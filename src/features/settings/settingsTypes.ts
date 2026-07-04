/**
 * Frontend mirror of the Rust `AppSettings` model (src-tauri/src/settings.rs).
 * Field names MUST match the serde JSON keys exactly.
 *
 * Window bounds are LOGICAL pixels (consistent with LogicalSize/LogicalPosition).
 */

export interface AppearanceSettings {
  bg_r: number;
  bg_g: number;
  bg_b: number;
  /** 0..1 */
  bg_a: number;
  /** backdrop blur in px */
  blur: number;
  /** corner radius in px */
  radius: number;
  /** font scale multiplier, 1.0 = default */
  font_scale: number;
}

/**
 * Result-overlay panel appearance (ResultWindow). INDEPENDENT of the global
 * glass theme: the overlay can have its own transparency / radius / blur /
 * font scale, plus list & bubble typography tweaks (row gap, item radius, row
 * padding, hover highlight, scrollbar width).
 *
 * Frontend mirror of the Rust `ResultAppearanceSettings` (settings.rs); field
 * names MUST match the serde JSON keys exactly.
 */
export interface ResultAppearanceSettings {
  /** Overlay background red (independent of the global card color). */
  bg_r: number;
  /** Overlay background green. */
  bg_g: number;
  /** Overlay background blue. */
  bg_b: number;
  /** 0..1, overlay background alpha (overrides the global bg_a on the overlay) */
  bg_a: number;
  /** overlay corner radius in px */
  radius: number;
  /** overlay backdrop blur in px */
  blur: number;
  /** result-area font scale; scoped via .result-card so it stays isolated
   *  from the input bar's global font scale. 1.0 = default */
  font_scale: number;
  /** list / chat-bubble row gap in px */
  row_gap: number;
  /** list row / chat bubble corner radius in px */
  item_radius: number;
  /** file-row inner padding in px (horizontal padding tracks this + 2px) */
  row_pad: number;
  /** 0..1, file-row hover highlight alpha */
  hover_alpha: number;
  /** scrollbar width in px */
  scrollbar_w: number;
  /** Locked conversation-card tint R/G/B (history rail `.is-locked`). */
  locked_r: number;
  locked_g: number;
  locked_b: number;
  /** 0..1, locked-card overlay alpha (history rail `.is-locked`). */
  locked_a: number;
  /** Unlocked conversation-card tint R/G/B (history rail `.history-item`). */
  unlocked_r: number;
  unlocked_g: number;
  unlocked_b: number;
  /** 0..1, unlocked-card overlay alpha (history rail `.history-item`). */
  unlocked_a: number;
}

export interface WindowSettings {
  x: number;
  y: number;
  w: number;
  h: number;
  expanded: boolean;
  locked: boolean;
  /** result overlay window height, LOGICAL px (persisted across restarts) */
  result_h: number;
  /** result overlay window X, LOGICAL px. -1 = never placed by user (default above bar). */
  result_x: number;
  /** result overlay window Y, LOGICAL px. -1 = never placed by user. */
  result_y: number;
  /** result overlay window width, LOGICAL px. 0 = never resized (tracks bar width). */
  result_w: number;
  /** settings popup X, LOGICAL px. */
  settings_x: number;
  /** settings popup Y, LOGICAL px. */
  settings_y: number;
  /** settings popup width, LOGICAL px. */
  settings_w: number;
  /** settings popup height, LOGICAL px. */
  settings_h: number;
}

export interface AiSettings {
  provider_name: string;
  base_url: string;
  model: string;
  system_prompt: string;
  temperature: number;
  stream: boolean;
}

export interface SearchSettings {
  default_engine: string;
  custom_engine_url: string;
  /** Extra directories scanned by `/file` (Desktop/Documents/Downloads always scanned). */
  index_dirs: string[];
  /** Directory-name segments pruned from the walk (compared against the final segment). */
  ignore_dirs: string[];
  /** Max results returned by `search_files`. */
  max_results: number;
}

export interface SystemSettings {
  /** User intent for launch-on-boot (synced to the OS autostart; toggled from tray). */
  autostart: boolean;
}

