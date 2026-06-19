//! Local filename search (plan §3.2 / §12 file_search.rs, task #7).
//!
//! v1 is real-time filename matching — no content index, no SQLite FTS. We walk
//! the well-known user folders (Desktop / Documents / Downloads) plus any
//! user-configured `index_dirs`, bounded by depth and a result cap, skipping
//! hidden and heavy dev directories. The walk runs on a blocking thread so it
//! never stalls the async executor.
//!
//! `open_file` / `reveal_file` hand a hit to the OS: open with the default
//! handler (via the opener plugin) or select it in Explorer.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// Maximum directory recursion depth. Keeps a broad user folder from being
/// walked to the bottom (e.g. Documents/.git history).
const MAX_DEPTH: usize = 6;
/// Hard ceiling applied on top of the user's `max_results` so a pathologically
/// large match set never balloons memory before truncation.
const ABSOLUTE_CAP: usize = 500;

/// Dev/build/cache directories we never descend into. Lowercased for compare.
/// Users can extend pruning via `search.ignore_dirs`.
const HEAVY_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "target",
    "dist",
    ".next",
    ".nuxt",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    ".idea",
    ".gradle",
    ".m2",
];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    /// File name (no directory).
    pub name: String,
    /// Absolute path as a string.
    pub path: String,
    /// Lowercased extension without the dot, or "" if none.
    pub ext: String,
    /// "file" or "dir".
    pub kind: String,
    /// Size in bytes.
    pub size: u64,
    /// Modification time as Unix milliseconds (frontend formats via `Date`).
    pub modified: u64,
}

/// True if a directory entry name should be pruned (hidden, a known heavy dir,
/// or a user-configured ignore entry). Ignore entries may be a bare name or a
/// trailing path segment; we compare the final segment case-insensitively.
fn is_pruned(name: &str, ignore_dirs: &[String]) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with('.') {
        return true;
    }
    if HEAVY_DIRS.iter().any(|d| *d == lower) {
        return true;
    }
    ignore_dirs.iter().any(|ig| {
        let ig = ig.trim();
        if ig.is_empty() {
            return false;
        }
        let ig_seg = Path::new(ig)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(ig)
            .to_ascii_lowercase();
        ig_seg == lower
    })
}

fn make_result(name: &str, path: &Path, meta: &fs::Metadata) -> FileSearchResult {
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = if meta.is_dir() { "dir" } else { "file" }.to_string();
    FileSearchResult {
        name: name.to_string(),
        path: path.to_string_lossy().to_string(),
        ext,
        kind,
        size: meta.len(),
        modified,
    }
}

/// Bounded recursive filename walk. Appends matches to `out`, stopping once
/// `cap` results are collected. Pruning happens before recursion, so pruned
/// directories are never entered.
fn walk(
    root: &Path,
    query_lower: &str,
    ignore_dirs: &[String],
    depth: usize,
    out: &mut Vec<FileSearchResult>,
    cap: usize,
) {
    if depth > MAX_DEPTH || out.len() >= cap {
        return;
    }
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= cap {
            return;
        }
        let name = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue, // non-UTF8 name — skip silently
        };
        if is_pruned(&name, ignore_dirs) {
            continue;
        }
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if name.to_ascii_lowercase().contains(query_lower) {
            out.push(make_result(&name, &path, &meta));
        }
        if meta.is_dir() {
            walk(&path, query_lower, ignore_dirs, depth + 1, out, cap);
        }
    }
}

#[tauri::command]
pub async fn search_files(app: AppHandle, query: String) -> Result<Vec<FileSearchResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let query_lower = q.to_ascii_lowercase();

    // Well-known roots + user-configured index dirs. Unresolvable roots are
    // skipped rather than erroring the whole search.
    let mut roots: Vec<PathBuf> = Vec::new();
    let pr = app.path();
    if let Ok(p) = pr.desktop_dir() {
        roots.push(p);
    }
    if let Ok(p) = pr.document_dir() {
        roots.push(p);
    }
    if let Ok(p) = pr.download_dir() {
        roots.push(p);
    }

    let cfg = crate::settings::load_settings(app.clone()).unwrap_or_default();
    for d in &cfg.search.index_dirs {
        let d = d.trim();
        if d.is_empty() {
            continue;
        }
        let p = PathBuf::from(d);
        if p.exists() {
            roots.push(p);
        }
    }
    let ignore_dirs = cfg.search.ignore_dirs.clone();
    let cap = (cfg.search.max_results.max(1) as usize).min(ABSOLUTE_CAP);

    // Run the blocking FS walk off the async executor.
    let results = tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<FileSearchResult> = Vec::with_capacity(cap.min(64));
        let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
        for root in roots {
            // Canonicalize so symlinks/`..` don't double-scan the same tree.
            let canon = fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
            if !seen.insert(canon.clone()) {
                continue;
            }
            walk(&canon, &query_lower, &ignore_dirs, 0, &mut out, cap);
            if out.len() >= cap {
                break;
            }
        }
        // Relevance: name starts-with query beats name contains query beats
        // anything else; ties broken by newest first. The comparison flips a/b
        // so `true` (1) sorts before `false` (0) for the startsWith flag.
        out.sort_by(|a, b| {
            let ap = a.name.to_ascii_lowercase().starts_with(&query_lower);
            let bp = b.name.to_ascii_lowercase().starts_with(&query_lower);
            bp.cmp(&ap).then_with(|| b.modified.cmp(&a.modified))
        });
        out.truncate(cap);
        out
    })
    .await
    .map_err(|e| format!("search task failed: {e}"))?;

    Ok(results)
}

#[tauri::command]
pub async fn open_file(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("open file: {e}"))
}

#[tauri::command]
pub async fn reveal_file(_app: AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // `explorer /select,<path>` opens Explorer with the file pre-selected.
        // The opener plugin has no /select equivalent, so shell out directly.
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{path}"))
            .spawn()
            .map_err(|e| format!("reveal file: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("reveal_file is Windows-only in this build".into())
    }
}
