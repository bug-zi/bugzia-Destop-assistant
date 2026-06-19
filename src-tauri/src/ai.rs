//! OpenAI-compatible streaming chat (plan §12 ai.rs).
//!
//! - Builds `POST {base_url}/chat/completions` from the persisted settings.
//! - Parses the SSE stream and pushes token deltas to the frontend over a
//!   `tauri::ipc::Channel` (`Delta` / `Done` / `Error`).
//! - Keeps the conversation context in memory (`ChatState`); the API Key is read
//!   from the OS keyring and is NEVER logged.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle, State};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// State + events
// ---------------------------------------------------------------------------

/// One turn of the in-memory conversation (system prompt is NOT stored here —
/// it is prepended fresh on every request from the live settings).
#[derive(Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Default)]
pub struct ChatState {
    /// Conversation context (user + assistant turns).
    pub messages: Mutex<Vec<ChatMessage>>,
    /// Abort flag for the in-flight `chat` call; `None` when idle.
    pub abort: Mutex<Option<Arc<AtomicBool>>>,
}

/// Tagged events sent to the frontend. `on_event` (Rust) ↔ `onEvent` (JS).
/// `pub` because it appears in the public `chat` command signature.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum ChatEvent {
    /// Token increment (or the full text in non-streaming mode).
    Delta { text: String },
    /// Generation finished. `full_text` is the complete assistant reply.
    /// `stopped` is true when the user aborted mid-stream.
    ///
    /// GOTCHA: `rename_all` on the ENUM only renames variant names, not the
    /// fields inside each variant — so `full_text` would serialize as snake_case
    /// and the JS side (which reads `fullText`) would see `undefined`, wiping the
    /// streamed reply to "(空)". Rename the field explicitly to keep the wire
    /// camelCase and matching the `ChatEvent` TS type in src/features/ai/chat.ts.
    Done {
        #[serde(rename = "fullText")]
        full_text: String,
        stopped: bool,
        /// The model the gateway actually served (echoed in the response), so the
        /// UI can show the *real* model — models routinely misreport their version.
        model: String,
    },
    /// Unrecoverable error before/while streaming.
    Error { message: String },
}

/// Send an event, ignoring channel errors (window may be gone).
fn emit(on_event: &Channel<ChatEvent>, ev: ChatEvent) {
    let _ = on_event.send(ev);
}

