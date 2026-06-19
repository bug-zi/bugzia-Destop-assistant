import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import ChatView from "./ChatView";
import FileResultsView from "./FileResultsView";
import "./ResultWindow.css";
import { getMessages, type ChatMessage } from "../features/ai/chat";
import {
  EV,
  type ResultMode,
  type ResultReplay,
  type ResultChatStart,
  type ResultChatDelta,
  type ResultChatDone,
  type ResultChatError,
  type ResultSetMode,
  type FileResult,
} from "../features/result/resultTypes";
import { loadSettings } from "../features/settings/settingsStore";
import type { SettingsPatch } from "../features/settings/settingsTypes";
import { applyAppearanceVars, applyResultVars } from "../features/appearance/appearance";

function logErr(label: string) {
  return (e: unknown) => console.error(`[bugzia] ${label}`, e);
}

/** Pin/thumbtack icon — outline when unpinned, filled when pinned. Mirrors the
 *  SparkIcon pattern in InputBar. Toggling it drives the result window's
 *  always-on-top (via the `set_result_always_on_top` backend command). */
function PinIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={active ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

/** Return a new list with the LAST assistant message's content mapped by `fn`.
 *  Mirrors the helper in CommandCard so the result window can append tokens /
 *  finalize / mark errors on the streaming bubble identically. */
function patchLastAssistant(
  msgs: ChatMessage[],
  fn: (content: string) => string,
): ChatMessage[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") {
      const copy = [...msgs];
      copy[i] = { ...copy[i], content: fn(copy[i].content) };
      return copy;
    }
  }
  return msgs;
}

/** Replace the LAST assistant message with finalized content + served model.
 *  `fullText` is authoritative (the gateway's complete reply); fall back to the
 *  already-streamed text when the payload is empty so a reply is never wiped. */
function finalizeLastAssistant(
  msgs: ChatMessage[],
  fullText: string,
  model: string,
): ChatMessage[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") {
      const copy = [...msgs];
      copy[i] = {
        ...copy[i],
        content: fullText || copy[i].content,
        ...(model ? { model } : {}),
      };
      return copy;
    }
  }
  return msgs;
}

/**
 * Result overlay window root. A MIRROR of the main window's chat — the main
 * window drives the stream and forwards events; this window only renders,
 * hydrates from `get_messages` on mount, then catches up via `result:replay`
 * (which carries the in-flight assistant bubble the backend has not committed
 * yet). Owns no AI requests; talks back to main via `command:*` events.
 *
 * Runs in the result window context: it may call `getCurrentWindow().hide()`
 * and emit/listen events, but NEVER setPosition/setSize (those run in main).
 */
