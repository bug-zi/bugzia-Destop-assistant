//! Localhost HTTP receiver for the "agent notify" feature.
//!
//! Claude Code and Codex POST their lifecycle events here (turn complete,
//! approval needed, errors). We classify the raw native payload and emit a
//! normalized `pet:agent-notify` Tauri event so the pet overlay can alert the
//! user. The agent side only forwards its own hook/notify JSON verbatim — all
//! shape knowledge lives here, so adding/changing a tool only touches this file.
//!
//! Design:
//!   - Binds 127.0.0.1 ONLY (never 0.0.0.0). No remote exposure.
//!   - Runs in a dedicated std::thread (tiny_http is sync); no async runtime.
//!   - A bind failure (port taken) is logged and skipped — never fatal to the app.
//!   - Every request gets the same empty 204: the caller treats us as best-effort
//!     and discards output, so we keep responses uniform and avoid any stdout the
//!     agent might try to parse (Codex's Stop hook, for example, requires JSON on
//!     stdout — but we're the server here, not a hook process, so it's moot).
//!
//! See docs/agent-notify/README.md for the shared protocol contract.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tiny_http::{Method, Response, Server};

/// Event channel the pet overlay listens on. Mirrors the const in
/// `src/features/petAgent/petAgentNotify.ts`.
const PET_AGENT_NOTIFY: &str = "pet:agent-notify";
const PATH: &str = "/agent-event";
static STARTED: AtomicBool = AtomicBool::new(false);

/// Snapshot of the settings the receiver needs. Captured at startup (the
/// listener binds once; changing the port needs an app restart). The kind
/// filters + show_content are also snapshotted — live-tuning them is a future
/// enhancement; the per-kind cooldown is enforced on the pet side regardless.
pub struct NotifyConfig {
    pub port: u16,
    pub token: Option<String>,
    pub on_done: bool,
    pub on_needs: bool,
    pub on_error: bool,
    pub show_content: bool,
}

/// Bind + spawn the receiver thread. Returns immediately (non-blocking). If the
/// port is already in use, logs and returns without starting — the app keeps
/// running, just without agent notifications.
pub fn start(app: AppHandle, cfg: NotifyConfig) -> bool {
    if STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }

    let addr = format!("127.0.0.1:{}", cfg.port);
    let server = match Server::http(&addr) {
        Ok(s) => s,
        Err(e) => {
            STARTED.store(false, Ordering::SeqCst);
            eprintln!("[agent_notify] bind {addr} failed: {e}; agent-notify disabled");
            return false;
        }
    };
    println!("[agent_notify] listening on http://{addr}{PATH}");

    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            if let Some(payload) = process(&cfg, &mut req) {
                let _ = app.emit(PET_AGENT_NOTIFY, payload);
            }
            // Always respond so the connection closes; the caller discards output.
            let _ = req.respond(Response::empty(204));
        }
    });
    true
}

/// Classify one request into a normalized payload, or None to stay silent. Reads
/// the body off `req` (borrowing it); the caller then consumes `req` to respond.
fn process(cfg: &NotifyConfig, req: &mut tiny_http::Request) -> Option<Value> {
    if req.method() != &Method::Post || !req.url().starts_with(PATH) {
        return None;
    }
    // Optional shared-secret: when configured, the caller must pass ?token=<this>.
    if let Some(ref token) = cfg.token {
        if parse_query(req.url(), "token").as_deref() != Some(token.as_str()) {
            return None;
        }
    }
    let source = parse_query(req.url(), "source");
    let mut body = String::new();
    if req.as_reader().read_to_string(&mut body).is_err() {
        return None;
    }
    let json: Value = serde_json::from_str(&body).ok()?;
    classify(source.as_deref().unwrap_or(""), &json, cfg)
}

/// Map a raw agent payload to a normalized `pet:agent-notify` payload, or None
/// if the event isn't one we surface. `source` is the `?source=` query value
/// ("claude" or "codex") that each tool's hook config sets.
fn classify(source: &str, body: &Value, cfg: &NotifyConfig) -> Option<Value> {
    let event = body.get("hook_event_name").and_then(|v| v.as_str());
    match source {
        "claude" => classify_claude(event, body, cfg),
        "codex" => classify_codex(event, body, cfg),
        _ => None,
    }
}

