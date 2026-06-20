//! Persistent conversation history (mirrors settings.rs storage pattern).
//!
//! Conversations are stored in `${app_config_dir}/conversations.json` as a
//! single JSON array. Retention: ALL locked conversations are kept forever;
//! among the unlocked, only the most recent DEFAULT_KEEP_RECENT (by updated_at)
//! survive. The active conversation's visible messages — including one-shot
//! results like /weather, /trans that never enter the backend ChatState — are
//! persisted by the frontend main window via `upsert_conversation` (the mirror
//! is the source of truth, "what you saw is what is saved"). On resume the
//! messages are pushed back into ChatState via `set_messages`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const CONVERSATIONS_FILE: &str = "conversations.json";
/// How many UNLOCKED conversations to keep. Locked ones are exempt.
const DEFAULT_KEEP_RECENT: usize = 10;
/// Title is derived from the first user message, truncated to this many chars.
const TITLE_MAX_CHARS: usize = 30;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/// One stored turn. Mirrors the frontend `ChatMessage` shape (role/content +
/// optional echoed model). `model` is `#[serde(default)]` so an older
/// conversations.json (or user turns that never carried one) still loads.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConvMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub locked: bool,
    pub messages: Vec<ConvMessage>,
}

/// Lightweight list item (no full messages) for the history rail.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConvSummary {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub locked: bool,
    pub message_count: usize,
}

// ---------------------------------------------------------------------------
// File I/O (mirrors settings.rs)
// ---------------------------------------------------------------------------

fn conversations_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app_config_dir: {e}"))?;
    Ok(dir.join(CONVERSATIONS_FILE))
}

/// Atomic write: `<file>.tmp` then rename. Same safeguard as settings.json — a
/// crash mid-write never leaves a half-written conversations.json.
fn atomic_write(path: &Path, data: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename tmp->conversations: {e}"))?;
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Load all conversations from disk. Missing or corrupt file -> empty list
/// (never fatal, mirroring `load_settings`).
fn load_all(app: &AppHandle) -> Result<Vec<Conversation>, String> {
    let path = conversations_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("read conversations: {e}"))?;
    let parsed: Vec<Conversation> = serde_json::from_str(&data).unwrap_or_default();
    Ok(parsed)
}

fn save_all(app: &AppHandle, convs: &[Conversation]) -> Result<(), String> {
    let path = conversations_path(app)?;
    let data =
        serde_json::to_string_pretty(convs).map_err(|e| format!("serialize conversations: {e}"))?;
    atomic_write(&path, &data)
}

fn summarize(c: &Conversation) -> ConvSummary {
    ConvSummary {
        id: c.id.clone(),
        title: c.title.clone(),
        created_at: c.created_at,
        updated_at: c.updated_at,
        locked: c.locked,
        message_count: c.messages.len(),
    }
}

/// Derive a title from the first user message (truncated), else "新对话".
fn derive_title(title: &str, messages: &[ConvMessage]) -> String {
    let t = title.trim();
    if !t.is_empty() {
        return t.to_string();
    }
    for m in messages {
        if m.role == "user" && !m.content.trim().is_empty() {
            let trimmed = m.content.trim();
            let count = trimmed.chars().count();
            let snippet: String = trimmed.chars().take(TITLE_MAX_CHARS).collect();
            return if count > TITLE_MAX_CHARS {
                format!("{snippet}…")
            } else {
                snippet
            };
        }
    }
    "新对话".to_string()
}

/// Enforce retention: keep ALL locked + the most recent DEFAULT_KEEP_RECENT
/// unlocked (by updated_at desc). The conversation just upserted is the
/// newest, so it always survives.
fn prune(convs: Vec<Conversation>) -> Vec<Conversation> {
    let mut sorted = convs;
    // Newest first by updated_at; ties broken by created_at.
    sorted.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(b.created_at.cmp(&a.created_at)));
    let mut kept: Vec<Conversation> = Vec::new();
    let mut unlocked_kept = 0usize;
    for c in sorted {
        if c.locked {
            kept.push(c);
        } else if unlocked_kept < DEFAULT_KEEP_RECENT {
            kept.push(c);
            unlocked_kept += 1;
        }
        // else: unlocked beyond the cap -> dropped
    }
    kept
}

/// Mint a unique-ish id without a uuid crate dependency. Millisecond timestamp
/// + a monotonic counter is collision-safe for a single-process desktop app.
fn mint_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}", now_ms(), n)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_conversations(app: AppHandle) -> Result<Vec<ConvSummary>, String> {
    let convs = load_all(&app)?;
    Ok(convs.iter().map(summarize).collect())
}

#[tauri::command]
pub fn get_conversation(app: AppHandle, id: String) -> Result<Vec<ConvMessage>, String> {
    let convs = load_all(&app)?;
    convs
        .into_iter()
        .find(|c| c.id == id)
        .map(|c| c.messages)
        .ok_or_else(|| format!("conversation not found: {id}"))
}

/// Create or update a conversation. Returns the id (minted if `id` was None or
/// empty). Retention is enforced before writing. The frontend guards against
/// persisting an empty mirror, so an empty `messages` here is treated as a
/// no-op write (the id is still returned so the caller can track it).
#[tauri::command]
pub fn upsert_conversation(
    app: AppHandle,
    id: Option<String>,
    title: String,
    messages: Vec<ConvMessage>,
) -> Result<String, String> {
    let now = now_ms();
    let mut convs = load_all(&app)?;

    let id = match id.filter(|s| !s.trim().is_empty()) {
        Some(existing) => existing,
        None => mint_id(),
    };

    if messages.is_empty() {
        // Nothing worth persisting; don't clobber an existing record with [].
        return Ok(id);
    }

    let derived_title = derive_title(&title, &messages);

    if let Some(c) = convs.iter_mut().find(|c| c.id == id) {
        // Update in place; preserve created_at + locked.
        c.title = derived_title;
        c.updated_at = now;
        c.messages = messages;
    } else {
        convs.push(Conversation {
            id: id.clone(),
            title: derived_title,
            created_at: now,
            updated_at: now,
            locked: false,
            messages,
        });
    }

    let pruned = prune(convs);
    save_all(&app, &pruned)?;
    Ok(id)
}

#[tauri::command]
pub fn set_conversation_locked(app: AppHandle, id: String, locked: bool) -> Result<(), String> {
    let mut convs = load_all(&app)?;
    let mut changed = false;
    for c in convs.iter_mut() {
        if c.id == id {
            c.locked = locked;
            changed = true;
            break;
        }
    }
    if changed {
        save_all(&app, &convs)?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_conversation(app: AppHandle, id: String) -> Result<(), String> {
    let mut convs = load_all(&app)?;
    let before = convs.len();
    convs.retain(|c| c.id != id);
    if convs.len() != before {
        save_all(&app, &convs)?;
    }
    Ok(())
}
