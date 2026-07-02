//! Social-app (WeChat / QQ / DingTalk) new-message detection for the pet.
//!
//! WHY THIS IS NOT THE WINDOWS NOTIFICATION LISTENER ANY MORE
//! The first implementation used the WinRT `UserNotificationListener` to read
//! the Action Center. That API requires the caller to have *package identity*
//! (MSIX / Desktop Bridge); a plain Win32 Tauri exe has none, so
//! `RequestAccessAsync` returns not-Allowed and the listener thread bailed
//! before ever seeing a toast — which is exactly why WeChat / QQ / DingTalk
//! never fired while the (HTTP-pushed) Claude / Codex path did. On top of that,
//! WeChat for Windows does not emit WinRT toasts at all, so even an MSIX build
//! would not catch it. Reading the Action Center is a dead end here.
//!
//! WHAT THIS DOES INSTEAD
//! Polls the desktop for WeChat's own windows and watches for the transient
//! popup WeChat raises when a message arrives.
//!
//! PINNED SIGNAL (WeChat 4.0 / `Weixin`, Qt 5.15.14 — confirmed from a live run
//! 2026-06-25): a new message makes WeChat create a SEPARATE top-level window
//! whose class carries the Qt "ToolSaveBits" suffix (observed
//! `Qt51514QWindowToolSaveBits`, title "Weixin", ex-style 0x80088 = layered |
//! tool-window | topmost, ~435x396, on-screen). It appears for the preview and
//! is gone shortly after.
//!
//! The MAIN window (class "...QWindowIcon", title "微信") only toggles between
//! a full-size on-screen form and a tiny 237x39 form parked at the Windows
//! hide-coordinate (-32000,-32000) on minimize/restore. That toggle is NOT a
//! message — so it is explicitly excluded. (An earlier draft treated the
//! toggle as a signal and produced false positives every time WeChat was
//! minimized/restored.)
//!
//! The detector therefore:
//!   1. finds every visible top-level window owned by the WeChat process;
//!   2. keeps only windows whose class contains "toolsavebits" AND that are
//!      on-screen (i.e. the popup), tracking them by HWND across polls;
//!   3. emits `pet:social-notify` when such a popup HWND appears that was not
//!      on-screen in the previous poll (cooldown-gated).
//!
//! Diagnostics: set `BUGZIA_SOCIAL_DEBUG=1` to log the full WeChat window set
//! every poll (class / title / size / position / ex-style / child count /
//! offscreen flag). Without the flag, only set CHANGES are logged.
//!
//! QQ / DingTalk are no-ops in this backend for now (WeChat first, per the
//! product ask).

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT};
#[cfg(target_os = "windows")]
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetClassNameW, GetWindowLongW, GetWindowRect, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOPMOST,
};

const PET_SOCIAL_NOTIFY: &str = "pet:social-notify";
/// 1s so a short-lived notification window (or a parked-window move) is caught
/// between polls. Cheap: one process snapshot + one EnumWindows per tick.
const POLL_INTERVAL: Duration = Duration::from_millis(1000);
/// Windows parked at or beyond this negative coordinate are treated as
/// "off-screen" (the standard Windows hide-at-(-32000,-32000) trick).
#[cfg(target_os = "windows")]
const OFFSCREEN_THRESHOLD: i32 = -10_000;

static STARTED: AtomicBool = AtomicBool::new(false);
static CONFIG: OnceLock<Arc<RwLock<SocialNotifySettings>>> = OnceLock::new();

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SocialNotifySettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub wechat: bool,
    #[serde(default = "default_true")]
    pub qq: bool,
    #[serde(default = "default_true")]
    pub dingtalk: bool,
    #[serde(default = "default_social_notify_cooldown_ms")]
    pub cooldown_ms: u64,
    #[serde(default)]
    pub show_content: bool,
}

fn default_true() -> bool {
    true
}

fn default_social_notify_cooldown_ms() -> u64 {
    5000
}

impl Default for SocialNotifySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            wechat: true,
            qq: true,
            dingtalk: true,
            cooldown_ms: default_social_notify_cooldown_ms(),
            show_content: false,
        }
    }
}

pub fn start(app: AppHandle, cfg: SocialNotifySettings) -> bool {
    let config = CONFIG
        .get_or_init(|| Arc::new(RwLock::new(SocialNotifySettings::default())))
        .clone();
    if let Ok(mut current) = config.write() {
        *current = cfg.clone();
    }

    if !cfg.enabled {
        return false;
    }
    if STARTED.swap(true, Ordering::SeqCst) {
        return true;
    }

    std::thread::spawn(move || run_listener(app, config));
    true
}

