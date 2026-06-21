import { useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { loadSettings } from "../features/settings/settingsStore";
import { DEFAULT_PET, type PetSettings } from "../features/settings/settingsTypes";
import "./PetWindow.css";
import blinkSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/blink.png";
import dragSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/drag.png";
import dropSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/drop.png";
import happySheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/happy.png";
import idleSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/idle.png";
import sleepStartSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/sleep_start.png";
import sleepSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/sleep.png";
import surpriseSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/surprise.png";
import wakeSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/wake.png";
import waveSheetSrc from "../../assets/pet/vampire-sprite-v1/runtime/wave.png";

type PetAction =
  | "idle"
  | "blink"
  | "happy"
  | "drag"
  | "drop"
  | "surprise"
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
  drag: { src: dragSheetSrc, frames: 4, fps: 10, loop: true },
  drop: { src: dropSheetSrc, frames: 5, fps: 12, loop: false, next: "idle" },
  surprise: { src: surpriseSheetSrc, frames: 6, fps: 14, loop: false, next: "idle" },
  sleep_start: { src: sleepStartSheetSrc, frames: 5, fps: 8, loop: false, next: "sleep" },
  sleep: { src: sleepSheetSrc, frames: 4, fps: 6, loop: true },
  wake: { src: wakeSheetSrc, frames: 5, fps: 12, loop: false, next: "idle" },
  wave: { src: waveSheetSrc, frames: 5, fps: 12, loop: false, next: "idle" },
};
const DOUBLE_CLICK_MS = 320;
const AUTO_SLEEP_MS = 45_000;
const SLEEP_CHECK_MS = 5_000;

type PetEvent =
  | { type: "pet" }
  | { type: "blink" }
  | { type: "drag-start" }
  | { type: "drag-end" }
  | { type: "surprise" }
  | { type: "sleep" }
  | { type: "wake" }
  | { type: "wave" }
  | { type: "complete"; action: PetAction };

function petReducer(state: PetAction, event: PetEvent): PetAction {
  switch (event.type) {
    case "pet":
      return "happy";
    case "blink":
      return state === "idle" ? "blink" : state;
    case "drag-start":
      return "drag";
    case "drag-end":
      return state === "drag" ? "drop" : state;
    case "surprise":
      return "surprise";
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

function randomLine(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

export default function PetWindow() {
  const [action, dispatch] = useReducer(petReducer, "idle");
  const actionSpec = ACTIONS[action];
  const [settings, setSettings] = useState<PetSettings>(DEFAULT_PET);
  const settingsRef = useRef<PetSettings>(DEFAULT_PET);
  const actionRef = useRef<PetAction>("idle");
  const lastInteractionRef = useRef(Date.now());
  const lastClickAtRef = useRef(0);
  const [bubble, setBubble] = useState<string | null>(null);
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
      dispatch({ type: "wave" });
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
      un = await listen<{ pet: PetSettings }>("settings:updated", (ev) => {
        if (ev.payload?.pet) {
          settingsRef.current = ev.payload.pet;
          setSettings(ev.payload.pet);
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

  // Idle random-speech timer.
  useEffect(() => {
    if (!settings.speech_enabled || !settings.speech_lines?.length) return;
    const iv = settings.speech_interval_ms;
    if (!iv || iv <= 0) return;
    const lines = settings.speech_lines;
    let stopped = false;
    let timer = 0;
    // First bubble arrives soon after enable (so the user sees she can talk
    // without waiting the full interval); subsequent ones are spaced by `iv`.
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        if (stopped) return;
        if (actionRef.current !== "sleep" && actionRef.current !== "drag") {
          setBubble(randomLine(lines));
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
    const t = window.setTimeout(() => setBubble(null), 2500);
    return () => window.clearTimeout(t);
  }, [bubble]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (settingsRef.current.locked) return;
      if (actionRef.current === "idle" && Date.now() - lastInteractionRef.current > AUTO_SLEEP_MS) {
        dispatch({ type: "sleep" });
      }
    }, SLEEP_CHECK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Click vs drag disambiguation (no data-tauri-drag-region — it eats clicks).
  const dragState = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  function finishDrag() {
    const wasDragging = dragState.current?.moved || actionRef.current === "drag";
    dragState.current = null;
    if (wasDragging) dispatch({ type: "drag-end" });
  }

  function noteInteraction() {
    lastInteractionRef.current = Date.now();
    if (actionRef.current === "sleep") dispatch({ type: "wake" });
  }

  function onPointerDown(e: React.PointerEvent) {
    if (settingsRef.current.locked) return; // click-through handled by backend
    noteInteraction();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture is best-effort; native dragging still works without it.
    }
    dragState.current = { x: e.clientX, y: e.clientY, moved: false };
  }

  function onPointerMove(e: React.PointerEvent) {
    if (settingsRef.current.locked) return;
    // Drag detection (button held).
    const ds = dragState.current;
    if (!ds) return;
    if (!ds.moved && isDrag(ds.x, ds.y, e.clientX, e.clientY, DRAG_THRESHOLD)) {
      ds.moved = true;
      dispatch({ type: "drag-start" });
      getCurrentWindow()
        .startDragging()
        .catch((err) => console.error("[bugzia] startDragging", err))
        .finally(finishDrag);
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
    if (!ds) return;
    if (ds.moved) {
      finishDrag();
      return;
    }
    dragState.current = null;
    if (!ds.moved) {
      const now = Date.now();
      const isDoubleClick = now - lastClickAtRef.current <= DOUBLE_CLICK_MS;
      lastClickAtRef.current = isDoubleClick ? 0 : now;
      // A click (no drag) -> pet reaction + speech. A quick second click gets a
      // stronger surprise reaction without adding another visible control.
      dispatch({ type: isDoubleClick ? "surprise" : "pet" });
      const cur = settingsRef.current;
      if (cur.speech_enabled && cur.speech_lines?.length) {
        setBubble(randomLine(cur.speech_lines));
      }
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

  return (
    <div
      ref={rootRef}
      className={`pet-root pet-action-${action}`}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div className="pet-bubble-layer">
        {bubble != null && <div className="pet-bubble">{bubble}</div>}
        {action === "sleep" && bubble == null && <div className="pet-snooze">Zzz</div>}
      </div>
      <div className="pet-body-layer">
        <div className="pet-look">
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
