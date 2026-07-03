//! 快捷键中心：统一数据模型 + 快捷键归一化层 + 冲突检测 + 中心聚合命令。
//!
//! 这是「快捷键中心」的总入口（开发文档 §5 / §6.1）。本版聚合：
//!   - Bugzia 自身快捷键（来自 settings.json）
//!   - Windows 系统快捷键只读目录
//!   - 手动登记的应用快捷键
//!   - 可写回的应用配置快捷键
//!   - 应用内置默认快捷键只读目录
//!   - Windows .lnk 快捷方式热键（由 `shortcut_hotkeys` 模块扫描）
//!
//! 统一的扁平 `HotkeyEntry` 模型面向「总览」表格，未来加 ProbedOccupied /
//! BlockRule 等 source_type 即可扩展，无需重构（附录 G 的
//! 「为终局架构留接口」要求）。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::settings::load_settings;
use crate::shortcut_hotkeys::scan_shortcuts_internal;

#[cfg(target_os = "windows")]
use std::mem::size_of;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, WPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::GetCurrentThreadId;
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EnumWindows, GetMessageW, GetWindowTextW, GetWindowThreadProcessId,
    IsWindowVisible, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, KBDLLHOOKSTRUCT,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_QUIT, WM_SYSKEYDOWN,
};

// ---------------------------------------------------------------------------
// 归一化层：把任意快捷键串（Bugzia 的小写 Tauri 串 / .lnk 的展示串）统一成
// 一种可比较的中间表示，供冲突检测和 WORD<->accel 转换共用。三种表示
// （Tauri 串 / .lnk WORD / 展示串）的唯一桥梁。
// ---------------------------------------------------------------------------

/// 归一化后的主键：`Char('A'..='Z' | '0'..='9')` / `F(1..=24)` / `Space`。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum NormalizedKey {
    Char(char),
    F(u8),
    Space,
    Named(String),
}

/// 归一化快捷键。中心模型支持 Win；`.lnk` 写入层会单独拒绝 Win。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct NormalizedAccelerator {
    pub win: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub key: NormalizedKey,
}

/// 解析快捷键串为归一化形式。大小写不敏感，按 `+` 切分。
/// 修饰键：`win`/`super`/`meta`、`ctrl`/`control`、`alt`/`opt`/`option`、`shift`。
/// 主键：`f1..f24`、`a..z`、`0..9`、`space` 和少量常见系统键。
/// 空串 / 多主键 / 无法识别返回 `None`。
pub fn parse_accel(s: &str) -> Option<NormalizedAccelerator> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let mut win = false;
    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut key: Option<NormalizedKey> = None;
    for raw in s.split('+') {
        let t = raw.trim().to_lowercase();
        if t.is_empty() {
            continue;
        }
        match t.as_str() {
            "ctrl" | "control" | "leftctrl" | "rightctrl" | "leftcontrol" | "rightcontrol" => {
                ctrl = true
            }
            "alt" | "opt" | "option" | "leftalt" | "rightalt" | "leftoption" | "rightoption" => {
                alt = true
            }
            "shift" | "leftshift" | "rightshift" => shift = true,
            "win" | "super" | "meta" | "leftwin" | "rightwin" | "leftmeta" | "rightmeta" => {
                win = true
            }
            "space" | "spacebar" => {
                if key.is_some() {
                    return None;
                }
                key = Some(NormalizedKey::Space);
            }
            _ => {
                if key.is_some() {
                    return None; // 多个主键，非法
                }
                key = Some(parse_key_token(&t)?);
            }
        }
    }
    Some(NormalizedAccelerator {
        win,
        ctrl,
        alt,
        shift,
        key: key?,
    })
}

fn parse_key_token(t: &str) -> Option<NormalizedKey> {
    if t.len() == 1 {
        let c = t.chars().next()?;
        if c.is_ascii_alphanumeric() {
            return Some(NormalizedKey::Char(c.to_ascii_uppercase()));
        }
    }
    let compact = t.replace(' ', "").replace('_', "");
    if let Some(rest) = t.strip_prefix('f') {
        if let Ok(n) = rest.parse::<u8>() {
            if (1..=24).contains(&n) {
                return Some(NormalizedKey::F(n));
            }
        }
        return None;
    }
    match compact.as_str() {
        "." | "period" | "dot" => Some(NormalizedKey::Named(".".into())),
        "," | "comma" => Some(NormalizedKey::Named(",".into())),
        ";" | "semicolon" => Some(NormalizedKey::Named(";".into())),
        "/" | "slash" | "forwardslash" => Some(NormalizedKey::Named("/".into())),
        "\\" | "backslash" => Some(NormalizedKey::Named("\\".into())),
        "[" | "openbracket" | "leftbracket" => Some(NormalizedKey::Named("[".into())),
        "]" | "closebracket" | "rightbracket" => Some(NormalizedKey::Named("]".into())),
        "'" | "quote" | "apostrophe" => Some(NormalizedKey::Named("'".into())),
        "`" | "grave" | "backtick" => Some(NormalizedKey::Named("`".into())),
        "-" | "minus" => Some(NormalizedKey::Named("Minus".into())),
        "=" | "equals" => Some(NormalizedKey::Named("=".into())),
        "plus" | "add" => Some(NormalizedKey::Named("Plus".into())),
        "left" | "arrowleft" => Some(NormalizedKey::Named("Left".into())),
        "right" | "arrowright" => Some(NormalizedKey::Named("Right".into())),
        "up" | "arrowup" => Some(NormalizedKey::Named("Up".into())),
        "down" | "arrowdown" => Some(NormalizedKey::Named("Down".into())),
        "home" => Some(NormalizedKey::Named("Home".into())),
        "end" => Some(NormalizedKey::Named("End".into())),
        "pageup" | "pgup" => Some(NormalizedKey::Named("PageUp".into())),
        "pagedown" | "pgdn" => Some(NormalizedKey::Named("PageDown".into())),
        "tab" => Some(NormalizedKey::Named("Tab".into())),
        "enter" | "return" => Some(NormalizedKey::Named("Enter".into())),
        "esc" | "escape" => Some(NormalizedKey::Named("Esc".into())),
        "delete" | "del" => Some(NormalizedKey::Named("Delete".into())),
        "backspace" => Some(NormalizedKey::Named("Backspace".into())),
        "insert" | "ins" => Some(NormalizedKey::Named("Insert".into())),
        "printscreen" | "prtscn" | "prtsc" => Some(NormalizedKey::Named("PrintScreen".into())),
        "pause" | "break" => Some(NormalizedKey::Named("Pause".into())),
        "numlock" => Some(NormalizedKey::Named("NumLock".into())),
        "scrolllock" => Some(NormalizedKey::Named("ScrollLock".into())),
        "capslock" => Some(NormalizedKey::Named("CapsLock".into())),
        "asterisk" | "multiply" => Some(NormalizedKey::Named("*".into())),
        _ => None,
    }
}

/// 展示形式：固定顺序 `Ctrl+Alt+Shift+主键`，混合大小写。
/// 例：`Ctrl+Alt+F5`、`Alt+Space`、`Alt+N`。
pub fn format_accel(a: &NormalizedAccelerator) -> String {
    let mut parts: Vec<String> = Vec::new();
    if a.win {
        parts.push("Win".into());
    }
    if a.ctrl {
        parts.push("Ctrl".into());
    }
    if a.alt {
        parts.push("Alt".into());
    }
    if a.shift {
        parts.push("Shift".into());
    }
    parts.push(match &a.key {
        NormalizedKey::Char(c) => c.to_string(),
        NormalizedKey::F(n) => format!("F{n}"),
        NormalizedKey::Space => "Space".into(),
        NormalizedKey::Named(name) => name.clone(),
    });
    parts.join("+")
}

