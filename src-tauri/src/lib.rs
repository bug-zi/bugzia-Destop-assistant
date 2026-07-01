mod agent_notify;
mod ai;
mod conversations;
mod file_search;
mod hotkey_center;
mod notes;
mod recyclebin;
mod settings;
mod shortcut_hotkeys;
mod social_notify;
mod waveform;
mod weather;

use ai::{
    ask_once, ask_once_stream, chat, clear_context, get_messages, set_messages, stop_chat,
    test_ai_connection,
};
use conversations::{
    delete_conversation, get_conversation, list_conversations, rename_conversation,
    reorder_conversations, set_conversation_locked, upsert_conversation,
};
use file_search::{open_file, reveal_file, search_files};
use notes::{notes_load, notes_save};
use recyclebin::pet_eat_files;
use settings::{
    clear_api_key, load_api_key, load_settings, save_api_key, save_settings, AgentNotifySettings,
};
use hotkey_center::{hotkey_center_detect_conflicts, hotkey_center_scan};
use shortcut_hotkeys::{
    shortcut_hotkey_clear, shortcut_hotkey_reveal, shortcut_hotkey_restore, shortcut_hotkey_set,
    shortcut_hotkeys_scan,
};

use std::fs;
#[cfg(target_os = "windows")]
use std::mem::size_of;
use std::path::PathBuf;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, HWND};
#[cfg(target_os = "windows")]
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
};

#[cfg(target_os = "windows")]
const HWND_BOTTOM: isize = 1;
#[cfg(target_os = "windows")]
const HWND_TOPMOST: isize = -1;
#[cfg(target_os = "windows")]
const SWP_NOMOVE: u32 = 0x0002;
#[cfg(target_os = "windows")]
const SWP_NOSIZE: u32 = 0x0001;
#[cfg(target_os = "windows")]
const SWP_SHOWWINDOW: u32 = 0x0040;

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn SetWindowPos(
        hwnd: isize,
        hwnd_insert_after: isize,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
}

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_autostart::{AutoLaunchManager, MacosLauncher};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Show + focus the main bar. Used by the global shortcut and the tray menu.
fn focus_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Toggle the main bar: hide it if currently visible, otherwise show + focus.
/// The summon shortcut uses this so the same key both summons and dismisses the
/// bar (the standard launcher-bar UX, e.g. Spotlight / PowerToys Run).
fn toggle_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        match win.is_visible() {
            Ok(true) => {
                let _ = win.hide();
            }
            _ => {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    }
}

/// Hand the note-set toggle to the main window. Main owns note state (which are
/// pinned) and persistence, so it decides hide-vs-summon and — on summon —
/// upgrades any unpinned (desktop-layer) notes to pinned (always-on-top) so they
/// are actually visible instead of buried under fullscreen apps. The backend
/// only checks whether ANY note window exists: none -> `note://quick-create`
/// (spawn a blank one, the "write anytime" case); some -> `note://toggle`.
///
/// hide-keep model still holds: hiding only flips visibility, the WebView and
/// its content/geometry stay in memory, no `NOTE_DESTROYED`. The pin upgrade on
/// summon is the only persistence touch.
fn toggle_notes(app: &AppHandle) {
    let has_note = app
        .webview_windows()
        .into_iter()
        .any(|(label, _)| label.starts_with("note-"));
    if !has_note {
        let _ = app.emit_to("main", "note://quick-create", ());
        return;
    }
    let _ = app.emit_to("main", "note://toggle", ());
}

/// (Re)register the input-bar and note global hotkeys. Clears any previously
/// registered shortcuts first so a settings change fully replaces both bindings
/// together (clearing is all-or-nothing, so the two keys MUST be registered in
/// the same call — otherwise reloading one would unregister the other). Each
/// accelerator is bound via `on_shortcut` (independent of any global handler):
/// `summon` toggles the input bar, `note` toggles the note set. An empty
/// accelerator is skipped; an unparseable one is recorded as an error naming the
/// offending combo. BOTH keys are always attempted so that one bad combo does
/// not silently drop the other; all errors are joined and surfaced together.
fn register_hotkeys(app: &AppHandle, summon: &str, note: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    // Clear every previous binding so a change fully replaces them.
    let _ = gs.unregister_all();
    let summon = summon.trim().to_lowercase();
    let note = note.trim().to_lowercase();
    let mut errs: Vec<String> = Vec::new();

    if !summon.is_empty() {
        if let Err(e) = gs.on_shortcut(summon.as_str(), |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_main(app);
            }
        }) {
            errs.push(format!("召唤键「{summon}」无效：{e}"));
        }
    }
    if !note.is_empty() {
        if let Err(e) = gs.on_shortcut(note.as_str(), |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_notes(app);
            }
        }) {
            errs.push(format!("便签键「{note}」无效：{e}"));
        }
    }

    if errs.is_empty() {
        Ok(())
    } else {
        Err(errs.join("；"))
    }
}

