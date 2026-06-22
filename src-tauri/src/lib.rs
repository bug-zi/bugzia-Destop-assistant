mod agent_notify;
mod ai;
mod conversations;
mod file_search;
mod notes;
mod recyclebin;
mod settings;
mod waveform;
mod weather;

use ai::{ask_once, ask_once_stream, chat, clear_context, get_messages, set_messages, stop_chat, test_ai_connection};
use conversations::{
    delete_conversation, get_conversation, list_conversations, reorder_conversations,
    rename_conversation, set_conversation_locked, upsert_conversation,
};
use file_search::{open_file, reveal_file, search_files};
use notes::{notes_load, notes_save};
use recyclebin::pet_eat_files;
use settings::{
    clear_api_key, load_api_key, load_settings, save_api_key, save_settings, AgentNotifySettings,
};

use std::fs;
use std::path::PathBuf;

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_autostart::{AutoLaunchManager, MacosLauncher};

/// Show + focus the main bar. Used by the global shortcut and the tray menu.
fn focus_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
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

/// Pin (or unpin) the pet overlay above every other window. Same ACL rationale
/// as `pet_set_locked` / `set_result_always_on_top`.
#[tauri::command]
fn pet_set_always_on_top(app: AppHandle, top: bool) {
    if let Some(win) = app.get_webview_window("pet") {
        let _ = win.set_always_on_top(top);
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
    let autostart_item =
        CheckMenuItem::with_id(app, "autostart", "开机自启", true, want_autostart, None::<&str>)?;
    let pet_item =
        CheckMenuItem::with_id(app, "pet", "桌宠", true, want_pet, None::<&str>)?;
    let waveform_item =
        CheckMenuItem::with_id(app, "waveform", "桌面波形", true, want_waveform, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    // Heterogeneous item types need an explicit `&[&dyn IsMenuItem]` coercion.
    let autostart_for_handler = autostart_item.clone();
    let pet_for_handler = pet_item.clone();
    let waveform_for_handler = waveform_item.clone();
    let items: &[&dyn IsMenuItem<Wry>] =
        &[&show_item, &autostart_item, &pet_item, &waveform_item, &quit_item];
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
    // Global shortcut: Alt+Space focuses the bar from anywhere (plan §8). The
    // handler fires on both press and release; focusing twice is harmless and
    // avoids depending on the ShortcutEvent state API.
    let global_shortcut = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcuts(["alt+space"])
        .expect("invalid global shortcut spec")
        .with_handler(|app, _shortcut, _event| {
            focus_main(app);
        })
        .build();

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
                if s.agent_notify.enabled {
                    agent_notify::start(app.handle().clone(), agent_notify_config(&s.agent_notify));
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
