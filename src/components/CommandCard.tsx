import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import InputBar from "./InputBar";
import "./CommandCard.css";
import { browserSearch, COMMANDS, parseCommand, SEARCH_ENGINES, type CommandMode, type SearchEngine } from "../features/search/command";
import { streamChat, streamOnce, stopChat, clearContext, type ChatEvent, type ChatMessage } from "../features/ai/chat";
import { loadSettings, saveSettings } from "../features/settings/settingsStore";
import { openSettingsWindow } from "../features/settings/settingsWindow";
import { applyAppearanceVars } from "../features/appearance/appearance";
import type { AppSettings, WaveformSettings, WindowSettings, SettingsPatch } from "../features/settings/settingsTypes";
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
import { EV, type FileResult, type ResultMode } from "../features/result/resultTypes";

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

/** Markdown listing of every command in the registry (powers /help). */
function renderHelpMarkdown(): string {
  const lines = COMMANDS.filter((c) => !c.hidden).map((c) => {
    const triggers = [c.prefix, ...(c.aliases ?? [])].filter(Boolean) as string[];
    return `- **${triggers.join(" / ")}** — ${c.description}`;
  });
  return [
    "可用命令",
    "",
    ...lines,
    "",
    "直接输入文本即与 AI 对话；带参数的命令需在命令名后加一个空格再写内容。",
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

  // One-line status shown in the bar without stretching the layout.
  const [statusText, setStatusText] = useState("");

  // Whether the result overlay is currently open — drives the spark's active
  // state. Kept in sync across every show/hide path via reveal/conceal below.
  const [resultOpen, setResultOpen] = useState(false);

  const settingsRef = useRef<AppSettings | null>(null);
  const saveTimer = useRef<number | null>(null);

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
          void clearContext().catch(logErr("clear_context"));
          setMessages([]);
          setStatusText("");
          emit(EV.RESULT_CHAT_CLEARED).catch(logErr("emit cleared"));
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

  // Tray "桌面波形" toggle persists in Rust + emits settings://changed. Reload the
  // authoritative settings so our mirror — and the enabled effect below — sync.
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
        onChange={setValue}
        onSubmit={handleSubmit}
        onOpenSettings={() => void handleOpenSettings()}
        onHideResult={handleHideResult}
        onToggleResult={() => void toggleResult()}
        resultOpen={resultOpen}
      />
    </div>
  );
}
