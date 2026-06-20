import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { loadSettings } from "../features/settings/settingsStore";
import type { AppSettings, WaveformSettings } from "../features/settings/settingsTypes";
import "./WaveformWindow.css";

/**
 * Desktop waveform overlay renderer. The backend (waveform.rs) captures system
 * audio via WASAPI loopback, reduces it to a single loudness level, and emits
 * `waveform://level` (~30 fps, raw 0..1). This window draws sakura petals whose
 * SPAWN DENSITY tracks that level: loud -> a flurry of petals falling + swaying
 * + spinning; silence -> no new petals, existing ones finish their fall and
 * drift off the bottom edge. A STATIC pale-white translucent band at the bottom
 * edge marks the water surface — it does NOT move with loudness, only the petals
 * do.
 *
 * Two performance rules:
 *  1. The audio level arrives at ~30 fps and is written to a REF (never React
 *     state) — a `setLevel` per packet would thrash the reconciler.
 *  2. The rAF loop is created ONCE on mount and reads everything (settings,
 *     level, canvas dims) through refs, so live setting changes (color /
 *     sensitivity / ...) apply immediately without restarting the loop.
 */

/** One falling sakura petal. All physics are in CSS pixels / seconds. */
interface Petal {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  swayPhase: number;
  swaySpeed: number;
  swayAmp: number;
  size: number;
  color: string;
  baseAlpha: number;
  /** Seconds alive (drives the fade-in). */
  life: number;
}

const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;

/** Pick a petal color: ~80% primary, ~20% accent highlight for sparkle. */
function pickColor(s: WaveformSettings): string {
  return Math.random() < 0.8
    ? rgb(s.color_r, s.color_g, s.color_b)
    : rgb(s.accent_r, s.accent_g, s.accent_b);
}