fn classify_claude(event: Option<&str>, body: &Value, cfg: &NotifyConfig) -> Option<Value> {
    let session = sid(body);
    let cwd = cwd(body);
    match event {
        Some("Stop") => {
            // Non-empty background_tasks = paused (background work still running),
            // not truly idle. Surface as a distinct, lower-key kind so the pet
            // doesn't claim "done" while work continues off-screen.
            let busy = body
                .get("background_tasks")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            if busy {
                return Some(build(
                    "claude",
                    "paused",
                    "Claude 还在后台跑",
                    None,
                    None,
                    session,
                    cwd.clone(),
                ));
            }
            if !cfg.on_done {
                return None;
            }
            Some(build(
                "claude",
                "done",
                "Claude 完成了回合",
                summary_if(body, "last_assistant_message", cfg.show_content),
                None,
                session,
                cwd.clone(),
            ))
        }
        Some("StopFailure") => {
            if !cfg.on_error {
                return None;
            }
            Some(build(
                "claude",
                "error",
                "Claude 出错了",
                None,
                None,
                session,
                cwd.clone(),
            ))
        }
        Some("Notification") => {
            let nt = body.get("notification_type").and_then(|v| v.as_str());
            let needs = matches!(
                nt,
                Some("permission_prompt" | "idle_prompt" | "elicitation_dialog")
            );
            if !needs || !cfg.on_needs {
                return None;
            }
            let title = body
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Claude 需要你确认");
            Some(build(
                "claude",
                "needs",
                title,
                summary_if(body, "message", cfg.show_content),
                None,
                session,
                cwd.clone(),
            ))
        }
        _ => None,
    }
}

fn classify_codex(event: Option<&str>, body: &Value, cfg: &NotifyConfig) -> Option<Value> {
    let session = sid(body);
    let cwd = cwd(body);
    // Codex `notify` program payload (argv JSON): type == agent-turn-complete.
    // Distinct from the hook payload (which carries hook_event_name on stdin).
    //
    // NOTE: both `agent-turn-complete` and the `Stop` hook fire at every TURN
    // BOUNDARY — including when Codex merely pauses to ask the user a question,
    // stops between steps, gets interrupted, or rate-limits. They do NOT mean
    // the task succeeded. Codex gives no reliable "task complete" signal, so we
    // surface these as `paused` ("Codex stopped, go check") rather than a
    // celebratory `done`, which would falsely claim the task finished. Mirrors
    // the Claude-side `paused` handling for an ambiguous Stop.
    let notify_done = body
        .get("type")
        .and_then(|v| v.as_str())
        .map(|t| t == "agent-turn-complete")
        .unwrap_or(false);
    if notify_done {
        if !cfg.on_done {
            return None;
        }
        return Some(build(
            "codex",
            "paused",
            "Codex 停下来了，去看看",
            // Codex notify uses a hyphenated key for the last message.
            summary_if(body, "last-assistant-message", cfg.show_content),
            None,
            session,
            cwd.clone(),
        ));
    }
    match event {
        Some("Stop") => {
            if !cfg.on_done {
                return None;
            }
            Some(build(
                "codex",
                "paused",
                "Codex 停下来了，去看看",
                summary_if(body, "last_assistant_message", cfg.show_content),
                None,
                session,
                cwd.clone(),
            ))
        }
        Some("PermissionRequest") => {
            if !cfg.on_needs {
                return None;
            }
            let tool = body
                .get("tool_name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Some(build(
                "codex",
                "needs",
                "Codex 需要你批准",
                body.get("tool_input")
                    .and_then(|t| t.get("description"))
                    .and_then(|v| v.as_str())
                    .filter(|_| cfg.show_content)
                    .map(|s| truncate(s, 40)),
                tool,
                session,
                cwd.clone(),
            ))
        }
        _ => None,
    }
}

/// Build the normalized payload object. `summary`/`tool`/`session` are only
/// included when present, so an absent summary (show_content off) never reaches
/// the frontend — the pet side can rely on `summary` presence as a content flag.
#[allow(clippy::too_many_arguments)]
fn build(
    source: &str,
    kind: &str,
    title: &str,
    summary: Option<String>,
    tool: Option<String>,
    session: Option<String>,
    cwd: Option<String>,
) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("source".into(), json!(source));
    obj.insert("kind".into(), json!(kind));
    obj.insert("title".into(), json!(title));
    if let Some(s) = summary {
        obj.insert("summary".into(), json!(s));
    }
    if let Some(t) = tool {
        obj.insert("tool".into(), json!(t));
    }
    if let Some(sid) = session {
        obj.insert("sessionId".into(), json!(sid));
    }
    if let Some(cwd) = cwd {
        obj.insert("cwd".into(), json!(cwd));
    }
    obj.insert("receivedAt".into(), json!(now_millis()));
    Value::Object(obj)
}

/// Pull a string field as a trimmed, length-capped summary, only when content
/// display is enabled. Returns None otherwise (privacy default: show nothing).
fn summary_if(body: &Value, key: &str, show_content: bool) -> Option<String> {
    if !show_content {
        return None;
    }
    body.get(key)
        .and_then(|v| v.as_str())
        .map(|s| truncate(s, 40))
}

