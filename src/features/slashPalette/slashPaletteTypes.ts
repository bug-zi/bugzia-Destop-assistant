import type { SlashPaletteItem } from "../search/command";

/**
 * Slash-command palette IPC contract. The palette is a MIRROR: main owns the
 * filtered list + highlighted index (keystrokes land there) and pushes state;
 * the palette window renders it and relays pointer interaction back. Namespaced
 * with `://` to match the project's other internal event channels.
 */

/** Main -> palette: the current filtered list + highlighted index. */
export const SLASHPALETTE_STATE = "slashpalette://state";
/** Palette -> main: the user clicked row `index` (Enter semantics). */
export const SLASHPALETTE_ACCEPT = "slashpalette://accept";
/** Palette -> main: the user hovered row `index` (move the highlight). */
export const SLASHPALETTE_HOVER = "slashpalette://hover";
/** Palette -> main: the palette window just mounted and is ready to render. */
export const SLASHPALETTE_READY = "slashpalette://ready";
/** Palette -> main: a navigation key (Arrow / Enter / Tab / Escape) pressed while
 *  the palette window held focus. Main applies the SAME logic as the input's
 *  keydown so the palette is never "stuck" if focus lands in it (focus is
 *  exclusive per window, so the input handler and this relay never double-fire). */
export const SLASHPALETTE_KEY = "slashpalette://key";

export interface SlashPaletteStatePayload {
  items: SlashPaletteItem[];
  index: number;
}

export interface SlashPaletteIndexPayload {
  index: number;
}

export interface SlashPaletteKeyPayload {
  key: "ArrowUp" | "ArrowDown" | "Enter" | "Tab" | "Escape";
}