/// Reload the global hotkeys from new accelerator strings. Called by the main
/// window whenever the hotkey settings change, so edits apply immediately
/// without a restart. Returns any parse error(s) for the UI to surface.
#[tauri::command]
fn reload_hotkeys(app: AppHandle, summon: String, note: String) -> Result<(), String> {
    register_hotkeys(&app, &summon, &note)
}

/// Pin (or unpin) the result overlay above every other window. Driven by the
/// result window's pin button. Implemented in Rust rather than the frontend
/// because the result window's capability (`capabilities/result.json`) lacks
/// `allow-set-always-on-top` — a backend command has full window access
/// regardless of the caller's ACL.
#[tauri::command]
fn set_result_always_on_top(app: AppHandle, top: bool) {
    if let Some(win) = app.get_webview_window("result") {
        let _ = win.set_always_on_top(top);
    }
}

/// Lock the pet overlay = click-through (pointer reaches the desktop). Backend
/// command (not frontend) because the pet window's capability lacks
/// `allow-set-ignore-cursor-events`. Fire-and-forget like `set_result_always_on_top`.
#[tauri::command]
fn pet_set_locked(app: AppHandle, locked: bool) {
    if let Some(win) = app.get_webview_window("pet") {
        let _ = win.set_ignore_cursor_events(locked);
    }
}

/// Pin the pet overlay above every other window, or return it to the desktop
/// layer when unpinned. Same ACL rationale as `pet_set_locked`.
#[tauri::command]
fn pet_set_always_on_top(app: AppHandle, top: bool) {
    if let Some(win) = app.get_webview_window("pet") {
        pet_apply_layer(&win, top);
    }
}

#[cfg(target_os = "windows")]
fn pet_apply_layer(win: &tauri::WebviewWindow, top: bool) {
    let _ = win.show();
    if let Ok(hwnd) = win.hwnd() {
        let insert_after = if top { HWND_TOPMOST } else { HWND_BOTTOM };
        let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW;
        unsafe {
            let _ = SetWindowPos(hwnd.0 as isize, insert_after, 0, 0, 0, 0, flags);
        }
    } else if top {
        let _ = win.set_always_on_bottom(false);
        let _ = win.set_always_on_top(true);
    } else {
        let _ = win.set_always_on_top(false);
        let _ = win.set_always_on_bottom(true);
    }
}

#[cfg(not(target_os = "windows"))]
fn pet_apply_layer(win: &tauri::WebviewWindow, top: bool) {
    if top {
        let _ = win.set_always_on_bottom(false);
        let _ = win.show();
        let _ = win.set_always_on_top(true);
    } else {
        let _ = win.set_always_on_top(false);
        let _ = win.set_always_on_bottom(true);
    }
}

fn agent_notify_config(s: &AgentNotifySettings) -> agent_notify::NotifyConfig {
    agent_notify::NotifyConfig {
        port: s.port,
        token: s
            .token
            .as_deref()
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .map(str::to_string),
        on_done: s.on_done,
        on_needs: s.on_needs,
        on_error: s.on_error,
        show_content: s.show_content,
    }
}

/// Start the localhost agent-notify receiver when the user enables it at
/// runtime. The listener is intentionally one-shot; changing port/token still
/// needs an app restart because the bound socket cannot be reconfigured.
#[tauri::command]
fn agent_notify_start(app: AppHandle, cfg: AgentNotifySettings) -> bool {
    if !cfg.enabled {
        return false;
    }
    agent_notify::start(app, agent_notify_config(&cfg))
}

#[tauri::command]
fn social_notify_start(app: AppHandle, cfg: social_notify::SocialNotifySettings) -> bool {
    social_notify::start(app, cfg)
}

