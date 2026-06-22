/**
 * Slash-command palette overlay window lifecycle — MUST run in the MAIN window
 * context. Same ACL rule as resultWindow.ts: only `main` (capabilities/
 * default.json) may setPosition / setSize / create webview windows, so the calls
 * below execute here.
 *
 * The palette is a pure MIRROR: the main window's InputBar owns the filtered
 * list + highlighted index (it is where the keystrokes land), and this window
 * only renders what main emits via `slashpalette://state`. Click / hover in the
 * palette are relayed back to main as `accept` / `hover` so main stays the sole
 * source of truth (same pattern as the result overlay).
 *
 * Geometry is NOT persisted: the palette is ephemeral and always tracks the bar
 * (placed just above it, falling back to below). Height shrinks/grows with the
 * item count so the transparent window never shows empty space. It is created
 * with `visible:false` then positioned before reveal (no flash), and shown
 * WITHOUT stealing focus — the user keeps typing in the bar.
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  SLASHPALETTE_ACCEPT,
  SLASHPALETTE_HOVER,
  SLASHPALETTE_KEY,
  SLASHPALETTE_READY,
  SLASHPALETTE_STATE,
  type SlashPaletteIndexPayload,
  type SlashPaletteKeyPayload,
  type SlashPaletteStatePayload,
} from "./slashPaletteTypes";
import type { SlashPaletteItem } from "../search/command";

const LABEL = "slashpalette";
const ROW_H = 44;
const PAD_Y = 12;
const MIN_H = 56;
const MAX_H = 340;
const GAP = 6;
const MIN_W = 360;

/** Get-or-create the palette window (hidden). Awaits creation so callers can
 *  position it. Idempotent — repeated calls reuse the hidden window. */
export async function ensureSlashPaletteWindow(): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) return existing;

  const win = new WebviewWindow(LABEL, {
    title: "Bugzia 命令",
    width: 420,
    height: MIN_H,
    minWidth: MIN_W,
    resizable: false,
    decorations: false,
    transparent: true,
    shadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    visible: false, // positioned before reveal — no flash
    center: false, // tracks the bar, never centered
  });

  await new Promise<void>((resolve, reject) => {
    win.once("tauri://created", () => resolve());
    win.once("tauri://error", (e) =>
      reject(new Error("slashpalette window creation failed: " + String(e))),
    );
  });
  return win;
}

/** Place the palette just above the bar (falling back to below when above won't
 *  fit), sized to exactly fit `itemCount` rows, then reveal. Does NOT call
 *  setFocus so the bar keeps keyboard focus. All math in LOGICAL pixels. */
export async function showSlashPaletteWindow(itemCount: number): Promise<void> {
  const palette = await ensureSlashPaletteWindow();
  const main = getCurrentWindow();
  const sf = await main.scaleFactor();
  const mPos = await main.outerPosition();
  const mSize = await main.outerSize();
  const mx = mPos.x / sf;
  const my = mPos.y / sf;
  const mw = mSize.width / sf;
  const mh = mSize.height / sf;

  const mon = await currentMonitor();
  const waX = mon ? mon.position.x / sf : 0;
  const waY = mon ? mon.position.y / sf : 0;
  const waW = mon ? mon.size.width / sf : mw;
  const waH = mon ? mon.size.height / sf : mh;

  const w = Math.max(MIN_W, Math.round(mw));
  const h = Math.min(MAX_H, Math.max(MIN_H, itemCount * ROW_H + PAD_Y * 2));

  const aboveY = my - h - GAP;
  const belowY = my + mh + GAP;
  const fitsAbove = aboveY >= waY;
  const fitsBelow = belowY + h <= waY + waH;
  // Prefer ABOVE (so it reads like a dropdown from the bar); fall back to below.
  let y = fitsAbove ? aboveY : fitsBelow ? belowY : aboveY;
  let x = mx;
  if (x + w > waX + waW) x = waX + waW - w;
  if (x < waX) x = waX;
  if (y < waY) y = waY;

  try {
    await palette.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
    await palette.setSize(new LogicalSize(w, h));
    await palette.show();
    // Intentionally no setFocus: the bar must keep focus so typing continues.
  } catch (e) {
    console.error("[bugzia] show slashpalette window", e);
  }
}

/** Hide (not destroy) the palette window. State is re-pushed on next show. */
export async function hideSlashPaletteWindow(): Promise<void> {
  const palette = await WebviewWindow.getByLabel(LABEL);
  if (!palette) return;
  try {
    await palette.hide();
  } catch (e) {
    console.error("[bugzia] hide slashpalette window", e);
  }
}

/** Main -> palette: push the current filtered list + highlighted index. */
export function emitSlashPaletteState(items: SlashPaletteItem[], index: number): void {
  const payload: SlashPaletteStatePayload = { items, index };
  void emit(SLASHPALETTE_STATE, payload).catch(() => {});
}

/** Palette -> main: register the row the user clicked (Enter semantics). */
export function onSlashPaletteAccept(cb: (index: number) => void): Promise<UnlistenFn> {
  return listen<SlashPaletteIndexPayload>(SLASHPALETTE_ACCEPT, (ev) => cb(ev.payload.index));
}

/** Palette -> main: register the row the user hovered (move the highlight). */
export function onSlashPaletteHover(cb: (index: number) => void): Promise<UnlistenFn> {
  return listen<SlashPaletteIndexPayload>(SLASHPALETTE_HOVER, (ev) => cb(ev.payload.index));
}

/** Palette -> main: the palette mounted and is ready to render — main replies by
 *  re-emitting the current state (covers the race where the first state push
 *  landed before the palette's listener was attached, same handshake the result
 *  window uses). */
export function onSlashPaletteReady(cb: () => void): Promise<UnlistenFn> {
  return listen(SLASHPALETTE_READY, () => cb());
}

/** Palette -> main: relay a navigation key pressed while focus was in the palette
 *  window. Lets the user navigate / accept / dismiss even if focus left the bar
 *  (the input handler in main covers the case where focus stayed in the bar). */
export function onSlashPaletteKey(
  cb: (key: SlashPaletteKeyPayload["key"]) => void,
): Promise<UnlistenFn> {
  return listen<SlashPaletteKeyPayload>(SLASHPALETTE_KEY, (ev) => cb(ev.payload.key));
}