#[cfg(target_os = "windows")]
fn run_listener(app: AppHandle, config: Arc<RwLock<SocialNotifySettings>>) {
    /// WeChat process image names (lower-cased) we attach to. Covers the classic
    /// 3.x client (`WeChat.exe`), the 4.0 Qt rewrite (`Weixin.exe`) and its
    /// helper runtime (`WeChatAppEx.exe`).
    const WECHAT_EXES: &[&str] = &["wechat.exe", "weixin.exe", "wechatappex.exe"];

    // Verbose per-poll logging when set — the diagnostic path for pinning down
    // the new-message signature on a given WeChat version.
    let verbose = std::env::var("BUGZIA_SOCIAL_DEBUG").is_ok();
    if verbose {
        eprintln!("[social_notify] verbose mode on (BUGZIA_SOCIAL_DEBUG)");
    }

    // Tracks which on-screen message-popup HWNDs were seen last poll. A popup
    // HWND present now but absent last poll = a fresh message preview just shown.
    let mut prev: HashSet<usize> = HashSet::new();
    let mut last_emit_at = 0u64;
    let mut primed = false;
    let mut last_signature = String::new();
    let mut pending_not_impl_log = true;

    loop {
        let cfg = config
            .read()
            .map(|current| current.clone())
            .unwrap_or_default();
        if !cfg.enabled {
            prev.clear();
            primed = false;
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }

        if pending_not_impl_log && (cfg.qq || cfg.dingtalk) {
            pending_not_impl_log = false;
            eprintln!(
                "[social_notify] qq/dingtalk not yet supported by the window backend \
                 (wechat only for now)"
            );
        }

        if cfg.wechat {
            let pids = collect_wechat_pids(WECHAT_EXES);

            let mut wins: Vec<WechatWindow> = Vec::new();
            let _ = unsafe { EnumWindows(Some(enum_proc), LPARAM(&mut wins as *mut _ as isize)) };
            // Enrich with child-window counts (a popup drawn as a child HWND
            // would change a window's count). Only for WeChat-owned windows.
            let owned: Vec<WechatWindow> = wins
                .into_iter()
                .filter(|w| pids.contains(&w.pid))
                .map(|mut w| {
                    w.child_count = count_children(w.hwnd_key);
                    w
                })
                .collect();

            if verbose {
                dump_windows(&owned);
            } else {
                dump_if_changed(&owned, &mut last_signature);
            }

            // Only the transient Qt popup windows ("ToolSaveBits" class) carry the
            // new-message signal. The main "QWindowIcon" window toggling on/off
            // screen is just minimize/restore — not a message — so it is excluded.
            let current_popups: HashSet<usize> = owned
                .iter()
                .filter(|w| is_message_signal_window(w) && is_on_screen(&w.rect))
                .map(|w| w.hwnd_key)
                .collect();

            // First poll after enable: seed the baseline so a popup already showing
            // when the feature turns on doesn't count as a new message.
            if primed && has_new_popup(&prev, &current_popups) {
                let now = now_millis();
                if cfg.cooldown_ms == 0 || now.saturating_sub(last_emit_at) >= cfg.cooldown_ms {
                    last_emit_at = now;
                    eprintln!("[social_notify] wechat new-message signal detected");
                    let _ = app.emit(
                        PET_SOCIAL_NOTIFY,
                        json!({
                            "source": "wechat",
                            "appName": "微信",
                            "summary": "",
                            "receivedAt": now,
                        }),
                    );
                }
            }
            prev = current_popups;
            primed = true;
        }

        std::thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(not(target_os = "windows"))]
fn run_listener(_app: AppHandle, _config: Arc<RwLock<SocialNotifySettings>>) {
    STARTED.store(false, Ordering::SeqCst);
}

/// The transient Qt popup WeChat 4.0 raises for a new message. Its window class
/// carries the Qt "ToolSaveBits" suffix (observed `Qt51514QWindowToolSaveBits`,
/// title "Weixin", layered+tool+topmost, ~435x396). The MAIN window's class
/// carries the "QWindowIcon" suffix and is excluded: it only toggles between
/// full-size-on-screen and a tiny parked-offscreen form on minimize/restore,
/// which is not a new message.
#[cfg(target_os = "windows")]
fn is_message_signal_window(w: &WechatWindow) -> bool {
    w.class.to_lowercase().contains("toolsavebits")
}

/// True if an on-screen popup in `current` was not on-screen in `prev` — i.e. a
/// new message preview just appeared this poll.
#[cfg(target_os = "windows")]
fn has_new_popup(prev: &HashSet<usize>, current: &HashSet<usize>) -> bool {
    current.iter().any(|k| !prev.contains(k))
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct WechatWindow {
    hwnd_key: usize,
    pid: u32,
    class: String,
    title: String,
    rect: RECT,
    ex_style: i32,
    child_count: u32,
}

/// `EnumWindows` callback: collect every VISIBLE top-level window's metadata.
#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }
    let out: &mut Vec<WechatWindow> = &mut *(lparam.0 as *mut Vec<WechatWindow>);

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));

    let mut class_buf = [0u16; 512];
    let class_n = GetClassNameW(hwnd, &mut class_buf);
    let class = wide_to_string(&class_buf, class_n);

    let mut title_buf = [0u16; 512];
    let title_n = GetWindowTextW(hwnd, &mut title_buf);
    let title = wide_to_string(&title_buf, title_n);

    let mut rect = RECT::default();
    let _ = GetWindowRect(hwnd, &mut rect);

    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);

    out.push(WechatWindow {
        hwnd_key: hwnd.0 as usize,
        pid,
        class,
        title,
        rect,
        ex_style,
        child_count: 0,
    });

    BOOL(1)
}