/// Debug echo: the frontend calls this the instant `pet:social-notify` arrives,
/// so a "[social_notify] frontend received" line in the terminal confirms the
/// event crossed the Rust->webview boundary (vs. being emitted but never
/// delivered). Temporary diagnostic for the WeChat-notify investigation.
#[tauri::command]
fn social_notify_ack() -> bool {
    eprintln!("[social_notify] frontend received pet:social-notify");
    true
}

#[tauri::command]
fn agent_notify_open_target(payload: serde_json::Value) -> Result<bool, String> {
    let source = payload
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cwd = payload
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    focus_agent_window(&source, &cwd)
}

fn is_bugzia_content_window(label: &str) -> bool {
    matches!(label, "main" | "result" | "settings") || label.starts_with("note-")
}

fn any_bugzia_content_window_focused(app: &AppHandle) -> bool {
    app.webview_windows().into_iter().any(|(label, win)| {
        is_bugzia_content_window(&label)
            && win.is_visible().unwrap_or(false)
            && win.is_focused().unwrap_or(false)
    })
}

#[tauri::command]
fn bugzia_any_content_window_focused(app: AppHandle) -> bool {
    any_bugzia_content_window_focused(&app)
}

#[tauri::command]
fn bugzia_should_suppress_agent_notify(app: AppHandle, payload: serde_json::Value) -> bool {
    any_bugzia_content_window_focused(&app) || is_foreground_agent_window(&payload)
}

#[cfg(target_os = "windows")]
fn is_foreground_agent_window(payload: &serde_json::Value) -> bool {
    let source = payload.get("source").and_then(|v| v.as_str()).unwrap_or("");
    let Some(front) = foreground_window_info() else {
        return false;
    };
    foreground_matches_agent(source, &front.process_name, &front.title)
}

#[cfg(not(target_os = "windows"))]
fn is_foreground_agent_window(_payload: &serde_json::Value) -> bool {
    false
}

fn foreground_matches_agent(source: &str, process_name: &str, title: &str) -> bool {
    let source = source.to_lowercase();
    let process_name = process_name.to_lowercase();
    let title = title.to_lowercase();
    let host_process = is_agent_host_process(&process_name);

    match source.as_str() {
        "codex" => process_name.contains("codex") || (host_process && title.contains("codex")),
        "claude" => process_name.contains("claude") || (host_process && title.contains("claude")),
        _ => false,
    }
}

fn is_agent_host_process(process_name: &str) -> bool {
    matches!(
        process_name,
        "code.exe"
            | "cursor.exe"
            | "windowsterminal.exe"
            | "wt.exe"
            | "powershell.exe"
            | "pwsh.exe"
            | "cmd.exe"
    )
}

#[cfg(target_os = "windows")]
struct ForegroundWindowInfo {
    process_name: String,
    title: String,
}

#[cfg(target_os = "windows")]
fn foreground_window_info() -> Option<ForegroundWindowInfo> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd == HWND(0) {
        return None;
    }

    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
    }
    if pid == 0 {
        return None;
    }

    Some(ForegroundWindowInfo {
        process_name: process_name_for_pid(pid).unwrap_or_default(),
        title: window_title(hwnd),
    })
}

#[cfg(target_os = "windows")]
fn window_title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

#[cfg(target_os = "windows")]
fn process_name_for_pid(pid: u32) -> Option<String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()? };
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut found = None;
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry).is_ok() };
    while ok {
        if entry.th32ProcessID == pid {
            found = Some(wide_nul_to_string(&entry.szExeFile));
            break;
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry).is_ok() };
    }
    let _ = unsafe { CloseHandle(snapshot) };
    found
}

#[cfg(target_os = "windows")]
fn wide_nul_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

#[cfg(target_os = "windows")]
fn focus_agent_window(source: &str, cwd: &str) -> Result<bool, String> {
    let script = r#"
$source = $env:BUGZIA_AGENT_SOURCE
$cwd = $env:BUGZIA_AGENT_CWD
$leaf = ""
if ($cwd) {
  try { $leaf = Split-Path -Leaf $cwd } catch {}
}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct BugziaRect {
  public int Left;
  public int Top;
  public int Right;
  public int Bottom;
}
public class BugziaWin32 {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out BugziaRect lpRect);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")]
  public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref BugziaRect pvParam, uint fWinIni);
}
"@