/// session_id (Claude Code + Codex hooks) or thread-id (Codex notify).
fn sid(body: &Value) -> Option<String> {
    body.get("session_id")
        .and_then(|v| v.as_str())
        .or_else(|| body.get("thread-id").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
}

fn cwd(body: &Value) -> Option<String> {
    body.get("cwd")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
}

/// Trim + cap to `max_chars` Unicode code points, appending an ellipsis if cut.
fn truncate(s: &str, max_chars: usize) -> String {
    let trimmed = s.trim();
    let count = trimmed.chars().count();
    let mut out: String = trimmed.chars().take(max_chars).collect();
    if count > max_chars {
        out.push('\u{2026}');
    }
    out
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Extract a query value from a `path?k=v&k2=v2` URL. tiny_http gives us the
/// full path+query in `request.url()`.
fn parse_query(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(v.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(show_content: bool) -> NotifyConfig {
        NotifyConfig {
            port: 17890,
            token: None,
            on_done: true,
            on_needs: true,
            on_error: true,
            show_content,
        }
    }

    #[test]
    fn claude_stop_done_classifies() {
        let body = serde_json::json!({
            "hook_event_name": "Stop",
            "last_assistant_message": "done",
            "background_tasks": [],
            "session_id": "s1",
            "cwd": "/x"
        });
        let p = classify("claude", &body, &cfg(false)).expect("done");
        assert_eq!(p["kind"], "done");
        assert_eq!(p["title"], "Claude 完成了回合");
        assert!(p.get("summary").is_none()); // show_content off
        assert_eq!(p["sessionId"], "s1");
    }

    #[test]
    fn claude_stop_with_background_tasks_is_paused() {
        let body = serde_json::json!({
            "hook_event_name": "Stop",
            "background_tasks": [{ "id": "x" }]
        });
        let p = classify("claude", &body, &cfg(false)).expect("paused");
        assert_eq!(p["kind"], "paused");
    }

    #[test]
    fn claude_notification_permission_is_needs() {
        let body = serde_json::json!({
            "hook_event_name": "Notification",
            "notification_type": "permission_prompt",
            "title": "允许？",
            "message": "run curl"
        });
        let p = classify("claude", &body, &cfg(true)).expect("needs");
        assert_eq!(p["kind"], "needs");
        assert_eq!(p["title"], "允许？");
        assert_eq!(p["summary"], "run curl"); // show_content on
    }

    #[test]
    fn claude_notification_other_types_ignored() {
        let body = serde_json::json!({
            "hook_event_name": "Notification",
            "notification_type": "auth_success"
        });
        assert!(classify("claude", &body, &cfg(true)).is_none());
    }

    #[test]
    fn codex_notify_turn_complete_is_paused() {
        // agent-turn-complete fires at every turn boundary (including when Codex
        // pauses to ask a question), not on task success -> classified paused.
        let body = serde_json::json!({
            "type": "agent-turn-complete",
            "thread-id": "t1",
            "last-assistant-message": "ok"
        });
        let p = classify("codex", &body, &cfg(true)).expect("paused");
        assert_eq!(p["kind"], "paused");
        assert_eq!(p["summary"], "ok");
        assert_eq!(p["sessionId"], "t1"); // thread-id fallback
    }

    #[test]
    fn codex_stop_is_paused() {
        // Stop hook likewise fires at every turn boundary -> paused, never done.
        let body = serde_json::json!({
            "hook_event_name": "Stop",
            "session_id": "c2",
            "last_assistant_message": "step done"
        });
        let p = classify("codex", &body, &cfg(true)).expect("paused");
        assert_eq!(p["kind"], "paused");
        assert_eq!(p["sessionId"], "c2");
    }

    #[test]
    fn codex_permission_request_is_needs() {
        let body = serde_json::json!({
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "tool_input": { "command": "rm -rf x", "description": "删除" },
            "session_id": "c1"
        });
        let p = classify("codex", &body, &cfg(true)).expect("needs");
        assert_eq!(p["kind"], "needs");
        assert_eq!(p["tool"], "Bash");
        assert_eq!(p["summary"], "删除");
    }

    #[test]
    fn unknown_source_ignored() {
        let body = serde_json::json!({ "hook_event_name": "Stop" });
        assert!(classify("other", &body, &cfg(true)).is_none());
    }

    #[test]
    fn on_done_false_suppresses_done() {
        let body = serde_json::json!({ "hook_event_name": "Stop", "background_tasks": [] });
        let mut c = cfg(false);
        c.on_done = false;
        assert!(classify("claude", &body, &c).is_none());
    }

    #[test]
    fn truncate_caps_and_ellipsizes() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("abcdefghij", 4), "abcd\u{2026}");
        assert_eq!(truncate("  spaces  ", 10), "spaces");
    }

    #[test]
    fn parse_query_extracts_values() {
        assert_eq!(
            parse_query("/agent-event?source=claude", "source"),
            Some("claude".into())
        );
        assert_eq!(parse_query("/x?a=1&b=2", "b"), Some("2".into()));
        assert_eq!(parse_query("/x", "source"), None);
    }
}
