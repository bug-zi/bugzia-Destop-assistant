import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS, type AppSettings } from "./settingsTypes";

/** Load persisted settings. Falls back to defaults on any failure. */
export async function loadSettings(): Promise<AppSettings> {
  try {
    const s = await invoke<AppSettings>("load_settings");
    // Merge defensively so a partial/older file can't drop required keys.
    return {
      appearance: { ...DEFAULT_SETTINGS.appearance, ...s.appearance },
      result: { ...DEFAULT_SETTINGS.result, ...s.result },
      window: { ...DEFAULT_SETTINGS.window, ...s.window },
      ai: { ...DEFAULT_SETTINGS.ai, ...s.ai },
      search: { ...DEFAULT_SETTINGS.search, ...s.search },
      system: { ...DEFAULT_SETTINGS.system, ...s.system },
      waveform: { ...DEFAULT_SETTINGS.waveform, ...s.waveform },
      pet: { ...DEFAULT_SETTINGS.pet, ...s.pet },
      note: { ...DEFAULT_SETTINGS.note, ...s.note },
      agent_notify: { ...DEFAULT_SETTINGS.agent_notify, ...s.agent_notify },
    };
  } catch (e) {
    console.error("[bugzia] load_settings failed", e);
    return DEFAULT_SETTINGS;
  }
}

/** Persist the full settings object (atomic write on the Rust side). */
export async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    await invoke("save_settings", { settings });
  } catch (e) {
    console.error("[bugzia] save_settings failed", e);
  }
}

/** Read the API key from the OS keyring. null when none stored. */
export async function loadApiKey(): Promise<string | null> {
  try {
    return await invoke<string | null>("load_api_key");
  } catch (e) {
    console.error("[bugzia] load_api_key failed", e);
    return null;
  }
}

/** Write (or clear, when empty) the API key in the OS keyring. */
export async function saveApiKey(key: string): Promise<boolean> {
  try {
    await invoke("save_api_key", { key });
    return true;
  } catch (e) {
    console.error("[bugzia] save_api_key failed", e);
    return false;
  }
}

/** Remove the API key from the OS keyring. */
export async function clearApiKey(): Promise<void> {
  try {
    await invoke("clear_api_key");
  } catch (e) {
    console.error("[bugzia] clear_api_key failed", e);
  }
}

/** Result of a one-shot AI connection probe (mirrors `TestResult` in ai.rs). */
export interface TestResult {
  ok: boolean;
  model: string;
  reply: string;
  message: string;
}

/**
 * One-shot connectivity probe for the AI settings form. Tests the live
 * BaseURL / Model / API Key without needing to save first.
 */
export async function testAiConnection(
  baseUrl: string,
  model: string,
  key: string,
): Promise<TestResult> {
  try {
    return await invoke<TestResult>("test_ai_connection", { baseUrl, model, key });
  } catch (e) {
    console.error("[bugzia] test_ai_connection failed", e);
    return { ok: false, model: "", reply: "", message: String(e) };
  }
}
