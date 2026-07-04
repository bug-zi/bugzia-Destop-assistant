/**
 * Inter-window event contract between the main window (the streaming driver)
 * and the result overlay window (the chat mirror). Routed via global Tauri
 * events, same pattern as `settings:updated`. Event names live in `EV` so both
 * sides share one source of truth — no string drift.
 *
 * Architectural note: the main window is the SOLE writer of the AI stream
 * (Plan A, design §9.3). It owns the authoritative `messages` mirror; the result
 * window is a mirror that hydrates from `get_messages` then catches up via
 * `result:replay` (which carries the in-flight assistant bubble `get_messages`
 * does not yet contain — backend only commits a turn at `done`).
 */
import type { ChatMessage } from "../ai/chat";

/** Which surface the result overlay shows. */
export type ResultMode = "chat" | "file" | "daily";

/** A single local file/dir hit from `search_files` (mirrors the Rust struct). */
export interface FileResult {
  name: string;
  path: string;
  /** lowercased extension without the dot, or "" */
  ext: string;
  /** "file" | "dir" */
  kind: string;
  /** bytes */
  size: number;
  /** modification time, Unix ms (frontend formats via Date) */
  modified: number;
}

// ── Main window  ->  Result window ──────────────────────────────────────────

/** Snapshot replace: the FULL overlay view — mode + chat mirror + file view.
 *  Sent on `result:ready` (and to push a fresh file search). The result window
 *  treats this as authoritative and replaces its state wholesale. */
export interface ResultReplay {
  mode: ResultMode;
  messages: ChatMessage[];
  generating: boolean;
  fileResults: FileResult[];
  fileQuery: string;
  /** True while a `/file` walk is in flight (shown instead of "no results"). */
  searching: boolean;
}

/** Flip only the surface mode (used at chat-start to leave a file view without
 *  wiping the in-flight stream a full replay would clobber). */
export interface ResultSetMode {
  mode: ResultMode;
}

/** Begin a new turn: append a user bubble + an empty assistant placeholder. */
export interface ResultChatStart {
  userText: string;
}

/** Append `text` to the last assistant bubble. */
export interface ResultChatDelta {
  text: string;
}

/** Finalize the last assistant bubble with the full text + served model. */
export interface ResultChatDone {
  fullText: string;
  model: string;
  stopped: boolean;
}

/** Mark the last assistant bubble as an error. */
export interface ResultChatError {
  message: string;
}

// ── Result window  ->  Main window ──────────────────────────────────────────

/** Result window finished mounting + hydrating; main replies with a replay. */
export type ResultReady = Record<string, never>;

/** User clicked stop in the result window. */
export type CommandStopChat = Record<string, never>;

/** User clicked clear-context in the result window. */
export type CommandClearContext = Record<string, never>;

/** User clicked "新对话" in the result window — start a fresh conversation. */
export type CommandNewConversation = Record<string, never>;

/** User clicked a conversation in the history rail — resume it by id. */
export interface HistoryResume {
  id: string;
}

/** User clicked close (or pressed Esc unpinned) in the result window. */
export type CommandCloseResult = Record<string, never>;

/** User toggled the pin. Main stores it to decide Esc behavior. */
export interface CommandPinnedChanged {
  pinned: boolean;
}

// ── Event names ─────────────────────────────────────────────────────────────

export const EV = {
  // main -> result
  RESULT_SHOW: "result:show",
  RESULT_REPLAY: "result:replay",
  RESULT_SET_MODE: "result:set-mode",
  RESULT_CHAT_START: "result:chat-start",
  RESULT_CHAT_DELTA: "result:chat-delta",
  RESULT_CHAT_DONE: "result:chat-done",
  RESULT_CHAT_ERROR: "result:chat-error",
  RESULT_CHAT_CLEARED: "result:chat-cleared",
  RESULT_HIDE: "result:hide",
  HISTORY_CHANGED: "history:changed",
  // result -> main
  RESULT_READY: "result:ready",
  COMMAND_STOP_CHAT: "command:stop-chat",
  COMMAND_CLEAR_CONTEXT: "command:clear-context",
  COMMAND_NEW_CONVERSATION: "command:new-conversation",
  HISTORY_RESUME: "history:resume",
  COMMAND_CLOSE_RESULT: "command:close-result",
  COMMAND_PINNED_CHANGED: "command:pinned-changed",
} as const;
