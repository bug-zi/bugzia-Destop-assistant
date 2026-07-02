// 快捷键中心前端类型，镜像 src-tauri/src/hotkey_center.rs 的 serde 结构。
// 约定：本项目 serde 不加 rename_all —— 枚举按 CamelCase 序列化，结构体字段保持
// Rust 的 snake_case。下面的联合类型与字段名必须与后端 serde 键逐字一致。
// 不含 NormalizedAccelerator：后端已预计算 display 字符串，前端不解析。

export type HotkeySourceType = "Bugzia" | "WindowsSystem" | "ShortcutLink" | "Manual";
export type HotkeyScope = "Global" | "AppLocal" | "WindowLocal" | "Unknown";
export type ManageLevel =
  | "DirectModify"
  | "AdapterModify"
  | "Blockable"
  | "ReadOnly"
  | "HighRisk";

export interface ConflictInfo {
  /** 真正的重复占用：两个会互相抢占的快捷键使用了同一组合。 */
  is_duplicate: boolean;
  /** 自定义快捷键覆盖了 Windows 只读目录里的低风险系统键。 */
  is_system_override: boolean;
  conflicts_with_bugzia: boolean;
  /** 同组其它条目 id，供 UI 高亮。 */
  conflicting_with: string[];
}

/** 统一扁平条目（对应文档 §5.1），面向「总览」表格。 */
export interface HotkeyEntry {
  id: string;
  /** format_accel 后的展示串；空 = 未设置。 */
  display: string;
  /** 功能名 / .lnk 文件名。 */
  title: string;
  /** 来源应用名（Bugzia / 目标程序名）。 */
  app_name: string;
  /** 手动登记应用的进程名，例如 KuGou.exe。其它来源为 null。 */
  process_name: string | null;
  /** 手动登记应用的窗口标题匹配词。其它来源为 null。 */
  window_title_match: string | null;
  source_type: HotkeySourceType;
  scope: HotkeyScope;
  manage_level: ManageLevel;
  /** .lnk 路径；Bugzia 自身快捷键为 null。 */
  source_path: string | null;
  /** .lnk 目标；Bugzia 自身快捷键为 null。 */
  target: string | null;
  can_modify: boolean;
  backup_available: boolean;
  conflict: ConflictInfo;
}

export interface ManualHotkeyInput {
  app_name: string;
  process_name: string;
  window_title_match: string;
  title: string;
  accelerator: string;
  scope: HotkeyScope;
  notes: string;
}

export interface ManualHotkeyEntry extends ManualHotkeyInput {
  id: string;
}

export interface RunningAppInfo {
  process_name: string;
  window_title: string;
  pid: number;
}

export interface ObservedHotkeyEntry {
  id: string;
  app_name: string;
  process_name: string;
  window_title: string;
  accelerator: string;
  count: number;
  first_seen_ms: number;
  last_seen_ms: number;
}

export interface HotkeyObserverStatus {
  enabled: boolean;
}

export type ShortcutLocation =
  | "UserDesktop"
  | "PublicDesktop"
  | "UserStartMenu"
  | "CommonStartMenu"
  | "Other";

export type ShortcutStatus =
  | "Ok"
  | "TargetUnresolved"
  | "AccessDenied"
  | "ReadError"
  | "OutsideWhitelist";

/** 快捷方式专用结构（对应文档 §5.2）。 */
export interface ShortcutHotkeyItem {
  id: string;
  /** 不含 .lnk 的文件名。 */
  name: string;
  /** 展示串；空 = 未设置。 */
  hotkey: string;
  target_path: string;
  arguments: string;
  shortcut_path: string;
  location: ShortcutLocation;
  can_modify: boolean;
  status: ShortcutStatus;
  backup_available: boolean;
}
