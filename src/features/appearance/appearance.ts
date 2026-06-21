import type { AppearanceSettings, NoteSettings, ResultAppearanceSettings } from "../settings/settingsTypes";
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

/**
 * Apply result-panel appearance to CSS custom properties only the result overlay
 * reads (--bugzia-result-*). Kept separate from applyAppearanceVars because the
 * main / settings windows have no result-panel DOM, so only ResultWindow calls
 * this. The overlay's .result-card also re-scopes --bugzia-font-scale onto
 * --bugzia-result-font-scale so result text size is isolated from the bar.
 */
export function applyResultVars(res: ResultAppearanceSettings): void {
  const el = document.documentElement.style;
  el.setProperty("--bugzia-result-bg-r", String(res.bg_r));
  el.setProperty("--bugzia-result-bg-g", String(res.bg_g));
  el.setProperty("--bugzia-result-bg-b", String(res.bg_b));
  el.setProperty("--bugzia-result-bg-a", String(res.bg_a));
  el.setProperty("--bugzia-result-radius", `${res.radius}px`);
  el.setProperty("--bugzia-result-blur", `${res.blur}px`);
  el.setProperty("--bugzia-result-font-scale", String(res.font_scale));
  el.setProperty("--bugzia-result-row-gap", `${res.row_gap}px`);
  el.setProperty("--bugzia-result-item-radius", `${res.item_radius}px`);
  el.setProperty("--bugzia-result-row-pad", `${res.row_pad}px`);
  el.setProperty("--bugzia-result-hover-alpha", String(res.hover_alpha));
  el.setProperty("--bugzia-result-scrollbar-w", `${res.scrollbar_w}px`);
  // Locked conversation-card tint (history rail). Read as the RGB channels of a
  // translucent overlay by .history-item.is-locked; alpha is fixed in the CSS so
  // the tint strength stays consistent with the glass theme.
  el.setProperty("--bugzia-result-locked-r", String(res.locked_r));
  el.setProperty("--bugzia-result-locked-g", String(res.locked_g));
  el.setProperty("--bugzia-result-locked-b", String(res.locked_b));
}

/** Load persisted settings and apply appearance to THIS window. */
export async function loadAndApplyAppearance(): Promise<void> {
  const s = await loadSettings();
  applyAppearanceVars(s.appearance);
}

/**
 * Apply sticky-note style defaults to CSS custom properties only a note window
 * reads (--bugzia-note-*). Called by NoteWindow on hydrate + on every
 * note://settings broadcast, so a settings-panel tweak recolors open notes live.
 */
export function applyNoteVars(n: NoteSettings): void {
  const el = document.documentElement.style;
  el.setProperty("--bugzia-note-bg-r", String(n.bg_r));
  el.setProperty("--bugzia-note-bg-g", String(n.bg_g));
  el.setProperty("--bugzia-note-bg-b", String(n.bg_b));
  el.setProperty("--bugzia-note-text-r", String(n.text_r));
  el.setProperty("--bugzia-note-text-g", String(n.text_g));
  el.setProperty("--bugzia-note-text-b", String(n.text_b));
  el.setProperty("--bugzia-note-radius", `${n.radius}px`);
  el.setProperty("--bugzia-note-font-size", `${n.font_size}px`);
  el.setProperty("--bugzia-note-bg-alpha", String(n.bg_alpha));
  el.setProperty("--bugzia-note-text-alpha", String(n.text_alpha));
}
