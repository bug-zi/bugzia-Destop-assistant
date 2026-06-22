import { useEffect, useState } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { loadSettings } from "../features/settings/settingsStore";
import { applyAppearanceVars } from "../features/appearance/appearance";
import {
  SLASHPALETTE_ACCEPT,
  SLASHPALETTE_HOVER,
  SLASHPALETTE_KEY,
  SLASHPALETTE_READY,
  SLASHPALETTE_STATE,
  type SlashPaletteStatePayload,
} from "../features/slashPalette/slashPaletteTypes";
import type { SlashPaletteItem } from "../features/search/command";
import "./SlashPaletteWindow.css";

/**
 * Slash-command palette overlay. A pure MIRROR of the main window: it renders
 * the filtered list + highlighted index pushed by main, and relays click /
 * hover back. Owns no filtering state of its own — main is the single source of
 * truth (same pattern as the result window). Runs in the `slashpalette` window
 * context; it never calls setPosition / setSize (those run in main).
 */
export default function SlashPaletteWindow() {
  const [items, setItems] = useState<SlashPaletteItem[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let alive = true;
    const offs: UnlistenFn[] = [];
    (async () => {
      // Match the main bar's customized glass appearance so the palette fits in.
      try {
        const s = await loadSettings();
        if (alive) applyAppearanceVars(s.appearance);
      } catch (e) {
        console.error("[bugzia] slashpalette load appearance", e);
      }
      if (!alive) return;

      offs.push(
        await listen<SlashPaletteStatePayload>(SLASHPALETTE_STATE, (ev) => {
          setItems(ev.payload.items);
          setIndex(ev.payload.index);
        }),
      );
      // Tell main we are ready to render; main re-emits the current state. Covers
      // the boot race where the first push landed before this listener attached.
      void emit(SLASHPALETTE_READY, {}).catch(() => {});
    })();
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  }, []);

  // Relay navigation keys to main. If focus ever lands in this window (its
  // buttons are focusable), Arrow / Enter / Tab / Escape would otherwise do
  // nothing or trap Tab between rows — main applies the same logic the bar's
  // input does, so the palette is never stuck. Focus is exclusive per window,
  // so this never double-fires with the input's own handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "ArrowUp" || k === "ArrowDown" || k === "Enter" || k === "Tab" || k === "Escape") {
        e.preventDefault();
        void emit(SLASHPALETTE_KEY, { key: k }).catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="slash-palette" role="listbox" aria-label="斜杠命令">
      {items.map((it, i) => (
        <button
          key={it.trigger}
          type="button"
          className={`slash-palette-row${i === index ? " active" : ""}`}
          role="option"
          aria-selected={i === index}
          tabIndex={-1}
          onMouseEnter={() => {
            if (i !== index) void emit(SLASHPALETTE_HOVER, { index: i }).catch(() => {});
          }}
          onClick={() => {
            void emit(SLASHPALETTE_ACCEPT, { index: i }).catch(() => {});
          }}
          title={it.description}
        >
          <span className="slash-palette-trigger">{it.trigger}</span>
          <span className="slash-palette-desc">{it.description}</span>
        </button>
      ))}
    </div>
  );
}