// ---------------------------------------------------------------------------
// chat command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn chat(
    app: AppHandle,
    state: State<'_, ChatState>,
    on_event: Channel<ChatEvent>,
    prompt: String,
) -> Result<(), ()> {
    // 1. Load config + key (Key is never logged).
    let cfg = match crate::settings::load_settings(app.clone()) {
        Ok(c) => c,
        Err(e) => {
            emit(&on_event, ChatEvent::Error { message: format!("读取设置失败: {e}") });
            return Ok(());
        }
    };
    let key = match crate::settings::load_api_key() {
        Ok(k) => k,
        Err(e) => {
            emit(&on_event, ChatEvent::Error { message: format!("读取 API Key 失败: {e}") });
            return Ok(());
        }
    };

    let base = cfg.ai.base_url.trim().trim_end_matches('/').to_string();
    let model = cfg.ai.model.trim();
    let key_missing = key.as_deref().map(str::is_empty).unwrap_or(true);
    if base.is_empty() || model.is_empty() || key_missing {
        emit(
            &on_event,
            ChatEvent::Error {
                message: "未配置 BaseURL / Model / API Key，请在设置中填写。".to_string(),
            },
        );
        return Ok(());
    }

    // 2. Snapshot the live context; build request messages (system prepended live).
    let ctx: Vec<ChatMessage> = state.messages.lock().unwrap().clone();
    let mut req_msgs: Vec<Value> = Vec::with_capacity(ctx.len() + 2);
    let sys = cfg.ai.system_prompt.trim();
    if !sys.is_empty() {
        req_msgs.push(json!({ "role": "system", "content": sys }));
    }
    for m in &ctx {
        req_msgs.push(json!({ "role": m.role, "content": m.content }));
    }
    req_msgs.push(json!({ "role": "user", "content": prompt }));

    let want_stream = cfg.ai.stream;
    let body = json!({
        "model": model,
        "messages": req_msgs,
        "temperature": cfg.ai.temperature,
        "stream": want_stream,
    });

    // 3. Register the abort flag for this call.
    let abort_flag = Arc::new(AtomicBool::new(false));
    *state.abort.lock().unwrap() = Some(abort_flag.clone());

    // 4. Send the request (no overall timeout — long streams would be killed).
    let client = match reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            emit(&on_event, ChatEvent::Error { message: format!("HTTP client 构建失败: {e}") });
            *state.abort.lock().unwrap() = None;
            return Ok(());
        }
    };
    let resp = match client
        .post(format!("{base}/chat/completions"))
        .bearer_auth(key.as_deref().unwrap_or(""))
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            emit(&on_event, ChatEvent::Error { message: format!("请求失败: {e}") });
            *state.abort.lock().unwrap() = None;
            return Ok(());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        let snippet: String = body_text.chars().take(500).collect();
        emit(&on_event, ChatEvent::Error { message: format!("HTTP {status}: {snippet}") });
        *state.abort.lock().unwrap() = None;
        return Ok(());
    }

    // 5. Consume the response.
    let mut assistant_text = String::new();
    let mut stopped = false;
    // The model the server echoes back (each SSE chunk / the JSON carries it).
    // Captured so the UI can display the *actual* model, not a self-claimed one.
    let mut echoed_model = String::new();

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // Keep the raw body so we can fall back to single-JSON parsing or surface a
    // diagnostic when SSE yields nothing.
    let mut raw_all: Vec<u8> = Vec::new();

    if want_stream {
        let mut stream = resp.bytes_stream();
        let mut pending: Vec<u8> = Vec::new();
        let mut done = false;

        'outer: while let Some(chunk_res) = stream.next().await {
            let chunk = match chunk_res {
                Ok(c) => c,
                // Treat a mid-stream break as a graceful end (some servers omit
                // the final [DONE]); commit whatever we have.
                Err(_) => break 'outer,
            };
            raw_all.extend_from_slice(&chunk);
            pending.extend_from_slice(&chunk);

            // Drain complete lines (terminated by '\n').
            while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
                let line: String = String::from_utf8_lossy(&pending[..pos]).trim().to_string();
                pending.drain(..=pos);
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    done = true;
                    break;
                }
                if data.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(data) {
                    if echoed_model.is_empty() {
                        if let Some(m) = v["model"].as_str() {
                            echoed_model = m.to_string();
                        }
                    }
                    if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                        assistant_text.push_str(t);
                        emit(&on_event, ChatEvent::Delta { text: t.to_string() });
                    }
                }
            }

            if done {
                break 'outer;
            }
            if abort_flag.load(Ordering::Acquire) {
                stopped = true;
                break 'outer;
            }
        }
    } else {
        match resp.json::<Value>().await {
            Ok(v) => {
                if let Some(m) = v["model"].as_str() {
                    echoed_model = m.to_string();
                }
                if let Some(t) = v["choices"][0]["message"]["content"].as_str() {
                    assistant_text = t.to_string();
                    emit(&on_event, ChatEvent::Delta { text: assistant_text.clone() });
                } else {
                    emit(
                        &on_event,
                        ChatEvent::Error {
                            message: "响应缺少 choices[0].message.content".to_string(),
                        },
                    );
                    *state.abort.lock().unwrap() = None;
                    return Ok(());
                }
            }
            Err(e) => {
                emit(&on_event, ChatEvent::Error { message: format!("解析响应失败: {e}") });
                *state.abort.lock().unwrap() = None;
                return Ok(());
            }
        }
    }

    // Fallback: some "OpenAI-compatible" servers ignore `stream:true` and return
    // a single JSON object (no `data:` lines). If SSE yielded nothing, try the raw
    // body as a plain chat completion.
    if assistant_text.is_empty() && !raw_all.is_empty() {
        if let Ok(v) = serde_json::from_slice::<Value>(&raw_all) {
            if let Some(t) = v["choices"][0]["message"]["content"].as_str() {
                assistant_text = t.to_string();
                emit(&on_event, ChatEvent::Delta { text: assistant_text.clone() });
            }
        }
    }

    // Still nothing -> surface a diagnostic so we can see what the server sent.
    if assistant_text.is_empty() {
        let snippet: String = String::from_utf8_lossy(&raw_all).chars().take(300).collect();
        *state.abort.lock().unwrap() = None;
        emit(
            &on_event,
            ChatEvent::Error {
                message: format!(
                    "未解析到回复内容。HTTP {status}, content-type=\"{content_type}\"。原始前300字符：{snippet}"
                ),
            },
        );
        return Ok(());
    }

    // 6. Commit the turn (user + assistant). Partial text on abort keeps the
    //    conversation coherent for the next turn.
    {
        let mut msgs = state.messages.lock().unwrap();
        *msgs = ctx;
        msgs.push(ChatMessage {
            role: "user".to_string(),
            content: prompt,
        });
        msgs.push(ChatMessage {
            role: "assistant".to_string(),
            content: assistant_text.clone(),
        });
    }
    *state.abort.lock().unwrap() = None;
    emit(
        &on_event,
        ChatEvent::Done {
            full_text: assistant_text,
            stopped,
            model: echoed_model,
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// stop / clear
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn stop_chat(state: State<'_, ChatState>) {
    if let Some(flag) = state.abort.lock().unwrap().as_ref() {
        flag.store(true, Ordering::Release);
    }
}

#[tauri::command]
pub fn clear_context(state: State<'_, ChatState>) {
    *state.messages.lock().unwrap() = Vec::new();
}

/// Read the full in-memory conversation context (user + assistant turns).
/// Rust `ChatState` is the single source of truth: the result window hydrates
/// from this on (re)open so history survives close/reopen of the overlay.
#[tauri::command]
pub fn get_messages(state: State<'_, ChatState>) -> Vec<ChatMessage> {
    state.messages.lock().unwrap().clone()
}

// ---------------------------------------------------------------------------
// ask_once (one-shot Q&A; used by `/trans`)
// ---------------------------------------------------------------------------

/// One-shot, non-streaming chat completion that does NOT touch `ChatState` —
/// the prompt is answered in isolation (no prior turns, no system prompt, no
/// commit afterwards). This keeps tool-style commands like translation from
/// polluting the main conversation context. The caller (frontend) wraps the raw
/// user intent into a self-contained `prompt` before invoking.
#[tauri::command]
pub async fn ask_once(app: AppHandle, prompt: String) -> Result<String, String> {
    let cfg = crate::settings::load_settings(app).map_err(|e| format!("读取设置失败: {e}"))?;
    let key = crate::settings::load_api_key().map_err(|e| format!("读取 API Key 失败: {e}"))?;

    let base = cfg.ai.base_url.trim().trim_end_matches('/').to_string();
    let model = cfg.ai.model.trim();
    let key_missing = key.as_deref().map(str::is_empty).unwrap_or(true);
    if base.is_empty() || model.is_empty() || key_missing {
        return Err("未配置 BaseURL / Model / API Key，请在设置中填写。".to_string());
    }

    let client = match reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => return Err(format!("HTTP client 构建失败: {e}")),
    };

    // No system prompt, no history — just the self-contained prompt. `stream`
    // is false so this resolves to a single JSON object.
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "temperature": cfg.ai.temperature,
        "stream": false,
    });

    let resp = match client
        .post(format!("{base}/chat/completions"))
        .bearer_auth(key.as_deref().unwrap_or(""))
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return Err(format!("请求失败: {e}")),
    };

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let txt = resp.text().await.unwrap_or_default();

    // SPA fallback: gateway served HTML (BaseURL likely missing /v1).
    let lower = txt.trim_start().to_lowercase();
    let looks_like_html = content_type.contains("text/html")
        || lower.starts_with("<!doctype")
        || lower.starts_with("<html");
    if looks_like_html {
        return Err(format!(
            "服务器返回了网页(HTML)而非 API 响应(HTTP {status})。BaseURL 很可能缺少 /v1 前缀，应改为: {base}/v1"
        ));
    }

    if !status.is_success() {
        let snippet: String = txt.chars().take(500).collect();
        return Err(format!("HTTP {status}: {snippet}"));
    }

    let v: Value = match serde_json::from_str(&txt) {
        Ok(v) => v,
        Err(e) => {
            let snippet: String = txt.chars().take(300).collect();
            return Err(format!("解析响应失败: {e}；前300字符: {snippet}"));
        }
    };
    if !v["error"].is_null() {
        let snippet: String = txt.chars().take(300).collect();
        return Err(format!("API 报错: {snippet}"));
    }

    v["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "响应缺少 choices[0].message.content".to_string())
}

