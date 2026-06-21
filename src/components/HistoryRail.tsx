import { useEffect, useRef, useState } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  listConversations,
  setConversationLocked,
  deleteConversation,
  renameConversation,
  reorderConversations,
  type ConvSummary,
} from "../features/conversations/conversations";
import { EV } from "../features/result/resultTypes";
import "./HistoryRail.css";

function logErr(label: string) {
  return (e: unknown) => console.error(`[bugzia] ${label}`, e);
}

/** Short relative-time label for a Unix-ms timestamp. */
function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Left rail listing saved conversations. Resume emits to the main window (which
 * owns the mirror + ChatState); lock/delete run directly against the backend
 * then refresh locally. Listens for `history:changed` (main pings after every
 * persist) so the list stays current while the rail is open.
 */
export default function HistoryRail() {
  const [items, setItems] = useState<ConvSummary[]>([]);
  const [loading, setLoading] = useState(true);
  /** Which conversation is being renamed inline (its id), or null. */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Draft text of the in-progress rename. */
  const [draft, setDraft] = useState("");
  /** Guards commitRename against a double-fire: Enter fires keydown, then the
   *  input unmounts and the focus loss fires blur — both would call commit. */
  const renamingIdRef = useRef<string | null>(null);
  /** Index of the item being dragged, or null. */
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  /** Index of the item the pointer is currently hovering over, or null. */
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const refresh = async () => {
    try {
      setItems(await listConversations());
    } catch (e) {
      logErr("list conversations")(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    let off: UnlistenFn | undefined;
    (async () => {
      off = await listen(EV.HISTORY_CHANGED, () => void refresh());
    })();
    return () => off?.();
  }, []);

  const toggleLock = async (id: string, locked: boolean) => {
    try {
      await setConversationLocked(id, !locked);
      await refresh();
      // Ping main so it can react if the locked state of the active chat
      // changed (and so any other open rails sync — harmless otherwise).
      emit(EV.HISTORY_CHANGED).catch(logErr("emit history-changed"));
    } catch (e) {
      logErr("toggle lock")(e);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteConversation(id);
      await refresh();
      // Main clears its mirror if this was the active conversation.
      emit(EV.HISTORY_CHANGED).catch(logErr("emit history-changed"));
    } catch (e) {
      logErr("delete conversation")(e);
    }
  };

  const startEdit = (c: ConvSummary) => {
    setDraft(c.title);
    setEditingId(c.id);
  };

  const cancelRename = () => {
    setEditingId(null);
    setDraft("");
  };

  /** Commit the draft as the new name. No-op when the box is empty (treated as
   *  cancel) or unchanged. `renamingIdRef` dedupes the Enter + blur double-fire. */
  const commitRename = async (id: string) => {
    if (renamingIdRef.current === id) return;
    const trimmed = draft.trim();
    const current = items.find((c) => c.id === id);
    setEditingId(null);
    renamingIdRef.current = id;
    if (!trimmed || (current && trimmed === current.title)) {
      renamingIdRef.current = null;
      return;
    }
    try {
      await renameConversation(id, trimmed);
      await refresh();
      // Sync any other open rails. The main window only re-derives titles on
      // its own upserts, so it ignores this ping — harmless either way.
      emit(EV.HISTORY_CHANGED).catch(logErr("emit history-changed"));
    } catch (e) {
      logErr("rename conversation")(e);
    } finally {
      renamingIdRef.current = null;
    }
  };

  /** Drop handler: splice the dragged item to the hover position (optimistic),
   *  persist the full id order, and roll back on failure. Index is corrected
   *  when dragging downward because removing the source shifts the target. */
  const commitReorder = async () => {
    if (dragIndex === null || overIndex === null || dragIndex === overIndex) {
      setDragIndex(null);
      setOverIndex(null);
      return;
    }
    const next = [...items];
    const [moved] = next.splice(dragIndex, 1);
    const target = dragIndex < overIndex ? overIndex - 1 : overIndex;
    next.splice(target, 0, moved);
    setItems(next);
    setDragIndex(null);
    setOverIndex(null);
    try {
      await reorderConversations(next.map((c) => c.id));
      // Sync any other open rails. Main ignores this ping (it only re-derives
      // titles on its own upserts) — harmless either way.
      emit(EV.HISTORY_CHANGED).catch(logErr("emit history-changed"));
    } catch (e) {
      logErr("reorder conversations")(e);
      await refresh(); // Roll back to the backend's truth.
    }
  };

  const resume = (id: string) => {
    emit(EV.HISTORY_RESUME, { id }).catch(logErr("emit resume"));
  };

  return (
    <div className="history-rail">
      <div className="history-rail-head">历史对话</div>
      <div className="history-rail-list">
        {loading ? (
          <div className="history-rail-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="history-rail-empty">还没有历史对话</div>
        ) : (
          items.map((c, i) => {
            const editing = editingId === c.id;
            const dragging = dragIndex === i;
            const dragOver = overIndex === i && dragIndex !== null && dragIndex !== i;
            return (
              <div
                key={c.id}
                className={
                  "history-item" +
                  (c.locked ? " is-locked" : "") +
                  (dragging ? " is-dragging" : "") +
                  (dragOver ? " is-drag-over" : "")
                }
                draggable={!editing}
                onDragStart={(e) => {
                  // Some WebViews (WebKit/WebKitGTK) need effectAllowed + a
                  // payload to start a drag on a non-text element; Chromium
                  // tolerates their absence but we set them for cross-platform
                  // robustness. The payload value is unused — dragIndex is the
                  // source of truth.
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(i));
                  setDragIndex(i);
                }}
                onDragOver={(e) => {
                  e.preventDefault(); // allow drop
                  e.dataTransfer.dropEffect = "move";
                  setOverIndex(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  void commitReorder();
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
              >
                {editing ? (
                  <input
                    className="history-item-edit"
                    type="text"
                    value={draft}
                    autoFocus
                    // Select all on focus so the rename starts as a clean replace.
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitRename(c.id);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                    onBlur={() => void commitRename(c.id)}
                    title="Enter 保存 · Esc 取消"
                  />
                ) : (
                  <>
                    <button
                      className="history-item-main"
                      type="button"
                      onClick={() => resume(c.id)}
                      title={c.title}
                    >
                      <span className="history-item-title">{c.title}</span>
                      <span className="history-item-meta">
                        {relTime(c.updatedAt)} · {c.messageCount} 条
                      </span>
                    </button>
                    <button
                      className={"history-item-btn" + (c.locked ? " active" : "")}
                      type="button"
                      onClick={() => toggleLock(c.id, c.locked)}
                      aria-pressed={c.locked}
                      title={c.locked ? "已锁定（永久保留）— 点击解锁" : "锁定后永久保留，不被自动清理"}
                    >
                      {c.locked ? "锁定" : "锁"}
                    </button>
                    <button
                      className="history-item-btn"
                      type="button"
                      onClick={() => startEdit(c)}
                      title="重命名"
                    >
                      修
                    </button>
                    <button
                      className="history-item-btn danger"
                      type="button"
                      onClick={() => remove(c.id)}
                      title="删除"
                    >
                      删
                    </button>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
