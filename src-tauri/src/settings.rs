//! Persistent settings for bugzia (plan §12 settings.rs).
//!
//! Storage is split:
//!   - appearance / window / ai(non-secret) / search -> JSON in the app config dir
//!   - API Key                                       -> OS keyring (Windows Credential Manager)
//!
//! The API Key never lands in the JSON file.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "settings.json";
/// keyring target identity. Identifies the (service, user) credential slot.
const KEYRING_SERVICE: &str = "com.bugzia.deskcard";
const KEYRING_USER: &str = "openai_api_key";

// ---------------------------------------------------------------------------
// Settings model
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppearanceSettings {
    pub bg_r: u8,
    pub bg_g: u8,
    pub bg_b: u8,
    /// 0.0 - 1.0
    pub bg_a: f32,
    /// backdrop blur in px
    pub blur: f32,
    /// corner radius in px
    pub radius: f32,
    /// font scale multiplier (1.0 = default)
    pub font_scale: f32,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        // Mirrors the original light-white glass theme in theme.css.
        Self {
            bg_r: 255,
            bg_g: 255,
            bg_b: 255,
            bg_a: 0.34,
            blur: 18.0,
            radius: 12.0,
            font_scale: 1.0,
        }
    }
}

/// Window bounds are stored in LOGICAL pixels (matches the frontend's
/// LogicalSize/LogicalPosition usage, so restore + expand-toggle share one space).
///
/// `result_h` is additive over the original {x,y,w,h,expanded,locked} shape.
/// Because `WindowSettings` has no field-level serde defaults, a naive
/// non-optional `result_h` would make legacy `settings.json` (which lack it)
/// fail to deserialize -> `load_settings`'s `unwrap_or_default()` would then
/// WIPE the user's saved bounds. The `#[serde(default = "default_result_h")]`
/// attribute prevents that, and a manual `Default` impl (instead of the derive)
/// keeps fresh installs at 360 rather than u32's default 0.
fn default_result_h() -> u32 {
    360
}

/// Sentinel for result_x/result_y meaning "the user has not placed the overlay
/// yet" — on show we then default to just above the bar instead of restoring.
fn default_result_pos() -> i32 {
    -1
}

/// Sentinel for result_w meaning "not yet resized by the user" — the default
/// above-bar placement then tracks the bar's width.
fn default_result_w() -> u32 {
    0
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WindowSettings {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub expanded: bool,
    pub locked: bool,
    /// Result overlay window height in LOGICAL px. Persisted so a manual resize
    /// survives an app restart. serde default keeps legacy settings.json loading.
    #[serde(default = "default_result_h")]
    pub result_h: u32,
    /// Result overlay window X in LOGICAL px. `-1` sentinel = never placed by the
    /// user (see `default_result_pos`); otherwise the restored left coordinate.
    #[serde(default = "default_result_pos")]
    pub result_x: i32,
    /// Result overlay window Y in LOGICAL px. `-1` sentinel (see `result_x`).
    #[serde(default = "default_result_pos")]
    pub result_y: i32,
    /// Result overlay window width in LOGICAL px. `0` sentinel = never resized;
    /// the default placement tracks the bar width.
    #[serde(default = "default_result_w")]
    pub result_w: u32,
}

impl Default for WindowSettings {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            w: 0,
            h: 0,
            expanded: false,
            locked: false,
            result_h: default_result_h(),
            result_x: default_result_pos(),
            result_y: default_result_pos(),
            result_w: default_result_w(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AiSettings {
    pub provider_name: String,
    pub base_url: String,
    pub model: String,
    pub system_prompt: String,
    pub temperature: f32,
    pub stream: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider_name: String::new(),
            base_url: String::new(),
            model: String::new(),
            system_prompt: String::new(),
            temperature: 0.7,
            stream: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SearchSettings {
    pub default_engine: String,
    pub custom_engine_url: String,
    /// Extra directories to include in `/file` search (Desktop/Documents/
    /// Downloads are always included). Stored as strings; resolved at search
    /// time so missing dirs are skipped, never fatal.
    #[serde(default)]
    pub index_dirs: Vec<String>,
    /// Directory-name segments to prune from the walk (e.g. "node_modules",
    /// "My Secret Folder"). Compared against the final path segment.
    #[serde(default)]
    pub ignore_dirs: Vec<String>,
    /// Max results returned by `search_files`. `#[serde(default)]` keeps legacy
    /// settings.json (which lack this field) loading instead of wiping them.
    #[serde(default = "default_max_results")]
    pub max_results: u32,
}

fn default_max_results() -> u32 {
    50
}

impl Default for SearchSettings {
    fn default() -> Self {
        Self {
            default_engine: "google".to_string(),
            custom_engine_url: String::new(),
            index_dirs: Vec::new(),
            ignore_dirs: Vec::new(),
            max_results: default_max_results(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SystemSettings {
    /// User intent for launch-on-boot. Synced to the OS autostart at startup
    /// and toggled from the tray menu. Manual `Default` (true) + serde default
    /// so a fresh install AND a legacy settings.json both yield "on" — matching
    /// the resident-desktop product intent while still letting the user opt out.
    #[serde(default = "default_autostart")]
    pub autostart: bool,
}

fn default_autostart() -> bool {
    true
}

impl Default for SystemSettings {
    fn default() -> Self {
        Self {
            autostart: default_autostart(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub window: WindowSettings,
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default)]
    pub search: SearchSettings,
    #[serde(default)]
    pub system: SystemSettings,
}

// ---------------------------------------------------------------------------
// JSON file I/O
// ---------------------------------------------------------------------------

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app_config_dir: {e}"))?;
    Ok(dir.join(SETTINGS_FILE))
}

/// Atomic write: write to `<file>.tmp` then rename over the target.
/// Avoids a half-written settings.json if the process is interrupted.
fn atomic_write(path: &Path, data: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename tmp->settings: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("read settings: {e}"))?;
    // Partial / corrupt file -> fall back to defaults rather than crash.
    let parsed: AppSettings = serde_json::from_str(&data).unwrap_or_default();
    Ok(parsed)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let data = serde_json::to_string_pretty(&settings).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(&path, &data)
}

// ---------------------------------------------------------------------------
// API Key via OS keyring
// ---------------------------------------------------------------------------

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("open keyring entry: {e}"))
}

#[tauri::command]
pub fn save_api_key(key: String) -> Result<(), String> {
    if key.is_empty() {
        return clear_api_key();
    }
    keyring_entry()?.set_password(&key).map_err(|e| format!("set keyring: {e}"))
}

#[tauri::command]
pub fn load_api_key() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("get keyring: {e}")),
    }
}

#[tauri::command]
pub fn clear_api_key() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("delete keyring: {e}")),
    }
}
