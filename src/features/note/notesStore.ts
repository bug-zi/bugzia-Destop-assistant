/**
 * Frontend invoke wrappers for notes.json (pinned sticky-notes persistence).
 * Mirrors settingsStore.ts: the main window is the sole writer, and failures
 * log + no-throw so a broken store never crashes the bar.
 */
import { invoke } from "@tauri-apps/api/core";
import type { NoteRecord } from "./noteTypes";

/** Load all pinned notes. Empty list when none / missing / corrupt (Rust side). */
export async function notesLoad(): Promise<NoteRecord[]> {
  try {
    return await invoke<NoteRecord[]>("notes_load");
  } catch (e) {
    console.error("[bugzia] notes_load failed", e);
    return [];
  }
}

/** Persist the full pinned-notes list (atomic write on the Rust side). */
export async function notesSave(notes: NoteRecord[]): Promise<void> {
  try {
    await invoke("notes_save", { notes });
  } catch (e) {
    console.error("[bugzia] notes_save failed", e);
  }
}