/// `EnumChildWindows` callback: just counts children (no per-child work).
#[cfg(target_os = "windows")]
unsafe extern "system" fn child_count_proc(_hwnd: HWND, lparam: LPARAM) -> BOOL {
    let count: &mut u32 = &mut *(lparam.0 as *mut u32);
    *count += 1;
    BOOL(1)
}

/// Number of direct child windows of the window identified by `hwnd_key`.
/// Reconstructs the HWND from the key (valid for the lifetime of this poll).
#[cfg(target_os = "windows")]
fn count_children(hwnd_key: usize) -> u32 {
    let mut count: u32 = 0;
    let _ = unsafe {
        EnumChildWindows(
            HWND(hwnd_key as isize),
            Some(child_count_proc),
            LPARAM(&mut count as *mut _ as isize),
        )
    };
    count
}

/// Snapshot all processes and return the PIDs whose image name matches one of
/// `names` (lower-cased, exact match on the file name). Empty set on any
/// snapshot failure — the caller just sees "no WeChat running" and skips.
#[cfg(target_os = "windows")]
fn collect_wechat_pids(names: &[&str]) -> HashSet<u32> {
    use std::mem::size_of;

    let mut pids = HashSet::new();
    let snap = unsafe {
        match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[social_notify] process snapshot failed: {e}");
                return pids;
            }
        }
    };

    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };

    let mut ok = unsafe { Process32FirstW(snap, &mut entry).is_ok() };
    while ok {
        let name = wide_to_string(&entry.szExeFile, entry.szExeFile.len() as i32).to_lowercase();
        if names.iter().any(|n| *n == name) {
            pids.insert(entry.th32ProcessID);
        }
        ok = unsafe { Process32NextW(snap, &mut entry).is_ok() };
    }

    let _ = unsafe { CloseHandle(snap) };
    pids
}

/// Decode a filled UTF-16 buffer of length `n` into a String, trimming NULs.
#[cfg(target_os = "windows")]
fn wide_to_string(buf: &[u16], n: i32) -> String {
    let len = if n > 0 {
        (n as usize).min(buf.len())
    } else {
        buf.len()
    };
    let slice = &buf[..len];
    let cut = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
    String::from_utf16_lossy(&slice[..cut])
}

/// A window parked at the Windows hide-coordinate (-32000,-32000) is treated as
/// off-screen; anything within the desktop bounds is on-screen.
#[cfg(target_os = "windows")]
fn is_on_screen(rect: &RECT) -> bool {
    rect.left > OFFSCREEN_THRESHOLD && rect.top > OFFSCREEN_THRESHOLD
}

/// Full per-window dump used in verbose mode. Prints every poll so a transient
/// notification window (or a parked-window move) is captured.
#[cfg(target_os = "windows")]
fn dump_windows(owned: &[WechatWindow]) {
    eprintln!("[social_notify] poll: wechat windows={}", owned.len());
    for w in owned {
        let width = w.rect.right - w.rect.left;
        let height = w.rect.bottom - w.rect.top;
        eprintln!(
            "  hwnd={:#x} class={:?} title={:?} {}x{}@({},{}) ex=0x{:x} kids={} offscreen={} popup={}",
            w.hwnd_key,
            w.class,
            w.title,
            width,
            height,
            w.rect.left,
            w.rect.top,
            w.ex_style as u32,
            w.child_count,
            !is_on_screen(&w.rect),
            is_message_popup(w),
        );
    }
}

