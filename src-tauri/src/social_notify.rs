use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const PET_SOCIAL_NOTIFY: &str = "pet:social-notify";
const POLL_INTERVAL: Duration = Duration::from_millis(2000);
const SEEN_LIMIT: usize = 256;

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
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
    use windows::UI::Notifications::Management::{
        UserNotificationListener, UserNotificationListenerAccessStatus,
    };
    use windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds};

    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }

    let listener = match UserNotificationListener::Current() {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("[social_notify] listener unavailable: {e}");
            STARTED.store(false, Ordering::SeqCst);
            return;
        }
    };

    let status = listener
        .GetAccessStatus()
        .unwrap_or(UserNotificationListenerAccessStatus::Unspecified);
    if status != UserNotificationListenerAccessStatus::Allowed {
        match listener.RequestAccessAsync().and_then(|op| op.get()) {
            Ok(UserNotificationListenerAccessStatus::Allowed) => {}
            Ok(other) => {
                eprintln!("[social_notify] notification access not allowed: {other:?}");
                STARTED.store(false, Ordering::SeqCst);
                return;
            }
            Err(e) => {
                eprintln!("[social_notify] request access failed: {e}");
                STARTED.store(false, Ordering::SeqCst);
                return;
            }
        }
    }

    let binding_name = match KnownNotificationBindings::ToastGeneric() {
        Ok(name) => name,
        Err(e) => {
            eprintln!("[social_notify] toast binding unavailable: {e}");
            STARTED.store(false, Ordering::SeqCst);
            return;
        }
    };

    let mut seen = HashSet::<String>::new();
    let mut seen_order = Vec::<String>::new();
    let mut last_emit_at = 0u64;
    let mut primed = false;

    loop {
        let cfg = config
            .read()
            .map(|current| current.clone())
            .unwrap_or_default();
        if !cfg.enabled {
            primed = false;
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }

        let notifications = match listener
            .GetNotificationsAsync(NotificationKinds::Toast)
            .and_then(|op| op.get())
        {
            Ok(notifications) => notifications,
            Err(e) => {
                eprintln!("[social_notify] read notifications failed: {e}");
                std::thread::sleep(POLL_INTERVAL);
                continue;
            }
        };

        let size = notifications.Size().unwrap_or(0);
        for i in 0..size {
            let item = match notifications.GetAt(i) {
                Ok(item) => item,
                Err(_) => continue,
            };
            let id = item.Id().unwrap_or(0);
            let app_info = match item.AppInfo() {
                Ok(app_info) => app_info,
                Err(_) => continue,
            };
            let app_name = app_info
                .DisplayInfo()
                .and_then(|display| display.DisplayName())
                .map(|s| s.to_string_lossy())
                .unwrap_or_default();
            let app_id = app_info
                .AppUserModelId()
                .map(|s| s.to_string_lossy())
                .unwrap_or_default();
            let Some(app_kind) = match_social_app(&cfg, &app_name, &app_id) else {
                continue;
            };

            let key = format!("{app_id}:{app_name}:{id}");
            if seen.contains(&key) {
                continue;
            }
            seen.insert(key.clone());
            seen_order.push(key);
            while seen_order.len() > SEEN_LIMIT {
                if let Some(old) = seen_order.first().cloned() {
                    seen.remove(&old);
                    seen_order.remove(0);
                }
            }
            if !primed {
                continue;
            }

            let now = now_millis();
            if cfg.cooldown_ms > 0 && now.saturating_sub(last_emit_at) < cfg.cooldown_ms {
                continue;
            }
            last_emit_at = now;

            let text = item
                .Notification()
                .and_then(|n| n.Visual())
                .and_then(|v| v.GetBinding(&binding_name))
                .and_then(|b| b.GetTextElements())
                .ok()
                .map(|texts| collect_texts(&texts))
                .unwrap_or_default();
            let summary = if cfg.show_content {
                text.join(" ")
            } else {
                String::new()
            };

            let _ = app.emit(
                PET_SOCIAL_NOTIFY,
                json!({
                    "source": app_kind,
                    "appName": if app_name.is_empty() { app_kind } else { app_name.as_str() },
                    "summary": summary,
                    "receivedAt": now,
                }),
            );
        }
        primed = true;

        std::thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(not(target_os = "windows"))]
fn run_listener(_app: AppHandle, _config: Arc<RwLock<SocialNotifySettings>>) {
    STARTED.store(false, Ordering::SeqCst);
}

#[cfg(target_os = "windows")]
fn collect_texts(
    texts: &windows::Foundation::Collections::IVectorView<
        windows::UI::Notifications::AdaptiveNotificationText,
    >,
) -> Vec<String> {
    let mut out = Vec::new();
    let size = texts.Size().unwrap_or(0);
    for i in 0..size {
        if let Ok(text) = texts.GetAt(i).and_then(|t| t.Text()) {
            let value = text.to_string_lossy();
            let value = value.trim();
            if !value.is_empty() {
                out.push(value.to_string());
            }
        }
    }
    out
}

fn match_social_app(
    cfg: &SocialNotifySettings,
    app_name: &str,
    app_id: &str,
) -> Option<&'static str> {
    let hay = format!("{} {}", app_name.to_lowercase(), app_id.to_lowercase());
    if cfg.wechat && (hay.contains("wechat") || hay.contains("weixin") || hay.contains("微信")) {
        return Some("wechat");
    }
    let app_name = app_name.trim();
    if cfg.qq
        && (app_name.eq_ignore_ascii_case("qq")
            || hay.contains("tencent.qq")
            || hay.contains("qq.exe")
            || hay.contains(" qq ")
            || hay.contains(".qq."))
    {
        return Some("qq");
    }
    if cfg.dingtalk && (hay.contains("dingtalk") || hay.contains("钉钉")) {
        return Some("dingtalk");
    }
    None
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
