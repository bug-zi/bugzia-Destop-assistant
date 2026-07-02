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

/** Inset from the screen edge for the top-left anchor. Notes pack flush against
 *  each other (no gap between them) but keep a small margin from the physical
 *  screen edge so nothing clips at the corner. */
const PLACE_MARGIN = 8;

/** Logical-px rectangle of an existing note on screen, used to avoid overlap. */
type NoteRect = { x: number; y: number; w: number; h: number };

/** Greedy top-left shelf packer. Given the existing note rectangles, find the
 *  topmost-then-leftmost spot for a w×h note that abuts existing notes (no gap)
 *  and wraps to the next row when the current row is full — so notes line up
 *  along the top-left and stack rightward without overlapping each other.
 *
 *  For each candidate row it slides the new note's left edge rightward, abutting
 *  any note it would overlap, until it lands in a free gap; x strictly increases
 *  each step so the loop always terminates. */
function packTopLeft(
  rects: NoteRect[],
  w: number,
  h: number,
  waW: number,
  waH: number,
): { x: number; y: number } {
  const left = PLACE_MARGIN;
  const top = PLACE_MARGIN;
  const right = waW - PLACE_MARGIN;
  const bottom = waH - PLACE_MARGIN;
  for (let rowTop = top; rowTop + h <= bottom; rowTop += h) {
    const bandBottom = rowTop + h;
    const inBand = rects.filter((r) => r.y < bandBottom && r.y + r.h > rowTop);
    let x = left;
    for (;;) {
      const hit = inBand.find((r) => r.x < x + w && r.x + r.w > x);
      if (!hit) break;
      x = hit.x + hit.w; // flush against its right edge — no gap
    }
    if (x + w <= right) return { x, y: rowTop };
  }
  // Everything is full: clamp to the anchor rather than drifting off-screen.
  return { x: left, y: top };
}

/** Default placement: TOP-LEFT, packing flush to the right of whatever notes are
 *  already on screen (no gap between them). Reads live window geometry so
 *  restored pinned notes and user-moved notes are respected, not just
 *  same-session generations. */
async function defaultPlace(
  win: WebviewWindow,
  label: string,
  newId: string,
  w: number,
  h: number,
  siblings: NoteRecord[],
): Promise<void> {
  const main = getCurrentWindow();
  const sf = await main.scaleFactor();
  const mon = await currentMonitor();
  const waW = mon ? mon.size.width / sf : w * 8;
  const waH = mon ? mon.size.height / sf : h * 8;

  const rects: NoteRect[] = [];
  for (const sib of siblings) {
    if (sib.id === newId) continue; // never pack against the note we're placing
    const live = await WebviewWindow.getByLabel(noteLabel(sib.id));
    let rect: NoteRect | null = null;
    if (live) {
      try {
        const pos = await live.outerPosition();
        const size = await live.outerSize();
        rect = { x: pos.x / sf, y: pos.y / sf, w: size.width / sf, h: size.height / sf };
      } catch {
        rect = null; // window gone mid-loop — fall back to record geometry
      }
    }
    if (!rect && sib.x >= 0 && sib.y >= 0) {
      rect = { x: sib.x, y: sib.y, w: sib.w || w, h: sib.h || h };
    }
    if (rect) rects.push(rect);
  }

  const { x, y } = packTopLeft(rects, w, h, waW, waH);
  // [诊断] 重叠排查：打印工作区、已有便笺矩形、本次落点。验证后移除。
  console.log("[bugzia-note] place", { label, waW, waH, w, h, rects, chosen: { x, y } });
  await placeAt(win, label, Math.max(0, Math.round(x)), Math.max(0, Math.round(y)), w, h);
}

/** Create (if missing) + place + set layer + reveal a note window. A pinned note
 *  with saved geometry (x >= 0) restores its exact spot; a brand-new note is
 *  packed at the top-left, flush against any notes already on screen (siblings).
 *  The z-order layer (pinned -> on top, else desktop) is applied before reveal. */
export async function createNoteWindow(
  record: NoteRecord,
  defaults: { w: number; h: number },
  siblings: NoteRecord[] = [],
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
    await defaultPlace(win, label, record.id, w, h, siblings);
  }

  // Set the z-order layer BEFORE reveal so an unpinned note never flashes over
  // open apps — it appears already at the desktop layer (pinned -> on top).
  await setNoteLayer(record.id, record.pinned);

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

/** Set a note's layer from its pinned state (backend command, by label).
 *  Pinned -> always on top; unpinned -> desktop layer (always on bottom) so app
 *  windows cover it instead of it floating over them. */
export async function setNoteLayer(id: string, pinned: boolean): Promise<void> {
  try {
    await invoke("note_set_layer", { label: noteLabel(id), pinned });
  } catch (e) {
    console.error("[bugzia] note set_layer", e);
  }
}
