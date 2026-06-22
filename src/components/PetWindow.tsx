import { useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { loadSettings } from "../features/settings/settingsStore";
import {
  DEFAULT_AGENT_NOTIFY,
  DEFAULT_PET,
  type AgentNotifySettings,
  type PetSettings,
  type SettingsPatch,
} from "../features/settings/settingsTypes";
import {
  getPetImprovisedLine,
  getPetLine,
  type PetAiAction,
  type PetMood,
} from "../features/petAgent/petDialogue";
import type { PetSpeechScene } from "../features/petAgent/petCorpus";
import {
  PET_INPUT_PREVIEW,
  pickPetInputReaction,
  type PetInputPreview,
} from "../features/petAgent/petInput";
import {
  AGENT_NOTIFY_REACTION,
  PET_AGENT_NOTIFY,
  pickAgentNotifyLine,
  type PetAgentNotify,
} from "../features/petAgent/petAgentNotify";
import {
  createPetMemory,
  rememberPetEvent,
  summarizePetMemory,
  type PetMemory,
} from "../features/petAgent/petMemory";
import {
  learnPetPreferences,
  loadPetPreferences,
  summarizePetPreferences,
  type PetPreferences,
} from "../features/petAgent/petPreferences";
import "./PetWindow.css";
import annoyedSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/annoyed.png";
import blinkSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/blink.png";
import curiousSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/curious.png";
import doubleSurpriseSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/double_surprise.png";
import dragSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/drag.png";
import dropSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/drop.png";
import happySheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/happy.png";
import idleSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/idle.png";
import mockingSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/mocking.png";
import protectiveSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/protective.png";
import sleepStartSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/sleep_start.png";
import sleepSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/sleep.png";
import surpriseSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/surprise.png";
import tapHappySheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/tap_happy.png";
import wakeSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/wake.png";
import waveSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/wave.png";

type PetAction =
  | "idle"
  | "blink"
  | "happy"
  | "tap_happy"
  | "drag"
  | "drop"
  | "surprise"
  | "double_surprise"
  | "annoyed"
  | "curious"
  | "protective"
  | "mocking"
  | "sleep_start"
  | "sleep"
  | "wake"
  | "wave";
interface ActionSpec {
  src: string;
  frames: number;
  fps: number;
  loop: boolean;
  next?: PetAction;
}
const ACTIONS: Record<PetAction, ActionSpec> = {
  idle: { src: idleSheetSrc, frames: 6, fps: 8, loop: true },
  blink: { src: blinkSheetSrc, frames: 4, fps: 12, loop: false, next: "idle" },
  happy: { src: happySheetSrc, frames: 6, fps: 12, loop: false, next: "idle" },
  tap_happy: { src: tapHappySheetSrc, frames: 6, fps: 12, loop: false, next: "idle" },
  drag: { src: dragSheetSrc, frames: 4, fps: 10, loop: true },
  drop: { src: dropSheetSrc, frames: 5, fps: 12, loop: false, next: "idle" },
  surprise: { src: surpriseSheetSrc, frames: 6, fps: 14, loop: false, next: "idle" },
  double_surprise: { src: doubleSurpriseSheetSrc, frames: 6, fps: 14, loop: false, next: "idle" },
  annoyed: { src: annoyedSheetSrc, frames: 6, fps: 14, loop: false, next: "idle" },
  curious: { src: curiousSheetSrc, frames: 6, fps: 10, loop: false, next: "idle" },
  protective: { src: protectiveSheetSrc, frames: 6, fps: 12, loop: false, next: "idle" },
  mocking: { src: mockingSheetSrc, frames: 6, fps: 12, loop: false, next: "idle" },
  sleep_start: { src: sleepStartSheetSrc, frames: 5, fps: 8, loop: false, next: "sleep" },
  sleep: { src: sleepSheetSrc, frames: 4, fps: 6, loop: true },
  wake: { src: wakeSheetSrc, frames: 5, fps: 12, loop: false, next: "idle" },
  wave: { src: waveSheetSrc, frames: 5, fps: 12, loop: false, next: "idle" },
};
const DOUBLE_CLICK_MS = 320;
const AUTO_SLEEP_MS = 45_000;
const SLEEP_CHECK_MS = 5_000;
const INPUT_REACTION_MIN_INTERVAL_MS = 3_000;
const BUBBLE_TTL_MS = 2_500;
const AI_FAILURE_NOTICE_MIN_INTERVAL_MS = 30_000;
const AI_FAILURE_INTERACTION_NOTICE_MIN_INTERVAL_MS = 8_000;
const AI_UNAVAILABLE_LINE = "本女王暂时懒得回应。";
const CHAT_AI_TIMEOUT_MS = 20_000;
const CHAT_THINKING_LINE = "稍等，本女王正在想。";

type PetNoticePriority = "ambient" | "input" | "system" | "interaction";

const NOTICE_PRIORITY: Record<PetNoticePriority, number> = {
  ambient: 0,
  input: 1,
  system: 2,
  interaction: 3,
};

const MOOD_EXPRESSION: Partial<Record<PetMood, string>> = {
  pleased: "♪",
  annoyed: "!",
  curious: "?",
  sleepy: "Z",
  protective: "!!",
  mocking: "...",
};

type PetEvent =
  | { type: "pet" }
  | { type: "blink" }
  | { type: "drag-start" }
  | { type: "drag-end" }
  | { type: "surprise" }
  | { type: "annoyed" }
  | { type: "curious" }
  | { type: "protective" }
  | { type: "mocking" }
  | { type: "sleep" }
  | { type: "wake" }
  | { type: "wave" }
  | { type: "complete"; action: PetAction };

function petReducer(state: PetAction, event: PetEvent): PetAction {
  switch (event.type) {
    case "pet":
      return "tap_happy";
    case "blink":
      return state === "idle" ? "blink" : state;
    case "drag-start":
      return "drag";
    case "drag-end":
      return state === "drag" ? "drop" : state;
    case "surprise":
      return "double_surprise";
    case "annoyed":
      return "annoyed";
    case "curious":
      return "curious";
    case "protective":
      return "protective";
    case "mocking":
      return "mocking";
    case "sleep":
      return state === "idle" ? "sleep_start" : state;
    case "wake":
      return state === "sleep" ? "wake" : state;
    case "complete":
      if (state !== event.action) return state;
      return ACTIONS[state].next ?? "idle";
    case "wave":
      return state === "idle" ? "wave" : state;
    default:
      return state;
  }
}

/** Pointer moved past `threshold` px from the start point -> it's a drag, not a
 *  click. Kept as an exported pure function so it can be unit-tested later. */
export function isDrag(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  threshold = 5,
): boolean {
  return Math.hypot(endX - startX, endY - startY) > threshold;
}

const DRAG_THRESHOLD = 5;
const PET_DRAG_POLL_MS = 16;

/** Result of `pet_eat_files`: how many files the pet "ate" vs couldn't swallow. */
interface EatResult {
  eaten: number;
  failed: { path: string; error: string }[];
}

interface ActivePetNotice {
  id: number;
  priority: PetNoticePriority;
  expiresAt: number;
}

export default function PetWindow() {
  const [action, dispatch] = useReducer(petReducer, "idle");
  const actionSpec = ACTIONS[action];
  const [settings, setSettings] = useState<PetSettings>(DEFAULT_PET);
  const settingsRef = useRef<PetSettings>(DEFAULT_PET);
  const actionRef = useRef<PetAction>("idle");
  const lastInteractionRef = useRef(Date.now());
  const lastClickAtRef = useRef(0);
  const lastAiSpeechAtRef = useRef(0);
  const lastAiFailureNoticeAtRef = useRef(0);
  const lastInputReactionAtRef = useRef(0);
  const lastInputReactionTextRef = useRef("");
  const speechRequestRef = useRef(0);
  const chatRequestRef = useRef(0);
  const dragSessionRef = useRef(0);
  const dragPollTimerRef = useRef<number | null>(null);
  const noticeIdRef = useRef(0);
  const activeNoticeRef = useRef<ActivePetNotice | null>(null);
  const memoryRef = useRef<PetMemory>(createPetMemory());
  const preferencesRef = useRef<PetPreferences>(loadPetPreferences());
  // agent_notify cfg (cooldown_ms + only_unfocused are read here; the per-kind
  // on_* flags + show_content are enforced Rust-side before the event fires).
  const agentNotifyRef = useRef<AgentNotifySettings>(DEFAULT_AGENT_NOTIFY);
  const lastAgentNotifyAtRef = useRef<Record<string, number>>({});
  const [bubble, setBubble] = useState<string | null>(null);
  const [mood, setMood] = useState<PetMood>("neutral");
  const [dragOver, setDragOver] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatPending, setChatPending] = useState(false);
  const [chatText, setChatText] = useState("");
  const [frame, setFrame] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    actionRef.current = action;
    setFrame(0);
  }, [action]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setFrame((current) => {
        const spec = ACTIONS[actionRef.current];
        const next = current + 1;
        if (next < spec.frames) return next;
        if (spec.loop) return 0;
        dispatch({ type: "complete", action: actionRef.current });
        return current;
      });
    }, 1000 / actionSpec.fps);
    return () => window.clearInterval(timer);
  }, [actionSpec.fps]);

  // Load settings on mount. The displayed art is the bundled vampire-sprite-v1
  // set, so stale user-dir pose PNGs cannot accidentally bring back old art.
  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await loadSettings();
      if (!alive) return;
      settingsRef.current = s.pet;
      setSettings(s.pet);
      agentNotifyRef.current = { ...DEFAULT_AGENT_NOTIFY, ...s.agent_notify };
      dispatch({ type: "wave" });
      if (s.pet.speech_enabled) speak("startup");
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Live-apply settings changes broadcast by the settings window.
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let alive = true;
    (async () => {
      un = await listen<SettingsPatch>("settings:updated", (ev) => {
        if (ev.payload?.pet) {
          settingsRef.current = ev.payload.pet;
          setSettings(ev.payload.pet);
        }
        if (ev.payload?.agent_notify) {
          agentNotifyRef.current = { ...DEFAULT_AGENT_NOTIFY, ...ev.payload.agent_notify };
        }
      });
      if (!alive && un) un();
    })();
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  // Idle blink timer (recursive). Cheap; keeps running while hidden (no harm).
  useEffect(() => {
    const iv = settings.blink_interval_ms;
    if (!iv || iv <= 0) return;
    let stopped = false;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (stopped) return;
        if (actionRef.current === "idle") dispatch({ type: "blink" });
        schedule();
      }, iv);
    };
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [settings.blink_interval_ms]);

  useEffect(() => {
    let un: UnlistenFn | undefined;
    let alive = true;
    (async () => {
      un = await listen<PetInputPreview>(PET_INPUT_PREVIEW, (ev) => {
        reactToInputPreview(ev.payload);
      });
      if (!alive && un) un();
    })();
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  // Agent-notify events (Claude Code / Codex lifecycle) relayed by the Rust
  // receiver. Classified backend-side; the pet only renders the bubble + pose.
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let alive = true;
    (async () => {
      un = await listen<PetAgentNotify>(PET_AGENT_NOTIFY, (ev) => {
        reactToAgentNotify(ev.payload);
      });
      if (!alive && un) un();
    })();
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  // Idle random-speech timer.
  useEffect(() => {
    if (!settings.speech_enabled) return;
    const iv = settings.speech_interval_ms;
    if (!iv || iv <= 0) return;
    const lines = settings.speech_lines ?? [];
    let stopped = false;
    let timer = 0;
    // First bubble arrives soon after enable (so the user sees she can talk
    // without waiting the full interval); subsequent ones are spaced by `iv`.
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        if (stopped) return;
        if (actionRef.current !== "sleep" && actionRef.current !== "drag") {
          speak("idle", {
            extraLines: lines,
            improvise: true,
            minAiIntervalMs: settingsRef.current.ai_idle_interval_ms,
          });
        }
        schedule(iv);
      }, delay);
    };
    schedule(1500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [settings.speech_enabled, settings.speech_interval_ms, settings.speech_lines]);

  // Auto-clear the speech bubble after a moment.
  useEffect(() => {
    if (bubble == null) return;
    const currentNotice = activeNoticeRef.current;
    const delay = currentNotice ? Math.max(0, currentNotice.expiresAt - Date.now()) : BUBBLE_TTL_MS;
    const t = window.setTimeout(() => {
      if (currentNotice && activeNoticeRef.current?.id !== currentNotice.id) return;
      activeNoticeRef.current = null;
      setBubble(null);
    }, delay);
    return () => window.clearTimeout(t);
  }, [bubble]);

  // OS file drag-drop: dropping files on the pet sends them to the recycle bin
  // ("the pet eats them"). Only active when NOT locked — a click-through (locked)
  // window can't receive OS drops, and feeding implies interacting with her.
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let alive = true;
    (async () => {
      const win = getCurrentWindow();
      un = await win.onDragDropEvent((event) => {
        const p = event.payload;
        if (settingsRef.current.locked) return;
        if (p.type === "enter") {
          setDragOver(true);
          speak("feedingHover");
        } else if (p.type === "over") {
          setDragOver(true);
        } else if (p.type === "leave") {
          setDragOver(false);
        } else if (p.type === "drop") {
          setDragOver(false);
          void eatFiles(p.paths ?? []);
        }
      });
      if (!alive && un) un();
    })();
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (settingsRef.current.locked) return;
      if (actionRef.current === "idle" && Date.now() - lastInteractionRef.current > AUTO_SLEEP_MS) {
        dispatch({ type: "sleep" });
        speak("sleepStart");
      }
    }, SLEEP_CHECK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Click vs drag disambiguation (no data-tauri-drag-region — it eats clicks).
  const dragState = useRef<{
    session: number;
    pointerX: number;
    pointerY: number;
    x: number;
    y: number;
    winX: number;
    winY: number;
    moved: boolean;
    ready: boolean;
  } | null>(null);

  function stopDragPoll() {
    if (dragPollTimerRef.current == null) return;
    window.clearTimeout(dragPollTimerRef.current);
    dragPollTimerRef.current = null;
  }

  function startDragPoll(session: number) {
    if (dragPollTimerRef.current != null) return;

    const tick = () => {
      const ds = dragState.current;
      if (!ds || !ds.moved || !ds.ready || dragSessionRef.current !== session) {
        dragPollTimerRef.current = null;
        return;
      }

      void cursorPosition()
        .then((cursor) => {
          const current = dragState.current;
          if (!current || !current.moved || !current.ready || dragSessionRef.current !== session) {
            return undefined;
          }
          const nextX = current.winX + cursor.x - current.x;
          const nextY = current.winY + cursor.y - current.y;
          return getCurrentWindow().setPosition(new PhysicalPosition(Math.round(nextX), Math.round(nextY)));
        })
        .catch((err) => console.error("[bugzia] pet setPosition", err))
        .finally(() => {
          if (dragState.current?.moved && dragSessionRef.current === session) {
            dragPollTimerRef.current = window.setTimeout(tick, PET_DRAG_POLL_MS);
          } else {
            dragPollTimerRef.current = null;
          }
        });
    };

    dragPollTimerRef.current = window.setTimeout(tick, 0);
  }

  function finishDrag() {
    const wasDragging = dragState.current?.moved || actionRef.current === "drag";
    stopDragPoll();
    dragSessionRef.current += 1;
    dragState.current = null;
    if (wasDragging) {
      dispatch({ type: "drag-end" });
      speak("drop");
    }
  }

  function noteInteraction() {
    lastInteractionRef.current = Date.now();
    if (actionRef.current === "sleep") {
      dispatch({ type: "wake" });
      speak("wake");
    }
  }

  function showPetNotice(
    line: string,
    moodValue: PetMood,
    priority: PetNoticePriority,
    aiAction?: PetAiAction,
  ): number | null {
    const now = Date.now();
    const current = activeNoticeRef.current;
    if (
      current &&
      current.expiresAt > now &&
      NOTICE_PRIORITY[priority] < NOTICE_PRIORITY[current.priority]
    ) {
      return null;
    }

    const id = ++noticeIdRef.current;
    activeNoticeRef.current = {
      id,
      priority,
      expiresAt: now + BUBBLE_TTL_MS,
    };
    if (aiAction) applyAiAction(aiAction);
    setMood(moodValue);
    setBubble(line);
    return id;
  }

  function canResolveNotice(id: number | null): boolean {
    return (
      id != null &&
      noticeIdRef.current === id &&
      (activeNoticeRef.current == null || activeNoticeRef.current.id === id)
    );
  }

  function showAiFailureNotice(priority: PetNoticePriority) {
    const now = Date.now();
    const minInterval =
      priority === "interaction"
        ? AI_FAILURE_INTERACTION_NOTICE_MIN_INTERVAL_MS
        : AI_FAILURE_NOTICE_MIN_INTERVAL_MS;
    if (now - lastAiFailureNoticeAtRef.current < minInterval) return;
    lastAiFailureNoticeAtRef.current = now;
    showPetNotice(AI_UNAVAILABLE_LINE, "mocking", priority);
  }

  async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("pet chat AI timeout")), ms);
      promise
        .then(resolve)
        .catch(reject)
        .finally(() => window.clearTimeout(timeout));
    });
  }

  function reactToInputPreview(payload: PetInputPreview) {
    if (settingsRef.current.locked || !settingsRef.current.speech_enabled) return;
    if (actionRef.current === "sleep" || actionRef.current === "drag") return;

    const text = payload.text.trim();
    if (text.length < 4) return;
    if (text === lastInputReactionTextRef.current) return;

    const now = Date.now();
    if (now - lastInputReactionAtRef.current < INPUT_REACTION_MIN_INTERVAL_MS) return;

    const reaction = pickPetInputReaction(text, payload.mode);
    if (!reaction) return;

    lastInputReactionAtRef.current = now;
    lastInputReactionTextRef.current = text;
    lastInteractionRef.current = now;
    memoryRef.current = rememberPetEvent(memoryRef.current, "inputPreview", reaction.line);
    const moodValue = reaction.kind === "happy"
      ? "pleased"
      : reaction.kind === "surprise" || reaction.kind === "curious"
        ? "curious"
        : reaction.kind === "protective"
          ? "protective"
          : reaction.kind === "annoyed"
            ? "annoyed"
            : reaction.kind === "mocking"
              ? "mocking"
              : "neutral";
    const aiAction = reaction.kind === "happy"
      ? "happy"
      : reaction.kind === "surprise"
        ? "surprise"
        : reaction.kind === "curious"
          ? "curious"
          : reaction.kind === "protective"
            ? "protective"
            : reaction.kind === "annoyed"
              ? "annoyed"
              : reaction.kind === "mocking"
                ? "mocking"
                : undefined;
    showPetNotice(
      reaction.line,
      moodValue,
      "input",
      aiAction,
    );
  }

  /** Best-effort "is any Bugzia window focused right now?" Backs the
   *  agent-notify only_unfocused gate. The pet window's ACL may forbid
   *  cross-window focus queries; on any error we resolve false (fail-open). */
  async function isAnyBugziaFocused(): Promise<boolean> {
    try {
      const all = await WebviewWindow.getAll();
      for (const w of all) {
        try {
          if (await w.isFocused()) return true;
        } catch {
          // A specific window may reject on ACL; ignore it and keep checking.
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /** React to a Claude Code / Codex lifecycle event relayed by the Rust
   *  receiver. Gated by speech_enabled (consistent with speak()) and the drag
   *  state; a per-kind cooldown stops back-to-back turns from spamming bubbles;
   *  only_unfocused suppresses the bubble while a Bugzia window is focused. */
  function reactToAgentNotify(payload: PetAgentNotify) {
    if (!settingsRef.current.speech_enabled) return;
    if (actionRef.current === "drag") return;

    const cfg = agentNotifyRef.current;
    if (!cfg.enabled) return;
    if ((payload.kind === "done" || payload.kind === "paused") && !cfg.on_done) return;
    if (payload.kind === "needs" && !cfg.on_needs) return;
    if (payload.kind === "error" && !cfg.on_error) return;

    const now = Date.now();
    const cooldown = cfg.cooldown_ms ?? 0;
    if (cooldown > 0) {
      const last = lastAgentNotifyAtRef.current[payload.kind] ?? 0;
      if (now - last < cooldown) return;
    }
    lastAgentNotifyAtRef.current[payload.kind] = now;

    const fire = () => {
      const reaction = AGENT_NOTIFY_REACTION[payload.kind] ?? AGENT_NOTIFY_REACTION.needs;
      const parts = [pickAgentNotifyLine(payload.source, payload.kind)];
      if (payload.tool) parts.push(`（${payload.tool}）`);
      if (cfg.show_content && payload.summary) parts.push(payload.summary);
      noteInteraction();
      showPetNotice(parts.join(" "), reaction.mood, "system", reaction.action);
    };

    if (cfg.only_unfocused) {
      void isAnyBugziaFocused()
        .then((focused) => {
          if (!focused) fire();
        })
        .catch(() => fire());
    } else {
      fire();
    }
  }

  function applyAiAction(aiAction: PetAiAction) {
    if (aiAction === "happy") dispatch({ type: "pet" });
    if (aiAction === "surprise") dispatch({ type: "surprise" });
    if (aiAction === "wake") dispatch({ type: "wake" });
    if (aiAction === "annoyed") dispatch({ type: "annoyed" });
    if (aiAction === "curious") dispatch({ type: "curious" });
    if (aiAction === "protective") dispatch({ type: "protective" });
    if (aiAction === "mocking") dispatch({ type: "mocking" });
  }

  function moodForScene(scene: PetSpeechScene): PetMood {
    switch (scene) {
      case "startup":
      case "click":
      case "fed":
      case "chat":
        return "pleased";
      case "doubleClick":
      case "drag":
      case "wake":
        return "annoyed";
      case "drop":
      case "fedFail":
        return "mocking";
      case "feedingHover":
      case "inputPreview":
        return "curious";
      case "sleepStart":
        return "sleepy";
      case "idle":
      default:
        return "neutral";
    }
  }

  function priorityForScene(scene: PetSpeechScene): PetNoticePriority {
    switch (scene) {
      case "idle":
        return "ambient";
      case "inputPreview":
      case "feedingHover":
        return "input";
      case "sleepStart":
      case "wake":
        return "system";
      default:
        return "interaction";
    }
  }

  /** "Eat" dropped files: send them to the OS recycle bin and react happily.
   *  Uses local lines via speak() so the feeding is remembered in memory, with no
   *  AI latency. */
  async function eatFiles(paths: string[]) {
    const valid = paths.filter((p) => p && p.trim().length > 0);
    if (valid.length === 0) return;
    noteInteraction();
    dispatch({ type: "pet" }); // -> happy (pleased with the tribute)
    try {
      const res = await invoke<EatResult>("pet_eat_files", { paths: valid });
      if (res.failed.length === 0) {
        speak("fed");
      } else if (res.eaten === 0) {
        speak("fedFail");
      } else if (settingsRef.current.speech_enabled) {
        showPetNotice(`${getPetLine("fed")}（${res.failed.length} 件没吃下）`, "pleased", "interaction");
      }
    } catch {
      speak("fedFail");
    }
  }

  function speak(
    scene: PetSpeechScene,
    options: {
      extraLines?: string[];
      improvise?: boolean;
      minAiIntervalMs?: number;
      userText?: string;
    } = {},
  ) {
    if (!settingsRef.current.speech_enabled) return;
    const localLine = getPetLine(scene, options.extraLines);
    memoryRef.current = rememberPetEvent(memoryRef.current, scene, localLine);
    const noticeId = showPetNotice(localLine, moodForScene(scene), priorityForScene(scene));
    if (noticeId == null) return;

    if (!options.improvise || !settingsRef.current.ai_speech_enabled) return;
    const now = Date.now();
    const minInterval = options.minAiIntervalMs ?? settingsRef.current.ai_interaction_interval_ms;
    if (now - lastAiSpeechAtRef.current < minInterval) return;
    if (actionRef.current === "sleep" || actionRef.current === "drag") return;

    lastAiSpeechAtRef.current = now;
    const requestId = ++speechRequestRef.current;
    const memorySummary = summarizePetMemory(memoryRef.current);
    const preferenceSummary = summarizePetPreferences(preferencesRef.current);
    void getPetImprovisedLine(scene, localLine, memorySummary, preferenceSummary, options.userText)
      .then((reply) => {
        if (speechRequestRef.current !== requestId) return;
        if (!canResolveNotice(noticeId)) return;
        if (!settingsRef.current.speech_enabled) return;
        if (actionRef.current === "sleep" || actionRef.current === "drag") return;
        memoryRef.current = rememberPetEvent(memoryRef.current, scene, reply.line);
        showPetNotice(reply.line, reply.mood, priorityForScene(scene), reply.action);
      })
      .catch(() => {
        if (!canResolveNotice(noticeId)) return;
        showAiFailureNotice(priorityForScene(scene));
      });
  }

  function openChat() {
    if (settingsRef.current.locked) return;
    if (!settingsRef.current.chat_enabled) return;
    if (chatPending) return;
    noteInteraction();
    setChatOpen(true);
    setChatText("");
  }

  function cancelChat() {
    setChatOpen(false);
    setChatText("");
  }

  function submitChat() {
    const text = chatText.trim();
    cancelChat();
    if (!text) {
      return;
    }

    noteInteraction();
    dispatch({ type: "pet" });
    const learning = learnPetPreferences(text, preferencesRef.current);
    preferencesRef.current = learning.preferences;
    if (learning.learnedLine) {
      memoryRef.current = rememberPetEvent(memoryRef.current, "chat", learning.learnedLine);
      showPetNotice(learning.learnedLine, "pleased", "interaction");
      return;
    }

    if (!settingsRef.current.speech_enabled) return;

    const localLine = getPetLine("chat");
    memoryRef.current = rememberPetEvent(memoryRef.current, "chat", localLine);
    const noticeId = showPetNotice(CHAT_THINKING_LINE, "curious", "interaction");
    if (noticeId == null) return;

    if (!settingsRef.current.ai_speech_enabled) {
      showPetNotice(localLine, moodForScene("chat"), "interaction");
      return;
    }

    lastAiSpeechAtRef.current = Date.now();
    setChatPending(true);
    const requestId = ++chatRequestRef.current;
    const memorySummary = summarizePetMemory(memoryRef.current);
    const preferenceSummary = summarizePetPreferences(preferencesRef.current);
    void withTimeout(
      getPetImprovisedLine("chat", localLine, memorySummary, preferenceSummary, text.slice(0, 160)),
      CHAT_AI_TIMEOUT_MS,
    )
      .then((reply) => {
        if (chatRequestRef.current !== requestId) return;
        if (!canResolveNotice(noticeId)) return;
        if (!settingsRef.current.speech_enabled) return;
        if (actionRef.current === "sleep" || actionRef.current === "drag") return;
        memoryRef.current = rememberPetEvent(memoryRef.current, "chat", reply.line);
        showPetNotice(reply.line, reply.mood, "interaction", reply.action);
      })
      .catch(() => {
        if (chatRequestRef.current !== requestId) return;
        if (!canResolveNotice(noticeId)) return;
        showAiFailureNotice("interaction");
      })
      .finally(() => {
        if (chatRequestRef.current === requestId) setChatPending(false);
      });
  }

  function onPointerDown(e: React.PointerEvent) {
    if (settingsRef.current.locked) return; // click-through handled by backend
    noteInteraction();
    const session = ++dragSessionRef.current;
    dragState.current = {
      session,
      pointerX: e.screenX,
      pointerY: e.screenY,
      x: 0,
      y: 0,
      winX: 0,
      winY: 0,
      moved: false,
      ready: false,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture is best-effort; native dragging still works without it.
    }
    void Promise.all([getCurrentWindow().outerPosition(), cursorPosition()])
      .then(([pos, cursor]) => {
        if (dragSessionRef.current !== session) return;
        if (!dragState.current) return;
        dragState.current = {
          ...dragState.current,
          x: cursor.x,
          y: cursor.y,
          winX: pos.x,
          winY: pos.y,
          ready: true,
        };
        if (dragState.current.moved) {
          startDragPoll(dragState.current.session);
        }
      })
      .catch((err) => console.error("[bugzia] pet drag setup", err));
  }

  function onPointerMove(e: React.PointerEvent) {
    if (settingsRef.current.locked) return;
    // Drag detection (button held).
    const ds = dragState.current;
    if (!ds) return;
    if (!ds.moved && isDrag(ds.pointerX, ds.pointerY, e.screenX, e.screenY, DRAG_THRESHOLD)) {
      ds.moved = true;
      dispatch({ type: "drag-start" });
      speak("drag");
      if (ds.ready) {
        startDragPoll(ds.session);
      }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (settingsRef.current.locked) return;
    noteInteraction();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Matching the best-effort capture above.
    }
    const ds = dragState.current;
    if (!ds) {
      stopDragPoll();
      dragSessionRef.current += 1;
      return;
    }
    if (ds.moved) {
      finishDrag();
      return;
    }
    dragSessionRef.current += 1;
    stopDragPoll();
    dragState.current = null;
    if (!ds.moved) {
      const now = Date.now();
      const isDoubleClick = now - lastClickAtRef.current <= DOUBLE_CLICK_MS;
      lastClickAtRef.current = isDoubleClick ? 0 : now;
      // A click (no drag) -> pet reaction + speech. A quick second click gets a
      // stronger surprise reaction without adding another visible control.
      dispatch({ type: isDoubleClick ? "surprise" : "pet" });
      if (isDoubleClick) openChat();
      speak(isDoubleClick ? "doubleClick" : "click", {
        improvise: true,
        minAiIntervalMs: settingsRef.current.ai_interaction_interval_ms,
      });
    }
  }

  function onPointerCancel() {
    finishDrag();
  }

  const style = { "--scale": settings.scale } as CSSProperties;
  const sheetStyle = {
    width: `${actionSpec.frames * 100}%`,
    transform: `translateX(-${(frame * 100) / actionSpec.frames}%)`,
  } as CSSProperties;
  const expression = MOOD_EXPRESSION[mood];

  return (
    <div
      ref={rootRef}
      className={`pet-root pet-action-${action} pet-mood-${mood}${dragOver ? " pet-dragover" : ""}`}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div className="pet-bubble-layer">
        {bubble != null && <div className="pet-bubble">{bubble}</div>}
        {chatOpen && (
          <div className="pet-chat" onPointerDown={(e) => e.stopPropagation()}>
            <input
              className="pet-chat-input"
              autoFocus
              disabled={chatPending}
              value={chatText}
              placeholder={chatPending ? "本女王正在思考" : "对她说点什么"}
              maxLength={160}
              onChange={(e) => setChatText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  submitChat();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelChat();
                }
              }}
            />
            <button
              type="button"
              className="pet-chat-cancel"
              aria-label="取消输入"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                cancelChat();
              }}
            >
              ×
            </button>
          </div>
        )}
        {action === "sleep" && bubble == null && <div className="pet-snooze">Zzz</div>}
      </div>
      <div className="pet-body-layer">
        <div className="pet-look">
          {expression && <div className="pet-expression" aria-hidden="true">{expression}</div>}
          <div className="pet-sprite-shell" aria-hidden="true">
            <img
              className="pet-sprite-sheet"
              src={actionSpec.src}
              alt=""
              draggable={false}
              style={sheetStyle}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
