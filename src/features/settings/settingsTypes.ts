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

export interface AppSettings {
  appearance: AppearanceSettings;
  window: WindowSettings;
  ai: AiSettings;
  search: SearchSettings;
  system: SystemSettings;
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

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: DEFAULT_APPEARANCE,
  window: DEFAULT_WINDOW,
  ai: DEFAULT_AI,
  search: DEFAULT_SEARCH,
  system: DEFAULT_SYSTEM,
};

/**
 * Patch broadcast by the settings window via the `settings:updated` event.
 * The main window is the sole writer of settings.json, so the settings window
 * only emits the sections it owns; main merges them with its authoritative
 * window bounds. Window bounds are deliberately omitted (no clobbering).
 */
export interface SettingsPatch {
  appearance: AppearanceSettings;
  ai: AiSettings;
  search: SearchSettings;
  windowLocked: boolean;
}
