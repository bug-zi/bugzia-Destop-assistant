//! Pinned desktop sticky-notes persistence (plan §数据模型).
//!
//! `settings.json` holds the note STYLE defaults (`NoteSettings`); this file
//! holds the note INSTANCES the user pinned — their content + geometry, which
//! survive an app restart. Unpinned (临时) notes never land here: they live only
//! in the main window's memory and clear on exit.
//!
//! Like settings.rs, the file lives in `app_config_dir()/notes.json` and is
//! written atomically (tmp + rename) so an interrupted write can't leave a
//! half-file. Main window is the sole writer; note windows emit events that
//! main turns into `notes_save` calls.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const NOTES_FILE: &str = "notes.json";

/// One pinned sticky-note. Geometry is LOGICAL px (matches the frontend's
/// LogicalSize/LogicalPosition usage). `pinned` is serialized too so the schema
/// stays self-describing, though only pinned notes are ever written here.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NoteRecord {
    /// `note-<crypto.randomUUID()>` window label suffix; unique per note.
    pub id: String,
    /// The note body (plain text). Empty is allowed but the UI treats
    /// destroy-on-empty as a convenience.
    pub content: String,
    /// LOGICAL px. `-1` sentinel = never placed by the user (default placement).
    pub x: i32,
    pub y: i32,
    /// LOGICAL px size.
    pub w: u32,
    pub h: u32,
    /// Whether the note is pinned (always-on-top + persisted). Persisted records
    /// are always pinned; the field keeps the on-disk shape explicit.
    pub pinned: bool,
}

/// On-disk shape: `{ "notes": [ ... ] }`. A wrapper (not a bare array) leaves
/// room to add top-level fields later (e.g. a schema version) without breaking
/// older readers — they simply ignore unknown keys, and a bare-array fallback
/// below tolerates a hand-edited legacy file.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
struct NotesFile {
    #[serde(default)]
    notes: Vec<NoteRecord>,
}

fn notes_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app_config_dir: {e}"))?;
    Ok(dir.join(NOTES_FILE))
}

/// Atomic write: write to `<file>.tmp` then rename over the target. Mirrors
/// settings.rs so an interrupted save can't corrupt the notes store.
fn atomic_write(path: &std::path::Path, data: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename tmp->notes: {e}"))?;
    Ok(())
}

/// Load all pinned notes. Missing / partial / corrupt file -> empty list (the
/// frontend then just creates no note windows on boot), never an error surface.
#[tauri::command]
pub fn notes_load(app: AppHandle) -> Result<Vec<NoteRecord>, String> {
    let path = notes_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("read notes: {e}"))?;
    // Tolerate both the wrapped {"notes":[...]} shape and a bare [...] legacy
    // file; any parse failure falls back to empty rather than crashing boot.
    let trimmed = data.trim_start();
    let records = if trimmed.starts_with('[') {
        serde_json::from_str::<Vec<NoteRecord>>(&data).unwrap_or_default()
    } else {
        serde_json::from_str::<NotesFile>(&data)
            .map(|f| f.notes)
            .unwrap_or_default()
    };
    Ok(records)
}

/// Persist the full pinned-notes list (atomic write). Main is the sole caller,
/// passing the complete authoritative list each save (debounced on the frontend).
#[tauri::command]
pub fn notes_save(app: AppHandle, notes: Vec<NoteRecord>) -> Result<(), String> {
    let path = notes_path(&app)?;
    let file = NotesFile { notes };
    let data =
        serde_json::to_string_pretty(&file).map_err(|e| format!("serialize notes: {e}"))?;
    atomic_write(&path, &data)
}
