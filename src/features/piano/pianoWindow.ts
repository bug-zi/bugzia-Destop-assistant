import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

const LABEL = "piano";
const WIDTH = 980;
const HEIGHT = 610;

/** Open the piano as a focused, dedicated input surface so musical keystrokes
 * never leak into Bugzia's normal text input. */
export async function openPianoWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    try {
      await existing.show();
      await existing.setFocus();
    } catch (e) {
      console.error("[bugzia] focus piano window", e);
    }
    return;
  }

  const win = new WebviewWindow(LABEL, {
    title: "Bugzia 钢琴",
    width: WIDTH,
    height: HEIGHT,
    minWidth: 760,
    minHeight: 480,
    resizable: true,
    decorations: false,
    transparent: true,
    shadow: true,
    skipTaskbar: true,
    center: true,
    visible: false,
  });

  await new Promise<void>((resolve, reject) => {
    win.once("tauri://created", () => resolve());
    win.once("tauri://error", (e) =>
      reject(new Error("piano window creation failed: " + String(e))),
    );
  });

  try {
    await win.show();
    await win.setFocus();
  } catch (e) {
    console.error("[bugzia] show piano window", e);
  }
}
