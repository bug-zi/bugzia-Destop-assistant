/**
 * Desktop-waveform overlay window lifecycle — MUST run in the MAIN window
 * context (main is the sole settings.json writer, and the move/resize listeners
 * are ACL-checked against the caller = main). Mirrors resultWindow.ts /
 * lyricsWindow.ts: get-or-create the overlay, restore or default its placement,
 * and report user moves/resizes back to main for persistence.
 *
 * Lifecycle is create-once-then-hide: the window is hidden, not destroyed, so
 * its React state (the canvas renderer + audio level ref) survives close/reopen
 * and reopening is instant. Created with `visible:false` then positioned + shown
 * to avoid a flash at a default location.
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";

const LABEL = "waveform";
const DEFAULT_W = 380;
const DEFAULT_H = 200;
const MIN_W = 200;
const MIN_H = 120;

/** Saved overlay geometry (LOGICAL px) handed to `showWaveformWindow`. */
export interface WaveformGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A partial geometry update emitted on a user move/resize (LOGICAL px). */
export type WaveformGeomPatch = Partial<WaveformGeom>;

let geomCb: ((patch: WaveformGeomPatch) => void) | null = null;
let geomAttached = false;
/** Suppress geometry persistence while WE move/resize the window on show, so a
 *  programmatic placement isn't mistaken for a user placement (which would pin
 *  the overlay to the default spot forever). */
let suppressGeomPersist = false;

/**
 * Register the callback fired with the waveform window's LOGICAL geometry
 * whenever the USER moves or resizes it. Wired by the main window so it can
 * persist waveform.x/y/w/h (main is the sole settings.json writer). The listener
 * attaches lazily — the first time the window exists — so registration order
 * (this at main mount, window created later) is free.
 */
export function onWaveformGeometryChange(cb: (patch: WaveformGeomPatch) => void): void {
  geomCb = cb;
}

/** Attach move + resize listeners once per app lifetime. ACL: `onMoved` /
 *  `onResized` / `scaleFactor` are checked against the CALLER (main,
 *  `core:default`), not the waveform window. */
function attachGeometryIfNeeded(win: WebviewWindow): void {
  if (geomAttached) return;
  geomAttached = true;

  win.onResized(async ({ payload }) => {
    if (suppressGeomPersist || !geomCb) return;
    try {
      const sf = await win.scaleFactor();
      geomCb({ w: Math.round(payload.width / sf), h: Math.round(payload.height / sf) });
    } catch {
      geomAttached = false;
    }
  }).catch(() => {
    geomAttached = false;
  });

  win.onMoved(async ({ payload }) => {
    if (suppressGeomPersist || !geomCb) return;
    try {
      const sf = await win.scaleFactor();
      geomCb({ x: Math.round(payload.x / sf), y: Math.round(payload.y / sf) });
    } catch {
      geomAttached = false;
    }
  }).catch(() => {
    geomAttached = false;
  });
}

/** Get-or-create the waveform window. Awaits creation so callers can position it. */
export async function ensureWaveformWindow(): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    attachGeometryIfNeeded(existing);
    return existing;
  }

  const win = new WebviewWindow(LABEL, {
    title: "Bugzia 波形",
    width: DEFAULT_W,
    height: DEFAULT_H,
    minWidth: MIN_W,
    minHeight: MIN_H,
    resizable: true,
    decorations: false,
    transparent: true,
    shadow: false,
    skipTaskbar: true,
    visible: false, // positioned before reveal — no flash
    center: false,
  });

  await new Promise<void>((resolve, reject) => {
    win.once("tauri://created", () => resolve());
    win.once("tauri://error", (e) =>
      reject(new Error("waveform window creation failed: " + String(e))),
    );
  });

  attachGeometryIfNeeded(win);
  return win;
}

/**
 * Default placement: horizontally centered, sitting just above the taskbar.
 * All math in LOGICAL pixels. Used only when the user has not yet placed the
 * overlay themselves (no saved waveform.x/y, or the -1 sentinel).
 */
async function defaultPlacement(): Promise<void> {
  const main = getCurrentWindow();
  const wf = (await WebviewWindow.getByLabel(LABEL)) ?? (await ensureWaveformWindow());
  const sf = await main.scaleFactor();
  const mon = await currentMonitor();
  const waW = mon ? mon.size.width / sf : DEFAULT_W;
  const waH = mon ? mon.size.height / sf : DEFAULT_H * 4;
  const w = DEFAULT_W;
  const h = DEFAULT_H;
  const x = Math.round((waW - w) / 2);
  const y = Math.round(waH - h - 80); // ~80 px above the taskbar
  suppressGeomPersist = true;
  try {
    await wf.setPosition(new LogicalPosition(x, y));
    await wf.setSize(new LogicalSize(w, h));
  } finally {
    // Move/resize events from our own setPosition/setSize land asynchronously;
    // stay suppressed briefly so they aren't persisted as a "user placement".
    setTimeout(() => {
      suppressGeomPersist = false;
    }, 60);
  }
}

/** Ensure + place + reveal. If `saved` carries a user placement (x >= 0),
 *  restore that exact position + size; otherwise default to centered lower-area.
 *  Pin / click-through are applied separately from main via backend commands
 *  (see waveform_set_always_on_top / waveform_set_locked), so this only owns
 *  geometry — that ordering guarantees the window exists before those run. */
export async function showWaveformWindow(saved?: WaveformGeom): Promise<void> {
  const wf = await ensureWaveformWindow();
  if (saved && saved.x >= 0 && saved.y >= 0) {
    // User has placed the overlay before: restore their exact spot + size.
    const w = Math.max(MIN_W, saved.w || DEFAULT_W);
    const h = Math.max(MIN_H, saved.h || DEFAULT_H);
    suppressGeomPersist = true;
    try {
      await wf.setPosition(new LogicalPosition(saved.x, saved.y));
      await wf.setSize(new LogicalSize(w, h));
    } finally {
      setTimeout(() => {
        suppressGeomPersist = false;
      }, 60);
    }
  } else {
    // No saved placement yet (or the -1 sentinel): default to lower-center.
    await defaultPlacement();
  }
  try {
    await wf.show();
  } catch (e) {
    console.error("[bugzia] show waveform window", e);
  }
}

/** Hide (not destroy) the waveform window. Renderer state persists for next show. */
export async function hideWaveformWindow(): Promise<void> {
  const wf = await WebviewWindow.getByLabel(LABEL);
  if (!wf) return;
  try {
    await wf.hide();
  } catch (e) {
    console.error("[bugzia] hide waveform window", e);
  }
}