/**
 * Global hotkey settings for the input bar. `summon` shows + focuses the bar and
 * hides it again when already visible (toggle) — one key both summons and
 * dismisses it. A Tauri accelerator string such as "alt+space". Frontend mirror
 * of Rust `HotkeySettings` (src-tauri/src/settings.rs); field names MUST match
 * the serde JSON keys exactly.
 */
export interface HotkeySettings {
  /** Accelerator to summon the input bar; toggles (hides) when already visible. */
  summon: string;
  /** Accelerator to toggle all notes: hide if any visible, else show; spawns a
   *  blank note when none exist. Empty = disabled. */
  note: string;
  /** Accelerator to ALWAYS spawn a fresh blank note, even when notes already
   *  exist (unlike `note`, which toggles the set). Empty = disabled (default). */
  note_create: string;
  /** Accelerator to destroy the currently-focused note. Empty = disabled
   *  (default); no note focused = no-op. */
  note_destroy: string;
}

/**
 * Desktop waveform visualizer settings. The overlay floats on the desktop and
 * dances to whatever the system is playing (captured via WASAPI loopback on the
 * Rust side). Frontend mirror of the Rust `WaveformSettings` (settings.rs);
 * field names MUST match the serde JSON keys exactly. Geometry is LOGICAL px;
 * `x/y = -1` is the "never placed by the user" sentinel -> default placement.
 */
export interface WaveformSettings {
  /** Master on/off for the overlay + audio capture. */
  enabled: boolean;
  /** Pin above all other windows while playing. */
  always_on_top: boolean;
  /** Lock = mouse click-through (overlay stops intercepting desktop clicks). */
  locked: boolean;
  /** 0..1 overlay opacity. */
  opacity: number;
  /** Loudness gain applied in the frontend (quiet passages can still move). */
  sensitivity: number;
  /** Base petal size in px. */
  petal_size: number;
  /** Max concurrent petals on screen. */
  petal_density: number;
  /** Fall-speed multiplier. */
  drift_speed: number;
  /** Primary petal color (default sakura pink #FFB7C5). */
  color_r: number;
  color_g: number;
  color_b: number;
  /** Highlight / water-line color (default white). */
  accent_r: number;
  accent_g: number;
  accent_b: number;
  /** Overlay window position in LOGICAL px. `-1` sentinel = never placed by the
   *  user; show then uses the default (lower-center) placement instead. */
  x: number;
  y: number;
  /** Overlay window size in LOGICAL px. */
  w: number;
  h: number;
}

/**
 * Desktop pet companion settings. Frontend mirror of Rust `PetSettings`
 * (src-tauri/src/settings.rs); field names MUST match the serde JSON keys exactly.
 *
 * Self-contained overlay: idles (blink), looks toward the cursor, reacts to a
 * click (petted + speech bubble), can be dragged. No audio / system events.
 * x/y of -1 = never placed by the user (show defaults to lower-right).
 */
