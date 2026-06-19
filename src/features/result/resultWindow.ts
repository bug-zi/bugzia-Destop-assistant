/**
 * Result overlay window lifecycle — MUST run in the MAIN window context.
 *
 * Why main? Tauri v2 checks window ACL against the CALLER window's capability,
 * not the target's. Only `main` (`capabilities/default.json`) has
 * `core:window:allow-set-position` / `allow-set-size`, so the positioning calls
 * below must execute here. The result window itself never calls setPosition /
 * setSize (its `capabilities/result.json` lacks those permissions) — it only
 * emits events and calls `getCurrentWindow().hide()`.
 *
 * Geometry memory: the overlay remembers its own LOGICAL position + size across
 * sessions (persisted by main into settings.json as result_x/y/w/h). On show,
 * if the user has placed it before (result_x >= 0) we restore that exact spot +
 * size; otherwise we default to just ABOVE the bar (the design's preferred
 * direction, falling back to below when there is no room above).
 *
 * Lifecycle is create-once-then-hide: the window is hidden, not destroyed, so
 * its React state (the chat mirror) survives close/reopen and reopening is
 * instant. Created with `visible:false` then positioned + shown to avoid a
 * flash at a default location.
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";

const LABEL = "result";
const MIN_RESULT_W = 420;
const DEFAULT_RESULT_H = 360;
const MIN_RESULT_H = 200;
const GAP = 8;

/** Saved overlay geometry (LOGICAL px) handed to `showResultWindow`. */
export interface ResultGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A partial geometry update emitted on a user move/resize (LOGICAL px). */
export type ResultGeomPatch = Partial<ResultGeom>;

let geomCb: ((patch: ResultGeomPatch) => void) | null = null;
let geomAttached = false;
/** Suppress geometry persistence while WE move/resize the window on show, so a
 *  programmatic placement isn't mistaken for a user placement (which would pin
 *  the overlay to the default above-bar spot forever). */
let suppressGeomPersist = false;

/**
 * Register the callback fired with the result window's LOGICAL geometry whenever
 * the USER moves or resizes it. Wired by the main window so it can persist
 * result_x/y/w/h (main is the sole settings.json writer). The listener attaches
 * to the result handle lazily — the first time the window exists — so
 * registration order (this at main mount, window created later) is free.
 */
export function onResultGeometryChange(cb: (patch: ResultGeomPatch) => void): void {
  geomCb = cb;
}

/** Attach move + resize listeners once per app lifetime. ACL: `onMoved` /
 *  `onResized` / `scaleFactor` are checked against the CALLER (main,
 *  `core:default`), not the result window — the same reason positioning runs in main. */
function attachGeometryIfNeeded(win: WebviewWindow): void {
  if (geomAttached) return;
  geomAttached = true;

  win.onResized(async ({ payload }) => {
    if (suppressGeomPersist || !geomCb) return;
    try {
      const sf = await win.scaleFactor();
      geomCb({ w: Math.round(payload.width / sf), h: Math.round(payload.height / sf) });
    } catch {
      // keep the listener; the next resize retries the scale-factor read
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
      // keep the listener; the next move retries the scale-factor read
    }
  }).catch(() => {
    // attach itself failed (e.g. window gone) — allow a later retry
    geomAttached = false;
  });
}

/** Get-or-create the result window. Awaits creation so callers can position it. */
export async function ensureResultWindow(): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    attachGeometryIfNeeded(existing);
    return existing;
  }

  const win = new WebviewWindow(LABEL, {
    title: "Bugzia 结果",
    width: MIN_RESULT_W,
    height: DEFAULT_RESULT_H,
    minWidth: 360,
    minHeight: MIN_RESULT_H,
    resizable: true,
    decorations: false,
    transparent: true,
    shadow: false,
    skipTaskbar: true,
    visible: false, // positioned before reveal — no flash
    center: false, // NOT a centered modal; it tracks the main bar
  });

  await new Promise<void>((resolve, reject) => {
    win.once("tauri://created", () => resolve());
    win.once("tauri://error", (e) =>
      reject(new Error("result window creation failed: " + String(e))),
    );
  });

  attachGeometryIfNeeded(win);
  return win;
}

