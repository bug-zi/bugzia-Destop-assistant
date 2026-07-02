//! Persistent settings for bugzia (plan §12 settings.rs).
//!
//! Storage is split:
//!   - appearance / window / ai(non-secret) / search -> JSON in the app config dir
//!   - API Key                                       -> OS keyring (Windows Credential Manager)
//!
//! The API Key never lands in the JSON file.

use std::fs;
use std::path::{Path, PathBuf};

use crate::social_notify::SocialNotifySettings;
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
        // Light rose-tinted glass theme (user-tuned): translucent + heavy blur.
        Self {
            bg_r: 254,
            bg_g: 210,
            bg_b: 210,
            bg_a: 0.11,
            blur: 40.0,
            radius: 12.0,
            font_scale: 1.0,
        }
    }
}

/// Result-overlay panel appearance. INDEPENDENT of the global glass theme so the
/// overlay can be tuned without touching the input bar. Like `AppearanceSettings`,
/// a manual `Default` (not the derive) keeps the values at the original hardcoded
/// pixels, and `#[serde(default)]` on the `AppSettings` field keeps a legacy
/// `settings.json` (which lacks this section) loading instead of wiping it.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ResultAppearanceSettings {
    /// Overlay background red (independent of the global card color so the panel
    /// can be tuned separately). serde default keeps a legacy settings.json (which
    /// predates these fields) loading instead of wiping the whole section.
    #[serde(default = "default_result_bg")]
    pub bg_r: u8,
    #[serde(default = "default_result_bg")]
    pub bg_g: u8,
    #[serde(default = "default_result_bg")]
    pub bg_b: u8,
    /// 0.0 - 1.0, overlay background alpha (overrides the global bg_a here).
    pub bg_a: f32,
    /// overlay corner radius in px.
    pub radius: f32,
    /// overlay backdrop blur in px.
    pub blur: f32,
    /// result-area font scale multiplier (scoped via .result-card). 1.0 = default.
    pub font_scale: f32,
    /// list / chat-bubble row gap in px.
    pub row_gap: f32,
    /// list row / chat bubble corner radius in px.
    pub item_radius: f32,
    /// file-row inner padding in px (horizontal padding tracks this + 2px).
    pub row_pad: f32,
    /// 0.0 - 1.0, file-row hover highlight alpha.
    pub hover_alpha: f32,
    /// scrollbar width in px.
    pub scrollbar_w: f32,
    /// Locked conversation-card tint, red channel. Applied as a translucent
    /// overlay on `.history-item.is-locked` in the history rail, so the user can
    /// color-code locked conversations instead of the fixed amber. Field-level
    /// serde defaults keep a legacy settings.json (predating this field) loading
    /// at the original amber instead of collapsing to 0 / wiping the section.
    #[serde(default = "default_locked_r")]
    pub locked_r: u8,
    #[serde(default = "default_locked_g")]
    pub locked_g: u8,
    #[serde(default = "default_locked_b")]
    pub locked_b: u8,
    /// 0.0 - 1.0, locked-card overlay alpha. Replaces the former CSS-hardcoded
    /// 0.22 so the locked tint strength is tunable alongside its hue.
    #[serde(default = "default_locked_a")]
    pub locked_a: f32,
    /// Unlocked (resting) conversation-card tint, red channel. Applied as the
    /// translucent background of `.history-item` (non-locked) in the history
    /// rail, so the user can tune the resting card color separately from locked
    /// ones. Field-level serde defaults keep a legacy settings.json (predating
    /// these fields) loading at the original white (255) instead of collapsing
    /// to 0 (black) / wiping the section.
    #[serde(default = "default_unlocked_r")]
    pub unlocked_r: u8,
    #[serde(default = "default_unlocked_g")]
    pub unlocked_g: u8,
    #[serde(default = "default_unlocked_b")]
    pub unlocked_b: u8,
    /// 0.0 - 1.0, unlocked-card overlay alpha. Replaces the former
    /// CSS-hardcoded 0.12 so the resting card strength is tunable.
    #[serde(default = "default_unlocked_a")]
    pub unlocked_a: f32,
}