// ---------------------------------------------------------------------------
// 统一数据模型（文档 §5.1，扁平结构面向「总览」表格）
// 枚举按 CamelCase 序列化（不加 rename_all），与文档 §5.3 及 settings.rs 风格一致。
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HotkeyEntry {
    pub id: String,
    /// `format_accel` 后的展示串；空 = 未设置。
    pub display: String,
    /// 功能名 / `.lnk` 文件名。
    pub title: String,
    /// 来源应用名（Bugzia / 目标程序名）。
    pub app_name: String,
    /// 手动登记应用的进程名，例如 `KuGou.exe`。其它来源为 `None`。
    pub process_name: Option<String>,
    /// 手动登记应用的窗口标题匹配词。其它来源为 `None`。
    pub window_title_match: Option<String>,
    pub source_type: HotkeySourceType,
    pub scope: HotkeyScope,
    pub manage_level: ManageLevel,
    /// `.lnk` 路径；Bugzia 自身快捷键为 `None`。
    pub source_path: Option<String>,
    /// `.lnk` 目标；Bugzia 自身快捷键为 `None`。
    pub target: Option<String>,
    pub can_modify: bool,
    pub backup_available: bool,
    pub conflict: ConflictInfo,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum HotkeySourceType {
    Bugzia,
    WindowsSystem,
    ShortcutLink,
    Manual,
    AppConfig,
    AppBuiltin,
    // 预留：ProbedOccupied, BlockRule
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub enum HotkeyScope {
    Global,
    AppLocal,
    WindowLocal,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub enum ManageLevel {
    DirectModify,
    AdapterModify,
    Blockable,
    ReadOnly,
    HighRisk,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ConflictInfo {
    /// 真正的重复占用：两个会互相抢占的快捷键使用了同一组合。
    pub is_duplicate: bool,
    /// 自定义快捷键覆盖了 Windows 只读目录里的低风险系统键。
    pub is_system_override: bool,
    pub conflicts_with_bugzia: bool,
    /// 同组其它条目 id，供 UI 高亮。
    pub conflicting_with: Vec<String>,
}

// ---------------------------------------------------------------------------
// 快捷方式专用结构（文档 §5.2）。放在本模块以避免与 `shortcut_hotkeys` 循环依赖：
// 类型集中在此，`shortcut_hotkeys` 只 `use` 它们 + 提供扫描函数。
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ShortcutHotkeyItem {
    pub id: String,
    /// 不含 `.lnk` 的文件名。
    pub name: String,
    /// 展示串；空 = 未设置。
    pub hotkey: String,
    pub target_path: String,
    pub arguments: String,
    pub shortcut_path: String,
    pub location: ShortcutLocation,
    pub can_modify: bool,
    pub status: ShortcutStatus,
    pub backup_available: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum ShortcutLocation {
    UserDesktop,
    PublicDesktop,
    UserStartMenu,
    CommonStartMenu,
    Other,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum ShortcutStatus {
    Ok,
    TargetUnresolved,
    AccessDenied,
    ReadError,
    OutsideWhitelist,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManualHotkeyEntry {
    pub id: String,
    pub app_name: String,
    #[serde(default)]
    pub process_name: String,
    #[serde(default)]
    pub window_title_match: String,
    pub title: String,
    pub accelerator: String,
    pub scope: HotkeyScope,
    pub notes: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManualHotkeyInput {
    pub app_name: String,
    #[serde(default)]
    pub process_name: String,
    #[serde(default)]
    pub window_title_match: String,
    pub title: String,
    pub accelerator: String,
    pub scope: HotkeyScope,
    pub notes: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RunningAppInfo {
    pub process_name: String,
    pub window_title: String,
    pub pid: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ObservedHotkeyEntry {
    pub id: String,
    pub app_name: String,
    pub process_name: String,
    pub window_title: String,
    pub accelerator: String,
    pub count: u32,
    pub first_seen_ms: u128,
    pub last_seen_ms: u128,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HotkeyObserverStatus {
    pub enabled: bool,
}

#[derive(Clone, Debug)]
struct ObservedHotkeySample {
    process_name: String,
    window_title: String,
    accelerator: String,
    seen_ms: u128,
}

#[cfg(target_os = "windows")]
#[derive(Default)]
struct HotkeyObserverRuntime {
    enabled: bool,
    thread_id: u32,
}

#[cfg(target_os = "windows")]
static HOTKEY_OBSERVER_RUNTIME: OnceLock<Mutex<HotkeyObserverRuntime>> = OnceLock::new();

#[cfg(target_os = "windows")]
static HOTKEY_OBSERVER_SENDER: OnceLock<Mutex<Option<mpsc::Sender<ObservedHotkeySample>>>> =
    OnceLock::new();

#[cfg(target_os = "windows")]
static HOTKEY_OBSERVER_LAST: OnceLock<Mutex<Option<ObservedHotkeySample>>> = OnceLock::new();

// ---------------------------------------------------------------------------
// Windows 系统快捷键只读目录 + 手动登记应用快捷键
// ---------------------------------------------------------------------------

fn windows_entry(
    id: &str,
    display: &str,
    title: &str,
    category: &str,
    scope: HotkeyScope,
    level: ManageLevel,
) -> HotkeyEntry {
    HotkeyEntry {
        id: id.to_string(),
        display: display.to_string(),
        title: title.to_string(),
        app_name: format!("Windows / {category}"),
        process_name: None,
        window_title_match: None,
        source_type: HotkeySourceType::WindowsSystem,
        scope,
        manage_level: level,
        source_path: None,
        target: None,
        can_modify: false,
        backup_available: false,
        conflict: ConflictInfo::default(),
    }
}

fn push_taskbar_number_entries(entries: &mut Vec<HotkeyEntry>) {
    for number in 0..=9 {
        let position = if number == 0 { 10 } else { number };
        entries.push(windows_entry(
            &format!("windows.taskbar.launch_{number}"),
            &format!("Win+{number}"),
            &format!("打开或切换到任务栏第 {position} 个应用"),
            "任务栏",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ));
        entries.push(windows_entry(
            &format!("windows.taskbar.new_instance_{number}"),
            &format!("Win+Shift+{number}"),
            &format!("启动任务栏第 {position} 个应用的新实例"),
            "任务栏",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ));
        entries.push(windows_entry(
            &format!("windows.taskbar.switch_last_{number}"),
            &format!("Win+Ctrl+{number}"),
            &format!("切换到任务栏第 {position} 个应用的最后活动窗口"),
            "任务栏",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ));
        entries.push(windows_entry(
            &format!("windows.taskbar.jump_list_{number}"),
            &format!("Win+Alt+{number}"),
            &format!("打开任务栏第 {position} 个应用的跳转列表"),
            "任务栏",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ));
        entries.push(windows_entry(
            &format!("windows.taskbar.admin_instance_{number}"),
            &format!("Win+Ctrl+Shift+{number}"),
            &format!("以管理员身份打开任务栏第 {position} 个应用的新实例"),
            "任务栏",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ));
    }
}

fn windows_system_entries() -> Vec<HotkeyEntry> {
    let mut entries = vec![
        windows_entry(
            "windows.lock",
            "Win+L",
            "锁定电脑",
            "系统安全",
            HotkeyScope::Global,
            ManageLevel::HighRisk,
        ),
        windows_entry(
            "windows.security",
            "Ctrl+Alt+Delete",
            "安全选项",
            "系统安全",
            HotkeyScope::Global,
            ManageLevel::HighRisk,
        ),
        windows_entry(
            "windows.display_reset",
            "Win+Ctrl+Shift+B",
            "唤醒屏幕或重置显示驱动",
            "系统安全",
            HotkeyScope::Global,
            ManageLevel::HighRisk,
        ),
        windows_entry(
            "windows.task_manager",
            "Ctrl+Shift+Esc",
            "打开任务管理器",
            "系统安全",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.start_ctrl",
            "Ctrl+Esc",
            "打开或关闭开始菜单",
            "开始菜单",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.quick_link",
            "Win+X",
            "打开快速链接菜单",
            "开始菜单",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.task_switch",
            "Alt+Tab",
            "切换窗口",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.task_switch_sticky",
            "Ctrl+Alt+Tab",
            "固定显示窗口切换器",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.task_switch_next",
            "Alt+Esc",
            "按打开顺序循环切换窗口",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.close_window",
            "Alt+F4",
            "关闭当前窗口",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.close_document",
            "Ctrl+F4",
            "关闭当前文档",
            "窗口管理",
            HotkeyScope::WindowLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.window_menu",
            "Alt+Space",
            "打开活动窗口快捷菜单",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.password_reveal",
            "Alt+F8",
            "在登录屏幕显示密码",
            "系统安全",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.screenshot_full",
            "PrintScreen",
            "复制全屏截图",
            "截图",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.screenshot_window",
            "Alt+PrintScreen",
            "复制当前窗口截图",
            "截图",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.screenshot_to_file",
            "Win+PrintScreen",
            "保存全屏截图",
            "截图",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.screenshot",
            "Win+Shift+S",
            "打开截图工具",
            "截图",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.desktop",
            "Win+D",
            "显示和隐藏桌面",
            "桌面",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.minimize_all",
            "Win+M",
            "最小化所有窗口",
            "桌面",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.restore_minimized",
            "Win+Shift+M",
            "还原最小化窗口",
            "桌面",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.peek_desktop",
            "Win+Comma",
            "临时速览桌面",
            "桌面",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.minimize_except_active",
            "Win+Home",
            "最小化除活动窗口外的所有窗口",
            "桌面",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.refresh",
            "F5",
            "刷新活动窗口",
            "桌面通用",
            HotkeyScope::WindowLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.cycle_screen_elements",
            "F6",
            "循环切换屏幕元素",
            "桌面通用",
            HotkeyScope::WindowLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.menu_bar",
            "F10",
            "激活活动应用菜单栏",
            "桌面通用",
            HotkeyScope::WindowLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.context_menu",
            "Shift+F10",
            "显示所选项目快捷菜单",
            "桌面通用",
            HotkeyScope::WindowLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.explorer",
            "Win+E",
            "打开文件资源管理器",
            "系统应用",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.run",
            "Win+R",
            "打开运行",
            "系统应用",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.settings",
            "Win+I",
            "打开设置",
            "系统应用",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.search",
            "Win+S",
            "打开搜索",
            "系统应用",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.search_alt",
            "Win+Q",
            "打开搜索",
            "系统应用",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.feedback",
            "Win+F",
            "打开反馈中心并截图",
            "系统应用",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.game_bar",
            "Win+G",
            "打开 Xbox Game Bar",
            "系统应用",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.voice_typing",
            "Win+H",
            "开始语音输入",
            "输入",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.clipboard",
            "Win+V",
            "剪贴板历史",
            "剪贴板",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.copilot",
            "Win+C",
            "打开 Copilot",
            "系统应用",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.recall",
            "Win+J",
            "打开 Recall 或 Windows 建议",
            "系统应用",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.cast",
            "Win+K",
            "打开投屏",
            "系统面板",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.display_switch",
            "Win+P",
            "选择演示显示模式",
            "系统面板",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.quick_assist",
            "Win+Ctrl+Q",
            "打开快速助手",
            "系统应用",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.quick_settings",
            "Win+A",
            "打开快速设置",
            "系统面板",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.notifications",
            "Win+N",
            "打开通知中心和日历",
            "系统面板",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.widgets",
            "Win+W",
            "打开小组件",
            "系统面板",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.accessibility",
            "Win+U",
            "打开辅助功能设置",
            "辅助功能",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.system_properties",
            "Win+Pause",
            "打开系统属性",
            "系统应用",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.orientation_lock",
            "Win+O",
            "锁定设备方向",
            "显示",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.emoji",
            "Win+.",
            "打开表情符号面板",
            "输入",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.emoji_alt",
            "Win+Semicolon",
            "打开表情符号面板",
            "输入",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.input_switch",
            "Win+Space",
            "切换输入语言和键盘布局",
            "输入",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.input_previous",
            "Win+Ctrl+Space",
            "切换到上一次输入法",
            "输入",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.ime_reconversion",
            "Win+Slash",
            "开始输入法复原",
            "输入",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.snap_left",
            "Win+Left",
            "窗口贴靠左侧",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.snap_right",
            "Win+Right",
            "窗口贴靠右侧",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.maximize",
            "Win+Up",
            "最大化窗口",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.minimize",
            "Win+Down",
            "最小化窗口或从最大化还原",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.stretch_up_down",
            "Win+Shift+Up",
            "将窗口拉伸到屏幕上下边缘",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.restore_width",
            "Win+Shift+Down",
            "还原或最小化活动窗口",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.move_monitor_left",
            "Win+Shift+Left",
            "将窗口移到左侧显示器",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.move_monitor_right",
            "Win+Shift+Right",
            "将窗口移到右侧显示器",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.snap_top",
            "Win+Alt+Up",
            "窗口贴靠到屏幕上半部分",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.snap_bottom",
            "Win+Alt+Down",
            "窗口贴靠到屏幕下半部分",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.snap_layouts",
            "Win+Z",
            "打开贴靠布局",
            "窗口管理",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.virtual_desktop_new",
            "Win+Ctrl+D",
            "新建虚拟桌面",
            "虚拟桌面",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.virtual_desktop_left",
            "Win+Ctrl+Left",
            "切换到左侧虚拟桌面",
            "虚拟桌面",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.virtual_desktop_right",
            "Win+Ctrl+Right",
            "切换到右侧虚拟桌面",
            "虚拟桌面",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.virtual_desktop_close",
            "Win+Ctrl+F4",
            "关闭当前虚拟桌面",
            "虚拟桌面",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.task_view",
            "Win+Tab",
            "打开任务视图",
            "虚拟桌面",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.focus_taskbar",
            "Win+T",
            "循环切换任务栏应用",
            "任务栏",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.focus_notification_area",
            "Win+B",
            "聚焦任务栏通知区域",
            "任务栏",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.magnifier_zoom_in",
            "Win+Plus",
            "放大镜放大",
            "辅助功能",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.magnifier_zoom_out",
            "Win+Minus",
            "放大镜缩小",
            "辅助功能",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.magnifier_exit",
            "Win+Esc",
            "退出放大镜",
            "辅助功能",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.narrator",
            "Win+Ctrl+Enter",
            "打开讲述人",
            "辅助功能",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.color_filters",
            "Win+Ctrl+C",
            "打开或关闭颜色筛选器",
            "辅助功能",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.high_contrast",
            "Alt+Shift+PrintScreen",
            "打开或关闭高对比度",
            "辅助功能",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.mouse_keys",
            "Alt+Shift+NumLock",
            "打开或关闭鼠标键",
            "辅助功能",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.mic_mute",
            "Win+Alt+K",
            "在支持的应用中切换麦克风静音",
            "辅助功能",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.hdr_toggle",
            "Win+Alt+B",
            "打开或关闭 HDR",
            "显示",
            HotkeyScope::Global,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_copy",
            "Ctrl+C",
            "复制所选内容",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_copy_insert",
            "Ctrl+Insert",
            "复制所选内容",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_cut",
            "Ctrl+X",
            "剪切所选内容",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_paste",
            "Ctrl+V",
            "粘贴",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_paste_insert",
            "Shift+Insert",
            "粘贴",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_all",
            "Ctrl+A",
            "全选",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_undo",
            "Ctrl+Z",
            "撤销",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_redo",
            "Ctrl+Y",
            "重做",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_bold",
            "Ctrl+B",
            "加粗所选文本",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_italic",
            "Ctrl+I",
            "倾斜所选文本",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_underline",
            "Ctrl+U",
            "为所选文本添加下划线",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_find",
            "Ctrl+F",
            "查找",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_replace",
            "Ctrl+H",
            "替换",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_delete_word_left",
            "Ctrl+Backspace",
            "删除左侧单词",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_delete_word_right",
            "Ctrl+Delete",
            "删除右侧单词",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_move_word_left",
            "Ctrl+Left",
            "向左移动一个单词",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_move_word_right",
            "Ctrl+Right",
            "向右移动一个单词",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_move_paragraph_up",
            "Ctrl+Up",
            "向上移动一个段落",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_move_paragraph_down",
            "Ctrl+Down",
            "向下移动一个段落",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_word_left",
            "Ctrl+Shift+Left",
            "向左选择一个单词",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_word_right",
            "Ctrl+Shift+Right",
            "向右选择一个单词",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_paragraph_up",
            "Ctrl+Shift+Up",
            "向上选择一个段落",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_paragraph_down",
            "Ctrl+Shift+Down",
            "向下选择一个段落",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_to_start",
            "Ctrl+Shift+Home",
            "选择到文档开头",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_to_end",
            "Ctrl+Shift+End",
            "选择到文档末尾",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_line_start",
            "Home",
            "移动到行首",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_line_end",
            "End",
            "移动到行尾",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_line_start",
            "Shift+Home",
            "选择到行首",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_line_end",
            "Shift+End",
            "选择到行尾",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_left",
            "Shift+Left",
            "向左选择一个字符",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_right",
            "Shift+Right",
            "向右选择一个字符",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_up",
            "Shift+Up",
            "向上选择一行",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_down",
            "Shift+Down",
            "向下选择一行",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_page_up",
            "Shift+PageUp",
            "向上选择一屏",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.text_select_page_down",
            "Shift+PageDown",
            "向下选择一屏",
            "文本编辑",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_address",
            "Alt+D",
            "选中地址栏",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_search",
            "Ctrl+E",
            "选中搜索框",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_search_alt",
            "Ctrl+F",
            "选中搜索框",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_new_window",
            "Ctrl+N",
            "打开新窗口",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_new_tab",
            "Ctrl+T",
            "打开新标签页",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_close_tab",
            "Ctrl+W",
            "关闭当前标签页",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_next_tab",
            "Ctrl+Tab",
            "切换到下一个标签页",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_previous_tab",
            "Ctrl+Shift+Tab",
            "切换到上一个标签页",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_new_folder",
            "Ctrl+Shift+N",
            "新建文件夹",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_expand_nav",
            "Ctrl+Shift+E",
            "展开导航窗格到当前文件夹",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_preview",
            "Alt+P",
            "显示或隐藏预览窗格",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_details",
            "Alt+Shift+P",
            "显示或隐藏详细信息窗格",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_properties",
            "Alt+Enter",
            "打开所选项目属性",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_back",
            "Alt+Left",
            "后退",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_forward",
            "Alt+Right",
            "前进",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_up",
            "Alt+Up",
            "转到上一级文件夹",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_rename",
            "F2",
            "重命名所选项目",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_search_f3",
            "F3",
            "搜索文件或文件夹",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_address_f4",
            "F4",
            "显示地址栏列表",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_refresh",
            "F5",
            "刷新活动窗口",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_panes",
            "F6",
            "循环切换窗口元素",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_fullscreen",
            "F11",
            "最大化或最小化活动窗口",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_select_address",
            "Ctrl+L",
            "选中地址栏",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_delete",
            "Delete",
            "删除所选项目并移到回收站",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_permanent_delete",
            "Shift+Delete",
            "永久删除所选项目",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_home",
            "Home",
            "显示活动窗口顶部",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.file_explorer_end",
            "End",
            "显示活动窗口底部",
            "文件资源管理器",
            HotkeyScope::AppLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.dialog_open_list",
            "F4",
            "显示活动列表项目",
            "对话框",
            HotkeyScope::WindowLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.dialog_next_tab",
            "Ctrl+Tab",
            "向前切换选项卡",
            "对话框",
            HotkeyScope::WindowLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.dialog_previous_tab",
            "Ctrl+Shift+Tab",
            "向后切换选项卡",
            "对话框",
            HotkeyScope::WindowLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.dialog_next_option",
            "Tab",
            "向前切换选项",
            "对话框",
            HotkeyScope::WindowLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.dialog_previous_option",
            "Shift+Tab",
            "向后切换选项",
            "对话框",
            HotkeyScope::WindowLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.dialog_check",
            "Space",
            "选中或清除复选框",
            "对话框",
            HotkeyScope::WindowLocal,
            ManageLevel::ReadOnly,
        ),
        windows_entry(
            "windows.dialog_back",
            "Backspace",
            "在另存为或打开对话框中返回上一级",
            "对话框",
            HotkeyScope::WindowLocal,
            ManageLevel::ReadOnly,
        ),
    ];

    for number in 1..=9 {
        entries.push(windows_entry(
            &format!("windows.dialog_tab_{number}"),
            &format!("Ctrl+{number}"),
            &format!("切换到第 {number} 个选项卡"),
            "对话框",
            HotkeyScope::WindowLocal,
            ManageLevel::ReadOnly,
        ));
    }
    push_taskbar_number_entries(&mut entries);
    entries
}

fn app_builtin_entry(
    id: &str,
    app_name: &str,
    process_name: &str,
    display: &str,
    title: &str,
    scope: HotkeyScope,
    source_path: Option<String>,
    note: &str,
) -> HotkeyEntry {
    HotkeyEntry {
        id: id.to_string(),
        display: display.to_string(),
        title: title.to_string(),
        app_name: app_name.to_string(),
        process_name: Some(process_name.to_string()),
        window_title_match: None,
        source_type: HotkeySourceType::AppBuiltin,
        scope,
        manage_level: ManageLevel::ReadOnly,
        source_path,
        target: Some(note.to_string()),
        can_modify: false,
        backup_available: false,
        conflict: ConflictInfo::default(),
    }
}

fn first_existing_path(candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .map(Path::new)
        .find(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
}

fn env_path(var: &str, suffix: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(|base| PathBuf::from(base).join(suffix))
}

fn read_json_value(path: &Path) -> Option<serde_json::Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn json_pointer_string(value: &serde_json::Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .map(str::to_string)
}

fn app_config_entry(
    id: &str,
    app_name: &str,
    process_name: &str,
    display: &str,
    title: &str,
    scope: HotkeyScope,
    source_path: &Path,
    can_modify: bool,
    note: &str,
) -> HotkeyEntry {
    HotkeyEntry {
        id: id.to_string(),
        display: display.trim().to_string(),
        title: title.to_string(),
        app_name: app_name.to_string(),
        process_name: Some(process_name.to_string()),
        window_title_match: None,
        source_type: HotkeySourceType::AppConfig,
        scope,
        manage_level: if can_modify {
            ManageLevel::AdapterModify
        } else {
            ManageLevel::ReadOnly
        },
        source_path: Some(source_path.to_string_lossy().to_string()),
        target: Some(note.to_string()),
        can_modify,
        backup_available: false,
        conflict: ConflictInfo::default(),
    }
}

fn raw_config_entry(
    id: &str,
    app_name: &str,
    process_name: &str,
    raw_value: &str,
    title: &str,
    source_path: &Path,
    note: &str,
) -> HotkeyEntry {
    app_config_entry(
        id,
        app_name,
        process_name,
        &format!("编码值 {}", raw_value.trim()),
        title,
        HotkeyScope::Global,
        source_path,
        false,
        note,
    )
}

fn typeless_config_entries() -> Vec<HotkeyEntry> {
    let Some(path) = env_path("APPDATA", r"Typeless.exe\app-settings.json") else {
        return Vec::new();
    };
    let Some(value) = read_json_value(&path) else {
        return Vec::new();
    };
    let fields = [
        (
            "app_config.typeless.push_to_talk",
            "/keyboardShortcut/pushToTalk",
            "按住说话",
            HotkeyScope::Global,
        ),
        (
            "app_config.typeless.handles_free_mode",
            "/keyboardShortcut/handlesFreeMode",
            "自由模式",
            HotkeyScope::Global,
        ),
        (
            "app_config.typeless.paste_last_transcript",
            "/keyboardShortcut/pasteLastTranscript",
            "粘贴上一条转写",
            HotkeyScope::Global,
        ),
        (
            "app_config.typeless.translation_mode",
            "/keyboardShortcut/translationMode",
            "翻译模式",
            HotkeyScope::Global,
        ),
    ];
    fields
        .into_iter()
        .filter_map(|(id, pointer, title, scope)| {
            let display = json_pointer_string(&value, pointer)?;
            Some(app_config_entry(
                id,
                "Typeless",
                "Typeless.exe",
                &display,
                title,
                scope,
                &path,
                true,
                "Typeless 用户配置 app-settings.json，可由 Bugzia 写回对应 keyboardShortcut 字段。",
            ))
        })
        .collect()
}

fn pixpin_config_entries() -> Vec<HotkeyEntry> {
    let Some(path) = env_path("LOCALAPPDATA", r"PixPin\Config\PixPinConfig.json") else {
        return Vec::new();
    };
    let Some(value) = read_json_value(&path) else {
        return Vec::new();
    };
    let specs = [
        (
            "app_config.pixpin.screenshot",
            "/Action.Screenshot#s.win/v/shortCut",
            "截图",
        ),
        (
            "app_config.pixpin.pin",
            "/Action.Pin#s.win/v/shortCut",
            "贴图",
        ),
        (
            "app_config.pixpin.bi_shortcut_4",
            "/BIShortcut.pixpin.4#s.win/v",
            "保存当前截图",
        ),
    ];
    specs
        .into_iter()
        .filter_map(|(id, pointer, title)| {
            let display = json_pointer_string(&value, pointer)?;
            Some(app_config_entry(
                id,
                "PixPin",
                "PixPin.exe",
                &display,
                title,
                HotkeyScope::Global,
                &path,
                true,
                "PixPin 用户配置 PixPinConfig.json，可写回对应动作 shortCut 字段。",
            ))
        })
        .collect()
}

fn bongocat_config_entries() -> Vec<HotkeyEntry> {
    let Some(path) = env_path(
        "APPDATA",
        r"com.ayangweb.BongoCat\tauri-plugin-pinia\shortcut.json",
    ) else {
        return Vec::new();
    };
    let Some(value) = read_json_value(&path) else {
        return Vec::new();
    };
    let fields = [
        (
            "app_config.bongocat.visible_cat",
            "visibleCat",
            "显示/隐藏猫",
        ),
        ("app_config.bongocat.penetrable", "penetrable", "鼠标穿透"),
        ("app_config.bongocat.mirror_mode", "mirrorMode", "镜像模式"),
        (
            "app_config.bongocat.visible_preference",
            "visiblePreference",
            "显示偏好设置",
        ),
        ("app_config.bongocat.always_on_top", "alwaysOnTop", "置顶"),
    ];
    fields
        .into_iter()
        .filter_map(|(id, key, title)| {
            let display = value
                .get(key)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            Some(app_config_entry(
                id,
                "BongoCat",
                "bongo-cat.exe",
                &display,
                title,
                HotkeyScope::Global,
                &path,
                true,
                "BongoCat 快捷键配置 shortcut.json，可写回对应字段；空值表示未设置。",
            ))
        })
        .collect()
}

fn read_ini_value(path: &Path, wanted_key: &str) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case(wanted_key) {
            return Some(value.trim().trim_matches('"').to_string());
        }
    }
    None
}

fn kugou_config_entries() -> Vec<HotkeyEntry> {
    let Some(path) = env_path("APPDATA", r"KuGou8\KuGou.ini") else {
        return Vec::new();
    };
    if !path.exists() {
        return Vec::new();
    }
    let note = "酷狗把热键存成数值编码；当前只读展示原始值，后续需要专项解码后才能安全写回。";
    [
        (
            "app_config.kugou.lyric_global",
            "LyricWinGlobalHotKey",
            "桌面歌词全局热键（待解码）",
        ),
        (
            "app_config.kugou.lyric_window",
            "LyricWinHotKey",
            "桌面歌词窗口热键（待解码）",
        ),
    ]
    .into_iter()
    .filter_map(|(id, key, title)| {
        let raw = read_ini_value(&path, key)?;
        if raw.is_empty() || raw == "0" {
            return None;
        }
        Some(raw_config_entry(
            id,
            "酷狗音乐",
            "KuGou.exe",
            &raw,
            title,
            &path,
            note,
        ))
    })
    .collect()
}

#[cfg(target_os = "windows")]
fn winstep_config_entries() -> Vec<HotkeyEntry> {
    let script = concat!(
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ",
        "$k=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\WinSTEP2000\\NeXuS\\Docks' ",
        "-ErrorAction SilentlyContinue; ",
        "if($k){$k.PSObject.Properties | ",
        "Where-Object { $_.Name -match '^1(Hotkey|Label|Path)\\d+$' } | ",
        "ForEach-Object { \"$($_.Name)`t$($_.Value)\" }}"
    );
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut labels: HashMap<String, String> = HashMap::new();
    let mut paths: HashMap<String, String> = HashMap::new();
    let mut hotkeys: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        let Some((name, value)) = line.split_once('\t') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim().to_string();
        if let Some(idx) = name.strip_prefix("1Label") {
            labels.insert(idx.to_string(), value);
        } else if let Some(idx) = name.strip_prefix("1Path") {
            paths.insert(idx.to_string(), value);
        } else if let Some(idx) = name.strip_prefix("1Hotkey") {
            hotkeys.insert(idx.to_string(), value);
        }
    }
    let source_path = PathBuf::from(r"HKCU\Software\WinSTEP2000\NeXuS\Docks");
    let mut out = Vec::new();
    for (idx, raw) in hotkeys {
        let raw = raw.trim();
        if raw.is_empty() || raw == "0" || raw.eq_ignore_ascii_case("0x0") {
            continue;
        }
        let raw_display = raw
            .strip_prefix("0x")
            .and_then(|hex| u32::from_str_radix(hex, 16).ok())
            .map(|n| n.to_string())
            .unwrap_or_else(|| raw.to_string());
        let label = labels
            .get(&idx)
            .cloned()
            .unwrap_or_else(|| format!("Dock 项目 {idx}"));
        let note = paths
            .get(&idx)
            .map(|p| format!("Winstep/Nexus Dock 热键存于注册表，当前只读展示原始值；目标：{p}"))
            .unwrap_or_else(|| "Winstep/Nexus Dock 热键存于注册表，当前只读展示原始值。".into());
        out.push(raw_config_entry(
            &format!("app_config.winstep.dock_{idx}"),
            "Winstep Nexus",
            "Nexus.exe",
            &raw_display,
            &format!("Dock 项目快捷键：{label}"),
            &source_path,
            &note,
        ));
    }
    out.sort_by(|a, b| a.title.cmp(&b.title));
    out
}

#[cfg(not(target_os = "windows"))]
fn winstep_config_entries() -> Vec<HotkeyEntry> {
    Vec::new()
}

fn app_config_entries() -> Vec<HotkeyEntry> {
    let mut entries = Vec::new();
    entries.extend(typeless_config_entries());
    entries.extend(pixpin_config_entries());
    entries.extend(bongocat_config_entries());
    entries.extend(kugou_config_entries());
    entries.extend(winstep_config_entries());
    entries
}

fn app_builtin_entries() -> Vec<HotkeyEntry> {
    let mut entries = Vec::new();
    let pogget_path = first_existing_path(&[r"D:\app\工具箱\Pogget文件收纳管理\Pogget.exe"]);
    if pogget_path.is_some() || process_name_exists("Pogget.exe") {
        let note = "Pogget.exe 内置默认全局热键；当前未发现可安全写回的外部配置。";
        entries.push(app_builtin_entry(
            "app_builtin.pogget.quick_panel",
            "Pogget",
            "Pogget.exe",
            "Ctrl+Shift+K",
            "启动快速面板",
            HotkeyScope::Global,
            pogget_path.clone(),
            note,
        ));
        entries.push(app_builtin_entry(
            "app_builtin.pogget.toggle_quick_panel",
            "Pogget",
            "Pogget.exe",
            "Ctrl+Shift+L",
            "启动/关闭快速面板",
            HotkeyScope::Global,
            pogget_path,
            note,
        ));
    }
    let dingtalk_path = first_existing_path(&[
        r"D:\app\钉钉\DingDing\main\current\DingTalk.exe",
        r"D:\app\钉钉\DingDing\main\current_new\DingTalk.exe",
    ]);
    if dingtalk_path.is_some() || process_name_exists("DingTalk.exe") {
        let note = "从钉钉本地资源文案提取的应用内置快捷键目录；当前未定位到可安全写回的用户配置。";
        entries.push(app_builtin_entry(
            "app_builtin.dingtalk.personal_switch",
            "钉钉",
            "DingTalk.exe",
            "Ctrl+Shift+1",
            "切换个人空间 / 标准版",
            HotkeyScope::AppLocal,
            dingtalk_path.clone(),
            note,
        ));
        for number in 1..=9 {
            entries.push(app_builtin_entry(
                &format!("app_builtin.dingtalk.nav_{number}"),
                "钉钉",
                "DingTalk.exe",
                &format!("Ctrl+{number}"),
                &format!("主导航栏切换 {number}"),
                HotkeyScope::AppLocal,
                dingtalk_path.clone(),
                note,
            ));
        }
        for (id, display, title) in [
            (
                "app_builtin.dingtalk.message_ctrl_enter",
                "Ctrl+Enter",
                "发送消息 / 换行选项",
            ),
            ("app_builtin.dingtalk.message_alt_s", "Alt+S", "发送消息"),
            (
                "app_builtin.dingtalk.streamline_refresh",
                "Ctrl+R",
                "收起无消息或已读会话",
            ),
            (
                "app_builtin.dingtalk.remote_stop",
                "Shift+Esc",
                "停止远程协助受控",
            ),
            ("app_builtin.dingtalk.snip_undo", "Ctrl+Z", "截图工具撤销"),
            ("app_builtin.dingtalk.snip_redo", "Ctrl+Y", "截图工具重做"),
            ("app_builtin.dingtalk.rich_bold", "Ctrl+B", "富文本加粗"),
            ("app_builtin.dingtalk.rich_italic", "Ctrl+I", "富文本斜体"),
            ("app_builtin.dingtalk.rich_link", "Ctrl+K", "富文本链接"),
            (
                "app_builtin.dingtalk.rich_inline_code",
                "Ctrl+E",
                "富文本行内代码",
            ),
            (
                "app_builtin.dingtalk.rich_strike",
                "Ctrl+Shift+X",
                "富文本删除线",
            ),
            (
                "app_builtin.dingtalk.rich_ulist",
                "Ctrl+Shift+7",
                "富文本无序列表",
            ),
            (
                "app_builtin.dingtalk.rich_olist",
                "Ctrl+Shift+8",
                "富文本有序列表",
            ),
            (
                "app_builtin.dingtalk.voice_dictation",
                "Ctrl+Alt",
                "语音听写",
            ),
        ] {
            entries.push(app_builtin_entry(
                id,
                "钉钉",
                "DingTalk.exe",
                display,
                title,
                HotkeyScope::AppLocal,
                dingtalk_path.clone(),
                note,
            ));
        }
    }

    let copytranslator_path = first_existing_path(&[
        r"D:\app\工具箱\翻译软件\copytranslator\copytranslator.exe",
        r"D:\app\工具箱\翻译软件\copytranslator\CopyTranslator.exe",
    ]);
    if copytranslator_path.is_some() || process_name_exists("copytranslator.exe") {
        let note = "从 CopyTranslator 本地资源文案提取的内置快捷键/按键行为；当前未定位到可安全写回的用户配置。";
        for (id, display, title) in [
            (
                "app_builtin.copytranslator.double_copy",
                "Ctrl+C",
                "双击复制触发翻译",
            ),
            (
                "app_builtin.copytranslator.translate_input",
                "Ctrl+Enter",
                "翻译输入框内容",
            ),
            (
                "app_builtin.copytranslator.auto_paste",
                "Ctrl+V",
                "翻译后模拟粘贴",
            ),
        ] {
            entries.push(app_builtin_entry(
                id,
                "CopyTranslator",
                "copytranslator.exe",
                display,
                title,
                HotkeyScope::AppLocal,
                copytranslator_path.clone(),
                note,
            ));
        }
    }

    let everything_path = first_existing_path(&[
        r"D:\app\工具箱\everything\Everything.exe",
        r"C:\Program Files\Everything\Everything.exe",
    ]);
    if everything_path.is_some() || process_name_exists("Everything.exe") {
        let note = "从 Everything.exe 字符串扫描到的应用内快捷键目录；Everything.ini 当前未设置额外全局热键。";
        for (id, display, title) in [
            (
                "app_builtin.everything.alt_down",
                "Alt+Down",
                "展开搜索历史或候选",
            ),
            (
                "app_builtin.everything.alt_up",
                "Alt+Up",
                "收起搜索历史或候选",
            ),
            ("app_builtin.everything.select_all", "Ctrl+A", "全选"),
            ("app_builtin.everything.copy", "Ctrl+C", "复制"),
            ("app_builtin.everything.focus_search", "Ctrl+E", "聚焦搜索"),
            ("app_builtin.everything.open", "Ctrl+Enter", "打开结果"),
            ("app_builtin.everything.help", "Ctrl+F1", "帮助"),
            ("app_builtin.everything.new_window", "Ctrl+N", "新建窗口"),
            ("app_builtin.everything.open_file", "Ctrl+O", "打开"),
            ("app_builtin.everything.save", "Ctrl+S", "保存"),
            (
                "app_builtin.everything.toggle_search",
                "Ctrl+Space",
                "切换搜索相关状态",
            ),
            ("app_builtin.everything.paste", "Ctrl+V", "粘贴"),
            ("app_builtin.everything.close", "Ctrl+W", "关闭窗口"),
            ("app_builtin.everything.cut", "Ctrl+X", "剪切"),
            (
                "app_builtin.everything.open_shift",
                "Shift+Enter",
                "打开结果的替代动作",
            ),
        ] {
            entries.push(app_builtin_entry(
                id,
                "Everything",
                "Everything.exe",
                display,
                title,
                HotkeyScope::AppLocal,
                everything_path.clone(),
                note,
            ));
        }
    }

    let peek_path = first_existing_path(&[r"D:\app\工具箱\Peek-桌面文件隐藏\PeekDesktop.exe"]);
    if peek_path.is_some() || process_name_exists("PeekDesktop.exe") {
        entries.push(app_builtin_entry(
            "app_builtin.peekdesktop.win_d",
            "PeekDesktop",
            "PeekDesktop.exe",
            "Win+D",
            "响应显示桌面",
            HotkeyScope::Global,
            peek_path,
            "从 PeekDesktop.exe 字符串扫描到的全局快捷键行为；当前未定位到可安全写回的用户配置。",
        ));
    }
    entries
}

fn manual_hotkeys_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join("manual-hotkeys.json"))
}

fn center_hidden_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join("hotkey-center-hidden.json"))
}

fn observed_hotkeys_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join("observed-hotkeys.json"))
}

fn observed_hotkeys_path_from_dir(dir: &Path) -> PathBuf {
    dir.join("observed-hotkeys.json")
}

fn atomic_write_json(path: &Path, data: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

fn load_manual_hotkeys(app: &AppHandle) -> Vec<ManualHotkeyEntry> {
    let p = match manual_hotkeys_path(app) {
        Ok(p) => p,
        Err(_) => return vec![],
    };
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_manual_hotkeys(app: &AppHandle, entries: &[ManualHotkeyEntry]) -> Result<(), String> {
    let p = manual_hotkeys_path(app)?;
    let data = serde_json::to_string_pretty(entries).map_err(|e| format!("serialize: {e}"))?;
    atomic_write_json(&p, &data)
}

fn load_center_hidden(app: &AppHandle) -> HashSet<String> {
    let p = match center_hidden_path(app) {
        Ok(p) => p,
        Err(_) => return HashSet::new(),
    };
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn save_center_hidden(app: &AppHandle, hidden: &HashSet<String>) -> Result<(), String> {
    let p = center_hidden_path(app)?;
    let mut entries: Vec<String> = hidden.iter().cloned().collect();
    entries.sort();
    let data = serde_json::to_string_pretty(&entries).map_err(|e| format!("serialize: {e}"))?;
    atomic_write_json(&p, &data)
}

fn load_observed_hotkeys_from_path(path: &Path) -> Vec<ObservedHotkeyEntry> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_observed_hotkeys_to_path(
    path: &Path,
    entries: &[ObservedHotkeyEntry],
) -> Result<(), String> {
    let data = serde_json::to_string_pretty(entries).map_err(|e| format!("serialize: {e}"))?;
    atomic_write_json(path, &data)
}

fn load_observed_hotkeys(app: &AppHandle) -> Vec<ObservedHotkeyEntry> {
    let p = match observed_hotkeys_path(app) {
        Ok(p) => p,
        Err(_) => return vec![],
    };
    load_observed_hotkeys_from_path(&p)
}

fn save_observed_hotkeys(app: &AppHandle, entries: &[ObservedHotkeyEntry]) -> Result<(), String> {
    let p = observed_hotkeys_path(app)?;
    save_observed_hotkeys_to_path(&p, entries)
}

fn can_hide_center_entry(entry: &HotkeyEntry) -> bool {
    matches!(
        entry.source_type,
        HotkeySourceType::WindowsSystem
            | HotkeySourceType::Manual
            | HotkeySourceType::AppConfig
            | HotkeySourceType::AppBuiltin
    )
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn observed_id(process_name: &str, accelerator: &str) -> String {
    format!(
        "observed.{}.{}",
        sanitize_id_part(process_name),
        sanitize_id_part(accelerator)
    )
}

fn sanitize_id_part(value: &str) -> String {
    let mut out = String::new();
    for c in value.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

fn merge_observed_sample(path: &Path, sample: ObservedHotkeySample) -> Result<(), String> {
    let mut entries = load_observed_hotkeys_from_path(path);
    let id = observed_id(&sample.process_name, &sample.accelerator);
    if let Some(entry) = entries.iter_mut().find(|item| item.id == id) {
        entry.count = entry.count.saturating_add(1);
        entry.window_title = sample.window_title;
        entry.last_seen_ms = sample.seen_ms;
    } else {
        entries.push(ObservedHotkeyEntry {
            id,
            app_name: app_name_from_process(&sample.process_name),
            process_name: sample.process_name,
            window_title: sample.window_title,
            accelerator: sample.accelerator,
            count: 1,
            first_seen_ms: sample.seen_ms,
            last_seen_ms: sample.seen_ms,
        });
    }
    entries.sort_by(|a, b| {
        b.last_seen_ms
            .cmp(&a.last_seen_ms)
            .then_with(|| {
                a.process_name
                    .to_lowercase()
                    .cmp(&b.process_name.to_lowercase())
            })
            .then_with(|| a.accelerator.cmp(&b.accelerator))
    });
    save_observed_hotkeys_to_path(path, &entries)
}

fn app_name_from_process(process_name: &str) -> String {
    process_name
        .trim()
        .strip_suffix(".exe")
        .or_else(|| process_name.trim().strip_suffix(".EXE"))
        .unwrap_or(process_name.trim())
        .to_string()
}

fn compact_accel(raw: &str) -> String {
    raw.split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("+")
}

fn is_modifier_token(token: &str) -> bool {
    matches!(
        token.trim().to_lowercase().as_str(),
        "ctrl"
            | "control"
            | "leftctrl"
            | "rightctrl"
            | "leftcontrol"
            | "rightcontrol"
            | "alt"
            | "opt"
            | "option"
            | "leftalt"
            | "rightalt"
            | "leftoption"
            | "rightoption"
            | "shift"
            | "leftshift"
            | "rightshift"
            | "win"
            | "super"
            | "meta"
            | "leftwin"
            | "rightwin"
            | "leftmeta"
            | "rightmeta"
    )
}

fn is_modifier_only_accel(raw: &str) -> bool {
    let parts: Vec<&str> = raw
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    !parts.is_empty() && parts.iter().all(|part| is_modifier_token(part))
}

fn validate_app_config_accel(raw: &str) -> Result<String, String> {
    let compact = compact_accel(raw);
    if compact.is_empty() {
        return Ok(String::new());
    }
    if parse_accel(&compact).is_some() || is_modifier_only_accel(&compact) {
        return Ok(compact);
    }
    Err("请输入有效快捷键，如 Ctrl+Alt+K；清空则表示未设置".into())
}

fn app_config_pointer_for_id(id: &str) -> Result<(PathBuf, &'static str), String> {
    match id {
        "app_config.typeless.push_to_talk" => {
            env_path("APPDATA", r"Typeless.exe\app-settings.json")
                .map(|path| (path, "/keyboardShortcut/pushToTalk"))
        }
        "app_config.typeless.handles_free_mode" => {
            env_path("APPDATA", r"Typeless.exe\app-settings.json")
                .map(|path| (path, "/keyboardShortcut/handlesFreeMode"))
        }
        "app_config.typeless.paste_last_transcript" => {
            env_path("APPDATA", r"Typeless.exe\app-settings.json")
                .map(|path| (path, "/keyboardShortcut/pasteLastTranscript"))
        }
        "app_config.typeless.translation_mode" => {
            env_path("APPDATA", r"Typeless.exe\app-settings.json")
                .map(|path| (path, "/keyboardShortcut/translationMode"))
        }
        "app_config.pixpin.screenshot" => {
            env_path("LOCALAPPDATA", r"PixPin\Config\PixPinConfig.json")
                .map(|path| (path, "/Action.Screenshot#s.win/v/shortCut"))
        }
        "app_config.pixpin.pin" => env_path("LOCALAPPDATA", r"PixPin\Config\PixPinConfig.json")
            .map(|path| (path, "/Action.Pin#s.win/v/shortCut")),
        "app_config.pixpin.bi_shortcut_4" => {
            env_path("LOCALAPPDATA", r"PixPin\Config\PixPinConfig.json")
                .map(|path| (path, "/BIShortcut.pixpin.4#s.win/v"))
        }
        "app_config.bongocat.visible_cat" => env_path(
            "APPDATA",
            r"com.ayangweb.BongoCat\tauri-plugin-pinia\shortcut.json",
        )
        .map(|path| (path, "/visibleCat")),
        "app_config.bongocat.penetrable" => env_path(
            "APPDATA",
            r"com.ayangweb.BongoCat\tauri-plugin-pinia\shortcut.json",
        )
        .map(|path| (path, "/penetrable")),
        "app_config.bongocat.mirror_mode" => env_path(
            "APPDATA",
            r"com.ayangweb.BongoCat\tauri-plugin-pinia\shortcut.json",
        )
        .map(|path| (path, "/mirrorMode")),
        "app_config.bongocat.visible_preference" => env_path(
            "APPDATA",
            r"com.ayangweb.BongoCat\tauri-plugin-pinia\shortcut.json",
        )
        .map(|path| (path, "/visiblePreference")),
        "app_config.bongocat.always_on_top" => env_path(
            "APPDATA",
            r"com.ayangweb.BongoCat\tauri-plugin-pinia\shortcut.json",
        )
        .map(|path| (path, "/alwaysOnTop")),
        _ => None,
    }
    .ok_or_else(|| "未找到这条应用配置快捷键".to_string())
}

fn set_json_pointer_string(
    value: &mut serde_json::Value,
    pointer: &str,
    accelerator: String,
) -> Result<(), String> {
    let Some(slot) = value.pointer_mut(pointer) else {
        return Err("配置字段不存在，已取消写入".into());
    };
    if !slot.is_string() {
        return Err("配置字段不是字符串，已取消写入".into());
    }
    *slot = serde_json::Value::String(accelerator);
    Ok(())
}

fn validate_manual_input(input: ManualHotkeyInput) -> Result<ManualHotkeyInput, String> {
    let app_name = input.app_name.trim().to_string();
    let process_name = input.process_name.trim().to_string();
    let window_title_match = input.window_title_match.trim().to_string();
    let title = input.title.trim().to_string();
    let accelerator = input.accelerator.trim().to_string();
    let notes = input.notes.trim().to_string();
    if app_name.is_empty() {
        return Err("请输入应用名称".into());
    }
    if title.is_empty() {
        return Err("请输入功能名称".into());
    }
    let accelerator = if accelerator.is_empty() {
        String::new()
    } else {
        let parsed = parse_accel(&accelerator)
            .ok_or_else(|| "请输入有效快捷键，如 Ctrl+Alt+K；清空则表示未设置".to_string())?;
        format_accel(&parsed)
    };
    Ok(ManualHotkeyInput {
        app_name,
        process_name,
        window_title_match,
        title,
        accelerator,
        scope: input.scope,
        notes,
    })
}

fn manual_to_entry(item: ManualHotkeyEntry) -> HotkeyEntry {
    HotkeyEntry {
        id: item.id,
        display: item.accelerator,
        title: item.title,
        app_name: item.app_name,
        process_name: if item.process_name.is_empty() {
            None
        } else {
            Some(item.process_name)
        },
        window_title_match: if item.window_title_match.is_empty() {
            None
        } else {
            Some(item.window_title_match)
        },
        source_type: HotkeySourceType::Manual,
        scope: item.scope,
        manage_level: ManageLevel::DirectModify,
        source_path: None,
        target: if item.notes.is_empty() {
            None
        } else {
            Some(item.notes)
        },
        can_modify: true,
        backup_available: false,
        conflict: ConflictInfo::default(),
    }
}

// ---------------------------------------------------------------------------
// 聚合构造 + 冲突标注
// ---------------------------------------------------------------------------

/// 由 Bugzia 自身快捷键 + `.lnk` 扫描结果构造统一条目（不含冲突计算）。
fn build_entries_raw(app: &AppHandle) -> Result<Vec<HotkeyEntry>, String> {
    let mut out: Vec<HotkeyEntry> = Vec::new();

    // Bugzia 自身：summon / note（来自 settings.json）。读失败则用默认值，不阻断扫描。
    let hotkey = load_settings(app.clone())
        .map(|s| s.hotkey)
        .unwrap_or_default();
    for (id, title, raw) in [
        ("bugzia.summon", "召唤输入框", hotkey.summon.as_str()),
        ("bugzia.note", "召唤便笺", hotkey.note.as_str()),
        (
            "bugzia.note_create",
            "直接新建便笺",
            hotkey.note_create.as_str(),
        ),
        (
            "bugzia.note_destroy",
            "销毁当前便笺",
            hotkey.note_destroy.as_str(),
        ),
    ] {
        // parse 失败（如含 Win）时回退到原始串，避免把有效键显示成空。
        let display = match parse_accel(raw) {
            Some(a) => format_accel(&a),
            None => raw.trim().to_string(),
        };
        out.push(HotkeyEntry {
            id: id.to_string(),
            display,
            title: title.to_string(),
            app_name: "Bugzia".into(),
            process_name: None,
            window_title_match: None,
            source_type: HotkeySourceType::Bugzia,
            scope: HotkeyScope::Global,
            manage_level: ManageLevel::DirectModify,
            source_path: None,
            target: None,
            can_modify: true,
            backup_available: false,
            conflict: ConflictInfo::default(),
        });
    }

    out.extend(windows_system_entries());
    out.extend(app_builtin_entries());
    out.extend(app_config_entries());

    for item in load_manual_hotkeys(app) {
        out.push(manual_to_entry(item));
    }

    // .lnk 快捷方式。
    for item in scan_shortcuts_internal(app) {
        out.push(HotkeyEntry {
            id: item.shortcut_path.clone(),
            display: item.hotkey.clone(),
            title: item.name.clone(),
            app_name: app_name_for(&item),
            process_name: None,
            window_title_match: None,
            source_type: HotkeySourceType::ShortcutLink,
            scope: HotkeyScope::Global,
            manage_level: ManageLevel::DirectModify,
            source_path: Some(item.shortcut_path.clone()),
            target: if item.target_path.is_empty() {
                None
            } else {
                Some(item.target_path.clone())
            },
            can_modify: item.can_modify,
            backup_available: item.backup_available,
            conflict: ConflictInfo::default(),
        });
    }
    Ok(out)
}

fn build_entries(app: &AppHandle) -> Result<Vec<HotkeyEntry>, String> {
    let hidden = load_center_hidden(app);
    let mut entries = build_entries_raw(app)?;
    entries.retain(|e| !hidden.contains(&e.id));
    Ok(entries)
}

/// 来源应用名：目标可执行文件名优先；取不到就用 `.lnk` 名字。
fn app_name_for(item: &ShortcutHotkeyItem) -> String {
    if !item.target_path.is_empty() {
        if let Some(stem) = Path::new(&item.target_path)
            .file_stem()
            .and_then(|s| s.to_str())
        {
            return stem.to_string();
        }
    }
    item.name.clone()
}

fn scopes_overlap(a: &HotkeyEntry, b: &HotkeyEntry) -> bool {
    if matches!(a.scope, HotkeyScope::Global | HotkeyScope::Unknown)
        || matches!(b.scope, HotkeyScope::Global | HotkeyScope::Unknown)
    {
        return true;
    }
    app_identity(a) == app_identity(b)
}

fn app_identity(entry: &HotkeyEntry) -> String {
    entry
        .process_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(entry.app_name.trim())
        .to_lowercase()
}

fn is_low_risk_windows_override(a: &HotkeyEntry, b: &HotkeyEntry) -> bool {
    let a_windows = matches!(a.source_type, HotkeySourceType::WindowsSystem);
    let b_windows = matches!(b.source_type, HotkeySourceType::WindowsSystem);
    if a_windows == b_windows {
        return false;
    }
    let windows_entry = if a_windows { a } else { b };
    !matches!(windows_entry.manage_level, ManageLevel::HighRisk)
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|v| v == &value) {
        values.push(value);
    }
}

#[cfg(target_os = "windows")]
fn list_running_apps() -> Vec<RunningAppInfo> {
    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let title = window_title(hwnd);
        if title.trim().is_empty() {
            return BOOL(1);
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
        if pid == 0 || pid == std::process::id() {
            return BOOL(1);
        }
        let process_name = process_name_for_pid(pid).unwrap_or_default();
        if process_name.trim().is_empty() {
            return BOOL(1);
        }
        let out = &mut *(lparam.0 as *mut Vec<RunningAppInfo>);
        out.push(RunningAppInfo {
            process_name,
            window_title: title,
            pid,
        });
        BOOL(1)
    }

    let mut out: Vec<RunningAppInfo> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut out as *mut _ as isize));
    }
    out.sort_by(|a, b| {
        a.process_name
            .to_lowercase()
            .cmp(&b.process_name.to_lowercase())
            .then_with(|| {
                a.window_title
                    .to_lowercase()
                    .cmp(&b.window_title.to_lowercase())
            })
            .then_with(|| a.pid.cmp(&b.pid))
    });
    out.dedup_by(|a, b| {
        a.pid == b.pid && a.process_name == b.process_name && a.window_title == b.window_title
    });
    out
}

#[cfg(not(target_os = "windows"))]
fn list_running_apps() -> Vec<RunningAppInfo> {
    Vec::new()
}

#[cfg(target_os = "windows")]
fn foreground_running_app() -> Option<RunningAppInfo> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd == HWND(0) {
        return None;
    }
    let title = window_title(hwnd);
    if title.trim().is_empty() {
        return None;
    }
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
    }
    if pid == 0 || pid == std::process::id() {
        return None;
    }
    let process_name = process_name_for_pid(pid)?;
    if process_name.trim().is_empty() {
        return None;
    }
    Some(RunningAppInfo {
        process_name,
        window_title: title,
        pid,
    })
}

#[cfg(target_os = "windows")]
fn observer_runtime() -> &'static Mutex<HotkeyObserverRuntime> {
    HOTKEY_OBSERVER_RUNTIME.get_or_init(|| Mutex::new(HotkeyObserverRuntime::default()))
}

#[cfg(target_os = "windows")]
fn observer_sender() -> &'static Mutex<Option<mpsc::Sender<ObservedHotkeySample>>> {
    HOTKEY_OBSERVER_SENDER.get_or_init(|| Mutex::new(None))
}