$wins = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 })
$matches = @()
if ($source -eq "codex") {
  $matches = @($wins | Where-Object {
    $_.ProcessName -match "(?i)codex" -or $_.MainWindowTitle -match "(?i)codex"
  })
} elseif ($source -eq "claude") {
  # Claude Code 没有独立窗口，跑在终端/IDE 宿主里。先排除属于 Codex 的窗口
  # (进程名/标题含 codex)：否则 "Codex" 进程名里的 "code" 子串会被下面的宿主
  # 进程规则误匹配，导致“立即前往”聚焦到 Codex 而不是 Claude。
  $pool = @($wins | Where-Object {
    $_.ProcessName -notmatch "(?i)codex" -and $_.MainWindowTitle -notmatch "(?i)codex"
  })
  # 优先：标题明确含 claude（终端被 Claude Code TUI 改名的情况）。
  $matches = @($pool | Where-Object { $_.MainWindowTitle -match "(?i)claude" })
  # 退回：常见终端/IDE 宿主进程。用 ^...$ 锚定整个进程名，避免子串误伤
  # （否则 "Codex" 会被 "code" 命中）；trae 用前缀覆盖 "Trae CN" 等变体。
  if ($matches.Count -eq 0) {
    $matches = @($pool | Where-Object {
      $_.ProcessName -match "(?i)^(code|cursor|windowsterminal|wt|powershell|pwsh|cmd)$" -or
      $_.ProcessName -match "(?i)^trae"
    })
  }
}
if ($leaf) {
  $byCwd = @($matches | Where-Object { $_.MainWindowTitle -like "*$leaf*" })
  if ($byCwd.Count -gt 0) { $matches = $byCwd }
}
$target = @($matches | Select-Object -First 1)[0]
if ($null -eq $target) { exit 2 }
$handle = $target.MainWindowHandle
[BugziaWin32]::ShowWindow($handle, 1) | Out-Null
$work = New-Object BugziaRect
$rect = New-Object BugziaRect
if ([BugziaWin32]::SystemParametersInfo(48, 0, [ref]$work, 0) -and [BugziaWin32]::GetWindowRect($handle, [ref]$rect)) {
  $workW = $work.Right - $work.Left
  $workH = $work.Bottom - $work.Top
  $winW = $rect.Right - $rect.Left
  $winH = $rect.Bottom - $rect.Top
  $looksFullscreen = [BugziaWin32]::IsZoomed($handle) -or (($workW -gt 0) -and ($workH -gt 0) -and ($winW -ge ($workW - 8)) -and ($winH -ge ($workH - 8)))
  if ($looksFullscreen) {
    $targetW = [Math]::Max(480, [Math]::Min(1280, [int]($workW * 0.72)))
    $targetH = [Math]::Max(360, [Math]::Min(820, [int]($workH * 0.78)))
    $targetW = [Math]::Min($targetW, [Math]::Max(320, $workW - 80))
    $targetH = [Math]::Min($targetH, [Math]::Max(240, $workH - 80))
    $x = $work.Left + [int](($workW - $targetW) / 2)
    $y = $work.Top + [int](($workH - $targetH) / 2)
    [BugziaWin32]::SetWindowPos($handle, [IntPtr]::Zero, $x, $y, $targetW, $targetH, 0x0244) | Out-Null
  }
}
[BugziaWin32]::SetForegroundWindow($handle) | Out-Null
exit 0
"#;

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .env("BUGZIA_AGENT_SOURCE", source)
        .env("BUGZIA_AGENT_CWD", cwd)
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("focus agent window: {e}"))?;
    Ok(output.status.success())
}

#[cfg(not(target_os = "windows"))]
fn focus_agent_window(_source: &str, _cwd: &str) -> Result<bool, String> {
    Ok(false)
}

