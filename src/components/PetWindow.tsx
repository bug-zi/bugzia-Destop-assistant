import { useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { loadSettings } from "../features/settings/settingsStore";
import { DEFAULT_PET, type PetSettings } from "../features/settings/settingsTypes";
import "./PetWindow.css";

type Pose = "idle" | "blink" | "happy";
const POSES: Pose[] = ["idle", "blink", "happy"];

type PetEvent =
  | { type: "pet" }
  | { type: "blink" }
  | { type: "to-idle" };

/** Pose state machine. `happy`/`blink` are transient — an effect reverts them to
 *  `idle` after a short delay (see `useEffect([pose])`). */
function petReducer(state: Pose, event: PetEvent): Pose {
  switch (event.type) {
    case "pet":
      return "happy";
    case "blink":
      return "blink";
    case "to-idle":
      return "idle";
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

/** Inline SVG shown when a pose PNG is missing or fails to load, so the feature
 *  is fully testable before real art exists. A pink chibi-ish labeled card. */
function placeholderDataUri(pose: Pose): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='150' height='200'>` +
    `<rect width='150' height='200' rx='18' fill='#FFB7C5' opacity='0.9'/>` +
    `<circle cx='75' cy='78' r='44' fill='#ffffff'/>` +
    `<circle cx='61' cy='74' r='6' fill='#5a3b46'/>` +
    `<circle cx='89' cy='74' r='6' fill='#5a3b46'/>` +
    `<path d='M62 92 Q75 102 88 92' stroke='#5a3b46' stroke-width='3' fill='none' stroke-linecap='round'/>` +
    `<text x='75' y='150' font-size='13' text-anchor='middle' fill='#ffffff'>${pose}</text>` +
    `<text x='75' y='172' font-size='11' text-anchor='middle' fill='#ffffff' opacity='0.85'>占位</text>` +
    `</svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function randomLine(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

export default function PetWindow() {
  const [pose, dispatch] = useReducer(petReducer, "idle");
  const [settings, setSettings] = useState<PetSettings>(DEFAULT_PET);
  const settingsRef = useRef<PetSettings>(DEFAULT_PET);
  const [bubble, setBubble] = useState<string | null>(null);
  const [poseSrcs, setPoseSrcs] = useState<Record<Pose, string> | null>(null);
  const [failed, setFailed] = useState<Partial<Record<Pose, boolean>>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Load settings on mount + resolve pose image URLs from ${appDataDir}/pet (the
  // dir is created by the `pet_assets_dir` backend command).
  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await loadSettings();
      if (!alive) return;
      settingsRef.current = s.pet;
      setSettings(s.pet);
      try {
        const dir = await invoke<string>("pet_assets_dir");
        if (!alive) return;
        const map = {} as Record<Pose, string>;
        for (const p of POSES) map[p] = convertFileSrc(`${dir}/${p}.png`);
        setPoseSrcs(map);
        setFailed({}); // clear stale per-pose failures on a fresh resolve
      } catch (e) {
        console.error("[bugzia] resolve pet asset dir", e);
      }
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

  // Revert a transient pose (happy / blink) back to idle.
  useEffect(() => {
    if (pose === "idle") return;
    const ms = pose === "blink" ? 150 : 800;
    const t = window.setTimeout(() => dispatch({ type: "to-idle" }), ms);
    return () => window.clearTimeout(t);
  }, [pose]);

  // Idle blink timer (recursive). Cheap; keeps running while hidden (no harm).
  useEffect(() => {
    const iv = settings.blink_interval_ms;
    if (!iv || iv <= 0) return;
    let stopped = false;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (stopped) return;
        dispatch({ type: "blink" });
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
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (stopped) return;
        setBubble(randomLine(lines));
        schedule();
      }, iv);
    };
    schedule();
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

  // Click vs drag disambiguation (no data-tauri-drag-region — it eats clicks).
  const dragState = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    if (settingsRef.current.locked) return; // click-through handled by backend
    dragState.current = { x: e.clientX, y: e.clientY, moved: false };
  }

  function onPointerMove(e: React.PointerEvent) {
    const el = rootRef.current;
    // Hover look (no button held): write normalized cursor pos as CSS vars.
    if (el && e.buttons === 0) {
      const r = el.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      el.style.setProperty("--look-x", nx.toFixed(3));
      el.style.setProperty("--look-y", ny.toFixed(3));
    }
    // Drag detection (button held).
    const ds = dragState.current;
    if (!ds) return;
    if (!ds.moved && isDrag(ds.x, ds.y, e.clientX, e.clientY, DRAG_THRESHOLD)) {
      ds.moved = true;
      getCurrentWindow()
        .startDragging()
        .catch((err) => console.error("[bugzia] startDragging", err));
    }
  }

  function onPointerUp() {
    const ds = dragState.current;
    dragState.current = null;
    if (!ds) return;
    if (!ds.moved) {
      // A click (no drag) -> pet reaction + speech.
      dispatch({ type: "pet" });
      const cur = settingsRef.current;
      if (cur.speech_enabled && cur.speech_lines?.length) {
        setBubble(randomLine(cur.speech_lines));
      }
    }
  }

  const src = poseSrcs?.[pose];
  const showFallback = !src || !!failed[pose];
  const style = { "--scale": settings.scale } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className="pet-root"
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {bubble != null && <div className="pet-bubble">{bubble}</div>}
      <div className="pet-look">
        {showFallback ? (
          <img className="pet-sprite" src={placeholderDataUri(pose)} alt="" draggable={false} />
        ) : (
          <img
            className="pet-sprite"
            src={src}
            alt=""
            draggable={false}
            onError={() => setFailed((f) => ({ ...f, [pose]: true }))}
          />
        )}
      </div>
    </div>
  );
}