#[cfg(target_os = "windows")]
fn observer_last() -> &'static Mutex<Option<ObservedHotkeySample>> {
    HOTKEY_OBSERVER_LAST.get_or_init(|| Mutex::new(None))
}

#[cfg(target_os = "windows")]
fn set_observer_enabled(app: &AppHandle, enabled: bool) -> Result<HotkeyObserverStatus, String> {
    if enabled {
        start_hotkey_observer(app)?;
    } else {
        stop_hotkey_observer();
    }
    Ok(HotkeyObserverStatus {
        enabled: observer_is_enabled(),
    })
}

#[cfg(not(target_os = "windows"))]
fn set_observer_enabled(_app: &AppHandle, _enabled: bool) -> Result<HotkeyObserverStatus, String> {
    Ok(HotkeyObserverStatus { enabled: false })
}

#[cfg(target_os = "windows")]
fn observer_is_enabled() -> bool {
    observer_runtime()
        .lock()
        .map(|rt| rt.enabled)
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn observer_is_enabled() -> bool {
    false
}

#[cfg(target_os = "windows")]
fn start_hotkey_observer(app: &AppHandle) -> Result<(), String> {
    {
        let runtime = observer_runtime()
            .lock()
            .map_err(|_| "hotkey observer runtime poisoned".to_string())?;
        if runtime.enabled {
            return Ok(());
        }
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    fs::create_dir_all(&app_data_dir).map_err(|e| format!("create app data dir: {e}"))?;
    let observed_path = observed_hotkeys_path_from_dir(&app_data_dir);
    let (sample_tx, sample_rx) = mpsc::channel::<ObservedHotkeySample>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();

    {
        let mut sender = observer_sender()
            .lock()
            .map_err(|_| "hotkey observer sender poisoned".to_string())?;
        *sender = Some(sample_tx);
    }

    thread::spawn(move || {
        for sample in sample_rx {
            let _ = merge_observed_sample(&observed_path, sample);
        }
    });

    thread::spawn(move || unsafe {
        let thread_id = GetCurrentThreadId();
        let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_observer_proc), None, 0) {
            Ok(hook) => hook,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("安装键盘观察器失败：{e}")));
                return;
            }
        };
        let _ = ready_tx.send(Ok(thread_id));
        let mut msg = Default::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        let _ = UnhookWindowsHookEx(hook);
    });

    let thread_id = ready_rx
        .recv()
        .map_err(|_| "键盘观察器启动失败".to_string())??;
    let mut runtime = observer_runtime()
        .lock()
        .map_err(|_| "hotkey observer runtime poisoned".to_string())?;
    runtime.enabled = true;
    runtime.thread_id = thread_id;
    Ok(())
}