export interface PetSettings {
  enabled: boolean;
  always_on_top: boolean;
  locked: boolean;
  /** Sprite scale multiplier, 1 = native image size. */
  scale: number;
  blink_interval_ms: number;
  speech_enabled: boolean;
  speech_interval_ms: number;
  ai_speech_enabled: boolean;
  ai_idle_interval_ms: number;
  ai_interaction_interval_ms: number;
  chat_enabled: boolean;
  debug_panel: boolean;
  speech_lines: string[];
  /** -1 sentinel = never placed by the user. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Desktop sticky-note DEFAULTS (the `/note <content>` feature). Frontend mirror
 * of Rust `NoteSettings` (src-tauri/src/settings.rs); field names MUST match the
 * serde JSON keys exactly. These are style/size defaults applied to a freshly
 * created note; per-instance content + geometry of PINNED notes lives in
 * notes.json (user data), not here.
 */
export interface NoteSettings {
  /** Note background color (default sakura deep red #9E1B32). */
  bg_r: number;
  bg_g: number;
  bg_b: number;
  /** Note text color (default white). */
  text_r: number;
  text_g: number;
  text_b: number;
  /** Default note width, LOGICAL px. */
  w: number;
  /** Default note height, LOGICAL px. */
  h: number;
  /** Corner radius in px. */
  radius: number;
  /** Font size in px. */
  font_size: number;
  /** 0..1 BACKGROUND fill opacity (the note's translucent backing, independent
   *  of text so the body can be see-through while text stays crisp). */
  bg_alpha: number;
  /** 0..1 TEXT opacity (body text + textarea; independent of background). */
  text_alpha: number;
}

/**
 * "Agent notify" settings. Frontend mirror of Rust `AgentNotifySettings`
 * (src-tauri/src/settings.rs); field names MUST match the serde JSON keys
 * exactly. A localhost HTTP endpoint that Claude Code / Codex POST lifecycle
 * events to (turn complete / approval needed / errors); the pet overlay turns
 * each into a bubble + pose. OFF by default.
 */
export interface AgentNotifySettings {
  /** Master on/off. When false the receiver isn't started at all. */
  enabled: boolean;
  /** Localhost port the receiver binds (127.0.0.1 only). */
  port: number;
  /** Optional shared secret; when set, callers must pass ?token=<this>. */
  token: string | null;
  /** Surface "turn complete / idle" events. */
  on_done: boolean;
  /** Surface "needs your approval" events. */
  on_needs: boolean;
  /** Surface agent errors. */
  on_error: boolean;
  /** Frontend per-kind cooldown (ms) so back-to-back turns don't spam bubbles. */
  cooldown_ms: number;
  /** When true, the bubble includes a short content snippet (privacy trade-off). */
  show_content: boolean;
  /** When true, suppress notifications while a Bugzia window is focused. */
  only_unfocused: boolean;
}

export interface SocialNotifySettings {
  /** Master on/off for Windows notification-center monitoring. */
  enabled: boolean;
  wechat: boolean;
  qq: boolean;
  dingtalk: boolean;
  /** Backend cooldown (ms) between surfaced social notifications. */
  cooldown_ms: number;
  /** Include notification text from Windows notification center. */
  show_content: boolean;
}

export interface DailySettings {
  /** Morning digest: news + quote + trivia. */
  push_enabled: boolean;
  /** Local HH:mm time for the digest. */
  push_time: string;
  push_news: boolean;
  push_quote: boolean;
  push_trivia: boolean;
  /** Nightly review of today's recorded activity. */
  review_enabled: boolean;
  /** Local HH:mm time for the review. */
  review_time: string;
}

export interface AppSettings {
  appearance: AppearanceSettings;
  result: ResultAppearanceSettings;
  window: WindowSettings;
  ai: AiSettings;
  search: SearchSettings;
  system: SystemSettings;
  waveform: WaveformSettings;
  pet: PetSettings;
  note: NoteSettings;
  agent_notify: AgentNotifySettings;
  social_notify: SocialNotifySettings;
  daily: DailySettings;
  hotkey: HotkeySettings;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  bg_r: 254,
  bg_g: 210,
  bg_b: 210,
  bg_a: 0.11,
  blur: 40,
  radius: 12,
  font_scale: 1,
};

export const DEFAULT_RESULT: ResultAppearanceSettings = {
  bg_r: 255,
  bg_g: 255,
  bg_b: 255,
  bg_a: 0.11,
  radius: 12,
  blur: 18,
  font_scale: 1,
  row_gap: 6,
  item_radius: 9,
  row_pad: 6,
  hover_alpha: 0.72,
  scrollbar_w: 8,
  locked_r: 255,
  locked_g: 135,
  locked_b: 135,
  locked_a: 0.22,
  unlocked_r: 255,
  unlocked_g: 255,
  unlocked_b: 255,
  unlocked_a: 0.12,
};

export const DEFAULT_WINDOW: WindowSettings = {
  x: 0,
  y: 0,
  w: 0, // sentinel: 0 = "never positioned, skip restore"
  h: 0,
  expanded: false,
  locked: false,
  result_h: 360,
  result_x: -1, // sentinel: -1 = "never placed by user" -> default above the bar
  result_y: -1,
  result_w: 0, // sentinel: 0 = "never resized" -> track the bar width
  settings_x: 245,
  settings_y: 25,
  settings_w: 1063,
  settings_h: 657,
};

export const DEFAULT_AI: AiSettings = {
  provider_name: "vibe",
  base_url: "https://token.aiedulab.cn/v1",
  model: "gpt-5.5",
  system_prompt: "",
  temperature: 0.7,
  stream: true,
};

export const DEFAULT_SEARCH: SearchSettings = {
  default_engine: "google",
  custom_engine_url: "",
  index_dirs: [],
  ignore_dirs: [],
  max_results: 50,
};

export const DEFAULT_SYSTEM: SystemSettings = {
  autostart: true,
};

export const DEFAULT_WAVEFORM: WaveformSettings = {
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
  x: -1, // sentinel: -1 = "never placed by user" -> default lower-center placement
  y: -1,
  w: 380,
  h: 200,
};

export const DEFAULT_PET: PetSettings = {
  enabled: true,
  always_on_top: false,
  locked: false,
  scale: 1,
  blink_interval_ms: 4000,
  speech_enabled: true,
  speech_interval_ms: 12000,
  ai_speech_enabled: true,
  ai_idle_interval_ms: 60000,
  ai_interaction_interval_ms: 12000,
  chat_enabled: true,
  debug_panel: false,
  speech_lines: ["哼，终于想起我了？", "今天也要优雅一点。", "别乱点，我在看着你。", "做得不错。", "再陪我一会儿。"],
  x: -1,
  y: -1,
  w: 230,
  h: 300,
};

export const DEFAULT_NOTE: NoteSettings = {
  bg_r: 201,
  bg_g: 88,
  bg_b: 119, // #C95877 rose pink (user-tuned)
  text_r: 255,
  text_g: 255,
  text_b: 255, // white
  w: 240,
  h: 220,
  radius: 10,
  font_size: 14,
  bg_alpha: 0.9,
  text_alpha: 1.0,
};

export const DEFAULT_AGENT_NOTIFY: AgentNotifySettings = {
  enabled: false,
  port: 17890,
  token: null,
  on_done: true,
  on_needs: true,
  on_error: true,
  cooldown_ms: 8000,
  show_content: false,
  only_unfocused: true,
};

export const DEFAULT_SOCIAL_NOTIFY: SocialNotifySettings = {
  enabled: false,
  wechat: true,
  qq: true,
  dingtalk: true,
  cooldown_ms: 5000,
  show_content: false,
};

export const DEFAULT_DAILY: DailySettings = {
  push_enabled: true,
  push_time: "09:00",
  push_news: true,
  push_quote: true,
  push_trivia: true,
  review_enabled: true,
  review_time: "23:00",
};

export const DEFAULT_HOTKEY: HotkeySettings = {
  summon: "alt+space", // 召唤键；已显示时再按一次即隐藏（切换）
  note: "alt+n", // 便签键；有便签显示则收起，否则呼出，一条都没有则新建空白便签
  note_create: "alt+shift+c", // 直接新建便签键；留空=未启用，由用户在设置里自定义
  note_destroy: "alt+z", // 销毁当前便签键；留空=未启用，由用户在设置里自定义
};

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: DEFAULT_APPEARANCE,
  result: DEFAULT_RESULT,
  window: DEFAULT_WINDOW,
  ai: DEFAULT_AI,
  search: DEFAULT_SEARCH,
  system: DEFAULT_SYSTEM,
  waveform: DEFAULT_WAVEFORM,
  pet: DEFAULT_PET,
  note: DEFAULT_NOTE,
  agent_notify: DEFAULT_AGENT_NOTIFY,
  social_notify: DEFAULT_SOCIAL_NOTIFY,
  daily: DEFAULT_DAILY,
  hotkey: DEFAULT_HOTKEY,
};

/**
 * Patch broadcast by the settings window via the `settings:updated` event.
 * The main window is the sole writer of settings.json, so the settings window
 * only emits the sections it owns; main merges them with its authoritative
 * window bounds. Window bounds are deliberately omitted (no clobbering).
 */
export interface SettingsPatch {
  appearance: AppearanceSettings;
  result: ResultAppearanceSettings;
  ai: AiSettings;
  search: SearchSettings;
  windowLocked: boolean;
  waveform: WaveformSettings;
  pet: PetSettings;
  note: NoteSettings;
  agent_notify: AgentNotifySettings;
  social_notify: SocialNotifySettings;
  daily: DailySettings;
  hotkey: HotkeySettings;
}
