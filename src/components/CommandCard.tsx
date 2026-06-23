import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import InputBar from "./InputBar";
import "./CommandCard.css";
import { browserSearch, COMMANDS, parseCommand, SEARCH_ENGINES, slashPaletteItems, type CommandMode, type SearchEngine, type SlashPaletteItem } from "../features/search/command";
import { streamChat, streamOnce, stopChat, clearContext, type ChatEvent, type ChatMessage } from "../features/ai/chat";
import { listConversations, getConversation, upsertConversation, deriveTitle } from "../features/conversations/conversations";
import { loadSettings, saveSettings } from "../features/settings/settingsStore";
import { openSettingsWindow } from "../features/settings/settingsWindow";
import { applyAppearanceVars } from "../features/appearance/appearance";
import { DEFAULT_NOTE } from "../features/settings/settingsTypes";
import type { AppSettings, PetSettings, WaveformSettings, WindowSettings, SettingsPatch } from "../features/settings/settingsTypes";
import {
  hideResultWindow,
  isResultVisible,
  onResultGeometryChange,
  showResultWindow,
} from "../features/result/resultWindow";
import {
  hideWaveformWindow,
  onWaveformGeometryChange,
  showWaveformWindow,
} from "../features/waveform/waveformWindow";
import {
  hidePetWindow,
  onPetGeometryChange,
  showPetWindow,
} from "../features/pet/petWindow";
import {
  closeNoteWindow,
  createNoteWindow,
  onNoteGeometryChange,
  setNoteLayer,
} from "../features/note/noteWindow";
import { notesLoad, notesSave } from "../features/note/notesStore";
import {
  NOTE_CHANGED,
  NOTE_DESTROYED,
  NOTE_HYDRATE,
  NOTE_PINNED,
  NOTE_READY,
  NOTE_SETTINGS,
  noteLabel,
  type NoteRecord,
} from "../features/note/noteTypes";
import { EV, type FileResult, type ResultMode } from "../features/result/resultTypes";
import { PET_INPUT_PREVIEW } from "../features/petAgent/petInput";
import {
  emitSlashPaletteState,
  hideSlashPaletteWindow,
  onSlashPaletteAccept,
  onSlashPaletteHover,
  onSlashPaletteKey,
  onSlashPaletteReady,
  showSlashPaletteWindow,
} from "../features/slashPalette/slashPaletteWindow";

const COLLAPSED_H = 64;
const SAVE_DEBOUNCE_MS = 400;

function logErr(label: string) {
  return (e: unknown) => console.error(`[bugzia] ${label}`, e);
}

/** Return a new message list with the LAST assistant message's content mapped by `fn`. */
function patchLastAssistant(msgs: ChatMessage[], fn: (content: string) => string): ChatMessage[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") {
      const copy = [...msgs];
      copy[i] = { ...copy[i], content: fn(copy[i].content) };
      return copy;
    }
  }
  return msgs;
}

/**
 * Keyboard shortcuts active in the input bar (Ctrl+L works from anywhere).
 * Listed by `/help`. Declared as data to mirror the COMMANDS registry style —
 * adding a shortcut means appending a line, not editing prose.
 */
const INPUT_SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: "Enter", desc: "发送（默认为 AI 对话）" },
  { keys: "Ctrl + Enter", desc: "用浏览器搜索（等同 /web）" },
  { keys: "Alt + Enter", desc: "搜索本地文件（等同 /file）" },
  { keys: "Esc", desc: "收起结果框" },
  { keys: "Ctrl + L", desc: "聚焦并全选输入框（任意位置可用）" },
];

/** Clickable affordances on the input bar, left-to-right. Listed by `/help`. */
const INPUT_BUTTONS: { name: string; desc: string }[] = [
  { name: "星标", desc: "展开 / 收起结果框" },
  { name: "齿轮", desc: "打开设置" },
  { name: "拖动输入框空白处", desc: "移动卡片（位置锁定后禁用）" },
];

/** Buttons inside the result overlay. Listed by `/help` for completeness. */
const RESULT_BUTTONS: { name: string; desc: string }[] = [
  { name: "图钉", desc: "固定并置顶（Esc 将不再隐藏结果框）" },
  { name: "历史", desc: "切换历史对话" },
  { name: "关闭", desc: "关闭结果框（不清空对话上下文）" },
];

/**
 * Markdown help rendered by `/help`. Lists every slash command (from the
 * COMMANDS registry) PLUS the keyboard shortcuts and the bar's clickable
 * buttons, so a single command documents how to use the whole input box.
 */
function renderHelpMarkdown(): string {
  const cmdLines = COMMANDS.filter((c) => !c.hidden).map((c) => {
    const triggers = [c.prefix, ...(c.aliases ?? [])].filter(Boolean) as string[];
    return `- **${triggers.join(" / ")}** — ${c.description}`;
  });
  const shortcutLines = INPUT_SHORTCUTS.map((s) => `- **${s.keys}** — ${s.desc}`);
  const buttonLines = INPUT_BUTTONS.map((b) => `- **${b.name}** — ${b.desc}`);
  const resultLines = RESULT_BUTTONS.map((b) => `- **${b.name}** — ${b.desc}`);

  return [
    "输入框使用方法",
    "",
    "斜杠命令（在输入框里输入，回车执行）",
    "",
    ...cmdLines,
    "",
    "直接打字回车即与 AI 对话；带参数的命令需在命令名后加一个空格再写内容。`?` 无需空格，如 `?北京` 直接搜索。",
    "",
    "快捷键（输入框内）",
    "",
    ...shortcutLines,
    "",
    "输入栏按钮",
    "",
    ...buttonLines,
    "",
    "结果框内",
    "",
    ...resultLines,
  ].join("\n");
}

/**
 * Main window root (the permanent command bar). Owns window-bounds memory and
 * remains the SOLE writer of settings.json. It is ALSO the AI streaming driver
 * (design §9.3 Plan A): it holds the authoritative `messages` mirror and
 * forwards every delta/done/error to the result overlay window, which renders
 * the chat. The main window never grows — it stays a thin bar and shows only a
 * one-line status (生成中 / 已回复 / 错误).
 */
