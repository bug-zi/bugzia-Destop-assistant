import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage } from "../ai/chat";

/**
 * Conversation persistence (mirrors `Conversation` / `ConvSummary` in
 * src-tauri/src/conversations.rs). The backend is dumb storage + retention;
 * the main window drives it (upsert on every turn, resume/lock/delete from
 * the history rail).
 *
 * `ConvMessage` is shape-compatible with `ChatMessage` (role/content/optional
 * model) so the live mirror saves and restores without conversion.
 */
export interface ConvMessage {
  role: "user" | "assistant";
  content: string;
  /** Echoed model (assistant turns only); omitted on user turns. */
  model?: string;
}

/** Lightweight list item for the history rail (no full messages). */
export interface ConvSummary {
  id: string;
  title: string;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms — retention sorts by this. */
  updatedAt: number;
  locked: boolean;
  messageCount: number;
}

/** List every saved conversation (locked + recent unlocked), newest first. */
export function listConversations(): Promise<ConvSummary[]> {
  return invoke<ConvSummary[]>("list_conversations");
}

/** Full messages of one conversation (for resume). */
export function getConversation(id: string): Promise<ConvMessage[]> {
  return invoke<ConvMessage[]>("get_conversation", { id });
}

/**
 * Create or update a conversation. Pass `id = null` to create (the backend
 * mints one and returns it). Retention (keep all locked + 10 most-recent
 * unlocked) runs server-side. Returns the effective id.
 */
export function upsertConversation(
  id: string | null,
  title: string,
  messages: ConvMessage[],
): Promise<string> {
  return invoke<string>("upsert_conversation", { id, title, messages });
}

/** Lock (true) / unlock (false). Locked conversations are exempt from retention. */
export function setConversationLocked(id: string, locked: boolean): Promise<void> {
  return invoke("set_conversation_locked", { id, locked });
}

/** Delete one conversation (locked ones may also be deleted explicitly). */
export function deleteConversation(id: string): Promise<void> {
  return invoke("delete_conversation", { id });
}

/** Rename one conversation. Sets a user-visible name override that survives
 *  later upserts — which would otherwise re-derive the title from the first
 *  user message on every turn and clobber a manual rename. An empty string
 *  clears the override, falling back to the auto-derived title. */
export function renameConversation(id: string, title: string): Promise<void> {
  return invoke("rename_conversation", { id, title });
}

/** Build a title from the first user message, truncated — matches backend logic
 *  so the rail can show a title before the first save round-trip. */
export function deriveTitle(messages: ChatMessage[]): string {
  for (const m of messages) {
    if (m.role === "user" && m.content.trim()) {
      const trimmed = m.content.trim();
      const count = [...trimmed].length;
      const snippet = [...trimmed].slice(0, 30).join("");
      return count > 30 ? `${snippet}…` : snippet;
    }
  }
  return "新对话";
}

/**
 * Persist a new manual order. Pass the full conversation-id list in the
 * desired top-to-bottom order. The backend reassigns each conversation's
 * `order` to its index (0..n). Called from the history rail after a drag.
 */
export function reorderConversations(orderedIds: string[]): Promise<void> {
  return invoke("reorder_conversations", { orderedIds });
}
