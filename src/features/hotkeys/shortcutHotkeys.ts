import { invoke } from "@tauri-apps/api/core";
import type { ShortcutHotkeyItem } from "./hotkeyTypes";

/**
 * 递归扫描 4 个白名单根目录的 *.lnk，返回快捷方式明细。
 * 非 Windows 平台后端返回空列表，前端据此显示静态提示。
 */
export async function scanShortcutHotkeys(): Promise<ShortcutHotkeyItem[]> {
  try {
    return await invoke<ShortcutHotkeyItem[]>("shortcut_hotkeys_scan");
  } catch (e) {
    console.error("[bugzia] shortcut_hotkeys_scan failed", e);
    return [];
  }
}

/**
 * 设置 / 修改某个 .lnk 的热键。后端流程：白名单 -> parse_accel -> 要求至少一个
 * 修饰键 -> accel_to_word -> 探 can_modify -> 备份 -> COM 写 -> 重读返回。
 * 失败时抛出错误文案（供 UI 行内显示），成功返回刷新后的明细。
 */
export async function setShortcutHotkey(
  shortcutPath: string,
  hotkey: string,
): Promise<ShortcutHotkeyItem> {
  return await invoke<ShortcutHotkeyItem>("shortcut_hotkey_set", {
    shortcutPath,
    hotkey,
  });
}

/**
 * 清空某个 .lnk 的热键（写入 0）。先备份再清空，可经 restore 恢复。
 */
export async function clearShortcutHotkey(
  shortcutPath: string,
): Promise<ShortcutHotkeyItem> {
  return await invoke<ShortcutHotkeyItem>("shortcut_hotkey_clear", {
    shortcutPath,
  });
}

/**
 * 恢复某 .lnk 的最近一次备份（fs::copy 覆盖）。无备份时后端返回错误。
 */
export async function restoreShortcutHotkey(
  shortcutPath: string,
): Promise<ShortcutHotkeyItem> {
  return await invoke<ShortcutHotkeyItem>("shortcut_hotkey_restore", {
    shortcutPath,
  });
}

/**
 * 在资源管理器里定位该 .lnk（explorer.exe /select,）。后端执行，因为前端 opener
 * 受 $APPDATA/** 作用域限制无法定位桌面 .lnk。
 */
export async function revealShortcut(shortcutPath: string): Promise<boolean> {
  try {
    return await invoke<boolean>("shortcut_hotkey_reveal", { shortcutPath });
  } catch (e) {
    console.error("[bugzia] shortcut_hotkey_reveal failed", e);
    return false;
  }
}
