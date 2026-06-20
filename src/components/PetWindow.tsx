import { useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { loadSettings } from "../features/settings/settingsStore";
import { DEFAULT_PET, type PetSettings } from "../features/settings/settingsTypes";
import "./PetWindow.css";

type Pose = "idle" | "blink" | "happy" | "drag" | "surprise" | "sleep";
const POSES: Pose[] = ["idle", "blink", "happy", "drag", "surprise", "sleep"];
const POSE_ASSET_FALLBACKS: Record<Pose, Pose[]> = {
  idle: ["idle"],
  blink: ["blink", "idle"],
  happy: ["happy", "idle"],
  drag: ["drag", "happy", "idle"],
  surprise: ["surprise", "happy", "idle"],
  sleep: ["sleep", "blink", "idle"],
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
  | { type: "to-idle" };

/** Pose state machine. `happy`/`blink` are transient — an effect reverts them to
 *  `idle` after a short delay (see `useEffect([pose])`). */
function petReducer(state: Pose, event: PetEvent): Pose {
  switch (event.type) {
    case "pet":
      return "happy";
    case "blink":
      return state === "idle" ? "blink" : state;
    case "drag-start":
      return "drag";
    case "drag-end":
      return "idle";
    case "surprise":
      return "surprise";
    case "sleep":
      return state === "idle" ? "sleep" : state;
    case "wake":
      return state === "sleep" ? "idle" : state;
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

function randomLine(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

function pickPoseAsset(
  poseSrcs: Record<Pose, string> | null,
  failed: Partial<Record<Pose, boolean>>,
  pose: Pose,
): { src: string | null; assetPose: Pose } {
  for (const assetPose of POSE_ASSET_FALLBACKS[pose]) {
    const src = poseSrcs?.[assetPose];
    if (src && !failed[assetPose]) return { src, assetPose };
  }
  return { src: null, assetPose: pose };
}

export default function PetWindow() {
  const [pose, dispatch] = useReducer(petReducer, "idle");
  const [settings, setSettings] = useState<PetSettings>(DEFAULT_PET);
  const settingsRef = useRef<PetSettings>(DEFAULT_PET);
  const poseRef = useRef<Pose>("idle");
  const lastInteractionRef = useRef(Date.now());
  const lastClickAtRef = useRef(0);
  const [bubble, setBubble] = useState<string | null>(null);
  const [poseSrcs, setPoseSrcs] = useState<Record<Pose, string> | null>(null);
  const [failed, setFailed] = useState<Partial<Record<Pose, boolean>>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    poseRef.current = pose;
  }, [pose]);

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
    if (pose === "idle" || pose === "drag" || pose === "sleep") return;
    const ms = pose === "blink" ? 200 : pose === "surprise" ? 650 : 800;
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
        if (poseRef.current === "idle") dispatch({ type: "blink" });
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
        if (poseRef.current !== "sleep" && poseRef.current !== "drag") {
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
      if (poseRef.current === "idle" && Date.now() - lastInteractionRef.current > AUTO_SLEEP_MS) {
        dispatch({ type: "sleep" });
      }
    }, SLEEP_CHECK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Click vs drag disambiguation (no data-tauri-drag-region — it eats clicks).
  const dragState = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  function noteInteraction() {
    lastInteractionRef.current = Date.now();
    if (poseRef.current === "sleep") dispatch({ type: "wake" });
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
    const el = rootRef.current;
    // Hover look (no button held): write normalized cursor pos as CSS vars.
    if (el && e.buttons === 0) {
      noteInteraction();
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
      dispatch({ type: "drag-start" });
      getCurrentWindow()
        .startDragging()
        .catch((err) => console.error("[bugzia] startDragging", err));
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
    dragState.current = null;
    if (!ds) return;
    if (ds.moved) {
      dispatch({ type: "drag-end" });
      return;
    }
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
    if (dragState.current?.moved) dispatch({ type: "drag-end" });
    dragState.current = null;
  }

  const asset = pickPoseAsset(poseSrcs, failed, pose);
  const style = { "--scale": settings.scale } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={`pet-root pet-pose-${pose}`}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div className="pet-bubble-layer">
        {bubble != null && <div className="pet-bubble">{bubble}</div>}
        {pose === "sleep" && bubble == null && <div className="pet-snooze">Zzz</div>}
      </div>
      <div className="pet-body-layer">
        <div className="pet-look">
          {asset.src != null && (
            <img
              className="pet-sprite"
              src={asset.src}
              alt=""
              draggable={false}
              onError={() => setFailed((f) => ({ ...f, [asset.assetPose]: true }))}
            />
          )}
        </div>
      </div>
    </div>
  );
}