/// serde defaults for the locked-card tint RGB — coral (255,135,135), the
/// user-tuned default tint, so a legacy settings.json missing this field loads
/// the current default instead of collapsing to black / wiping the section.
fn default_locked_r() -> u8 {
    255
}
fn default_locked_g() -> u8 {
    135
}
fn default_locked_b() -> u8 {
    135
}
/// serde default for `ResultAppearanceSettings::locked_a` — 0.22, the former
/// CSS-hardcoded locked-card overlay alpha, so a legacy settings.json missing
/// this field loads at the same strength instead of collapsing to 0 (invisible)
/// or wiping the section.
fn default_locked_a() -> f32 {
    0.22
}
/// serde defaults for the unlocked-card tint RGB — white (255), the former
/// CSS-hardcoded resting card color, so a legacy settings.json missing these
/// fields loads white instead of collapsing to 0 (black) / wiping the section.
fn default_unlocked_r() -> u8 {
    255
}
fn default_unlocked_g() -> u8 {
    255
}
fn default_unlocked_b() -> u8 {
    255
}
/// serde default for `ResultAppearanceSettings::unlocked_a` — 0.12, the former
/// CSS-hardcoded resting-card overlay alpha.
fn default_unlocked_a() -> f32 {
    0.12
}

/// serde default for `ResultAppearanceSettings::bg_r/g/b` — 255 (white), so a
/// legacy settings.json missing these fields keeps the panel white instead of
/// collapsing to 0 (black) or wiping the whole section via `unwrap_or_default`.
fn default_result_bg() -> u8 {
    255
}