// ---------------------------------------------------------------------------
// ask_once_stream (streaming one-shot; used by `/trans`)
// ---------------------------------------------------------------------------

/// Streaming variant of `ask_once`. Mirrors `chat`'s SSE pipeline token-for-
/// token but is CONTEXT-FREE: a single self-contained `prompt`, no system
/// prompt, no prior turns, and NO commit to `ChatState.messages` afterward — so
/// a rich dictionary-style translation neither pollutes nor depends on the main
/// conversation (same isolation goal as `ask_once`).
///
/// The shared `ChatState.abort` flag IS still registered, so the frontend
/// "stop" button (`stop_chat`) interrupts this stream exactly like `chat`. Only
/// `.abort` is touched; `.messages` is left untouched.
#[tauri::command]
pub async fn ask_once_stream(
    app: AppHandle,
    state: State<'_, ChatState>,
    on_event: Channel<ChatEvent>,
    prompt: String,
) -> Result<(), ()> {
    // 1. Load config + key (key is never logged).
    let cfg = match crate::settings::load_settings(app.clone()) {
        Ok(c) => c,
        Err(e) => {
            emit(&on_event, ChatEvent::Error { message: format!("读取设置失败: {e}") });
            return Ok(());
        }
    };
    let key = match crate::settings::load_api_key() {
        Ok(k) => k,
        Err(e) => {
            emit(&on_event, ChatEvent::Error { message: format!("读取 API Key 失败: {e}") });
            return Ok(());
        }
    };

    let base = cfg.ai.base_url.trim().trim_end_matches('/').to_string();
    let model = cfg.ai.model.trim();
    let key_missing = key.as_deref().map(str::is_empty).unwrap_or(true);
    if base.is_empty() || model.is_empty() || key_missing {
        emit(
            &on_event,
            ChatEvent::Error {
                message: "未配置 BaseURL / Model / API Key，请在设置中填写。".to_string(),
            },
        );
        return Ok(());
    }

    // 2. Context-free request: just the self-contained prompt (no history, no
    //    system prompt). `stream` tracks the live setting like `chat` does.
    let want_stream = cfg.ai.stream;
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "temperature": cfg.ai.temperature,
        "stream": want_stream,
    });

    // 3. Register the abort flag so `stop_chat` can interrupt this stream.
    let abort_flag = Arc::new(AtomicBool::new(false));
    *state.abort.lock().unwrap() = Some(abort_flag.clone());

    // 4. Send the request (no overall timeout — long streams would be killed).
    let client = match reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            emit(&on_event, ChatEvent::Error { message: format!("HTTP client 构建失败: {e}") });
            *state.abort.lock().unwrap() = None;
            return Ok(());
        }
    };
    let resp = match client
        .post(format!("{base}/chat/completions"))
        .bearer_auth(key.as_deref().unwrap_or(""))
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            emit(&on_event, ChatEvent::Error { message: format!("请求失败: {e}") });
            *state.abort.lock().unwrap() = None;
            return Ok(());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        let snippet: String = body_text.chars().take(500).collect();
        emit(&on_event, ChatEvent::Error { message: format!("HTTP {status}: {snippet}") });
        *state.abort.lock().unwrap() = None;
        return Ok(());
    }

    // 5. Consume the response — identical SSE/JSON handling to `chat`, minus the
    //    context commit. Tokens stream to the frontend as they arrive.
    let mut assistant_text = String::new();
    let mut stopped = false;
    let mut echoed_model = String::new();

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // Keep the raw body for the single-JSON fallback / empty-content diagnostic.
    let mut raw_all: Vec<u8> = Vec::new();

    if want_stream {
        let mut stream = resp.bytes_stream();
        let mut pending: Vec<u8> = Vec::new();
        let mut done = false;

        'outer: while let Some(chunk_res) = stream.next().await {
            let chunk = match chunk_res {
                Ok(c) => c,
                // Treat a mid-stream break as a graceful end (some servers omit
                // the final [DONE]); commit whatever we have.
                Err(_) => break 'outer,
            };
            raw_all.extend_from_slice(&chunk);
            pending.extend_from_slice(&chunk);

            // Drain complete lines (terminated by '\n').
            while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
                let line: String = String::from_utf8_lossy(&pending[..pos]).trim().to_string();
                pending.drain(..=pos);
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data == "[DONE]" {
                    done = true;
                    break;
                }
                if data.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(data) {
                    if echoed_model.is_empty() {
                        if let Some(m) = v["model"].as_str() {
                            echoed_model = m.to_string();
                        }
                    }
                    if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                        assistant_text.push_str(t);
                        emit(&on_event, ChatEvent::Delta { text: t.to_string() });
                    }
                }
            }

            if done {
                break 'outer;
            }
            if abort_flag.load(Ordering::Acquire) {
                stopped = true;
                break 'outer;
            }
        }
    } else {
        match resp.json::<Value>().await {
            Ok(v) => {
                if let Some(m) = v["model"].as_str() {
                    echoed_model = m.to_string();
                }
                if let Some(t) = v["choices"][0]["message"]["content"].as_str() {
                    assistant_text = t.to_string();
                    emit(&on_event, ChatEvent::Delta { text: assistant_text.clone() });
                } else {
                    emit(
                        &on_event,
                        ChatEvent::Error {
                            message: "响应缺少 choices[0].message.content".to_string(),
                        },
                    );
                    *state.abort.lock().unwrap() = None;
                    return Ok(());
                }
            }
            Err(e) => {
                emit(&on_event, ChatEvent::Error { message: format!("解析响应失败: {e}") });
                *state.abort.lock().unwrap() = None;
                return Ok(());
            }
        }
    }

    // Fallback: some "OpenAI-compatible" servers ignore `stream:true` and return
    // a single JSON object (no `data:` lines). If SSE yielded nothing, try the
    // raw body as a plain chat completion.
    if assistant_text.is_empty() && !raw_all.is_empty() {
        if let Ok(v) = serde_json::from_slice::<Value>(&raw_all) {
            if let Some(t) = v["choices"][0]["message"]["content"].as_str() {
                assistant_text = t.to_string();
                emit(&on_event, ChatEvent::Delta { text: assistant_text.clone() });
            }
        }
    }

    // Still nothing -> surface a diagnostic so we can see what the server sent.
    if assistant_text.is_empty() {
        let snippet: String = String::from_utf8_lossy(&raw_all).chars().take(300).collect();
        *state.abort.lock().unwrap() = None;
        emit(
            &on_event,
            ChatEvent::Error {
                message: format!(
                    "未解析到回复内容。HTTP {status}, content-type=\"{content_type}\"。原始前300字符：{snippet}"
                ),
            },
        );
        return Ok(());
    }

    // 6. No ChatState commit — this stays context-free. Clear the abort flag and
    //    deliver the final text (partial on abort keeps the result coherent).
    *state.abort.lock().unwrap() = None;
    emit(
        &on_event,
        ChatEvent::Done {
            full_text: assistant_text,
            stopped,
            model: echoed_model,
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// connectivity test (settings "测试连接")
// ---------------------------------------------------------------------------

/// Result of a one-shot connection probe. `model` is what the gateway echoed
/// back (the *real* model); shown in the UI so users can confirm the model name.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub model: String,
    pub reply: String,
    pub message: String,
}

/// Minimal non-streaming chat request to verify BaseURL / Model / API Key.
/// `base_url`/`model`/`key` come from the live settings form (so users can test
/// before saving); an empty `key` falls back to the value stored in the keyring.
#[tauri::command]
pub async fn test_ai_connection(
    base_url: String,
    model: String,
    key: String,
) -> Result<TestResult, ()> {
    let base = base_url.trim().trim_end_matches('/').to_string();
    let model = model.trim().to_string();
    let key = if key.trim().is_empty() {
        match crate::settings::load_api_key() {
            Ok(Some(k)) => k,
            _ => String::new(),
        }
    } else {
        key.trim().to_string()
    };
    if base.is_empty() || model.is_empty() {
        return Ok(TestResult {
            ok: false,
            model: String::new(),
            reply: String::new(),
            message: "BaseURL / Model 未填写".to_string(),
        });
    }
    if key.is_empty() {
        return Ok(TestResult {
            ok: false,
            model: String::new(),
            reply: String::new(),
            message: "未设置 API Key".to_string(),
        });
    }

    let client = match reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            return Ok(TestResult {
                ok: false,
                model: String::new(),
                reply: String::new(),
                message: format!("HTTP client 构建失败: {e}"),
            })
        }
    };
    let body = json!({
        "model": model,
        "messages": [{"role":"user","content":"reply with exactly: OK"}],
        "stream": false,
        "temperature": 0.0,
    });
    let resp = match client
        .post(format!("{base}/chat/completions"))
        .bearer_auth(&key)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return Ok(TestResult {
                ok: false,
                model: String::new(),
                reply: String::new(),
                message: format!("请求失败: {e}"),
            })
        }
    };

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let txt = resp.text().await.unwrap_or_default();

    // SPA fallback: the gateway served its HTML page instead of an API response.
    // Almost always means the BaseURL is missing the `/v1` prefix.
    let lower = txt.trim_start().to_lowercase();
    let looks_like_html = content_type.contains("text/html")
        || lower.starts_with("<!doctype")
        || lower.starts_with("<html");
    if looks_like_html {
        return Ok(TestResult {
            ok: false,
            model: String::new(),
            reply: String::new(),
            message: format!(
                "服务器返回了网页(HTML)而非 API 响应(HTTP {status})。BaseURL 很可能缺少 /v1 前缀，应改为: {base}/v1"
            ),
        });
    }

    if !status.is_success() {
        let snippet: String = txt.chars().take(300).collect();
        return Ok(TestResult {
            ok: false,
            model: String::new(),
            reply: String::new(),
            message: format!("HTTP {status}: {snippet}"),
        });
    }

    match serde_json::from_str::<Value>(&txt) {
        Ok(v) => {
            let echoed = v["model"].as_str().unwrap_or("").to_string();
            if !v["error"].is_null() {
                let snippet: String = txt.chars().take(300).collect();
                return Ok(TestResult {
                    ok: false,
                    model: echoed,
                    reply: String::new(),
                    message: format!("API 报错: {snippet}"),
                });
            }
            let reply: String = v["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(80)
                .collect();
            Ok(TestResult {
                ok: true,
                model: echoed,
                reply,
                message: String::new(),
            })
        }
        Err(e) => {
            let snippet: String = txt.chars().take(300).collect();
            Ok(TestResult {
                ok: false,
                model: String::new(),
                reply: String::new(),
                message: format!("解析响应失败: {e}；前300字符: {snippet}"),
            })
        }
    }
}