/// Set a desktop sticky-note window's layer from its pinned state. Pinned ->
/// always-on-top (overlays every app window, the original behaviour). Unpinned
/// -> desktop layer: always-on-BOTTOM, so opened app windows cover the note
/// instead of the note floating over them.
///
/// ORDER MATTERS on Windows (tao): `set_always_on_bottom(false)` issues a
/// `SetWindowPos(HWND_NOTOPMOST)` that strips a just-applied topmost flag, and
/// `set_always_on_top(false)` raises the window toward the top. So we clear the
/// OPPOSITE layer first and apply the TARGET layer LAST — the final
/// `SetWindowPos` is what fixes the z-order. Doing both unconditionally (top
/// then bottom) left pinned notes non-topmost, covered by other windows.
///
/// Unlike the pet/waveform/result overlays (single instance, fixed label), notes
/// are MULTI-INSTANCE with dynamic labels (`note-<id>`), so the target label is a
/// parameter. Same ACL rationale: the note window's capability lacks
/// `allow-set-always-on-top` / `allow-set-always-on-bottom`, so the backend sets
/// them regardless of caller ACL.
#[tauri::command]
fn note_set_layer(app: AppHandle, label: String, pinned: bool) {
    if let Some(win) = app.get_webview_window(&label) {
        if pinned {
            let _ = win.set_always_on_bottom(false); // stop sinking first
            let _ = win.set_always_on_top(true); // then raise LAST -> stays topmost
        } else {
            let _ = win.set_always_on_top(false); // drop out of topmost first
            let _ = win.set_always_on_bottom(true); // then sink LAST -> desktop layer
        }
    }
}

/// Resolve (and create if missing) the pet sprite directory under appDataDir,
/// returning its absolute path. The frontend uses this both to know where to
/// load pose PNGs from (via `convertFileSrc`) and to open in the file manager
/// from Settings. Creating it here means `openPath` never targets a missing dir.
#[tauri::command]
fn pet_assets_dir(app: AppHandle) -> Result<String, String> {
    let dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?
        .join("pet");
    fs::create_dir_all(&dir).map_err(|e| format!("create pet dir: {e}"))?;
    dir.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "pet dir path is not valid UTF-8".to_string())
}

/// Make the OS launch-on-boot state match the user's stored intent. Called at
/// startup so a user who disabled autostart stays disabled across restarts —
/// we never force-enable over their choice.
fn sync_autostart(app: &AppHandle) {
    let want = load_settings(app.clone())
        .map(|s| s.system.autostart)
        .unwrap_or(true);
    let mgr = app.state::<AutoLaunchManager>();
    let cur = mgr.is_enabled().unwrap_or(false);
    if want && !cur {
        let _ = mgr.enable();
    } else if !want && cur {
        let _ = mgr.disable();
    }
}

