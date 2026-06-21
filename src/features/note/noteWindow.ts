/**
 * Desktop sticky-note overlay window lifecycle — MUST run in the MAIN window
 * context. Mirrors petWindow.ts / resultWindow.ts, but MULTI-INSTANCE: each note
 * has a dynamic label `note-<id>` (see noteTypes). Only main has the ACL to
 * create + position windows, and main is the sole notes.json writer, so geometry
 * listeners attach here and report back up via `onNoteGeometryChange`.
 *
 * Lifecycle is create-on-show: notes are real windows that close on destroy
 * (unlike pet/result which hide-and-keep). Pinned notes are recreated from
 * notes.json on the next app launch at their saved spot.
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { noteLabel, type NoteRecord } from "./noteTypes";

const MIN_W = 160;
const MIN_H = 120;

export type NoteGeomPatch = Partial<{ x: number; y: number; w: number; h: number }>;

let geomCb: ((id: string, patch: NoteGeomPatch) => void) | null = null;
/** Labels whose listeners are already wired (one attach per note lifetime). */
const attached = new Set<string>();
/** Labels mid-programmatic-move: skip their next move/resize so a default
 *  placement isn't mistaken for a user placement (mirrors petWindow.ts). */
const suppressFor = new Set<string>();

/** Register the callback fired with (id, patch) when the USER moves/resizes a
 *  note. Wired by main so it can update the note record + persist pinned notes. */
export function onNoteGeometryChange(cb: (id: string, patch: NoteGeomPatch) => void): void {
  geomCb = cb;
}

/** Attach move + resize listeners to one note window (ACL-checked against main). */
function attachGeometry(label: string, id: string, win: WebviewWindow): void {
  if (attached.has(label)) return;
  attached.add(label);

  win.onResized(async ({ payload }) => {
    if (suppressFor.has(label) || !geomCb) return;
    try {
      const sf = await win.scaleFactor();
      geomCb(id, { w: Math.round(payload.width / sf), h: Math.round(payload.height / sf) });
    } catch {
      attached.delete(label);
    }
  }).catch(() => attached.delete(label));

  win.onMoved(async ({ payload }) => {
    if (suppressFor.has(label) || !geomCb) return;
    try {
      const sf = await win.scaleFactor();
      geomCb(id, { x: Math.round(payload.x / sf), y: Math.round(payload.y / sf) });
    } catch {
      attached.delete(label);
    }
  }).catch(() => attached.delete(label));
}

/** Programmatic placement helper: suppress persistence for the move we cause. */
async function placeAt(
  win: WebviewWindow,
  label: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<void> {
  suppressFor.add(label);
  try {
    await win.setPosition(new LogicalPosition(x, y));
    await win.setSize(new LogicalSize(w, h));
  } finally {
    setTimeout(() => suppressFor.delete(label), 60);
  }
}

/** Monotonic cascade counter so successive new notes don't stack on the same
 *  spot. Wraps every 6 to avoid drifting off-screen. */
let cascadeIndex = 0;

/** Default placement: LOWER-RIGHT with a per-note cascade offset (mirrors pet's
 *  default corner but spreads notes so multiple are visible at once). */
async function cascadePlace(
  win: WebviewWindow,
  label: string,
  w: number,
  h: number,
): Promise<void> {
  const main = getCurrentWindow();
  const sf = await main.scaleFactor();
  const mon = await currentMonitor();
  const waW = mon ? mon.size.width / sf : w * 6;
  const waH = mon ? mon.size.height / sf : h * 6;
  const step = 32;
  const i = cascadeIndex % 6;
  cascadeIndex += 1;
  const x = Math.max(0, Math.round(waW - w - 24 - i * step));
  const y = Math.max(0, Math.round(waH - h - 80 - i * step));
  await placeAt(win, label, x, y, w, h);
}

/** Create (if missing) + place + reveal a note window. A pinned note with saved
 *  geometry (x >= 0) restores its exact spot; a brand-new note cascades. */
export async function createNoteWindow(
  record: NoteRecord,
  defaults: { w: number; h: number },
): Promise<WebviewWindow> {
  const label = noteLabel(record.id);
  const w = Math.max(MIN_W, record.w || defaults.w);
  const h = Math.max(MIN_H, record.h || defaults.h);

  let win = await WebviewWindow.getByLabel(label);
  if (!win) {
    win = await new Promise<WebviewWindow>((resolve, reject) => {
      const created = new WebviewWindow(label, {
        title: "Bugzia 便笺",
        width: w,
        height: h,
        minWidth: MIN_W,
        minHeight: MIN_H,
        resizable: true,
        decorations: false,
        transparent: true,
        shadow: true, // opaque notes read better with a soft edge on the desktop
        skipTaskbar: true,
        visible: false, // positioned before reveal — no flash
        center: false,
      });
      created.once("tauri://created", () => resolve(created));
      created.once("tauri://error", (e) =>
        reject(new Error("note window creation failed: " + String(e))),
      );
    });
  }

  attachGeometry(label, record.id, win);

  if (record.x >= 0 && record.y >= 0) {
    await placeAt(win, label, record.x, record.y, w, h);
  } else {
    await cascadePlace(win, label, w, h);
  }

  try {
    await win.show();
  } catch (e) {
    console.error("[bugzia] show note window", e);
  }
  return win;
}

/** Close + destroy a note window (used on 销毁). */
export async function closeNoteWindow(id: string): Promise<void> {
  const label = noteLabel(id);
  const win = await WebviewWindow.getByLabel(label);
  attached.delete(label);
  if (!win) return;
  try {
    await win.close();
  } catch (e) {
    console.error("[bugzia] close note window", e);
  }
}

/** Pin (or unpin) a note above every other window (backend command, by label). */
export async function setNoteAlwaysOnTop(id: string, top: boolean): Promise<void> {
  try {
    await invoke("note_set_always_on_top", { label: noteLabel(id), top });
  } catch (e) {
    console.error("[bugzia] note on_top", e);
  }
}
