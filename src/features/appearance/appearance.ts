import type { AppearanceSettings } from "../settings/settingsTypes";
import { loadSettings } from "../settings/settingsStore";

/**
 * Apply appearance to the CSS custom properties every window reads
 * (--bugzia-bg-*, --bugzia-blur, --bugzia-radius, --bugzia-font-scale).
 * Shared by all windows so the glass theme stays consistent across main /
 * result / settings.
 */
export function applyAppearanceVars(a: AppearanceSettings): void {
  const r = document.documentElement.style;
  r.setProperty("--bugzia-bg-r", String(a.bg_r));
  r.setProperty("--bugzia-bg-g", String(a.bg_g));
  r.setProperty("--bugzia-bg-b", String(a.bg_b));
  r.setProperty("--bugzia-bg-a", String(a.bg_a));
  r.setProperty("--bugzia-blur", `${a.blur}px`);
  r.setProperty("--bugzia-radius", `${a.radius}px`);
  r.setProperty("--bugzia-font-scale", String(a.font_scale));
}

/** Load persisted settings and apply appearance to THIS window. */
export async function loadAndApplyAppearance(): Promise<void> {
  const s = await loadSettings();
  applyAppearanceVars(s.appearance);
}