/// Build the system tray: show / autostart toggle / pet toggle / waveform toggle
/// / quit. The autostart item starts checked to match the synced intent and
/// re-syncs on every toggle. The pet item mirrors `settings.pet.enabled` and the
/// waveform item mirrors `settings.waveform.enabled`; toggling either only
/// persists the intent and emits `settings://changed` — the MAIN window does the
/// actual overlay create/show (+ capture start for waveform; frontend ACL), not Rust.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let want_autostart = load_settings(app.clone())
        .map(|s| s.system.autostart)
        .unwrap_or(true);
    let want_pet = load_settings(app.clone())
        .map(|s| s.pet.enabled)
        .unwrap_or(false);
    let want_waveform = load_settings(app.clone())
        .map(|s| s.waveform.enabled)
        .unwrap_or(false);

    let show_item = MenuItem::with_id(app, "show", "显示 Bugzia", true, None::<&str>)?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启",
        true,
        want_autostart,
        None::<&str>,
    )?;
    let pet_item = CheckMenuItem::with_id(app, "pet", "桌宠", true, want_pet, None::<&str>)?;
    let waveform_item = CheckMenuItem::with_id(
        app,
        "waveform",
        "桌面波形",
        true,
        want_waveform,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    // Heterogeneous item types need an explicit `&[&dyn IsMenuItem]` coercion.
    let autostart_for_handler = autostart_item.clone();
    let pet_for_handler = pet_item.clone();
    let waveform_for_handler = waveform_item.clone();
    let items: &[&dyn IsMenuItem<Wry>] = &[
        &show_item,
        &autostart_item,
        &pet_item,
        &waveform_item,
        &quit_item,
    ];
    let menu = Menu::with_items(app, items)?;

    TrayIconBuilder::new()
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("missing default window icon"),
        )
        .tooltip("Bugzia")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => focus_main(app),
            "quit" => app.exit(0),
            "autostart" => {
                // Toggle the user intent, persist it, mirror to the OS, and
                // update the check mark so the menu reflects the new state.
                let mut s = load_settings(app.clone()).unwrap_or_default();
                s.system.autostart = !s.system.autostart;
                let next = s.system.autostart;
                let _ = save_settings(app.clone(), s);
                let mgr = app.state::<AutoLaunchManager>();
                let _ = if next { mgr.enable() } else { mgr.disable() };
                let _ = autostart_for_handler.set_checked(next);
            }
            "pet" => {
                // Toggle the pet-enabled intent, persist it, mirror the
                // checkmark, and signal MAIN to apply it. Rust does NOT create
                // the overlay window (frontend ACL); main reloads settings on
                // "settings://changed" and drives window creation.
                let mut s = load_settings(app.clone()).unwrap_or_default();
                s.pet.enabled = !s.pet.enabled;
                let next = s.pet.enabled;
                let _ = save_settings(app.clone(), s);
                let _ = app.emit("settings://changed", ());
                let _ = pet_for_handler.set_checked(next);
            }
            "waveform" => {
                // Toggle the waveform-enabled intent, persist it, mirror the
                // checkmark, and signal MAIN to apply it. The overlay window must
                // be created from the frontend (ACL), so Rust does NOT create it
                // here; main reloads settings on "settings://changed" and drives
                // window creation + capture start.
                let mut s = load_settings(app.clone()).unwrap_or_default();
                s.waveform.enabled = !s.waveform.enabled;
                let next = s.waveform.enabled;
                let _ = save_settings(app.clone(), s);
                let _ = app.emit("settings://changed", ());
                let _ = waveform_for_handler.set_checked(next);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Global hotkeys are (un)registered at runtime from settings (see
    // `register_hotkeys`), so the plugin is added with no startup shortcuts and
    // no global handler — each binding carries its own handler via `on_shortcut`
    // and is swapped on demand from `reload_hotkeys`.
    let global_shortcut = tauri_plugin_global_shortcut::Builder::new().build();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(global_shortcut)
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None::<Vec<&'static str>>,
        ))
        .manage(ai::ChatState::default())
        .manage(waveform::WaveformState::default())
        .setup(|app| {
            sync_autostart(app.handle());
            build_tray(app.handle())?;
            // Agent-notify receiver: a localhost HTTP endpoint that Claude Code
            // and Codex POST lifecycle events to (turn complete / approval
            // needed / errors). Started only when the user enables it; a bind
            // failure (port taken) is logged inside start() and never fatal.
            if let Ok(s) = load_settings(app.handle().clone()) {
                // Register the input-bar hotkeys from saved settings. Best-effort:
                // a malformed accelerator is logged + skipped, never fatal (the bar
                // is still focusable via the tray and re-registered on next change).
                if let Err(e) = register_hotkeys(app.handle(), &s.hotkey.summon, &s.hotkey.note) {
                    eprintln!("[bugzia] register hotkeys: {e}");
                }
                if s.agent_notify.enabled {
                    agent_notify::start(app.handle().clone(), agent_notify_config(&s.agent_notify));
                }
                if s.social_notify.enabled {
                    social_notify::start(app.handle().clone(), s.social_notify);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            save_api_key,
            load_api_key,
            clear_api_key,
            chat,
            stop_chat,
            clear_context,
            get_messages,
            set_messages,
            test_ai_connection,
            ask_once,
            ask_once_stream,
            list_conversations,
            get_conversation,
            upsert_conversation,
            set_conversation_locked,
            delete_conversation,
            rename_conversation,
            reorder_conversations,
            search_files,
            open_file,
            reveal_file,
            weather::weather,
            waveform::waveform_set_enabled,
            waveform::waveform_set_locked,
            waveform::waveform_set_always_on_top,
            set_result_always_on_top,
            pet_set_locked,
            pet_set_always_on_top,
            pet_assets_dir,
            pet_eat_files,
            notes_load,
            notes_save,
            note_set_layer,
            agent_notify_start,
            agent_notify_open_target,
            bugzia_any_content_window_focused,
            bugzia_should_suppress_agent_notify,
            social_notify_start,
            social_notify_ack,
            reload_hotkeys,
            hotkey_center_scan,
            hotkey_center_detect_conflicts,
            shortcut_hotkeys_scan,
            shortcut_hotkey_set,
            shortcut_hotkey_clear,
            shortcut_hotkey_restore,
            shortcut_hotkey_reveal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
