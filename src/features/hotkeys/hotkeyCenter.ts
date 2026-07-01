import { invoke } from "@tauri-apps/api/core";
import type { HotkeyEntry } from "./hotkeyTypes";

/**
 * 汇总所有已支持来源（Bugzia 自身 + .lnk 快捷方式），不做冲突计算。
 * 失败时返回空数组，调用方据此显示「扫描失败」而非崩溃。
 */
export async function scanHotkeyCenter(): Promise<HotkeyEntry[]> {
  try {
    return await invoke<HotkeyEntry[]>("hotkey_center_scan");
  } catch (e) {
    console.error("[bugzia] hotkey_center_scan failed", e);
    return [];
  }
}

/**
 * 返回带冲突状态的统一列表（总览页调用）。按归一化快捷键分组标注重复 /
 * 与 Bugzia 冲突。失败时回退为不带冲突的扫描结果。
 */
export async function detectHotkeyConflicts(): Promise<HotkeyEntry[]> {
  try {
    return await invoke<HotkeyEntry[]>("hotkey_center_detect_conflicts");
  } catch (e) {
    console.error("[bugzia] hotkey_center_detect_conflicts failed", e);
    return [];
  }
}