impl Default for ResultAppearanceSettings {
    fn default() -> Self {
        // Mirrors the original hardcoded result-panel values. row_gap (previously
        // file 4 / chat 8) and item_radius (previously file ~6.6 / bubble 11) are
        // unified to a midpoint; every other value reproduces the prior pixel so a
        // fresh install is visually unchanged.
        Self {
            bg_r: default_result_bg(),
            bg_g: default_result_bg(),
            bg_b: default_result_bg(),
            bg_a: 0.11,
            radius: 12.0,
            blur: 18.0,
            font_scale: 1.0,
            row_gap: 6.0,
            item_radius: 9.0,
            row_pad: 6.0,
            hover_alpha: 0.72,
            scrollbar_w: 8.0,
            locked_r: default_locked_r(),
            locked_g: default_locked_g(),
            locked_b: default_locked_b(),
            locked_a: default_locked_a(),
            unlocked_r: default_unlocked_r(),
            unlocked_g: default_unlocked_g(),
            unlocked_b: default_unlocked_b(),
            unlocked_a: default_unlocked_a(),
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

fn default_settings_window_w() -> u32 {
    1063
}

fn default_settings_window_h() -> u32 {
    657
}

fn default_settings_window_x() -> i32 {
    245
}

fn default_settings_window_y() -> i32 {
    25
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
    /// Settings popup X in LOGICAL px.
    #[serde(default = "default_settings_window_x")]
    pub settings_x: i32,
    /// Settings popup Y in LOGICAL px.
    #[serde(default = "default_settings_window_y")]
    pub settings_y: i32,
    /// Settings popup width in LOGICAL px.
    #[serde(default = "default_settings_window_w")]
    pub settings_w: u32,
    /// Settings popup height in LOGICAL px.
    #[serde(default = "default_settings_window_h")]
    pub settings_h: u32,
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
            settings_x: default_settings_window_x(),
            settings_y: default_settings_window_y(),
            settings_w: default_settings_window_w(),
            settings_h: default_settings_window_h(),
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
            provider_name: "vibe".to_string(),
            base_url: "https://token.aiedulab.cn/v1".to_string(),
            model: "gpt-5.5".to_string(),
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

fn default_true() -> bool {
    true
}

impl Default for SystemSettings {
    fn default() -> Self {
        Self {
            autostart: default_autostart(),
        }
    }
}

/// Global hotkey settings for the input bar. `summon` shows + focuses the bar
/// and hides it again when already visible (toggle, the standard launcher-bar
/// UX) — one key both summons and dismisses the bar. A Tauri accelerator string
/// such as "alt+space". The whole section is `#[serde(default)]` on
/// `AppSettings`, so a legacy settings.json (which predates this feature) loads
/// the default below instead of wiping. Manual `Default` keeps a fresh install
/// at the working default rather than collapsing to an empty string (which
/// would leave the bar with no way to be summoned).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HotkeySettings {
    /// Accelerator to summon the input bar; toggles (hides) when already visible.
    #[serde(default = "default_hotkey_summon")]
    pub summon: String,
    /// Accelerator to toggle all sticky notes: hides them if any are visible,
    /// otherwise shows them; when no note exists at all it asks the main window
    /// to spawn a blank one. Empty = skip (notes stay reachable only via the
    /// `/note` command). Same `#[serde(default)]` rationale as `summon`.
    #[serde(default = "default_hotkey_note")]
    pub note: String,
    /// Accelerator to ALWAYS spawn a fresh blank note, even when notes already
    /// exist (unlike `note`, which toggles the whole set). The default is
    /// `alt+shift+c`; users can clear it in Settings to disable it. Same
    /// `#[serde(default)]` rationale as `summon`.
    #[serde(default = "default_hotkey_note_create")]
    pub note_create: String,
    /// Accelerator to destroy the currently-focused note (the "current note").
    /// The default is `alt+z`; users can clear it in Settings to disable it.
    /// Same `#[serde(default)]` rationale as `summon`.
    #[serde(default = "default_hotkey_note_destroy")]
    pub note_destroy: String,
}

fn default_hotkey_summon() -> String {
    "alt+space".to_string()
}

fn default_hotkey_note() -> String {
    "alt+n".to_string()
}

fn default_hotkey_note_create() -> String {
    "alt+shift+c".to_string()
}

fn default_hotkey_note_destroy() -> String {
    "alt+z".to_string()
}

impl Default for HotkeySettings {
    fn default() -> Self {
        Self {
            summon: default_hotkey_summon(),
            note: default_hotkey_note(),
            note_create: default_hotkey_note_create(),
            note_destroy: default_hotkey_note_destroy(),
        }
    }
}

/// Desktop pet companion settings. A self-contained floating overlay that
/// idles (blink), looks toward the cursor, reacts to a click (petted + speech
/// bubble), and can be dragged. Decoupled from Bugzia's other features — no
/// audio / system events. The whole section is `#[serde(default)]` on
/// `AppSettings`, so a legacy settings.json (which predates this feature) loads
/// the defaults below instead of wiping. Manual `Default` keeps a fresh install
/// visually correct rather than collapsing to 0/false.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PetSettings {
    /// Master on/off for the overlay.
    pub enabled: bool,
    /// Pin above all other windows.
    pub always_on_top: bool,
    /// Lock = mouse click-through (pointer reaches the desktop; the pet's own
    /// click/drag handlers stop firing — the expected behavior of "lock").
    pub locked: bool,
    /// Overall sprite scale multiplier (1.0 = native image size).
    pub scale: f32,
    /// Idle blink interval, ms.
    pub blink_interval_ms: u32,
    /// Whether the pet shows speech bubbles at all.
    pub speech_enabled: bool,
    /// Idle random-speech interval, ms.
    pub speech_interval_ms: u32,
    /// Whether the pet may ask the configured AI model for improvised short lines.
    #[serde(default = "default_true")]
    pub ai_speech_enabled: bool,
    /// Minimum interval between idle AI improvised lines, ms.
    #[serde(default = "default_pet_ai_idle_interval_ms")]
    pub ai_idle_interval_ms: u32,
    /// Minimum interval between interaction AI improvised lines, ms.
    #[serde(default = "default_pet_ai_interaction_interval_ms")]
    pub ai_interaction_interval_ms: u32,
    /// Whether double-click opens the pet chat input.
    #[serde(default = "default_true")]
    pub chat_enabled: bool,
    /// Show developer-only runtime state overlay on the pet window.
    #[serde(default)]
    pub debug_panel: bool,
    /// Speech-bubble lines (one chosen at random). User-editable in Settings.
    #[serde(default = "default_pet_speech_lines")]
    pub speech_lines: Vec<String>,
    /// Overlay window position, LOGICAL px. `-1` sentinel = never placed by the
    /// user; show then defaults to lower-right of the screen.
    pub x: i32,
    pub y: i32,
    /// Overlay window size, LOGICAL px.
    pub w: u32,
    pub h: u32,
}

/// Desktop waveform visualizer settings. The overlay floats on the desktop and
/// dances to whatever the system is playing (captured via WASAPI loopback). The
/// whole section is `#[serde(default)]` on `AppSettings`, so a legacy
/// settings.json (which predates this feature) loads the rose-pink defaults
/// below instead of wiping. Manual `Default` keeps a fresh install visually
/// correct rather than collapsing to 0/false.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WaveformSettings {
    /// Master on/off for the overlay + audio capture.
    pub enabled: bool,
    /// Pin above all other windows while playing.
    pub always_on_top: bool,
    /// Lock = mouse click-through (overlay stops intercepting desktop clicks).
    pub locked: bool,
    /// 0.0 - 1.0 overlay opacity.
    pub opacity: f32,
    /// Loudness gain applied in the frontend (lets quiet passages still move).
    pub sensitivity: f32,
    /// Base petal size in px.
    pub petal_size: f32,
    /// Max concurrent petals on screen.
    pub petal_density: u32,
    /// Fall-speed multiplier.
    pub drift_speed: f32,
    /// Primary petal color (default rose pink #FF5274).
    pub color_r: u8,
    pub color_g: u8,
    pub color_b: u8,
    /// Highlight / water-line color (default light pink #FF9494).
    pub accent_r: u8,
    pub accent_g: u8,
    pub accent_b: u8,
    /// Overlay window position in LOGICAL px. `-1` sentinel = never placed by
    /// the user; show then uses the default (lower-center) placement instead.
    pub x: i32,
    pub y: i32,
    /// Overlay window size in LOGICAL px.
    pub w: u32,
    pub h: u32,
}

fn default_pet_speech_lines() -> Vec<String> {
    [
        "哼，终于想起我了？",
        "今天也要优雅一点。",
        "别乱点，我在看着你。",
        "做得不错。",
        "再陪我一会儿。",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn default_pet_ai_idle_interval_ms() -> u32 {
    60000
}

fn default_pet_ai_interaction_interval_ms() -> u32 {
    12000
}

impl Default for PetSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            always_on_top: false,
            locked: false,
            scale: 1.0,
            blink_interval_ms: 4000,
            speech_enabled: true,
            speech_interval_ms: 12000,
            ai_speech_enabled: true,
            ai_idle_interval_ms: default_pet_ai_idle_interval_ms(),
            ai_interaction_interval_ms: default_pet_ai_interaction_interval_ms(),
            chat_enabled: true,
            debug_panel: false,
            speech_lines: default_pet_speech_lines(),
            x: -1,
            y: -1,
            w: 210,
            h: 300,
        }
    }
}

