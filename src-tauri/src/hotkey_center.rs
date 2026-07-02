//! 快捷键中心：统一数据模型 + 快捷键归一化层 + 冲突检测 + 中心聚合命令。
//!
//! 这是「快捷键中心」的总入口（开发文档 §5 / §6.1）。本版只聚合两类来源：
//!   - Bugzia 自身快捷键（来自 settings.json 的 summon/note）
//!   - Windows .lnk 快捷方式热键（由 `shortcut_hotkeys` 模块扫描）
//!
//! 统一的扁平 `HotkeyEntry` 模型面向「总览」表格，未来加 AppConfig /
//! ProbedOccupied / BlockRule 等 source_type 即可扩展，无需重构（附录 G 的
//! 「为终局架构留接口」要求）。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::settings::load_settings;
use crate::shortcut_hotkeys::scan_shortcuts_internal;

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
            "ctrl" | "control" => ctrl = true,
            "alt" | "opt" | "option" => alt = true,
            "shift" => shift = true,
            "win" | "super" | "meta" => win = true,
            "space" => {
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
        return None;
    }
    if let Some(rest) = t.strip_prefix('f') {
        if let Ok(n) = rest.parse::<u8>() {
            if (1..=24).contains(&n) {
                return Some(NormalizedKey::F(n));
            }
        }
        return None;
    }
    match t {
        "." => Some(NormalizedKey::Named(".".into())),
        "left" | "arrowleft" => Some(NormalizedKey::Named("Left".into())),
        "right" | "arrowright" => Some(NormalizedKey::Named("Right".into())),
        "up" | "arrowup" => Some(NormalizedKey::Named("Up".into())),
        "down" | "arrowdown" => Some(NormalizedKey::Named("Down".into())),
        "tab" => Some(NormalizedKey::Named("Tab".into())),
        "enter" | "return" => Some(NormalizedKey::Named("Enter".into())),
        "esc" | "escape" => Some(NormalizedKey::Named("Esc".into())),
        "delete" | "del" => Some(NormalizedKey::Named("Delete".into())),
        "backspace" => Some(NormalizedKey::Named("Backspace".into())),
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
    // 预留：AppConfig, ProbedOccupied, BlockRule
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum HotkeyScope {
    Global,
    AppLocal,
    WindowLocal,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum ManageLevel {
    DirectModify,
    AdapterModify,
    Blockable,
    ReadOnly,
    HighRisk,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ConflictInfo {
    pub is_duplicate: bool,
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
    pub title: String,
    pub accelerator: String,
    pub scope: HotkeyScope,
    pub notes: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManualHotkeyInput {
    pub app_name: String,
    pub title: String,
    pub accelerator: String,
    pub scope: HotkeyScope,
    pub notes: String,
}

// ---------------------------------------------------------------------------
// Windows 系统快捷键只读目录 + 手动登记应用快捷键
// ---------------------------------------------------------------------------

fn windows_system_entries() -> Vec<HotkeyEntry> {
    [
        ("windows.lock", "Win+L", "锁定电脑", "系统安全", ManageLevel::HighRisk),
        ("windows.security", "Ctrl+Alt+Delete", "安全选项", "系统安全", ManageLevel::HighRisk),
        ("windows.task_switch", "Alt+Tab", "切换窗口", "窗口管理", ManageLevel::ReadOnly),
        ("windows.close_window", "Alt+F4", "关闭当前窗口", "窗口管理", ManageLevel::ReadOnly),
        ("windows.desktop", "Win+D", "显示桌面", "桌面", ManageLevel::ReadOnly),
        ("windows.explorer", "Win+E", "打开文件资源管理器", "系统应用", ManageLevel::ReadOnly),
        ("windows.run", "Win+R", "打开运行", "系统应用", ManageLevel::ReadOnly),
        ("windows.settings", "Win+I", "打开设置", "系统应用", ManageLevel::ReadOnly),
        ("windows.search", "Win+S", "打开搜索", "系统应用", ManageLevel::ReadOnly),
        ("windows.clipboard", "Win+V", "剪贴板历史", "剪贴板", ManageLevel::ReadOnly),
        ("windows.screenshot", "Win+Shift+S", "截图", "截图", ManageLevel::ReadOnly),
        ("windows.emoji", "Win+.", "表情符号面板", "输入", ManageLevel::ReadOnly),
        ("windows.input_switch", "Win+Space", "切换输入语言", "输入", ManageLevel::ReadOnly),
        ("windows.virtual_desktop_new", "Win+Ctrl+D", "新建虚拟桌面", "虚拟桌面", ManageLevel::ReadOnly),
        ("windows.virtual_desktop_left", "Win+Ctrl+Left", "切换到左侧虚拟桌面", "虚拟桌面", ManageLevel::ReadOnly),
        ("windows.virtual_desktop_right", "Win+Ctrl+Right", "切换到右侧虚拟桌面", "虚拟桌面", ManageLevel::ReadOnly),
        ("windows.snap_left", "Win+Left", "窗口贴靠左侧", "窗口管理", ManageLevel::ReadOnly),
        ("windows.snap_right", "Win+Right", "窗口贴靠右侧", "窗口管理", ManageLevel::ReadOnly),
        ("windows.quick_settings", "Win+A", "快速设置", "系统面板", ManageLevel::ReadOnly),
        ("windows.notifications", "Win+N", "通知中心", "系统面板", ManageLevel::ReadOnly),
        ("windows.widgets", "Win+W", "小组件", "系统面板", ManageLevel::ReadOnly),
        ("windows.accessibility", "Win+U", "辅助功能设置", "辅助功能", ManageLevel::ReadOnly),
    ]
    .into_iter()
    .map(|(id, display, title, category, level)| HotkeyEntry {
        id: id.to_string(),
        display: display.to_string(),
        title: title.to_string(),
        app_name: format!("Windows / {category}"),
        source_type: HotkeySourceType::WindowsSystem,
        scope: HotkeyScope::Global,
        manage_level: level,
        source_path: None,
        target: None,
        can_modify: false,
        backup_available: false,
        conflict: ConflictInfo::default(),
    })
    .collect()
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

fn can_hide_center_entry(entry: &HotkeyEntry) -> bool {
    matches!(
        entry.source_type,
        HotkeySourceType::WindowsSystem | HotkeySourceType::Manual
    )
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn validate_manual_input(input: ManualHotkeyInput) -> Result<ManualHotkeyInput, String> {
    let app_name = input.app_name.trim().to_string();
    let title = input.title.trim().to_string();
    let accelerator = input.accelerator.trim().to_string();
    let notes = input.notes.trim().to_string();
    if app_name.is_empty() {
        return Err("请输入应用名称".into());
    }
    if title.is_empty() {
        return Err("请输入功能名称".into());
    }
    let parsed = parse_accel(&accelerator)
        .ok_or_else(|| "请输入有效快捷键，如 Ctrl+Alt+K 或 Win+Shift+S".to_string())?;
    Ok(ManualHotkeyInput {
        app_name,
        title,
        accelerator: format_accel(&parsed),
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
        source_type: HotkeySourceType::Manual,
        scope: item.scope,
        manage_level: ManageLevel::DirectModify,
        source_path: None,
        target: if item.notes.is_empty() { None } else { Some(item.notes) },
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
    let hotkey = load_settings(app.clone()).map(|s| s.hotkey).unwrap_or_default();
    for (id, title, raw) in [
        ("bugzia.summon", "召唤输入框", hotkey.summon.as_str()),
        ("bugzia.note", "召唤便笺", hotkey.note.as_str()),
        ("bugzia.note_create", "直接新建便笺", hotkey.note_create.as_str()),
        ("bugzia.note_destroy", "销毁当前便笺", hotkey.note_destroy.as_str()),
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

/// 按 `NormalizedAccelerator` 分组：组内 >1 置 `is_duplicate`；组内含 Bugzia 置
/// `conflicts_with_bugzia` 并填 `conflicting_with`（同组其它 id）。
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
        let has_bugzia = idxs
            .iter()
            .any(|&i| matches!(entries[i].source_type, HotkeySourceType::Bugzia));
        let ids: Vec<String> = idxs.iter().map(|&i| entries[i].id.clone()).collect();
        for (pos, &i) in idxs.iter().enumerate() {
            entries[i].conflict.is_duplicate = true;
            entries[i].conflict.conflicts_with_bugzia = has_bugzia;
            entries[i].conflict.conflicting_with = ids
                .iter()
                .enumerate()
                .filter(|(p, _)| *p != pos)
                .map(|(_, s)| s.clone())
                .collect();
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