#[cfg(target_os = "windows")]
fn stop_hotkey_observer() {
    if let Ok(mut sender) = observer_sender().lock() {
        *sender = None;
    }
    if let Ok(mut last) = observer_last().lock() {
        *last = None;
    }
    if let Ok(mut runtime) = observer_runtime().lock() {
        if runtime.enabled && runtime.thread_id != 0 {
            unsafe {
                let _ = PostThreadMessageW(runtime.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        runtime.enabled = false;
        runtime.thread_id = 0;
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn keyboard_observer_proc(
    code: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    if code >= 0 && (wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN) {
        let kb = *(lparam.0 as *const KBDLLHOOKSTRUCT);
        if let Some(accelerator) = accelerator_from_vk(kb.vkCode) {
            if let Some(front) = foreground_running_app() {
                let sample = ObservedHotkeySample {
                    process_name: front.process_name,
                    window_title: front.window_title,
                    accelerator,
                    seen_ms: now_ms(),
                };
                if should_record_observed_sample(&sample) {
                    if let Ok(sender_guard) = observer_sender().lock() {
                        if let Some(sender) = sender_guard.as_ref() {
                            let _ = sender.send(sample);
                        }
                    }
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

#[cfg(target_os = "windows")]
fn should_record_observed_sample(sample: &ObservedHotkeySample) -> bool {
    let Ok(mut last) = observer_last().lock() else {
        return true;
    };
    let should_skip = last.as_ref().is_some_and(|prev| {
        prev.process_name.eq_ignore_ascii_case(&sample.process_name)
            && prev.accelerator.eq_ignore_ascii_case(&sample.accelerator)
            && sample.seen_ms.saturating_sub(prev.seen_ms) < 450
    });
    if should_skip {
        return false;
    }
    *last = Some(sample.clone());
    true
}

#[cfg(target_os = "windows")]
fn accelerator_from_vk(vk: u32) -> Option<String> {
    let (key, record_without_modifier) = vk_key_name(vk)?;
    if is_modifier_vk(vk) {
        return None;
    }
    let ctrl = key_down(VK_CONTROL.0 as i32);
    let alt = key_down(VK_MENU.0 as i32);
    let shift = key_down(VK_SHIFT.0 as i32);
    let win = key_down(VK_LWIN.0 as i32) || key_down(VK_RWIN.0 as i32);
    if !(ctrl || alt || shift || win || record_without_modifier) {
        return None;
    }
    let mut parts = Vec::new();
    if win {
        parts.push("Win".to_string());
    }
    if ctrl {
        parts.push("Ctrl".to_string());
    }
    if alt {
        parts.push("Alt".to_string());
    }
    if shift {
        parts.push("Shift".to_string());
    }
    parts.push(key);
    Some(parts.join("+"))
}

#[cfg(target_os = "windows")]
fn key_down(vk: i32) -> bool {
    unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 }
}

#[cfg(target_os = "windows")]
fn is_modifier_vk(vk: u32) -> bool {
    matches!(vk, 0x10 | 0x11 | 0x12 | 0x5B | 0x5C | 0xA0..=0xA5)
}

#[cfg(target_os = "windows")]
fn vk_key_name(vk: u32) -> Option<(String, bool)> {
    match vk {
        0x30..=0x39 => Some(((vk as u8 as char).to_string(), false)),
        0x41..=0x5A => Some(((vk as u8 as char).to_string(), false)),
        0x70..=0x87 => Some((format!("F{}", vk - 0x6F), true)),
        0x20 => Some(("Space".into(), false)),
        0x25 => Some(("Left".into(), false)),
        0x26 => Some(("Up".into(), false)),
        0x27 => Some(("Right".into(), false)),
        0x28 => Some(("Down".into(), false)),
        0x09 => Some(("Tab".into(), false)),
        0x0D => Some(("Enter".into(), false)),
        0x1B => Some(("Esc".into(), false)),
        0x2E => Some(("Delete".into(), false)),
        0x08 => Some(("Backspace".into(), false)),
        0x2D => Some(("Insert".into(), false)),
        0x24 => Some(("Home".into(), false)),
        0x23 => Some(("End".into(), false)),
        0x21 => Some(("PageUp".into(), false)),
        0x22 => Some(("PageDown".into(), false)),
        0x2C => Some(("PrintScreen".into(), true)),
        0x13 => Some(("Pause".into(), true)),
        0x90 => Some(("NumLock".into(), true)),
        0xBA => Some((";".into(), false)),
        0xBB => Some(("=".into(), false)),
        0xBC => Some((",".into(), false)),
        0xBD => Some(("Minus".into(), false)),
        0xBE => Some((".".into(), false)),
        0xBF => Some(("/".into(), false)),
        0xC0 => Some(("`".into(), false)),
        0xDB => Some(("[".into(), false)),
        0xDC => Some(("\\".into(), false)),
        0xDD => Some(("]".into(), false)),
        0xDE => Some(("'".into(), false)),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn window_title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

#[cfg(target_os = "windows")]
fn process_name_for_pid(pid: u32) -> Option<String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()? };
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut found = None;
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry).is_ok() };
    while ok {
        if entry.th32ProcessID == pid {
            found = Some(wide_nul_to_string(&entry.szExeFile));
            break;
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry).is_ok() };
    }
    let _ = unsafe { CloseHandle(snapshot) };
    found
}

#[cfg(target_os = "windows")]
fn process_name_exists(name: &str) -> bool {
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return false;
    };
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry).is_ok() };
    while ok {
        if wide_nul_to_string(&entry.szExeFile).eq_ignore_ascii_case(name) {
            let _ = unsafe { CloseHandle(snapshot) };
            return true;
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry).is_ok() };
    }
    let _ = unsafe { CloseHandle(snapshot) };
    false
}

#[cfg(not(target_os = "windows"))]
fn process_name_exists(_name: &str) -> bool {
    false
}

#[cfg(target_os = "windows")]
fn wide_nul_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// 按 `NormalizedAccelerator` 分组，再按作用域判断是否真的互相覆盖。全局键会
/// 和局部键冲突；低风险 Windows 系统键被自定义键接管时标为系统覆盖，而不
/// 算真正冲突；两个不同应用的局部键只作为目录展示，不互相误报。
fn annotate_conflicts(entries: &mut [HotkeyEntry]) {
    let mut groups: HashMap<NormalizedAccelerator, Vec<usize>> = HashMap::new();
    for (i, e) in entries.iter().enumerate() {
        if let Some(a) = parse_accel(&e.display) {
            groups.entry(a).or_default().push(i);
        }
    }
    for idxs in groups.into_values() {
        if idxs.len() < 2 {
            continue;
        }
        let mut peers: HashMap<usize, Vec<usize>> = HashMap::new();
        for (left_pos, &left) in idxs.iter().enumerate() {
            for &right in idxs.iter().skip(left_pos + 1) {
                if scopes_overlap(&entries[left], &entries[right]) {
                    peers.entry(left).or_default().push(right);
                    peers.entry(right).or_default().push(left);
                }
            }
        }
        for (&i, peer_idxs) in peers.iter() {
            for &peer in peer_idxs {
                let is_system_override = is_low_risk_windows_override(&entries[i], &entries[peer]);
                let peer_id = entries[peer].id.clone();
                let peer_is_bugzia = matches!(entries[peer].source_type, HotkeySourceType::Bugzia);
                let self_is_bugzia = matches!(entries[i].source_type, HotkeySourceType::Bugzia);
                let conflict = &mut entries[i].conflict;
                if is_system_override {
                    conflict.is_system_override = true;
                    conflict.conflicts_with_bugzia |= self_is_bugzia || peer_is_bugzia;
                    push_unique(&mut conflict.conflicting_with, peer_id);
                } else {
                    conflict.is_duplicate = true;
                    conflict.conflicts_with_bugzia |= self_is_bugzia || peer_is_bugzia;
                    push_unique(&mut conflict.conflicting_with, peer_id);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri 命令（文档 §6.1，本版只取这两个；探测/拦截/手动登记留后续阶段）
// ---------------------------------------------------------------------------

/// 汇总所有已支持来源，不做冲突计算。
#[tauri::command]
pub fn hotkey_center_scan(app: AppHandle) -> Result<Vec<HotkeyEntry>, String> {
    build_entries(&app)
}

/// 返回带冲突状态的统一列表（总览页调用）。
#[tauri::command]
pub fn hotkey_center_detect_conflicts(app: AppHandle) -> Result<Vec<HotkeyEntry>, String> {
    let mut entries = build_entries(&app)?;
    annotate_conflicts(&mut entries);
    Ok(entries)
}

#[tauri::command]
pub fn manual_hotkey_entries_list(app: AppHandle) -> Result<Vec<ManualHotkeyEntry>, String> {
    Ok(load_manual_hotkeys(&app))
}

#[tauri::command]
pub fn running_apps_list() -> Result<Vec<RunningAppInfo>, String> {
    Ok(list_running_apps())
}

#[tauri::command]
pub fn hotkey_observer_set_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<HotkeyObserverStatus, String> {
    set_observer_enabled(&app, enabled)
}

#[tauri::command]
pub fn hotkey_observer_status() -> Result<HotkeyObserverStatus, String> {
    Ok(HotkeyObserverStatus {
        enabled: observer_is_enabled(),
    })
}

#[tauri::command]
pub fn observed_hotkeys_list(app: AppHandle) -> Result<Vec<ObservedHotkeyEntry>, String> {
    Ok(load_observed_hotkeys(&app))
}

#[tauri::command]
pub fn observed_hotkey_remove(app: AppHandle, observed_id: String) -> Result<bool, String> {
    let mut entries = load_observed_hotkeys(&app);
    let before = entries.len();
    entries.retain(|entry| entry.id != observed_id);
    let removed = entries.len() != before;
    save_observed_hotkeys(&app, &entries)?;
    Ok(removed)
}

#[tauri::command]
pub fn observed_hotkey_promote(
    app: AppHandle,
    observed_id: String,
) -> Result<ManualHotkeyEntry, String> {
    let observed = load_observed_hotkeys(&app)
        .into_iter()
        .find(|entry| entry.id == observed_id)
        .ok_or_else(|| "未找到这条观察记录".to_string())?;
    let input = ManualHotkeyInput {
        app_name: observed.app_name,
        process_name: observed.process_name,
        window_title_match: observed.window_title,
        title: format!("观察到的快捷键 {}", observed.accelerator),
        accelerator: observed.accelerator,
        scope: HotkeyScope::AppLocal,
        notes: format!("自动观察记录，触发 {} 次", observed.count),
    };
    manual_hotkey_entry_add(app, input)
}

#[tauri::command]
pub fn manual_hotkey_entry_add(
    app: AppHandle,
    input: ManualHotkeyInput,
) -> Result<ManualHotkeyEntry, String> {
    let input = validate_manual_input(input)?;
    let mut entries = load_manual_hotkeys(&app);
    let mut id = format!("manual.{}", now_ms());
    while entries.iter().any(|e| e.id == id) {
        id = format!("manual.{}", now_ms() + entries.len() as u128 + 1);
    }
    let entry = ManualHotkeyEntry {
        id,
        app_name: input.app_name,
        process_name: input.process_name,
        window_title_match: input.window_title_match,
        title: input.title,
        accelerator: input.accelerator,
        scope: input.scope,
        notes: input.notes,
    };
    entries.push(entry.clone());
    save_manual_hotkeys(&app, &entries)?;
    Ok(entry)
}

#[tauri::command]
pub fn manual_hotkey_entry_update(
    app: AppHandle,
    id: String,
    input: ManualHotkeyInput,
) -> Result<ManualHotkeyEntry, String> {
    let input = validate_manual_input(input)?;
    let mut entries = load_manual_hotkeys(&app);
    let entry = entries
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| "未找到这条手动登记".to_string())?;
    entry.app_name = input.app_name;
    entry.process_name = input.process_name;
    entry.window_title_match = input.window_title_match;
    entry.title = input.title;
    entry.accelerator = input.accelerator;
    entry.scope = input.scope;
    entry.notes = input.notes;
    let updated = entry.clone();
    save_manual_hotkeys(&app, &entries)?;
    Ok(updated)
}

#[tauri::command]
pub fn manual_hotkey_entry_remove(app: AppHandle, id: String) -> Result<bool, String> {
    let mut entries = load_manual_hotkeys(&app);
    let before = entries.len();
    entries.retain(|e| e.id != id);
    let removed = entries.len() != before;
    save_manual_hotkeys(&app, &entries)?;
    Ok(removed)
}

#[tauri::command]
pub fn app_config_hotkey_entry_update(id: String, accelerator: String) -> Result<bool, String> {
    let accelerator = validate_app_config_accel(&accelerator)?;
    let (path, pointer) = app_config_pointer_for_id(&id)?;
    let mut value = read_json_value(&path).ok_or_else(|| "无法读取应用配置文件".to_string())?;
    set_json_pointer_string(&mut value, pointer, accelerator)?;
    let data = serde_json::to_string_pretty(&value).map_err(|e| format!("serialize: {e}"))?;
    atomic_write_json(&path, &data)?;
    Ok(true)
}

#[tauri::command]
pub fn hotkey_center_hide_entry(app: AppHandle, entry_id: String) -> Result<bool, String> {
    let entries = build_entries_raw(&app)?;
    let entry = entries
        .iter()
        .find(|e| e.id == entry_id)
        .ok_or_else(|| "未找到这条快捷键".to_string())?;
    if !can_hide_center_entry(entry) {
        return Err("这条快捷键不支持从快捷键中心隐藏".into());
    }
    let mut hidden = load_center_hidden(&app);
    hidden.insert(entry_id);
    save_center_hidden(&app, &hidden)?;
    Ok(true)
}

#[tauri::command]
pub fn hotkey_center_hidden_list(app: AppHandle) -> Result<Vec<HotkeyEntry>, String> {
    let hidden = load_center_hidden(&app);
    let mut entries = build_entries_raw(&app)?;
    entries.retain(|e| can_hide_center_entry(e) && hidden.contains(&e.id));
    annotate_conflicts(&mut entries);
    Ok(entries)
}

#[tauri::command]
pub fn hotkey_center_unhide_entry(app: AppHandle, entry_id: String) -> Result<bool, String> {
    let mut hidden = load_center_hidden(&app);
    let removed = hidden.remove(&entry_id);
    save_center_hidden(&app, &hidden)?;
    Ok(removed)
}
