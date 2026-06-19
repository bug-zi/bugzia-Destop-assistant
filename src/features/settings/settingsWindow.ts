import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

const LABEL = "settings";
const W = 460;
const H = 640;

/**
 * Open the settings window: create it if absent (transparent, no decorations,
 * same glass theme via App.tsx label routing -> <SettingsWindow/>), or focus
 * the existing one. The settings window is NOT a writer of settings.json — it
 * only edits and broadcasts a `settings:updated` patch; the main window (sole
 * writer) merges it alongside its authoritative window bounds and persists.
 */
export async function openSettingsWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    try {
      await existing.show();
      await existing.setFocus();
    } catch (e) {
      console.error("[bugzia] focus settings window", e);
    }
    return;
  }

  const win = new WebviewWindow(LABEL, {
    title: "Bugzia 设置",
    width: W,
    height: H,
    minWidth: 360,
    minHeight: 460,
    resizable: true,
    decorations: false,
    transparent: true,
    shadow: false,
    skipTaskbar: true,
    center: true,
    visible: true,
  });
  win.once("tauri://error", (e) => console.error("[bugzia] create settings window", e));
}
