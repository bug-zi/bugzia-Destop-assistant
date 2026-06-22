//! Desktop pet "eats" files: moves OS-dragged files to the recycle bin.
//!
//! The pet window receives OS file drag-drop (Tauri `onDragDropEvent`) and calls
//! `pet_eat_files` with the dropped paths. Each is sent to the OS recycle bin via
//! the `trash` crate (Windows -> IFileOperation; reversible, NOT a permanent
//! delete). Per-file failures are collected instead of aborting the batch, so one
//! unreadable path doesn't block the rest.

#[derive(serde::Serialize)]
pub struct EatFailure {
    pub path: String,
    pub error: String,
}

#[derive(serde::Serialize)]
pub struct EatResult {
    pub eaten: usize,
    pub failed: Vec<EatFailure>,
}

/// Move every path in `paths` to the OS recycle bin. Always returns a structured
/// result: successfully trashed paths increment `eaten`; the rest land in
/// `failed` with their error. Empty/whitespace-only entries are skipped silently.
#[tauri::command]
pub fn pet_eat_files(paths: Vec<String>) -> EatResult {
    let mut eaten = 0usize;
    let mut failed = Vec::new();
    for raw in paths {
        let path = raw.trim();
        if path.is_empty() {
            continue;
        }
        match trash::delete(path) {
            Ok(()) => eaten += 1,
            Err(err) => failed.push(EatFailure {
                path: raw,
                error: err.to_string(),
            }),
        }
    }
    EatResult { eaten, failed }
}