export default function CommandCard() {
  const [value, setValue] = useState("");
  // `settings` is the single source of truth; locked lives inside it.
  const [settings, setSettings] = useState<AppSettings | null>(null);

  // AI chat mirror (#6) — authoritative during a turn; forwarded to the result
  // window. Kept in a ref so the `result:ready` replay handler reads fresh state
  // (a stale closure would drop the in-flight assistant bubble).
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [generating, setGenerating] = useState(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const generatingRef = useRef(false);

  // Result-overlay view mirror (main is the source of truth). `mode` switches
  // the surface (chat vs file); fileResults/fileQuery back the file view. All
  // three ride on `result:replay` so a freshly-booted overlay catches up.
  const modeRef = useRef<ResultMode>("chat");
  const fileResultsRef = useRef<FileResult[]>([]);
  const fileQueryRef = useRef("");
  const searchingRef = useRef(false);

  // Result-window pin state (mirrored from the result window's toggle).
  const pinnedRef = useRef(false);

  // Active conversation id (null = brand-new, not yet persisted). The frontend
  // mirror is the persistence source of truth; on resume it is pushed back into
  // ChatState via `set_messages`.
  const activeIdRef = useRef<string | null>(null);
  const persistTimer = useRef<number | null>(null);

  // One-line status shown in the bar without stretching the layout.
  const [statusText, setStatusText] = useState("");

  // Whether the result overlay is currently open — drives the spark's active
  // state. Kept in sync across every show/hide path via reveal/conceal below.
  const [resultOpen, setResultOpen] = useState(false);

  const settingsRef = useRef<AppSettings | null>(null);
  const saveTimer = useRef<number | null>(null);

  // Notes (multi-instance overlays). notesRef is the authoritative in-memory
  // list (temp + pinned); only PINNED records are persisted to notes.json, so
  // scheduleNotesSave filters to pinned===true.
  const notesRef = useRef<NoteRecord[]>([]);
  const notesSaveTimer = useRef<number | null>(null);

  /** Commit new settings to state + ref + debounced persistence. */
  const update = useCallback((next: AppSettings) => {
    settingsRef.current = next;
    setSettings(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (settingsRef.current) void saveSettings(settingsRef.current);
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const patchWindow = useCallback(
    (p: Partial<WindowSettings>) => {
      const cur = settingsRef.current;
      if (!cur) return;
      update({ ...cur, window: { ...cur.window, ...p } });
    },
    [update],
  );

  /** Patch the waveform overlay section (settings.waveform) + debounced persist.
   *  Backs the user drag/resize geometry; other fields arrive via the settings
   *  panel broadcast / tray toggle merged into state below. */
  const patchWaveform = useCallback(
    (p: Partial<WaveformSettings>) => {
      const cur = settingsRef.current;
      if (!cur) return;
      update({ ...cur, waveform: { ...cur.waveform, ...p } });
    },
    [update],
  );

  /** Emit the authoritative full-view snapshot to the result overlay. Used on
   *  `result:ready` (boot catch-up) and after a file search resolves. */
  const emitReplay = useCallback(() => {
    emit(EV.RESULT_REPLAY, {
      mode: modeRef.current,
      messages: messagesRef.current,
      generating: generatingRef.current,
      fileResults: fileResultsRef.current,
      fileQuery: fileQueryRef.current,
      searching: searchingRef.current,
    }).catch(logErr("emit replay"));
  }, []);

  /** Persist the active conversation from the live mirror (debounced). Skips an
   *  empty mirror so a cleared screen never clobbers an existing record. The
   *  debounce delay is long enough that `messagesRef` (synced one render later)
   *  is fresh by the time this fires. */
  const persistActive = useCallback(async () => {
    const msgs = messagesRef.current;
    if (msgs.length === 0) return;
    try {
      const title = deriveTitle(msgs);
      const id = await upsertConversation(activeIdRef.current, title, msgs);
      activeIdRef.current = id;
      emit(EV.HISTORY_CHANGED).catch(logErr("emit history-changed"));
    } catch (e) {
      logErr("persist conversation")(e);
    }
  }, []);

  /** Debounced schedule of `persistActive`. Called after every turn completes. */
  const schedulePersist = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null;
      void persistActive();
    }, 600);
  }, [persistActive]);

  /** Show the result overlay and mirror it as open. Centralizes the show call so
   *  every path (AI turn, /file search, spark toggle) stays in sync with
   *  `resultOpen` — the spark then reflects the real visibility. Passes the saved
   *  geometry so the overlay reopens at the user's last position + size. */
  const revealResult = useCallback(async () => {
    const win = settingsRef.current?.window;
    await showResultWindow(
      win ? { x: win.result_x, y: win.result_y, w: win.result_w, h: win.result_h } : undefined,
    ).catch(logErr("show result"));
    setResultOpen(true);
  }, []);

  /** Hide the result overlay (state persists for next show) and mirror as closed. */
  const concealResult = useCallback(async () => {
    await hideResultWindow();
    setResultOpen(false);
  }, []);

  // ── keep refs in sync with state for use in event handlers ──
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    generatingRef.current = generating;
  }, [generating]);

  // ── launch: restore saved bounds (height FORCED to the bar height) + appearance, then reveal ──
  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await loadSettings();
      if (!alive) return;
      settingsRef.current = s;
      setSettings(s);
      applyAppearanceVars(s.appearance);
      const win = getCurrentWindow();
      try {
        if (s.window.w > 0 && s.window.h > 0) {
          await win.setPosition(new LogicalPosition(s.window.x, s.window.y));
          // Never restore the old expanded height (legacy saves may hold 420);
          // main is always a thin bar (height locked: tauri.conf.json
          // minHeight=maxHeight=64). Width is user-adjustable, so restore the
          // persisted s.window.w.
          await win.setSize(new LogicalSize(s.window.w, COLLAPSED_H));
        }
      } catch (e) {
        console.error("[bugzia] restore bounds", e);
      }
      try {
        await win.show();
      } catch (e) {
        console.error("[bugzia] show window", e);
      }
    })();
    return () => {
      alive = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // ── restore pinned notes from notes.json (temp notes were cleared on exit).
  //    Each pinned record recreates its window at its saved geometry + on-top. ──
  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await notesLoad();
      if (!alive) return;
      notesRef.current = list;
      const ns = settingsRef.current?.note ?? DEFAULT_NOTE;
      for (const rec of list) {
        await createNoteWindow(rec, { w: ns.w, h: ns.h }, notesRef.current).catch(logErr("restore note"));
      }
    })();
    return () => {
      alive = false;
      if (notesSaveTimer.current) clearTimeout(notesSaveTimer.current);
    };
  }, []);

  // ── live-apply appearance whenever it changes ──
  useEffect(() => {
    if (settings) applyAppearanceVars(settings.appearance);
  }, [settings?.appearance]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── lock also freezes SIZE: disable resize while locked (position is already
  //    frozen by the drag-layer). Toggled from Settings; requires the
  //    core:window:allow-set-resizable capability (capabilities/default.json). ──
  useEffect(() => {
    if (!settings) return;
    const win = getCurrentWindow();
    void win.setResizable(!settings.window.locked).catch(logErr("setResizable"));
  }, [settings?.window.locked]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── persist window bounds on OS move/resize ──
  useEffect(() => {
    const win = getCurrentWindow();
    const persistBounds = async (
      phys: { x?: number; y?: number; width?: number; height?: number },
    ) => {
      const cur = settingsRef.current;
      if (!cur) return;
      const f = await win.scaleFactor();
      const w = phys.width !== undefined ? Math.round(phys.width / f) : cur.window.w;
      // The bar height is fixed (64..72); persist it but it is always restored
      // to COLLAPSED_H on launch regardless.
      const h = phys.height !== undefined ? Math.round(phys.height / f) : cur.window.h;
      const x = phys.x !== undefined ? Math.round(phys.x / f) : cur.window.x;
      const y = phys.y !== undefined ? Math.round(phys.y / f) : cur.window.y;
      patchWindow({ w, h, x, y });
    };

    const offResized = win.onResized(async ({ payload }) => {
      await persistBounds({ width: payload.width, height: payload.height });
    });
    const offMoved = win.onMoved(async ({ payload }) => {
      await persistBounds({ x: payload.x, y: payload.y });
    });
    return () => {
      offResized.then((fn) => fn()).catch(logErr("unlisten resized"));
      offMoved.then((fn) => fn()).catch(logErr("unlisten moved"));
    };
  }, [patchWindow]);

  // ── settings window -> main: merge its patch with our window bounds, persist,
  //    live-apply appearance. Main is the sole writer, so bounds are never lost. ──
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    (async () => {
      unlisten = await listen<SettingsPatch>("settings:updated", (ev) => {
        const cur = settingsRef.current;
        if (!cur) return;
        const merged: AppSettings = {
          ...cur,
          appearance: ev.payload.appearance,
          result: ev.payload.result,
          ai: ev.payload.ai,
          search: ev.payload.search,
          window: { ...cur.window, locked: ev.payload.windowLocked },
          waveform: ev.payload.waveform ?? cur.waveform,
          pet: ev.payload.pet ?? cur.pet,
          note: ev.payload.note ?? cur.note,
          agent_notify: ev.payload.agent_notify ?? cur.agent_notify,
          social_notify: ev.payload.social_notify ?? cur.social_notify,
        };
        update(merged);
        applyAppearanceVars(merged.appearance);
      });
      if (!alive && unlisten) unlisten();
    })();
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [update]);

  // Agent notify can be enabled from Settings while Bugzia is already running.
  // The backend listener binds once; changing port/token still needs restart.
  useEffect(() => {
    const cfg = settings?.agent_notify;
    if (!cfg?.enabled) return;
    void invoke("agent_notify_start", { cfg }).catch(logErr("agent_notify_start"));
  }, [settings?.agent_notify.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cfg = settings?.social_notify;
    if (!cfg) return;
    void invoke("social_notify_start", { cfg }).catch(logErr("social_notify_start"));
  }, [settings?.social_notify]);

  // ── result window -> main: chat control + lifecycle + ready-handshake ──
  useEffect(() => {
    const offs: UnlistenFn[] = [];
    (async () => {
      offs.push(
        await listen(EV.COMMAND_STOP_CHAT, () => {
          void stopChat().catch(logErr("stop_chat"));
        }),
      );
      offs.push(
        await listen(EV.COMMAND_CLEAR_CONTEXT, () => {
          // Keep original behavior (wipe context + screen); additionally rotate
          // activeId so the next turn starts a new record instead of clobbering
          // the just-saved one.
          activeIdRef.current = null;
          void clearContext().catch(logErr("clear_context"));
          setMessages([]);
          setStatusText("");
          emit(EV.RESULT_CHAT_CLEARED).catch(logErr("emit cleared"));
          emit(EV.HISTORY_CHANGED).catch(logErr("emit history-changed"));
        }),
      );
      offs.push(
        await listen(EV.COMMAND_NEW_CONVERSATION, async () => {
          if (generatingRef.current) return;
          // Flush the current conversation (in case a debounced save hadn't
          // fired), then rotate to a brand-new one.
          await persistActive();
          activeIdRef.current = null;
          void clearContext().catch(logErr("clear_context"));
          setMessages([]);
          setStatusText("");
          emit(EV.RESULT_CHAT_CLEARED).catch(logErr("emit cleared"));
          emit(EV.HISTORY_CHANGED).catch(logErr("emit history-changed"));
          // No emitReplay() here: RESULT_CHAT_CLEARED already empties the result
          // window, and emitReplay() would read messagesRef BEFORE the just-queued
          // setMessages([]) has flushed (the sync-effect runs only after render),
          // so it would re-push the OLD messages and the screen would refuse to
          // clear — making "新对话" look like it failed.
        }),
      );
      offs.push(
        await listen<{ id: string }>(EV.HISTORY_RESUME, async (ev) => {
          if (generatingRef.current) return;
          const id = ev.payload.id;
          try {
            const msgs = await getConversation(id);
            activeIdRef.current = id;
            setMessages(msgs);
            // Sync the ref immediately: emitReplay() below reads messagesRef,
            // which the sync-effect only updates AFTER render. Without this the
            // resumed messages could be sent stale (the pre-resume mirror), so
            // the result window would briefly show the wrong conversation.
            messagesRef.current = msgs;
            await invoke("set_messages", { messages: msgs }).catch(logErr("set_messages"));
            modeRef.current = "chat";
            setStatusText(msgs.length ? `已恢复 ${msgs.length} 条` : "");
            await revealResult();
            emit(EV.RESULT_SET_MODE, { mode: "chat" }).catch(logErr("emit set-mode"));
            emitReplay();
          } catch (e) {
            logErr("resume conversation")(e);
          }
        }),
      );
      offs.push(
        await listen(EV.HISTORY_CHANGED, async () => {
          // The rail may have deleted the active conversation; if so, clear the
          // mirror so we don't keep editing a ghost. (Own persists also ping
          // here — harmless: the active id is still present, no-op.)
          const aid = activeIdRef.current;
          if (!aid) return;
          try {
            const all = await listConversations();
            if (!all.some((c) => c.id === aid)) {
              activeIdRef.current = null;
              void clearContext().catch(logErr("clear_context"));
              setMessages([]);
              setStatusText("");
              // Tell the result window to clear directly. emitReplay() would read
              // messagesRef before the setMessages([]) above has flushed (the
              // sync-effect runs post-render) and re-push the stale messages.
              emit(EV.RESULT_CHAT_CLEARED).catch(logErr("emit cleared"));
            }
          } catch (e) {
            logErr("history-changed check")(e);
          }
        }),
      );
      offs.push(
        await listen(EV.COMMAND_CLOSE_RESULT, () => {
          void concealResult();
        }),
      );
      offs.push(
        await listen<{ pinned: boolean }>(EV.COMMAND_PINNED_CHANGED, (ev) => {
          pinnedRef.current = ev.payload.pinned;
        }),
      );
      offs.push(
        await listen(EV.RESULT_READY, () => {
          // Result window just mounted + hydrated; replay the authoritative
          // full view so it catches up (incl. any in-flight assistant bubble
          // or the last file results).
          emitReplay();
        }),
      );
    })();
    return () => offs.forEach((off) => off());
  }, []);

  // ── persist the result window's geometry when the USER moves/resizes it (so a
  //    manual placement + size survives an app restart). Main is the sole
  //    settings.json writer. Programmatic placements on show are suppressed in
  //    resultWindow.ts so only genuine user moves land here. ──
  useEffect(() => {
    onResultGeometryChange((g) => {
      const patch: Partial<WindowSettings> = {};
      if (g.x !== undefined) patch.result_x = g.x;
      if (g.y !== undefined) patch.result_y = g.y;
      if (g.w !== undefined) patch.result_w = g.w;
      if (g.h !== undefined) patch.result_h = g.h;
      patchWindow(patch);
    });
  }, [patchWindow]);

  // ── waveform overlay lifecycle ───────────────────────────────────────────
  // The overlay window must be created from the frontend (ACL), and main is the
  // sole settings.json writer, so all of this lives here. `enabled` drives the
  // create/show + capture; pin + click-through are applied AFTER showWaveformWindow
  // resolves so the window definitely exists before the backend commands target
  // it (they'd otherwise error "waveform window not found").

  // Tray toggles (桌面波形 / 桌宠) persist in Rust + emit settings://changed.
  // Reload the authoritative settings so our mirror — and the enabled effects
  // below — sync.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    (async () => {
      unlisten = await listen("settings://changed", () => {
        void loadSettings()
          .then((s) => {
            if (!alive || !s) return;
            settingsRef.current = s;
            setSettings(s);
          })
          .catch(logErr("reload settings"));
      });
      if (!alive && unlisten) unlisten();
    })();
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // enabled: show + pin + lock + start capture, or stop capture + hide.
  useEffect(() => {
    if (!settings) return;
    const wf = settings.waveform;
    let cancelled = false;
    (async () => {
      if (wf.enabled) {
        await showWaveformWindow(
          wf.x >= 0 && wf.y >= 0 ? { x: wf.x, y: wf.y, w: wf.w, h: wf.h } : undefined,
        ).catch(logErr("show waveform"));
        if (cancelled) return;
        // Window now exists: apply pin + click-through, then start audio capture.
        await invoke("waveform_set_always_on_top", { top: wf.always_on_top }).catch(
          logErr("waveform on_top"),
        );
        await invoke("waveform_set_locked", { locked: wf.locked }).catch(
          logErr("waveform lock"),
        );
        await invoke("waveform_set_enabled", { enabled: true }).catch(
          logErr("waveform_set_enabled"),
        );
      } else {
        await invoke("waveform_set_enabled", { enabled: false }).catch(
          logErr("waveform_set_enabled"),
        );
        await hideWaveformWindow();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings?.waveform.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live pin / click-through toggles while the overlay is already open.
  useEffect(() => {
    if (!settings?.waveform.enabled) return;
    void invoke("waveform_set_always_on_top", { top: settings.waveform.always_on_top }).catch(
      logErr("waveform on_top"),
    );
  }, [settings?.waveform.always_on_top, settings?.waveform.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!settings?.waveform.enabled) return;
    void invoke("waveform_set_locked", { locked: settings.waveform.locked }).catch(
      logErr("waveform lock"),
    );
  }, [settings?.waveform.locked, settings?.waveform.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sticky lock re-assertion. On Windows, set_ignore_cursor_events is silently
  // reset by later window operations (show, z-order / always-on-top, window
  // reactivation), so a one-shot apply-after-show can lose that race and leave a
  // locked=true overlay still interactive (the "lock never takes effect" bug).
  // While the overlay is enabled, re-apply its saved lock state on a
  // low-frequency interval from this main window (which has full invoke
  // access), so the lock stays sticky no matter which op last touched the
  // window. Idempotent with the apply-after-show in showWaveformWindow.
  useEffect(() => {
    if (!settings?.waveform.enabled) return;
    const apply = () => {
      const locked = settingsRef.current?.waveform.locked ?? false;
      void invoke("waveform_set_locked", { locked }).catch(logErr("waveform sticky lock"));
    };
    apply();
    const id = window.setInterval(apply, 1000);
    return () => window.clearInterval(id);
  }, [settings?.waveform.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // "重置位置" resets x/y to the -1 sentinel -> while open, re-default the
  // placement immediately so the user sees it move (not only on next toggle).
  useEffect(() => {
    if (!settings?.waveform.enabled) return;
    if (settings.waveform.x < 0 || settings.waveform.y < 0) {
      void showWaveformWindow(undefined).catch(logErr("waveform reposition"));
    }
  }, [settings?.waveform.x, settings?.waveform.y]); // eslint-disable-line react-hooks/exhaustive-deps

  // Forward live waveform appearance (color / sensitivity / density / ...) to the
  // overlay every time the section changes, so tweaks render on the next frame.
  useEffect(() => {
    if (!settings) return;
    emit("waveform://settings", settings.waveform).catch(logErr("emit waveform settings"));
  }, [settings?.waveform]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the waveform window's geometry when the USER moves/resizes it, so a
  // manual placement + size survives an app restart. Main is the sole writer.
  useEffect(() => {
    onWaveformGeometryChange((g) => {
      const patch: Partial<WaveformSettings> = {};
      if (g.x !== undefined) patch.x = g.x;
      if (g.y !== undefined) patch.y = g.y;
      if (g.w !== undefined) patch.w = g.w;
      if (g.h !== undefined) patch.h = g.h;
      patchWaveform(patch);
    });
  }, [patchWaveform]);

  // ── pet overlay lifecycle ────────────────────────────────────────────────
  // The pet window is created from the frontend (ACL) and main is the sole
  // settings.json writer, so show/hide + pin + click-through live here. The
  // shared settings://changed reload above (also driven by the tray "桌宠"
  // toggle) feeds fresh settings into the enabled effect below.

  // enabled: show + apply pin/lock (after the window exists), or hide.
  useEffect(() => {
    const pet = settings?.pet;
    if (!pet) return;
    if (pet.enabled) {
      void showPetWindow({ x: pet.x, y: pet.y, w: pet.w, h: pet.h })
        .then(() => {
          void invoke("pet_set_always_on_top", { top: pet.always_on_top }).catch(
            logErr("pet on_top"),
          );
          void invoke("pet_set_locked", { locked: pet.locked }).catch(logErr("pet lock"));
        })
        .catch(logErr("show pet"));
    } else {
      void hidePetWindow().catch(logErr("hide pet"));
    }
  }, [settings?.pet.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live pin / click-through toggles while the pet is already open.
  useEffect(() => {
    if (!settings?.pet.enabled) return;
    void invoke("pet_set_always_on_top", { top: settings.pet.always_on_top }).catch(
      logErr("pet on_top"),
    );
  }, [settings?.pet.always_on_top, settings?.pet.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!settings?.pet.enabled) return;
    void invoke("pet_set_locked", { locked: settings.pet.locked }).catch(logErr("pet lock"));
  }, [settings?.pet.locked, settings?.pet.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Reset position" button (Settings) sets pet.x/y to the -1 sentinel.
  // showPetWindow routes x<0 to defaultPlacement (lower-right), so re-invoking
  // it here moves the already-open window to the default spot. No loop:
  // defaultPlacement suppresses its own move event (petWindow.ts), so x stays
  // -1 and this effect doesn't re-fire until the user places it again.
  useEffect(() => {
    const pet = settings?.pet;
    if (!pet?.enabled) return;
    if (pet.x < 0 || pet.y < 0) {
      void showPetWindow({ x: pet.x, y: pet.y, w: pet.w, h: pet.h }).catch(
        logErr("reset pet pos"),
      );
    }
  }, [settings?.pet.x, settings?.pet.y, settings?.pet.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the pet window's geometry when the USER moves/resizes it, so a
  // manual placement + size survives an app restart. Programmatic placements on
  // show are suppressed in petWindow.ts.
  useEffect(() => {
    onPetGeometryChange((g) => {
      const cur = settingsRef.current;
      if (!cur) return;
      const patch: Partial<PetSettings> = {};
      if (g.x !== undefined) patch.x = g.x;
      if (g.y !== undefined) patch.y = g.y;
      if (g.w !== undefined) patch.w = g.w;
      if (g.h !== undefined) patch.h = g.h;
      update({ ...cur, pet: { ...cur.pet, ...patch } });
    });
  }, [update]);

  // ── note overlay lifecycle (multi-instance) ──────────────────────────────
  // Main is the sole notes.json writer: each note window is a thin view that
  // hydrates on NOTE_READY, reports edits / pin / destroy up, and is positioned
  // by the geometry listener below. Only PINNED notes are persisted.

  // Hydrate a freshly-mounted note, then record edits / pin toggles / destroys.
  useEffect(() => {
    const offs: UnlistenFn[] = [];
    (async () => {
      offs.push(
        await listen<{ id: string }>(NOTE_READY, (ev) => {
          const rec = notesRef.current.find((n) => n.id === ev.payload.id);
          const ns = settingsRef.current?.note ?? DEFAULT_NOTE;
          emitTo(noteLabel(ev.payload.id), NOTE_HYDRATE, {
            content: rec?.content ?? "",
            settings: ns,
          }).catch(logErr("note hydrate"));
        }),
      );
      offs.push(
        await listen<{ id: string; content: string }>(NOTE_CHANGED, (ev) => {
          notesRef.current = notesRef.current.map((n) =>
            n.id === ev.payload.id ? { ...n, content: ev.payload.content } : n,
          );
          scheduleNotesSave();
        }),
      );
      offs.push(
        await listen<{ id: string; pinned: boolean }>(NOTE_PINNED, (ev) => {
          notesRef.current = notesRef.current.map((n) =>
            n.id === ev.payload.id ? { ...n, pinned: ev.payload.pinned } : n,
          );
          void setNoteLayer(ev.payload.id, ev.payload.pinned).catch(logErr("note set_layer"));
          scheduleNotesSave();
        }),
      );
      offs.push(
        await listen<{ id: string }>(NOTE_DESTROYED, (ev) => {
          notesRef.current = notesRef.current.filter((n) => n.id !== ev.payload.id);
          void closeNoteWindow(ev.payload.id).catch(logErr("close note"));
          scheduleNotesSave();
        }),
      );
    })();
    return () => offs.forEach((off) => off());
  }, []);

  // Persist a note's geometry when the USER moves/resizes it (pinned notes
  // survive restart; temp notes keep in-memory geom only for the session).
  useEffect(() => {
    onNoteGeometryChange((id, patch) => {
      notesRef.current = notesRef.current.map((n) =>
        n.id === id
          ? {
              ...n,
              ...(patch.x !== undefined ? { x: patch.x } : {}),
              ...(patch.y !== undefined ? { y: patch.y } : {}),
              ...(patch.w !== undefined ? { w: patch.w } : {}),
              ...(patch.h !== undefined ? { h: patch.h } : {}),
            }
          : n,
      );
      scheduleNotesSave();
    });
  }, []);

  // Forward live note style defaults (color / size / radius / font / opacity) to
  // every open note whenever the section changes, so tweaks render next paint.
  useEffect(() => {
    if (!settings) return;
    emit(NOTE_SETTINGS, settings.note).catch(logErr("emit note settings"));
  }, [settings?.note]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── slash-command palette (autocomplete floating above the bar) ───────────
  // InputBar owns the keystrokes; main is the single source of truth for the
  // filtered list + highlighted index and mirrors it to the `slashpalette`
  // overlay window (which only renders + relays click/hover back, like the
  // result overlay).
  const paletteItems = useMemo(() => slashPaletteItems(value), [value]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const paletteOpen = paletteItems.length > 0 && !paletteDismissed;
  const safePaletteIndex =
    paletteItems.length > 0 ? Math.min(paletteIndex, paletteItems.length - 1) : 0;

  // Fresh snapshot for the once-registered accept/ready listeners — they cannot
  // close over per-render values without re-subscribing on every keystroke.
  const paletteStateRef = useRef({ items: paletteItems, index: safePaletteIndex });
  paletteStateRef.current = { items: paletteItems, index: safePaletteIndex };
  const acceptPaletteRef = useRef<(item: SlashPaletteItem, via: "enter" | "tab") => void>(
    () => {},
  );

  /** Accept a palette row. Argless commands (e.g. /help) submit immediately on
   *  Enter; everything else is filled as `<trigger> ` so the user can type the
   *  query. Tab always fills without running. The dismissal latch keeps the
   *  palette closed until the user types again; the trailing space / the help
   *  clear closes it too. */
  const acceptPalette = (item: SlashPaletteItem, via: "enter" | "tab") => {
    setPaletteDismissed(true);
    if (item.argless && via === "enter") {
      void handleSubmit(item.mode);
    } else {
      handleInputChange(item.argless ? item.trigger : `${item.trigger} `);
    }
  };
  acceptPaletteRef.current = acceptPalette;

  /** User typed in the bar: clear the dismissal latch so the palette can reopen,
   *  then forward to the normal change handler (value + pet preview). Acceptance
   *  fills call `handleInputChange` DIRECTLY so they do NOT clear the latch. */
  const onInputChange = (next: string) => {
    setPaletteDismissed(false);
    handleInputChange(next);
  };

  // Keep the highlighted index inside the (possibly shrunk) list.
  useEffect(() => {
    if (paletteItems.length > 0 && paletteIndex >= paletteItems.length) {
      setPaletteIndex(0);
    }
  }, [paletteItems.length, paletteIndex]);

  // The shared input element ref. CommandCard owns it so it can reclaim focus
  // AFTER the palette overlay reveals (show() can steal focus on some platforms;
  // reclaiming it before show resolves is too early, so we do it in the .then).
  const inputRef = useRef<HTMLInputElement>(null);

  // Show / hide + position the overlay. Runs only when the open-state OR the row
  // count changes — NOT on every highlight move, which would re-show the window
  // on each arrow press. Focus is reclaimed after reveal so the bar keeps
  // receiving the Arrow / Enter / Tab / Esc keystrokes that drive the palette.
  useEffect(() => {
    let cancelled = false;
    if (paletteOpen) {
      showSlashPaletteWindow(paletteItems.length)
        .then(async () => {
          if (cancelled) return;
          try {
            await getCurrentWindow().setFocus();
          } catch {
            // non-fatal: focus is best-effort
          }
          inputRef.current?.focus();
          emitSlashPaletteState(paletteItems, safePaletteIndex);
        })
        .catch(logErr("show slashpalette"));
    } else {
      void hideSlashPaletteWindow().catch(logErr("hide slashpalette"));
    }
    return () => {
      cancelled = true;
    };
  }, [paletteOpen, paletteItems.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Push the current filtered list + highlight whenever they change. This covers
  // the per-arrow highlight moves cheaply, WITHOUT re-showing the window.
  useEffect(() => {
    if (paletteOpen) emitSlashPaletteState(paletteItems, safePaletteIndex);
  }, [paletteOpen, paletteItems, safePaletteIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Register the palette's pointer relays once. They read the latest snapshot
  // via refs so they never go stale across renders.
  useEffect(() => {
    const offs: UnlistenFn[] = [];
    (async () => {
      offs.push(await onSlashPaletteHover((i) => setPaletteIndex(i)));
      offs.push(
        await onSlashPaletteAccept((i) => {
          const st = paletteStateRef.current;
          const item = st.items[i];
          if (item) acceptPaletteRef.current(item, "enter");
        }),
      );
      offs.push(
        await onSlashPaletteReady(() => {
          const st = paletteStateRef.current;
          emitSlashPaletteState(st.items, st.index);
        }),
      );
      // Navigation keys relayed from the palette window (when focus landed in it
      // instead of the bar). Same logic as the input's keydown.
      offs.push(
        await onSlashPaletteKey((key) => {
          const { items, index } = paletteStateRef.current;
          if (items.length === 0) return;
          const len = items.length;
          const idx = Math.min(index, len - 1);
          if (key === "ArrowDown") setPaletteIndex((i) => (i + 1) % len);
          else if (key === "ArrowUp") setPaletteIndex((i) => (i - 1 + len) % len);
          else if (key === "Enter") acceptPaletteRef.current(items[idx], "enter");
          else if (key === "Tab") acceptPaletteRef.current(items[idx], "tab");
          else if (key === "Escape") setPaletteDismissed(true);
        }),
      );
    })();
    return () => offs.forEach((off) => off());
  }, []);

  function resolveEngine(): SearchEngine {
    const s = settingsRef.current;
    if (s && s.search.custom_engine_url.trim()) {
      const tmpl = s.search.custom_engine_url.trim();
      return { id: "custom", name: "自定义", url: (q) => tmpl.replace("{q}", encodeURIComponent(q)) };
    }
    if (s) {
      const found = SEARCH_ENGINES.find((eng) => eng.id === s.search.default_engine);
      if (found) return found;
    }
    return SEARCH_ENGINES[0];
  }

  /** Drive a `/file` search: flip the overlay to file mode, show a searching
   *  state, run the (blocking) walk off-thread, then push the results. */
  async function runFileSearch(query: string) {
    setStatusText("搜索中");
    modeRef.current = "file";
    fileQueryRef.current = query;
    fileResultsRef.current = [];
    searchingRef.current = true;
    await revealResult();
    emitReplay();
    try {
      const results = await invoke<FileResult[]>("search_files", { query });
      fileResultsRef.current = results;
      searchingRef.current = false;
      emitReplay();
      setStatusText(results.length ? `${results.length} 个结果` : "无结果");
    } catch (e) {
      logErr("file search")(e);
      searchingRef.current = false;
      setStatusText("错误");
    }
  }

  /** Render a one-shot result as a single assistant message — no streaming,
   *  no backend `ChatState` write. Used by /weather, /trans, /help. The result
   *  does NOT enter the conversation context; the frontend mirror is
   *  self-consistent for the session (replayed to the overlay), and a restart
   *  loses it (same as an AI turn). */
  async function runAssistantOnce(
    displayText: string,
    produce: () => Promise<string>,
    busyText: string,
  ) {
    modeRef.current = "chat";
    setMessages((m) => [
      ...m,
      { role: "user", content: displayText },
      { role: "assistant", content: "" },
    ]);
    setGenerating(true);
    setStatusText(busyText);
    await revealResult();
    emit(EV.RESULT_SET_MODE, { mode: "chat" }).catch(logErr("emit set-mode"));
    emit(EV.RESULT_CHAT_START, { userText: displayText }).catch(logErr("emit chat-start"));
    try {
      const md = await produce();
      setMessages((m) => patchLastAssistant(m, () => md));
      emit(EV.RESULT_CHAT_DONE, { fullText: md, model: "", stopped: false }).catch(
        logErr("emit done"),
      );
      setStatusText("已回复");
      schedulePersist();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setMessages((m) => patchLastAssistant(m, () => `错误：${message}`));
      emit(EV.RESULT_CHAT_ERROR, { message }).catch(logErr("emit error"));
      setStatusText("错误");
    } finally {
      setGenerating(false);
    }
  }

  /** Streaming sibling of `runAssistantOnce`: used by `/trans` (and any future
   *  one-shot command whose result is long enough to warrant live tokens). Like
   *  `runAssistantOnce`, it does NOT touch the backend `ChatState` — the prompt
   *  is answered context-free (see `ask_once_stream`), so tool-style results
   *  never pollute the main conversation. Deltas are forwarded to the result
   *  overlay exactly like an AI turn. */
  async function runAssistantStream(
    displayText: string,
    streamFn: (onEvent: (e: ChatEvent) => void) => Promise<void>,
    busyText: string,
  ) {
    modeRef.current = "chat";
    setMessages((m) => [
      ...m,
      { role: "user", content: displayText },
      { role: "assistant", content: "" },
    ]);
    setGenerating(true);
    setStatusText(busyText);
    await revealResult();
    emit(EV.RESULT_SET_MODE, { mode: "chat" }).catch(logErr("emit set-mode"));
    emit(EV.RESULT_CHAT_START, { userText: displayText }).catch(logErr("emit chat-start"));
    try {
      await streamFn((e) => {
        if (e.event === "delta") {
          setMessages((m) => patchLastAssistant(m, (c) => c + e.data.text));
          emit(EV.RESULT_CHAT_DELTA, { text: e.data.text }).catch(logErr("emit delta"));
        } else if (e.event === "done") {
          const full = e.data.fullText;
          const model = e.data.model;
          setMessages((m) => {
            const copy = [...m];
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].role === "assistant") {
                copy[i] = {
                  ...copy[i],
                  content: full || copy[i].content,
                  ...(model ? { model } : {}),
                };
                break;
              }
            }
            return copy;
          });
          emit(EV.RESULT_CHAT_DONE, { fullText: full, model, stopped: e.data.stopped }).catch(
            logErr("emit done"),
          );
          setStatusText("已回复");
          schedulePersist();
        } else if (e.event === "error") {
          const message = e.data.message;
          setMessages((m) => patchLastAssistant(m, () => `错误：${message}`));
          emit(EV.RESULT_CHAT_ERROR, { message }).catch(logErr("emit error"));
          setStatusText("错误");
        }
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setMessages((m) => patchLastAssistant(m, () => `错误：${message}`));
      emit(EV.RESULT_CHAT_ERROR, { message }).catch(logErr("emit error"));
      setStatusText("错误");
    } finally {
      setGenerating(false);
    }
  }

  /** Spawn a fresh (temporary) note at the cascaded lower-right spot. The window
   *  is always-on-top from the start (desktop overlay) and only persisted to
   *  notes.json once the user pins it. Soft-capped at 50 open notes. */
  async function spawnNote(text: string) {
    if (notesRef.current.length >= 50) {
      setStatusText("便笺已达上限（50）");
      window.setTimeout(() => setStatusText(""), 1500);
      return;
    }
    const s = settingsRef.current?.note ?? DEFAULT_NOTE;
    const record: NoteRecord = {
      id: crypto.randomUUID(),
      content: text,
      x: -1,
      y: -1,
      w: s.w,
      h: s.h,
      pinned: false,
    };
    notesRef.current = [...notesRef.current, record];
    await createNoteWindow(record, { w: s.w, h: s.h }, notesRef.current).catch(logErr("create note"));
    setStatusText("已生成便笺");
    window.setTimeout(() => setStatusText(""), 1500);
  }

  /** Debounced persist of the PINNED subset only (temp notes live in memory and
   *  vanish on app exit). Main is the sole notes.json writer. */
  function scheduleNotesSave() {
    if (notesSaveTimer.current) clearTimeout(notesSaveTimer.current);
    notesSaveTimer.current = window.setTimeout(() => {
      notesSaveTimer.current = null;
      void notesSave(notesRef.current.filter((n) => n.pinned));
    }, 400);
  }

  async function handleSubmit(forceMode?: CommandMode) {
    const cmd = parseCommand(value);
    const mode = forceMode ?? cmd.mode;
    const query = cmd.query;

    // /help is argless (query is always "") and must run before the empty-query
    // early return below.
    if (mode === "help") {
      setValue("");
      void runAssistantOnce("命令列表", () => Promise.resolve(renderHelpMarkdown()), "生成中");
      return;
    }

    if (mode === "note") {
      const text = query.trim();
      if (!text) {
        setStatusText("请输入便笺内容");
        window.setTimeout(() => setStatusText(""), 1500);
        return;
      }
      setValue("");
      void spawnNote(text);
      return;
    }

    if (!query) return;
    // Don't start a new turn while one is in flight (keep the typed text).
    if (generatingRef.current && (mode === "ai" || mode === "weather" || mode === "trans")) {
      return;
    }
    setValue("");

    if (mode === "web") {
      browserSearch(query, resolveEngine()).catch(logErr("web search"));
      setStatusText("已打开浏览器搜索");
      return;
    }
    if (mode === "file") {
      void runFileSearch(query);
      return;
    }
    if (mode === "weather") {
      void runAssistantOnce(
        query,
        () => invoke<string>("weather", { city: query }),
        "查询天气中",
      );
      return;
    }
    if (mode === "trans") {
      // Dictionary-style: all senses + example sentences. Direction defaults to
      // Chinese <-> English; an explicit target stated in the input (e.g.
      // "翻译成日语", "into French") overrides it. Streams token-by-token via
      // the context-free `ask_once_stream`, so a translation never pollutes the
      // main chat history.
      const prompt =
        "请把下面的内容当作词典词条处理，用 Markdown 分点输出，不要寒暄或多余说明：\n" +
        "- 若是单词或短语：列出该词所有常见释义，按词性或含义分点（如 n. / v. / adj.）；为最常用的 1 至 2 个释义各给一个例句（原文 + 中文翻译）。\n" +
        "- 若是完整的句子：先给整句译文；再挑出关键生词给出释义和一个例句。\n" +
        '默认中英互译；若内容中明确指定了其他目标语言（例如"翻译成日语"、"into French"），则翻译成该语言。\n\n' +
        "内容：\n" +
        query;
      void runAssistantStream(query, (onEvent) => streamOnce(prompt, onEvent), "翻译中");
      return;
    }

    // AI streaming chat. Main is the driver: append to the mirror, open the
    // result overlay, then stream — updating the mirror AND forwarding to it.
    // Flip back to chat in case the overlay is showing file results.
    modeRef.current = "chat";
    setMessages((m) => [
      ...m,
      { role: "user", content: query },
      { role: "assistant", content: "" },
    ]);
    setGenerating(true);
    setStatusText("生成中");
    await revealResult();
    emit(EV.RESULT_SET_MODE, { mode: "chat" }).catch(logErr("emit set-mode"));
    emit(EV.RESULT_CHAT_START, { userText: query }).catch(logErr("emit chat-start"));

    streamChat(query, (e) => {
      if (e.event === "delta") {
        setMessages((m) => patchLastAssistant(m, (c) => c + e.data.text));
        emit(EV.RESULT_CHAT_DELTA, { text: e.data.text }).catch(logErr("emit delta"));
      } else if (e.event === "done") {
        // Authoritative full text + the *real* model the gateway served. Never
        // wipe what was already streamed if the payload is empty/missing.
        const full = e.data.fullText;
        const model = e.data.model;
        setMessages((m) => {
          const copy = [...m];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === "assistant") {
              copy[i] = { ...copy[i], content: full || copy[i].content, ...(model ? { model } : {}) };
              break;
            }
          }
          return copy;
        });
        emit(EV.RESULT_CHAT_DONE, { fullText: full, model, stopped: e.data.stopped }).catch(
          logErr("emit done"),
        );
        setStatusText("已回复");
        schedulePersist();
      } else if (e.event === "error") {
        setMessages((m) => patchLastAssistant(m, () => `⚠️ ${e.data.message}`));
        emit(EV.RESULT_CHAT_ERROR, { message: e.data.message }).catch(logErr("emit error"));
        setStatusText("错误");
      }
    })
      .catch(logErr("chat"))
      .finally(() => setGenerating(false));
  }

  function handleHideResult() {
    // Esc in the bar: hide the overlay unless it's pinned.
    if (!pinnedRef.current) void concealResult();
  }

  function handleInputChange(next: string) {
    setValue(next);
    emit(PET_INPUT_PREVIEW, {
      text: next,
      mode: parseCommand(next).mode,
      at: Date.now(),
    }).catch(logErr("emit pet input preview"));
  }

  async function toggleResult() {
    // Spark click: show the overlay if hidden, hide it if already visible.
    if (await isResultVisible()) {
      await concealResult();
    } else {
      await revealResult();
    }
  }

  async function handleOpenSettings() {
    // Opening settings while an unpinned result is visible would clash (§13.5).
    if ((await isResultVisible()) && !pinnedRef.current) {
      await concealResult();
    }
    void openSettingsWindow();
  }

  // Nothing to paint until settings have loaded (the window is hidden anyway).
  if (!settings) return null;

  const locked = settings.window.locked;

  return (
    <div className="card">
      <InputBar
        value={value}
        locked={locked}
        statusText={statusText}
        onChange={onInputChange}
        onSubmit={handleSubmit}
        onOpenSettings={() => void handleOpenSettings()}
        onHideResult={handleHideResult}
        onToggleResult={() => void toggleResult()}
        resultOpen={resultOpen}
        inputRef={inputRef}
        paletteItems={paletteItems}
        paletteIndex={safePaletteIndex}
        paletteOpen={paletteOpen}
        onPaletteIndexChange={setPaletteIndex}
        onPaletteAccept={(item, via) => acceptPalette(item, via)}
        onPaletteDismiss={() => setPaletteDismissed(true)}
      />
    </div>
  );
}
