import { useEffect, useState } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  listConversations,
  setConversationLocked,
  deleteConversation,
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
          items.map((c) => (
            <div key={c.id} className={"history-item" + (c.locked ? " is-locked" : "")}>
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
                className="history-item-btn danger"
                type="button"
                onClick={() => remove(c.id)}
                title="删除"
              >
                删
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