export default function WaveformWindow() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [settings, setSettings] = useState<WaveformSettings | null>(null);
  const settingsRef = useRef<WaveformSettings | null>(null);

  // High-frequency audio level (raw 0..1) + a smoothed copy for calmer visuals.
  // Written by the IPC listener, read by the rAF loop. NEVER setState here.
  const levelRef = useRef(0);
  const smoothedRef = useRef(0);

  // Mutable render state owned by the rAF loop (not React).
  const petalsRef = useRef<Petal[]>([]);
  const dimsRef = useRef({ w: 0, h: 0 });
  const spawnAccumRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);

  // Hydrate appearance on mount.
  useEffect(() => {
    let alive = true;
    loadSettings().then((s: AppSettings) => {
      if (!alive) return;
      settingsRef.current = s.waveform;
      setSettings(s.waveform);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Live-apply appearance pushed from the main window (settings panel / tray /
  // geometry drag). Updates both the state (drives root opacity) and the ref the
  // rAF loop reads, so color/sensitivity/density tweaks show up the next frame.
  useEffect(() => {
    let off: (() => void) | undefined;
    (async () => {
      off = await listen<WaveformSettings>("waveform://settings", (ev) => {
        settingsRef.current = ev.payload;
        setSettings(ev.payload);
      });
    })();
    return () => {
      off?.();
    };
  }, []);

  // Audio level feed from the backend capture thread (~30 fps, raw 0..1).
  useEffect(() => {
    let off: (() => void) | undefined;
    (async () => {
      off = await listen<number>("waveform://level", (ev) => {
        levelRef.current = ev.payload;
      });
    })();
    return () => {
      off?.();
    };
  }, []);

  // Canvas sizing: back it with devicePixelRatio so petals stay crisp on HiDPI,
  // and keep a CSS-pixel dims ref for the physics math. Re-runs on window
  // resize via a ResizeObserver so a manual resize immediately recomputes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS px
      dimsRef.current = { w, h };
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // The render loop (created once). Spawns petals at a density driven by the
  // audio level, advances their fall / sway / spin, and paints them. Silence
  // stops spawning; in-flight petals finish their fall and drift off-screen.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const GRAVITY = 90; // px/s^2 downward acceleration
    const MAX_VY = 150; // terminal fall speed (px/s)

    const makePetal = (s: WaveformSettings, w: number): Petal => {
      const size = s.petal_size * (0.7 + Math.random() * 0.7);
      return {
        x: Math.random() * w,
        y: -size,
        vx: (Math.random() - 0.5) * 20,
        vy: 18 + Math.random() * 34,
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 2.2,
        swayPhase: Math.random() * Math.PI * 2,
        swaySpeed: 1.4 + Math.random() * 2,
        swayAmp: 8 + Math.random() * 20,
        size,
        color: pickColor(s),
        baseAlpha: 0.7 + Math.random() * 0.3,
        life: 0,
      };
    };

    const drawPetal = (p: Petal) => {
      const s = p.size;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = p.baseAlpha * Math.min(1, p.life * 4);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      // Petal silhouette: pointed top, rounded bottom (a smooth petal/leaf).
      ctx.moveTo(0, -s);
      ctx.bezierCurveTo(s * 0.55, -s * 0.4, s * 0.5, s * 0.55, 0, s);
      ctx.bezierCurveTo(-s * 0.5, s * 0.55, -s * 0.55, -s * 0.4, 0, -s);
      ctx.fill();
      ctx.restore();
    };

    // Static water-surface highlight at the bottom edge: a pale-white translucent
    // band that anchors the falling petals. Fixed color (does NOT follow the
    // accent/highlight setting) and does NOT move with loudness — a calm, still
    // baseline, while only the petals dance.
    const drawWaterLine = (w: number, h: number) => {
      const bandH = 6;
      const grad = ctx.createLinearGradient(0, h - bandH, 0, h);
      grad.addColorStop(0, "rgba(255, 255, 255, 0)");
      grad.addColorStop(1, "rgba(255, 255, 255, 0.42)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, h - bandH, w, bandH);
    };

    const tick = (ts: number) => {
      rafRef.current = requestAnimationFrame(tick);
      const s = settingsRef.current;
      const { w, h } = dimsRef.current;
      if (!s || w === 0) return; // not hydrated / not laid out yet

      const now = ts / 1000;
      let dt = lastTsRef.current ? now - lastTsRef.current : 0.016;
      lastTsRef.current = now;
      if (dt > 0.05) dt = 0.05; // clamp after a backgrounded tab to avoid jumps

      // Smooth the level so a single loud sample doesn't strobe the spawn rate.
      const target = Math.min(1, levelRef.current * s.sensitivity);
      smoothedRef.current += (target - smoothedRef.current) * Math.min(1, dt * 12);
      const lvl = smoothedRef.current;

      // ── spawn ── (density tracks loudness; silence spawns nothing)
      spawnAccumRef.current += lvl * (s.petal_density / 60) * 0.6;
      while (spawnAccumRef.current >= 1 && petalsRef.current.length < s.petal_density) {
        petalsRef.current.push(makePetal(s, w));
        spawnAccumRef.current -= 1;
      }
      if (spawnAccumRef.current > 1) spawnAccumRef.current = 1; // bleed overflow

      const petals = petalsRef.current;

      // ── advance ── (pure falling petals: gravity + sway + spin. A petal is
      //    culled once it falls past the bottom edge or is blown off the sides.)
      for (let i = petals.length - 1; i >= 0; i--) {
        const p = petals[i];
        p.life += dt;
        p.vy = Math.min(MAX_VY, p.vy + GRAVITY * dt);
        p.y += p.vy * s.drift_speed * dt;
        p.x += p.vx * s.drift_speed * dt;
        p.swayPhase += p.swaySpeed * dt;
        p.x += Math.sin(p.swayPhase) * p.swayAmp * dt;
        p.rot += p.vrot * dt;
        // Fell past the bottom edge or blown off the sides: cull.
        if (p.y > h + p.size || p.x < -p.size * 2 || p.x > w + p.size * 2) {
          petals.splice(i, 1);
        }
      }

      // ── paint ── (static water line first, then falling petals on top)
      ctx.clearRect(0, 0, w, h);
      drawWaterLine(w, h);
      for (const p of petals) drawPetal(p);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  // IMPORTANT: do NOT early-return null before settings hydrate. The sizing +
  // rAF effects above have EMPTY deps and read canvasRef.current exactly once on
  // mount; if the <canvas> were absent on first commit (a `return null` here
  // would guarantee that, since `settings` starts null), both effects bail on
  // `if (!canvas) return` and NEVER re-run -> the renderer stays dead and the
  // overlay is permanently blank. Always mount the canvas; gate only opacity.
  // The rAF loop no-ops until settingsRef hydrates.
  return (
    <div
      className="waveform-root"
      data-tauri-drag-region
      style={{ opacity: settings ? settings.opacity : 0 }}
    >
      <canvas ref={canvasRef} className="waveform-canvas" />
    </div>
  );
}