impl Default for WaveformSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            always_on_top: false,
            locked: false,
            opacity: 0.95,
            sensitivity: 1.0,
            petal_size: 4.0,
            petal_density: 136,
            drift_speed: 0.6,
            color_r: 255,
            color_g: 82,
            color_b: 116, // #FF5274 rose pink (user-tuned)
            accent_r: 255,
            accent_g: 148,
            accent_b: 148, // #FF9494 light pink highlight
            x: -1,
            y: -1,
            w: 380,
            h: 200,
        }
    }
}

/// Desktop sticky-note DEFAULTS (the `/note <content>` feature). Each note is a
/// self-contained floating overlay; these are the style/size defaults applied to
/// a freshly created note. Individual note content + geometry for PINNED notes
/// lives in `notes.json` (user data, see `notes.rs`), NOT here — this section is
/// purely preferences, mirroring how `WaveformSettings` holds visual defaults
/// while per-instance state is separate. The whole section is `#[serde(default)]`
/// on `AppSettings`, so a legacy settings.json (which predates this feature)
/// loads the rose-pink defaults below instead of wiping. Manual `Default`
/// keeps a fresh install visually correct rather than collapsing to 0/false.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NoteSettings {
    /// Note background color (default rose pink #C95877).
    pub bg_r: u8,
    pub bg_g: u8,
    pub bg_b: u8,
    /// Note text color (default white).
    pub text_r: u8,
    pub text_g: u8,
    pub text_b: u8,
    /// Default note width in LOGICAL px (applied on creation; each note remembers
    /// its own w/h in notes.json once the user resizes it).
    pub w: u32,
    /// Default note height in LOGICAL px.
    pub h: u32,
    /// Corner radius in px.
    pub radius: f32,
    /// Font size in px.
    pub font_size: f32,
    /// 0..1 BACKGROUND fill opacity (the note's translucent backing, independent
    /// of text so the body can be see-through while text stays crisp).
    pub bg_alpha: f32,
    /// 0..1 TEXT opacity (applied to body text + textarea; independent of bg).
    pub text_alpha: f32,
}

