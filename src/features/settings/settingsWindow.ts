import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";

const LABEL = "settings";
const W = 560;
const H = 640;
/** 弹窗底边与搜索栏顶边之间留出的间隙（逻辑像素）。 */
const GAP = 8;

/**
 * 把设置弹窗定位到「当前搜索栏正上方」:水平方向相对搜索栏居中(弹窗比搜索栏
 * 宽,向两侧伸出);垂直方向优先让底边贴在搜索栏顶边上方 GAP 处,若搜索栏上方
 * 放不下(贴着显示器顶部),则退到搜索栏正下方;最后整体夹进显示器工作区,保证
 * 完整可见。全部按逻辑像素计算。
 *
 * 与 resultWindow.ts 的 positionResultWindowNearMain 同一套路,差别只在水平居中
 * 而非左对齐。MUST 在主窗口上下文执行(core:window:allow-set-position 仅 main 的
 * capability 有,见 capabilities/default.json);本函数由 openSettingsWindow 在
 * CommandCard(main)中调用,符合该约束。
 */
async function placeAboveBar(win: WebviewWindow): Promise<void> {
  const main = getCurrentWindow();
  const sf = await main.scaleFactor();
  const mPos = await main.outerPosition(); // PhysicalPosition
  const mSize = await main.outerSize(); // PhysicalSize
  const mx = mPos.x / sf;
  const my = mPos.y / sf;
  const mw = mSize.width / sf;
  const mh = mSize.height / sf;

  // currentMonitor 返回主窗口所在的显示器。
  const mon = await currentMonitor();
  const waX = mon ? mon.position.x / sf : 0;
  const waY = mon ? mon.position.y / sf : 0;
  const waW = mon ? mon.size.width / sf : mw;
  const waH = mon ? mon.size.height / sf : mh;

  const w = W;
  const h = H;

  // 水平:弹窗中心对齐搜索栏中心。
  let x = mx + mw / 2 - w / 2;
  // 垂直:优先正上方;上方放不下则正下方。
  const aboveY = my - h - GAP;
  const belowY = my + mh + GAP;
  const fitsAbove = aboveY >= waY;
  const fitsBelow = belowY + h <= waY + waH;
  let y = fitsAbove ? aboveY : fitsBelow ? belowY : aboveY;

  // 夹进显示器工作区。
  if (x + w > waX + waW) x = waX + waW - w;
  if (x < waX) x = waX;
  if (y < waY) y = waY;

  await win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
}

/**
 * Open the settings window: create it if absent (transparent, no decorations,
 * same glass theme via App.tsx label routing -> <SettingsWindow/>), or focus
 * the existing one. Either way it is (re)placed directly above the main search
 * bar first, then shown. The settings window is NOT a writer of settings.json —
 * it only edits and broadcasts a `settings:updated` patch; the main window (sole
 * writer) merges it alongside its authoritative window bounds and persists.
 */
export async function openSettingsWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    try {
      await placeAboveBar(existing);
      await existing.show();
      await existing.setFocus();
    } catch (e) {
      console.error("[bugzia] focus settings window", e);
    }
    return;
  }

  // visible:false + center:false:先创建为不可见,placeAboveBar 定好位再 show,
  // 避免在默认/屏幕中央位置闪一下。
  const win = new WebviewWindow(LABEL, {
    title: "Bugzia 设置",
    width: W,
    height: H,
    minWidth: 400,
    minHeight: 460,
    resizable: true,
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
    await placeAboveBar(win);
    await win.show();
    await win.setFocus();
  } catch (e) {
    console.error("[bugzia] create settings window", e);
  }
}
