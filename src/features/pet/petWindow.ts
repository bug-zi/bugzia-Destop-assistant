/**
 * Desktop-pet overlay window lifecycle — MUST run in the MAIN window context.
 *
 * Same rationale as resultWindow.ts: Tauri v2 checks window ACL against the
 * CALLER (main, `capabilities/default.json` has allow-set-position/size), so
 * positioning runs here. The pet window itself (`capabilities/pet.json`) lacks
 * those perms — it only renders, listens for `settings:updated`, and calls
 * `getCurrentWindow().startDragging()` on a pointer drag.
 *
 * Geometry memory: the overlay remembers its LOGICAL position + size across
 * sessions (persisted by main into settings.json as pet.x/y/w/h). On show, if
 * the user has placed it before (x >= 0) we restore that exact spot + size;
 * otherwise we default to the LOWER-RIGHT of the screen.
 *
 * Lifecycle is create-once-then-hide: the window is hidden, not destroyed, so
 * its React state (pose machine, timers) survives close/reopen and reopening is
 * instant. Created with `visible:false` then positioned + shown to avoid a
 * flash at a default location.
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { loadSettings } from "../settings/settingsStore";

const LABEL = "pet";
const DEFAULT_W = 230;
const DEFAULT_H = 300;
const MIN_W = 230;
const MIN_H = 220;

/** Saved overlay geometry (LOGICAL px) handed to `showPetWindow`. */
export interface PetGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A partial geometry update emitted on a user move (LOGICAL px). */
export type PetGeomPatch = Partial<Pick<PetGeom, "x" | "y">>;

let geomCb: ((patch: PetGeomPatch) => void) | null = null;
let geomAttached = false;
/** Suppress geometry persistence while WE move/resize the window on show, so a
 *  programmatic placement isn't mistaken for a user placement (which would pin
 *  the pet to the default spot forever). */
let suppressGeomPersist = false;

/**
 * Register the callback fired with the pet window's LOGICAL geometry whenever the
 * USER moves it. Wired by the main window so it can persist pet.x/y
 * (main is the sole settings.json writer). Attaches lazily on first window existence.
 */
export function onPetGeometryChange(cb: (patch: PetGeomPatch) => void): void {
  geomCb = cb;
}

/** Attach move listeners once per app lifetime. ACL-checked against main. */
function attachGeometryIfNeeded(win: WebviewWindow): void {
  if (geomAttached) return;
  geomAttached = true;

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

async function enforcePetWindowMinSize(win: WebviewWindow): Promise<void> {
  suppressGeomPersist = true;
  try {
    await win.setResizable(false);
    await win.setMinSize(new LogicalSize(MIN_W, MIN_H));
    const [size, sf] = await Promise.all([win.innerSize(), win.scaleFactor()]);
    const w = Math.round(size.width / sf);
    const h = Math.round(size.height / sf);
    if (w < MIN_W || h < MIN_H) {
      await win.setSize(new LogicalSize(Math.max(MIN_W, w), Math.max(MIN_H, h)));
    }
  } finally {
    setTimeout(() => {
      suppressGeomPersist = false;
    }, 60);
  }
}

/** Get-or-create the pet window. Awaits creation so callers can position it. */
export async function ensurePetWindow(): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    await enforcePetWindowMinSize(existing);
    attachGeometryIfNeeded(existing);
    return existing;
  }

  const win = new WebviewWindow(LABEL, {
    title: "Bugzia 桌宠",
    width: DEFAULT_W,
    height: DEFAULT_H,
    minWidth: MIN_W,
    minHeight: MIN_H,
    resizable: false,
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
      reject(new Error("pet window creation failed: " + String(e))),
    );
  });

  attachGeometryIfNeeded(win);
  return win;
}

/**
 * Default placement: LOWER-RIGHT of the screen (so it doesn't cover the centered
 * main bar). All math in LOGICAL pixels. Used only when the user has not yet
 * placed the pet themselves (no saved pet.x/y, or the -1 sentinel).
 */
async function defaultPlacement(w = DEFAULT_W, h = DEFAULT_H): Promise<void> {
  const main = getCurrentWindow();
  const pet = (await WebviewWindow.getByLabel(LABEL)) ?? (await ensurePetWindow());
  const sf = await main.scaleFactor();
  const mon = await currentMonitor();
  const waW = mon ? mon.size.width / sf : DEFAULT_W * 6;
  const waH = mon ? mon.size.height / sf : DEFAULT_H * 6;
  // Honour the caller's size (so "reset position" keeps a resized window) while
  // still clamping to the minimums.
  const cw = Math.max(MIN_W, w);
  const ch = Math.max(MIN_H, h);
  const x = Math.round(waW - cw - 24); // 24px right margin
  const y = Math.round(waH - ch - 80); // ~80px above the taskbar

  suppressGeomPersist = true;
  try {
    await pet.setPosition(new LogicalPosition(x, y));
    await pet.setSize(new LogicalSize(cw, ch));
  } finally {
    // Move/resize events from our own setPosition/setSize land asynchronously;
    // stay suppressed briefly so they aren't persisted as a "user placement".
    setTimeout(() => {
      suppressGeomPersist = false;
    }, 60);
  }
}

/** Ensure + place + reveal. If `saved` carries a user placement (x >= 0),
 *  restore that exact position + size; otherwise default to lower-right.
 *  Click-through lock + always-on-top are re-applied as the LAST step of every
 *  reveal from the persisted settings (see the note after `show()` below). */
export async function showPetWindow(saved?: PetGeom): Promise<void> {
  const pet = await ensurePetWindow();
  if (saved && saved.x >= 0 && saved.y >= 0) {
    const w = Math.max(MIN_W, saved.w || DEFAULT_W);
    const h = Math.max(DEFAULT_H, saved.h || DEFAULT_H);
    suppressGeomPersist = true;
    try {
      await pet.setPosition(new LogicalPosition(saved.x, saved.y));
      await pet.setSize(new LogicalSize(w, h));
    } finally {
      setTimeout(() => {
        suppressGeomPersist = false;
      }, 60);
    }
  } else {
    await defaultPlacement(saved?.w ?? DEFAULT_W, saved?.h ?? DEFAULT_H);
  }
  try {
    await pet.show();
  } catch (e) {
    console.error("[bugzia] show pet window", e);
  }
  // Re-apply click-through lock + always-on-top as the LAST step of every
  // reveal. On first open (x/y = -1 sentinel) BOTH the CommandCard enabled
  // effect and the reset-position effect call showPetWindow, so show() runs
  // twice and races; a later show() can reset ignore_cursor_events on Windows,
  // un-doing a lock applied by the earlier call (the "lock fails on first
  // open" bug). Applying these flags after EVERY show makes the saved state
  // the last writer, so the lock always sticks regardless of how many shows
  // race. Idempotent with the main window's effects; mirrored in showWaveformWindow.
  const s = await loadSettings();
  await invoke("pet_set_always_on_top", { top: s.pet.always_on_top }).catch(() => {});
  await invoke("pet_set_locked", { locked: s.pet.locked }).catch(() => {});
}

/** Hide (not destroy) the pet window. Renderer state persists for next show. */
export async function hidePetWindow(): Promise<void> {
  const pet = await WebviewWindow.getByLabel(LABEL);
  if (!pet) return;
  try {
    await pet.hide();
  } catch (e) {
    console.error("[bugzia] hide pet window", e);
  }
}