/// Print the WeChat window set only when it changes (non-verbose mode).
#[cfg(target_os = "windows")]
fn dump_if_changed(owned: &[WechatWindow], last_signature: &mut String) {
    let mut ordered: Vec<&WechatWindow> = owned.iter().collect();
    ordered.sort_by_key(|w| w.hwnd_key);
    let signature = ordered
        .iter()
        .map(|w| {
            format!(
                "{}|{}x{}@{},{}|{:x}|kids{}",
                w.class,
                w.rect.right - w.rect.left,
                w.rect.bottom - w.rect.top,
                w.rect.left,
                w.rect.top,
                w.ex_style as u32,
                w.child_count,
            )
        })
        .collect::<Vec<_>>()
        .join(";");
    if signature == *last_signature {
        return;
    }
    *last_signature = signature;
    eprintln!("[social_notify] wechat windows ({}):", owned.len());
    for w in ordered {
        eprintln!(
            "  class={:?} title={:?} {}x{}@({},{}) ex=0x{:x} kids={} offscreen={}",
            w.class,
            w.title,
            w.rect.right - w.rect.left,
            w.rect.bottom - w.rect.top,
            w.rect.left,
            w.rect.top,
            w.ex_style as u32,
            w.child_count,
            !is_on_screen(&w.rect),
        );
    }
}

/// Best-effort popup matcher (kept for when a version DOES show a topmost
/// floating preview). Currently not the primary signal for Qt WeChat 4.0.
#[cfg(target_os = "windows")]
fn is_message_popup(w: &WechatWindow) -> bool {
    let ex = w.ex_style as u32;
    let floating = (ex & WS_EX_TOPMOST.0 != 0) || (ex & WS_EX_NOACTIVATE.0 != 0);
    if !floating {
        return false;
    }
    let width = (w.rect.right - w.rect.left).max(0);
    let height = (w.rect.bottom - w.rect.top).max(0);
    (120..=560).contains(&width) && (40..=320).contains(&height)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    fn rect(l: i32, t: i32, r: i32, b: i32) -> RECT {
        RECT {
            left: l,
            top: t,
            bottom: b,
            right: r,
        }
    }

    #[test]
    fn normal_position_is_on_screen() {
        assert!(is_on_screen(&rect(1272, 0, 2571, 1537)));
    }

    #[test]
    fn parked_offscreen_coordinate_is_off_screen() {
        // The classic Windows hide coordinate.
        assert!(!is_on_screen(&rect(-32000, -32000, -31763, -31961)));
    }

    fn set(keys: &[usize]) -> HashSet<usize> {
        keys.iter().copied().collect()
    }

    #[test]
    fn toolsavebits_class_is_signal_window() {
        // Real telemetry: the message preview popup (ex=0x80088, 435x396).
        let w = WechatWindow {
            hwnd_key: 0,
            pid: 0,
            class: "Qt51514QWindowToolSaveBits".into(),
            title: "Weixin".into(),
            rect: rect(1823, 1023, 2258, 1419),
            ex_style: 0x80088,
            child_count: 0,
        };
        assert!(is_message_signal_window(&w));
    }

    #[test]
    fn main_icon_window_is_not_signal_window() {
        // The main window toggling on/off is minimize/restore, not a message.
        let w = WechatWindow {
            hwnd_key: 0,
            pid: 0,
            class: "Qt51514QWindowIcon".into(),
            title: "微信".into(),
            rect: rect(1272, 0, 2571, 1537),
            ex_style: 0x100,
            child_count: 1,
        };
        assert!(!is_message_signal_window(&w));
    }

    #[test]
    fn new_popup_key_signals() {
        assert!(has_new_popup(&set(&[]), &set(&[200])));
    }

    #[test]
    fn persistent_popup_does_not_signal() {
        assert!(!has_new_popup(&set(&[200]), &set(&[200])));
    }

    #[test]
    fn popup_disappearing_does_not_signal() {
        assert!(!has_new_popup(&set(&[200]), &set(&[])));
    }

    #[test]
    fn topmost_small_window_is_popup() {
        let w = WechatWindow {
            hwnd_key: 0,
            pid: 0,
            class: String::new(),
            title: String::new(),
            rect: rect(0, 0, 320, 120),
            ex_style: 0x8,
            child_count: 0,
        };
        assert!(is_message_popup(&w));
    }

    #[test]
    fn plain_wechat40_main_window_is_not_popup() {
        // Real telemetry: ex=0x100 (WS_EX_WINDOWEDGE only), full-size -> not a popup.
        let w = WechatWindow {
            hwnd_key: 0,
            pid: 0,
            class: String::new(),
            title: String::new(),
            rect: rect(1272, 0, 2571, 1537),
            ex_style: 0x100,
            child_count: 0,
        };
        assert!(!is_message_popup(&w));
    }
}
