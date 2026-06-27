import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import SettingsPanel from "./SettingsPanel";
import { applyAppearanceVars } from "../features/appearance/appearance";
import { loadSettings } from "../features/settings/settingsStore";
import type { AppSettings } from "../features/settings/settingsTypes";

const SAVE_DEBOUNCE_MS = 400;

/**
 * Root of the settings popup window. Owns settings state, renders the unchanged
 * controlled <SettingsPanel>, and bridges it to the rest of the app:
 *  - applies appearance live to THIS window (sliders reflect immediately),
 *  - broadcasts `settings:updated` (debounced) so the main window — sole writer
 *    of settings.json — can merge it with its window bounds and persist,
 *  - closes this window on Esc / close button, flushing the last edit first.
 */
export default function SettingsWindow() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const patchTimer = useRef<number | null>(null);
  const settingsRef = useRef<AppSettings | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await loadSettings();
      if (!alive) return;
      settingsRef.current = s;
      setSettings(s);
      applyAppearanceVars(s.appearance);
    })();
    return () => {
      alive = false;
      if (patchTimer.current) clearTimeout(patchTimer.current);
    };
  }, []);

  function broadcast(next: AppSettings) {
    if (patchTimer.current) clearTimeout(patchTimer.current);
    patchTimer.current = window.setTimeout(() => {
      void emit("settings:updated", {
        appearance: next.appearance,
        result: next.result,
        ai: next.ai,
        search: next.search,
        windowLocked: next.window.locked,
        waveform: next.waveform,
        pet: next.pet,
        note: next.note,
        agent_notify: next.agent_notify,
        social_notify: next.social_notify,
        hotkey: next.hotkey,
      });
    }, SAVE_DEBOUNCE_MS);
  }

  function handleChange(next: AppSettings) {
    settingsRef.current = next;
    setSettings(next);
    applyAppearanceVars(next.appearance);
    broadcast(next);
  }

  function flushAndClose() {
    const cur = settingsRef.current;
    if (patchTimer.current && cur) {
      clearTimeout(patchTimer.current);
      patchTimer.current = null;
      void emit("settings:updated", {
        appearance: cur.appearance,
        result: cur.result,
        ai: cur.ai,
        search: cur.search,
        windowLocked: cur.window.locked,
        waveform: cur.waveform,
        pet: cur.pet,
        note: cur.note,
        agent_notify: cur.agent_notify,
        social_notify: cur.social_notify,
        hotkey: cur.hotkey,
      });
    }
    getCurrentWindow().close().catch((e) => console.error("[bugzia] close settings", e));
  }

  // Esc closes the settings window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        flushAndClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!settings) return null;
  return <SettingsPanel settings={settings} onChange={handleChange} onClose={flushAndClose} />;
}