impl Default for NoteSettings {
    fn default() -> Self {
        Self {
            bg_r: 201,
            bg_g: 88,
            bg_b: 119, // #C95877 rose pink (user-tuned)
            text_r: 255,
            text_g: 255,
            text_b: 255, // white
            w: 240,
            h: 220,
            radius: 10.0,
            font_size: 14.0,
            bg_alpha: 0.9,
            text_alpha: 1.0,
        }
    }
}

/// "Agent notify" settings: a localhost HTTP endpoint that Claude Code / Codex
/// POST lifecycle events to (turn complete / approval needed / errors); the pet
/// overlay turns each into a bubble + pose. Decoupled from every other feature
/// and OFF by default. The whole section is `#[serde(default)]` on AppSettings,
/// so a legacy settings.json (which predates this feature) loads the defaults
/// below instead of wiping. Manual `Default` keeps a fresh install correct.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentNotifySettings {
    /// Master on/off. When false the receiver isn't started at all.
    #[serde(default)]
    pub enabled: bool,
    /// Localhost port the receiver binds (127.0.0.1 only).
    #[serde(default = "default_agent_notify_port")]
    pub port: u16,
    /// Optional shared secret; when set, callers must pass ?token=<this>.
    #[serde(default)]
    pub token: Option<String>,
    /// Surface "turn complete / idle" events.
    #[serde(default = "default_true")]
    pub on_done: bool,
    /// Surface "needs your approval" events.
    #[serde(default = "default_true")]
    pub on_needs: bool,
    /// Surface agent errors.
    #[serde(default = "default_true")]
    pub on_error: bool,
    /// Frontend per-kind cooldown (ms) so back-to-back turns don't spam bubbles.
    #[serde(default = "default_agent_notify_cooldown_ms")]
    pub cooldown_ms: u64,
    /// When true, the bubble includes a short content snippet (privacy trade-off).
    #[serde(default)]
    pub show_content: bool,
    /// When true, suppress notifications while a Bugzia window is focused (the
    /// user is already looking at the app, no need to grab attention).
    #[serde(default = "default_true")]
    pub only_unfocused: bool,
}

fn default_agent_notify_port() -> u16 {
    17890
}

fn default_agent_notify_cooldown_ms() -> u64 {
    8000
}

