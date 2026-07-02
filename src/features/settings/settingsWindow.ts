import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";

const LABEL = "settings";
const FIXED_X = 245;
const FIXED_Y = 25;
const FIXED_W = 1063;
const FIXED_H = 657;

async function placeSettingsWindow(win: WebviewWindow): Promise<void> {
  await win.setResizable(false);
  await win.setSize(new LogicalSize(FIXED_W, FIXED_H));
  await win.setPosition(new LogicalPosition(FIXED_X, FIXED_Y));
}

/**
 * Open the settings window: create it if absent (transparent, no decorations,
 * same glass theme via App.tsx label routing -> <SettingsWindow/>), or focus
 * the existing one. Either way it is restored to the fixed position and size
 * first, then shown. The settings window is NOT a writer of settings.json —
 * it only edits and broadcasts a `settings:updated` patch; the main window (sole
 * writer) merges settings sections and persists them.
 */
export async function openSettingsWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    try {
      await placeSettingsWindow(existing);
      await existing.show();
      await existing.setFocus();
    } catch (e) {
      console.error("[bugzia] focus settings window", e);
    }
    return;
  }

  // visible:false + center:false:先创建为不可见,固定位置/尺寸后再 show,
  // 避免在默认/屏幕中央位置闪一下。
  const win = new WebviewWindow(LABEL, {
    title: "Bugzia 设置",
    width: FIXED_W,
    height: FIXED_H,
    minWidth: FIXED_W,
    minHeight: FIXED_H,
    maxWidth: FIXED_W,
    maxHeight: FIXED_H,
    resizable: false,
    decorations: false,
    transparent: true,
    shadow: false,
    skipTaskbar: true,
    center: false,
    visible: false,
  });

  await new Promise<void>((resolve, reject) => {
    win.once("tauri://created", () => resolve());
    win.once("tauri://error", (e) =>
      reject(new Error("settings window creation failed: " + String(e))),
    );
  });

  try {
    await placeSettingsWindow(win);
    await win.show();
    await win.setFocus();
  } catch (e) {
    console.error("[bugzia] create settings window", e);
  }
}
