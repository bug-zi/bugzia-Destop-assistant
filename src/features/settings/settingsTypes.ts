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
  speech_lines: string[];
  /** -1 sentinel = never placed by the user. */
  x: number;
  y: number;
  w: number;
  h: number;
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
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  bg_r: 255,
  bg_g: 255,
  bg_b: 255,
  bg_a: 0.34,
  blur: 18,
  radius: 12,
  font_scale: 1,
};

export const DEFAULT_RESULT: ResultAppearanceSettings = {
  bg_r: 255,
  bg_g: 255,
  bg_b: 255,
  bg_a: 0.34,
  radius: 12,
  blur: 18,
  font_scale: 1,
  row_gap: 6,
  item_radius: 9,
  row_pad: 6,
  hover_alpha: 0.72,
  scrollbar_w: 8,
  locked_r: 255,
  locked_g: 222,
  locked_b: 120,
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
};

export const DEFAULT_AI: AiSettings = {
  provider_name: "",
  base_url: "",
  model: "",
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
  enabled: false,
  always_on_top: false,
  locked: false,
  opacity: 0.95,
  sensitivity: 1.0,
  petal_size: 14.0,
  petal_density: 60,
  drift_speed: 1.0,
  color_r: 255,
  color_g: 183,
  color_b: 197, // #FFB7C5 sakura pink
  accent_r: 255,
  accent_g: 255,
  accent_b: 255,
  x: -1, // sentinel: -1 = "never placed by user" -> default lower-center placement
  y: -1,
  w: 380,
  h: 200,
};

export const DEFAULT_PET: PetSettings = {
  enabled: false,
  always_on_top: true,
  locked: false,
  scale: 1,
  blink_interval_ms: 4000,
  speech_enabled: true,
  speech_interval_ms: 20000,
  speech_lines: ["哼，终于想起我了？", "今天也要优雅一点。", "别乱点，我在看着你。", "做得不错。", "再陪我一会儿。"],
  x: -1,
  y: -1,
  w: 210,
  h: 300,
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
}