impl Default for AgentNotifySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: default_agent_notify_port(),
            token: None,
            on_done: true,
            on_needs: true,
            on_error: true,
            cooldown_ms: default_agent_notify_cooldown_ms(),
            show_content: false,
            only_unfocused: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub result: ResultAppearanceSettings,
    #[serde(default)]
    pub window: WindowSettings,
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default)]
    pub search: SearchSettings,
    #[serde(default)]
    pub system: SystemSettings,
    #[serde(default)]
    pub pet: PetSettings,
    #[serde(default)]
    pub waveform: WaveformSettings,
    #[serde(default)]
    pub note: NoteSettings,
    #[serde(default)]
    pub agent_notify: AgentNotifySettings,
    #[serde(default)]
    pub social_notify: SocialNotifySettings,
    #[serde(default)]
    pub hotkey: HotkeySettings,
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
    keyring_entry()?
        .set_password(&key)
        .map_err(|e| format!("set keyring: {e}"))
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pet_settings_default_is_sensible() {
        let p = PetSettings::default();
        assert!(p.enabled); // user-tuned default: pet on
        assert!(!p.always_on_top); // user-tuned default: not pinned
        assert!(!p.locked); // interactive by default
        assert!((p.scale - 1.0).abs() < 1e-6);
        assert_eq!(p.x, -1);
        assert_eq!(p.y, -1); // -1 sentinel = never placed
        assert!(!p.speech_lines.is_empty());
    }

    #[test]
    fn note_settings_default_is_rose_pink_white_text() {
        let n = NoteSettings::default();
        assert_eq!((n.bg_r, n.bg_g, n.bg_b), (201, 88, 119)); // #C95877
        assert_eq!((n.text_r, n.text_g, n.text_b), (255, 255, 255)); // white
        assert!(n.w > 0 && n.h > 0);
        assert!(n.radius > 0.0 && n.font_size > 0.0);
        assert!(n.bg_alpha > 0.0 && n.bg_alpha <= 1.0);
        assert!(n.text_alpha > 0.0 && n.text_alpha <= 1.0);
    }

    #[test]
    fn legacy_settings_without_pet_section_still_loads() {
        // A settings.json written before this feature lacks the `pet` section.
        // It MUST still deserialize (pet falls back to default) instead of
        // wiping the user's saved appearance/system.
        let legacy = serde_json::json!({
            "appearance": {
                "bg_r": 10, "bg_g": 20, "bg_b": 30, "bg_a": 0.5,
                "blur": 1.0, "radius": 2.0, "font_scale": 1.0
            },
            "system": { "autostart": false }
        });
        let parsed: AppSettings = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.appearance.bg_r, 10); // preserved
        assert!(!parsed.system.autostart); // preserved
        assert!(parsed.pet.enabled); // pet defaulted (user-tuned default: on)
        assert!(!parsed.pet.always_on_top); // user-tuned default: not pinned
    }

    /// Regression guard for the result-panel color-picker change: a legacy
    /// `settings.json` whose `result` section predates the `bg_r/g/b` fields
    /// must still deserialize — with bg defaulting to white (255), not failing
    /// and wiping the whole section via `unwrap_or_default`. The field-level
    /// `#[serde(default = "default_result_bg")]` is what makes this work; if
    /// someone removes it, this test fails and saves the user's tuning.
    #[test]
    fn legacy_result_without_bg_rgb_loads_white() {
        let json = r#"{
            "result": {
                "bg_a": 0.5,
                "radius": 20.0,
                "blur": 5.0,
                "font_scale": 1.2,
                "row_gap": 10.0,
                "item_radius": 7.0,
                "row_pad": 4.0,
                "hover_alpha": 0.6,
                "scrollbar_w": 10.0
            }
        }"#;
        let parsed: AppSettings = serde_json::from_str(json).unwrap();
        let r = parsed.result;
        // bg defaulted to white, not 0/black, not a full-section wipe:
        assert_eq!((r.bg_r, r.bg_g, r.bg_b), (255, 255, 255));
        // other fields preserved (proves it didn't fall back to Default::default,
        // which would have reset bg_a to 0.34 / scrollbar_w to 8.0):
        assert_eq!(r.bg_a, 0.5);
        assert_eq!(r.radius, 20.0);
        assert_eq!(r.scrollbar_w, 10.0);
    }

    /// Regression guard for the locked-card tint: a legacy settings.json whose
    /// `result` section predates the `locked_r/g/b` fields must still
    /// deserialize — with the tint defaulting to the current default coral
    /// (255,135,135), not failing and wiping the whole section. The field-level
    /// `#[serde(default = "default_locked_*")]` is what makes this work; remove
    /// it and this test fails, saving the user's other result-panel tuning.
    #[test]
    fn legacy_result_without_locked_tint_loads_default() {
        let json = r#"{
            "result": {
                "bg_r": 255, "bg_g": 255, "bg_b": 255, "bg_a": 0.34,
                "radius": 12.0, "blur": 18.0, "font_scale": 1.0,
                "row_gap": 6.0, "item_radius": 9.0, "row_pad": 6.0,
                "hover_alpha": 0.72, "scrollbar_w": 8.0
            }
        }"#;
        let parsed: AppSettings = serde_json::from_str(json).unwrap();
        let r = parsed.result;
        // tint defaulted to coral, not 0/black, not a full-section wipe:
        assert_eq!((r.locked_r, r.locked_g, r.locked_b), (255, 135, 135));
        // other fields preserved (proves it didn't fall back to Default::default
        // for the whole object — bg_a stays 0.34, not the struct's own 0.34 by
        // coincidence is indistinguishable, so check scrollbar_w == 8.0 too):
        assert_eq!(r.bg_a, 0.34);
        assert_eq!(r.scrollbar_w, 8.0);
    }

    /// Regression guard for the per-state history-card alpha + unlocked tint: a
    /// legacy settings.json whose `result` section predates `locked_a` and
    /// `unlocked_r/g/b/a` must still deserialize — with each new field defaulting
    /// to its former CSS-hardcoded value (locked_a 0.22, unlocked white @ 0.12),
    /// not failing and wiping the whole section. The field-level
    /// `#[serde(default = "default_*")]` is what makes this work; remove it and
    /// this test fails, saving the user's other result-panel tuning.
    #[test]
    fn legacy_result_without_history_card_colors_loads_default() {
        let json = r#"{
            "result": {
                "bg_r": 255, "bg_g": 255, "bg_b": 255, "bg_a": 0.34,
                "radius": 12.0, "blur": 18.0, "font_scale": 1.0,
                "row_gap": 6.0, "item_radius": 9.0, "row_pad": 6.0,
                "hover_alpha": 0.72, "scrollbar_w": 8.0,
                "locked_r": 10, "locked_g": 20, "locked_b": 30
            }
        }"#;
        let parsed: AppSettings = serde_json::from_str(json).unwrap();
        let r = parsed.result;
        // locked RGB preserved from the file (proves no section wipe):
        assert_eq!((r.locked_r, r.locked_g, r.locked_b), (10, 20, 30));
        // locked_a defaulted to 0.22 (the former CSS-hardcoded value):
        assert!((r.locked_a - 0.22).abs() < 1e-6);
        // unlocked tint defaulted to white @ 0.12 (former CSS-hardcoded values):
        assert_eq!((r.unlocked_r, r.unlocked_g, r.unlocked_b), (255, 255, 255));
        assert!((r.unlocked_a - 0.12).abs() < 1e-6);
        // other fields preserved:
        assert_eq!(r.scrollbar_w, 8.0);
    }

    /// Regression guard for the global hotkey settings: a legacy settings.json
    /// that predates the `hotkey` section must still deserialize — with summon
    /// defaulting to the working accelerator (alt+space), not failing and wiping
    /// the rest. The section-level `#[serde(default)]` is what makes this work;
    /// remove it and this test fails, saving the user's other tuning.
    #[test]
    fn legacy_settings_without_hotkey_section_loads_default() {
        let legacy = serde_json::json!({
            "system": { "autostart": true }
        });
        let parsed: AppSettings = serde_json::from_value(legacy).unwrap();
        assert!(parsed.system.autostart); // preserved
        assert_eq!(parsed.hotkey.summon, "alt+space"); // defaulted, not wiped
    }

    /// A settings.json whose `hotkey` section predates the `note` field must
    /// still load — `note` defaults to "alt+n" via its field-level
    /// `#[serde(default)]`, while the user's `summon` is preserved untouched.
    #[test]
    fn legacy_settings_with_hotkey_summon_only_loads_note_default() {
        let legacy = serde_json::json!({
            "hotkey": { "summon": "ctrl+k" }
        });
        let parsed: AppSettings = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.hotkey.summon, "ctrl+k"); // user value preserved
        assert_eq!(parsed.hotkey.note, "alt+n"); // new field defaulted, not wiped
    }

    /// A settings.json whose `hotkey` predates `note_create` / `note_destroy`
    /// must still load — both default to working bindings, while the user's
    /// `summon` / `note` are preserved untouched.
    #[test]
    fn legacy_settings_with_hotkey_summon_note_loads_create_destroy_defaults() {
        let legacy = serde_json::json!({
            "hotkey": { "summon": "ctrl+k", "note": "alt+n" }
        });
        let parsed: AppSettings = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.hotkey.summon, "ctrl+k"); // preserved
        assert_eq!(parsed.hotkey.note, "alt+n"); // preserved
        assert_eq!(parsed.hotkey.note_create, "alt+shift+c"); // new field defaulted
        assert_eq!(parsed.hotkey.note_destroy, "alt+z"); // new field defaulted
    }
}
