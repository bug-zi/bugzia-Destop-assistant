/**
 * Desktop sticky-note types + IPC event protocol (plan §事件协议).
 *
 * Notes are MULTI-INSTANCE overlay windows with dynamic labels `note-<id>`. The
 * main window owns the authoritative note list (and is the sole writer of
 * notes.json); each note window is a thin view that hydrates from main, reports
 * user edits/geometry/pin back up, and self-closes on destroy.
 *
 * Event flow:
 *   note window mount  -> NOTE_READY {id}               (note -> main)
 *   main               -> emitTo(label, NOTE_HYDRATE)   (main -> that note)
 *   edit / move / pin  -> NOTE_CHANGED / NOTE_GEOM / NOTE_PINNED  (note -> main)
 *   destroy            -> NOTE_DESTROYED {id}           (note -> main, then close)
 *   style change       -> NOTE_SETTINGS (broadcast)     (main -> all notes)
 */

export interface NoteRecord {
  /** `note-<crypto.randomUUID()>` window label suffix; unique per note. */
  id: string;
  /** Plain-text body. */
  content: string;
  /** LOGICAL px. -1 sentinel = never placed (default placement). */
  x: number;
  y: number;
  /** LOGICAL px size. */
  w: number;
  h: number;
  /** Pinned = always-on-top + persisted to notes.json. */
  pinned: boolean;
}

/** Label prefix every note window shares; the suffix is the note id. */
export const NOTE_LABEL_PREFIX = "note-";

/** Build a window label from a note id. */
export function noteLabel(id: string): string {
  return NOTE_LABEL_PREFIX + id;
}

/** Extract the note id from a window label (label without the `note-` prefix). */
export function noteIdFromLabel(label: string): string {
  return label.startsWith(NOTE_LABEL_PREFIX) ? label.slice(NOTE_LABEL_PREFIX.length) : label;
}

/** note://ready — note window mounted, requests its content. Payload: {id}. */
export const NOTE_READY = "note://ready";
/** note://hydrate — main -> a specific note (emitTo). Payload: {content, settings}. */
export const NOTE_HYDRATE = "note://hydrate";
/** note://changed — note -> main after an edit. Payload: {id, content}. */
export const NOTE_CHANGED = "note://changed";
/** note://geom — note -> main after a user move/resize. Payload: {id, x, y, w, h}. */
export const NOTE_GEOM = "note://geom";
/** note://pinned — note -> main on pin toggle. Payload: {id, pinned}. */
export const NOTE_PINNED = "note://pinned";
/** note://destroyed — note -> main before self-close. Payload: {id}. */
export const NOTE_DESTROYED = "note://destroyed";
/** note://settings — main -> broadcast style defaults. Payload: NoteSettings. */
export const NOTE_SETTINGS = "note://settings";
