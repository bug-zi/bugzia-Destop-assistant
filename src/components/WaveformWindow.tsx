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
 * + spinning + fading; silence -> no new petals, existing ones settle onto a
 * calm water line at the bottom and fade out.
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
  /** Landed on the water line: no more falling, just a gentle drift + slow fade. */
  settled: boolean;
  /** 1 -> 0 multiplier while settled (alpha ramps down over ~2s). */
  settleAlpha: number;
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
  // audio level, advances their fall / sway / spin / fade, and paints a water
  // line whose brightness rises with loudness. Silence stops spawning and lets
  // in-flight petals settle onto the water and fade out.
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
        settled: false,
        settleAlpha: 1,
      };
    };

    const drawPetal = (p: Petal) => {
      const s = p.size;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = p.baseAlpha * (p.settled ? p.settleAlpha : 1) * Math.min(1, p.life * 4);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      // Petal silhouette: pointed top, rounded bottom (a smooth petal/leaf).
      ctx.moveTo(0, -s);
      ctx.bezierCurveTo(s * 0.55, -s * 0.4, s * 0.5, s * 0.55, 0, s);
      ctx.bezierCurveTo(-s * 0.5, s * 0.55, -s * 0.55, -s * 0.4, 0, -s);
      ctx.fill();
      ctx.restore();
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

      // Water-line band rises a little with loudness; petals "land" at its top.
      const waterTop = h - (4 + lvl * 20);
      const petals = petalsRef.current;

      // ── advance ──
      for (let i = petals.length - 1; i >= 0; i--) {
        const p = petals[i];
        p.life += dt;
        if (!p.settled) {
          p.vy = Math.min(MAX_VY, p.vy + GRAVITY * dt);
          p.y += p.vy * s.drift_speed * dt;
          p.x += p.vx * s.drift_speed * dt;
          p.swayPhase += p.swaySpeed * dt;
          p.x += Math.sin(p.swayPhase) * p.swayAmp * dt;
          p.rot += p.vrot * dt;
          // Reached the water: settle — stop falling, drift gently, fade slowly.
          if (p.y >= waterTop) {
            p.settled = true;
            p.y = waterTop + Math.random() * 4;
            p.vy = 0;
            p.vrot *= 0.2;
          }
        } else {
          p.swayPhase += p.swaySpeed * 0.4 * dt;
          p.x += Math.sin(p.swayPhase) * p.swayAmp * 0.3 * dt;
          p.rot += p.vrot * dt;
          p.settleAlpha -= dt * 0.5; // ~2s fade once settled
          if (p.settleAlpha <= 0) {
            petals.splice(i, 1);
            continue;
          }
        }
        // Blown off the sides: cull.
        if (p.x < -p.size * 2 || p.x > w + p.size * 2) {
          petals.splice(i, 1);
        }
      }

      // ── paint ──
      ctx.clearRect(0, 0, w, h);
      // water line: soft band whose brightness tracks loudness.
      const bandH = h - waterTop;
      ctx.fillStyle = `rgba(${s.accent_r}, ${s.accent_g}, ${s.accent_b}, ${0.08 + lvl * 0.22})`;
      ctx.fillRect(0, waterTop, w, bandH);
      // a crisp highlight right on the water's surface.
      ctx.fillStyle = `rgba(${s.accent_r}, ${s.accent_g}, ${s.accent_b}, ${0.25 + lvl * 0.4})`;
      ctx.fillRect(0, waterTop, w, Math.min(2, bandH));
      // petals on top of the water.
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