/**
 * Default placement: just ABOVE the main bar (left-aligned, width tracks the
 * bar), falling back to below when above won't fit, and clamping into the
 * monitor bounds. All math in LOGICAL pixels. Used only when the user has not
 * yet placed the overlay themselves (no saved result_x/y).
 */
export async function positionResultWindowNearMain(
  savedH: number = DEFAULT_RESULT_H,
): Promise<void> {
  const main = getCurrentWindow();
  const result = (await WebviewWindow.getByLabel(LABEL)) ?? (await ensureResultWindow());

  const sf = await main.scaleFactor();
  const mPos = await main.outerPosition(); // PhysicalPosition
  const mSize = await main.outerSize(); // PhysicalSize
  const mx = mPos.x / sf;
  const my = mPos.y / sf;
  const mw = mSize.width / sf;
  const mh = mSize.height / sf;

  // `currentMonitor` is the monitor hosting the main window (standalone fn).
  const mon = await currentMonitor();
  const waX = mon ? mon.position.x / sf : 0;
  const waY = mon ? mon.position.y / sf : 0;
  const waW = mon ? mon.size.width / sf : mw;
  const waH = mon ? mon.size.height / sf : mh;

  const w = Math.max(MIN_RESULT_W, Math.round(mw));
  const h = Math.max(MIN_RESULT_H, savedH);

  const aboveY = my - h - GAP;
  const belowY = my + mh + GAP;
  const fitsAbove = aboveY >= waY;
  const fitsBelow = belowY + h <= waY + waH;
  // Prefer ABOVE (design direction); fall back to below; last resort clamp above.
  let y = fitsAbove ? aboveY : fitsBelow ? belowY : aboveY;
  let x = mx;
  if (x + w > waX + waW) x = waX + waW - w;
  if (x < waX) x = waX;
  if (y < waY) y = waY;

  suppressGeomPersist = true;
  try {
    await result.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
    await result.setSize(new LogicalSize(w, h));
  } finally {
    // Move/resize events from our own setPosition/setSize land asynchronously;
    // stay suppressed briefly so they aren't persisted as a "user placement".
    setTimeout(() => {
      suppressGeomPersist = false;
    }, 60);
  }
}

/** Ensure + place + reveal + focus. If `saved` carries a user placement
 *  (x >= 0), restore that exact position + size; otherwise default to above the
 *  bar. The result window's React app re-emits `result:ready` on first creation;
 *  main replies with a `result:replay`. */
export async function showResultWindow(saved?: ResultGeom): Promise<void> {
  const result = await ensureResultWindow();
  if (saved && saved.x >= 0 && saved.y >= 0) {
    // User has placed the overlay before: restore their exact spot + size.
    const w = Math.max(MIN_RESULT_W, saved.w);
    const h = Math.max(MIN_RESULT_H, saved.h || DEFAULT_RESULT_H);
    suppressGeomPersist = true;
    try {
      await result.setPosition(new LogicalPosition(saved.x, saved.y));
      await result.setSize(new LogicalSize(w, h));
    } finally {
      setTimeout(() => {
        suppressGeomPersist = false;
      }, 60);
    }
  } else {
    // No saved placement yet: default to just above the bar.
    await positionResultWindowNearMain(saved?.h || DEFAULT_RESULT_H);
  }
  try {
    await result.show();
    await result.setFocus();
  } catch (e) {
    console.error("[bugzia] show result window", e);
  }
}

/** Hide (not destroy) the result window. State persists for next show. */
export async function hideResultWindow(): Promise<void> {
  const result = await WebviewWindow.getByLabel(LABEL);
  if (!result) return;
  try {
    await result.hide();
  } catch (e) {
    console.error("[bugzia] hide result window", e);
  }
}

/** Whether the result window currently exists and is visible. */
export async function isResultVisible(): Promise<boolean> {
  const result = await WebviewWindow.getByLabel(LABEL);
  if (!result) return false;
  try {
    return await result.isVisible();
  } catch {
    return false;
  }
}
