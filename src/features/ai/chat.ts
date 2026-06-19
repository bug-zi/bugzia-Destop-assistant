import { invoke, Channel } from "@tauri-apps/api/core";

/**
 * Events streamed from the Rust `chat` command (mirrors `ChatEvent` in
 * src-tauri/src/ai.rs). `on_event` (Rust) ↔ `onEvent` (JS).
 */
export type ChatEvent =
  | { event: "delta"; data: { text: string } }
  | { event: "done"; data: { fullText: string; stopped: boolean; model: string } }
  | { event: "error"; data: { message: string } };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** The model the gateway actually served (echoed). Assistant turns only. */
  model?: string;
}

/**
 * Start a streaming chat turn. Token deltas arrive via `onEvent`; the returned
 * promise resolves when the backend command returns (after the final `done`).
 */
export function streamChat(prompt: string, onEvent: (e: ChatEvent) => void): Promise<void> {
  const ch = new Channel<ChatEvent>();
  ch.onmessage = onEvent;
  return invoke("chat", { prompt, onEvent: ch });
}

/** Abort the in-flight generation (takes effect at the next streamed token). */
export function stopChat(): Promise<void> {
  return invoke("stop_chat");
}

/** Forget the conversation context on the backend. */
export function clearContext(): Promise<void> {
  return invoke("clear_context");
}

/**
 * Read the full in-memory conversation context (user + assistant turns) from the
 * backend. Rust `ChatState` is the single source of truth; the result window
 * hydrates from this on (re)open so history survives close/reopen.
 */
export function getMessages(): Promise<ChatMessage[]> {
  return invoke<ChatMessage[]>("get_messages");
}