export default function ResultWindow() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [generating, setGenerating] = useState(false);
  const [pinned, setPinned] = useState(false);
  // Which surface the overlay shows. Chat is the default; file mode is pushed
  // by the main window on a `/file` search (and switched back via set-mode).
  const [mode, setMode] = useState<ResultMode>("chat");
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const [fileQuery, setFileQuery] = useState("");
  const [searching, setSearching] = useState(false);
  // Gate live deltas until the first `result:replay` lands, so tokens that
  // arrived while we were still booting aren't applied on top of a stale base.
  const hydratedRef = useRef(false);
  const pinnedRef = useRef(false);

  // ── mount: theme, hydrate from backend truth, register listeners, signal ready ──
  useEffect(() => {
    let alive = true;
    const offs: UnlistenFn[] = [];

    (async () => {
      // Match the main bar's customized glass appearance (design §2.1.4 shared theme).
      try {
        const s = await loadSettings();
        if (alive) {
          applyAppearanceVars(s.appearance);
          applyResultVars(s.result);
        }
      } catch (e) {
        console.error("[bugzia] result load appearance", e);
      }

      // Hydrate from backend-committed turns (survives close/reopen of the overlay).
      try {
        const base = await getMessages();
        if (alive) setMessages(base);
      } catch (e) {
        console.error("[bugzia] result get_messages", e);
      }

      if (!alive) return;

      offs.push(
        await listen<ResultReplay>(EV.RESULT_REPLAY, (ev) => {
          // Authoritative full-snapshot replace: surface mode + chat mirror +
          // file view (carries the in-flight bubble / fresh file results).
          hydratedRef.current = true;
          setMode(ev.payload.mode);
          setMessages(ev.payload.messages);
          setGenerating(ev.payload.generating);
          setFileResults(ev.payload.fileResults);
          setFileQuery(ev.payload.fileQuery);
          setSearching(ev.payload.searching);
        }),
      );
      offs.push(
        await listen<ResultSetMode>(EV.RESULT_SET_MODE, (ev) => {
          // Flip only the surface (e.g. back to chat at the start of a turn)
          // without clobbering the in-flight stream a full replay would.
          if (!hydratedRef.current) return;
          setMode(ev.payload.mode);
        }),
      );
      offs.push(
        await listen<ResultChatStart>(EV.RESULT_CHAT_START, (ev) => {
          if (!hydratedRef.current) return;
          // A turn started: mirror main's generating so the stop button shows
          // and clear stays disabled for the duration of this turn. Without
          // this, `generating` is seeded only once by `result:replay` at mount
          // and never updated again, so it gets stuck and breaks stop/clear.
          setGenerating(true);
          // Idempotent: skip if the last bubble is already this user turn.
          setMessages((m) => {
            const last = m[m.length - 1];
            if (last && last.role === "user" && last.content === ev.payload.userText) {
              return m;
            }
            return [...m, { role: "user", content: ev.payload.userText }, { role: "assistant", content: "" }];
          });
        }),
      );
      offs.push(
        await listen<ResultChatDelta>(EV.RESULT_CHAT_DELTA, (ev) => {
          if (!hydratedRef.current) return;
          setMessages((m) => patchLastAssistant(m, (c) => c + ev.payload.text));
        }),
      );
      offs.push(
        await listen<ResultChatDone>(EV.RESULT_CHAT_DONE, (ev) => {
          if (!hydratedRef.current) return;
          // Turn finished: stop mirroring generating (hides the stop button,
          // re-enables clear). Replay seeds the initial value; this keeps it live.
          setGenerating(false);
          setMessages((m) => finalizeLastAssistant(m, ev.payload.fullText, ev.payload.model));
        }),
      );
      offs.push(
        await listen<ResultChatError>(EV.RESULT_CHAT_ERROR, (ev) => {
          if (!hydratedRef.current) return;
          // Turn failed: also counts as "not generating" anymore.
          setGenerating(false);
          setMessages((m) => patchLastAssistant(m, () => `⚠️ ${ev.payload.message}`));
        }),
      );
      offs.push(
        await listen(EV.RESULT_CHAT_CLEARED, () => {
          setMessages([]);
        }),
      );
      offs.push(
        await listen(EV.RESULT_HIDE, () => {
          void getCurrentWindow().hide().catch(logErr("result hide"));
        }),
      );
      offs.push(
        await listen<SettingsPatch>("settings:updated", (ev) => {
          // Live-apply panel styling as the user drags the result-panel sliders
          // in the settings window — and the global glass theme too, which the
          // overlay otherwise only picks up once on mount.
          applyAppearanceVars(ev.payload.appearance);
          applyResultVars(ev.payload.result);
        }),
      );

      // Tell main we're listening; it replies with a `result:replay`.
      emit(EV.RESULT_READY).catch(logErr("result emit ready"));
    })();

    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  }, []);

  // ── Esc: hide unless pinned (main owns the actual hide lifecycle) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pinnedRef.current) {
        e.preventDefault();
        emit(EV.COMMAND_CLOSE_RESULT).catch(logErr("result emit close"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function togglePin() {
    setPinned((v) => {
      const next = !v;
      pinnedRef.current = next;
      invoke("set_result_always_on_top", { top: next }).catch(logErr("result set always on top"));
      emit(EV.COMMAND_PINNED_CHANGED, { pinned: next }).catch(logErr("result emit pinned"));
      return next;
    });
  }

  const isFile = mode === "file";

  return (
    <div className="result-card">
      <div className="result-header">
        {/* Dedicated drag grip — a SIBLING of the buttons, never an ancestor,
            so button mousedowns are never swallowed by window drag. */}
        <div className="result-grip" data-tauri-drag-region title="拖动结果窗口" />
        <span className="result-title">{isFile ? "文件结果" : "AI 对话"}</span>
        <div className="result-actions">
          <button
            className="result-btn result-btn-icon"
            type="button"
            onClick={togglePin}
            aria-pressed={pinned}
            title={pinned ? "取消固定与置顶（Esc 将可隐藏）" : "固定并置顶（Esc 不再隐藏）"}
          >
            <PinIcon active={pinned} />
          </button>
          <button
            className="result-btn"
            type="button"
            onClick={() => emit(EV.COMMAND_CLOSE_RESULT).catch(logErr("result emit close"))}
            title="关闭结果窗口（不清空上下文）"
          >
            关闭
          </button>
        </div>
      </div>
      <div className="result-body">
        {isFile ? (
          <FileResultsView
            query={fileQuery}
            results={fileResults}
            searching={searching}
            onOpen={(p) => invoke("open_file", { path: p }).catch(logErr("open_file"))}
            onReveal={(p) => invoke("reveal_file", { path: p }).catch(logErr("reveal_file"))}
          />
        ) : (
          <ChatView
            messages={messages}
            generating={generating}
            onStop={() => emit(EV.COMMAND_STOP_CHAT).catch(logErr("result emit stop"))}
            onClear={() => emit(EV.COMMAND_CLEAR_CONTEXT).catch(logErr("result emit clear"))}
          />
        )}
      </div>
    </div>
  );
}
