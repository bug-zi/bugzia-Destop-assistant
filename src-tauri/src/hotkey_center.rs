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
use std::collections::HashMap;
use std::path::Path;
use tauri::AppHandle;

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
}

/// 归一化快捷键。`.lnk` 不支持 Win，故不建模 Win；含 Win 的组合 `parse_accel`
/// 直接返回 `None`（既不参与 `.lnk` 冲突比较，也不会被写入 `.lnk`）。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct NormalizedAccelerator {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub key: NormalizedKey,
}

/// 解析快捷键串为归一化形式。大小写不敏感，按 `+` 切分。
/// 修饰键：`ctrl`/`control`、`alt`/`opt`/`option`、`shift`；遇到
/// `win`/`super`/`meta` 返回 `None`（`.lnk` 不支持，整体放弃）。
/// 主键：`f1..f24`、`a..z`、`0..9`、`space`。空串 / 多主键 / 无法识别返回 `None`。
pub fn parse_accel(s: &str) -> Option<NormalizedAccelerator> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
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
            "win" | "super" | "meta" => return None, // .lnk 不支持 -> 整体放弃
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
    None
}

/// 展示形式：固定顺序 `Ctrl+Alt+Shift+主键`，混合大小写。
/// 例：`Ctrl+Alt+F5`、`Alt+Space`、`Alt+N`。
pub fn format_accel(a: &NormalizedAccelerator) -> String {
    let mut parts: Vec<String> = Vec::new();
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
    ShortcutLink,
    // 预留：AppConfig, SystemDefault, ProbedOccupied, BlockRule, Manual
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

// ---------------------------------------------------------------------------
// 聚合构造 + 冲突标注
// ---------------------------------------------------------------------------

/// 由 Bugzia 自身快捷键 + `.lnk` 扫描结果构造统一条目（不含冲突计算）。
fn build_entries(app: &AppHandle) -> Result<Vec<HotkeyEntry>, String> {
    let mut out: Vec<HotkeyEntry> = Vec::new();

    // Bugzia 自身：summon / note（来自 settings.json）。读失败则用默认值，不阻断扫描。
    let hotkey = load_settings(app.clone()).map(|s| s.hotkey).unwrap_or_default();
    for (id, title, raw) in [
        ("bugzia.summon", "召唤输入框", hotkey.summon.as_str()),
        ("bugzia.note", "召唤便笺", hotkey.note.as_str()),
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
