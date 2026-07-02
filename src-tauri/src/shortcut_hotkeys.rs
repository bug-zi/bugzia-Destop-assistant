//! Windows `.lnk` 快捷方式热键的读写 / 备份 / 恢复 + 路径白名单 + 单文件命令
//! （开发文档 §6.2 / §7 / §9 / §10）。
//!
//! 这是快捷键中心的第一块「可直接修改」数据源。`.lnk` 的 Hotkey 是一个 WORD：
//! 低字节 = 虚拟键码，高字节 = 修饰键标志（HOTKEYF_SHIFT=0x01 / CONTROL=0x02 /
//! ALT=0x04）。读写走 Shell COM（`IShellLinkW` + `IPersistFile`）。
//!
//! 线程模型（R1 对策）：所有 COM 操作都在独立 `std::thread` 中进行，线程入口
//! `CoInitializeEx(COINIT_APARTMENTTHREADED)`、出口 `CoUninitialize`，主线程
//! 通过 channel + `join` 阻塞取回结果——绝不在 Tauri 的 tokio worker 线程上
//! 初始化 Shell COM。扫描复用一个 ShellLink 实例多次 Load。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::hotkey_center::{
    format_accel, parse_accel, NormalizedAccelerator, NormalizedKey, ShortcutHotkeyItem,
    ShortcutLocation, ShortcutStatus,
};

// ---------------------------------------------------------------------------
// WORD <-> NormalizedAccelerator（文档 §7.2）
// ---------------------------------------------------------------------------

/// 把 `.lnk` 的 WORD 解析回归一化形式。无法识别的 VK 返回 `None`。
pub fn word_to_accel(w: u16) -> Option<NormalizedAccelerator> {
    let lo = (w & 0xFF) as u8;
    let hi = ((w >> 8) & 0xFF) as u8;
    let key = vk_to_key(lo)?;
    Some(NormalizedAccelerator {
        win: false,
        ctrl: hi & 0x02 != 0,
        alt: hi & 0x04 != 0,
        shift: hi & 0x01 != 0,
        key,
    })
}

/// 把归一化形式编码为 `.lnk` WORD。不支持的主键返回 `None`。
pub fn accel_to_word(a: &NormalizedAccelerator) -> Option<u16> {
    if a.win {
        return None;
    }
    let lo = key_to_vk(&a.key)?;
    let mut hi: u8 = 0;
    if a.shift {
        hi |= 0x01;
    }
    if a.ctrl {
        hi |= 0x02;
    }
    if a.alt {
        hi |= 0x04;
    }
    Some(((hi as u16) << 8) | lo as u16)
}

fn vk_to_key(vk: u8) -> Option<NormalizedKey> {
    match vk {
        0x20 => Some(NormalizedKey::Space),
        0x30..=0x39 => Some(NormalizedKey::Char(vk as char)), // '0'..'9'
        0x41..=0x5A => Some(NormalizedKey::Char(vk as char)), // 'A'..'Z'
        0x70..=0x87 => Some(NormalizedKey::F(vk - 0x70 + 1)), // F1..F24
        _ => None,
    }
}

fn key_to_vk(k: &NormalizedKey) -> Option<u8> {
    match k {
        NormalizedKey::Space => Some(0x20),
        NormalizedKey::Char(c) => {
            let cu = c.to_ascii_uppercase();
            if ('0'..='9').contains(&cu) || ('A'..='Z').contains(&cu) {
                Some(cu as u8)
            } else {
                None
            }
        }
        NormalizedKey::F(n) => {
            if (1..=24).contains(n) {
                Some(0x70 + (n - 1))
            } else {
                None
            }
        }
        NormalizedKey::Named(_) => None,
    }
}

// ---------------------------------------------------------------------------
// 路径白名单（文档 §9 / §10.1）——只允许 4 个根目录下的 `.lnk`
// ---------------------------------------------------------------------------

fn allowed_roots() -> Vec<(ShortcutLocation, PathBuf)> {
    let mut out: Vec<(ShortcutLocation, PathBuf)> = Vec::new();
    if let Ok(up) = std::env::var("USERPROFILE") {
        out.push((ShortcutLocation::UserDesktop, PathBuf::from(up).join("Desktop")));
    }
    let public = std::env::var("PUBLIC")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "C:\\Users\\Public".to_string());
    out.push((
        ShortcutLocation::PublicDesktop,
        PathBuf::from(&public).join("Desktop"),
    ));
    if let Ok(ad) = std::env::var("APPDATA") {
        out.push((
            ShortcutLocation::UserStartMenu,
            PathBuf::from(ad).join("Microsoft\\Windows\\Start Menu\\Programs"),
        ));
    }
    if let Ok(pd) = std::env::var("ProgramData") {
        out.push((
            ShortcutLocation::CommonStartMenu,
            PathBuf::from(pd).join("Microsoft\\Windows\\Start Menu\\Programs"),
        ));
    }
    out
}

/// 判定路径是否在允许根目录内 + 归属哪个 location。canonicalize 失败时
/// 视为不允许（R5：不 unwrap）。
fn classify_path(p: &Path) -> (ShortcutLocation, bool) {
    let canon = match p.canonicalize() {
        Ok(c) => c,
        Err(_) => return (ShortcutLocation::Other, false),
    };
    for (loc, root) in allowed_roots() {
        if let Ok(rcanon) = root.canonicalize() {
            if canon.starts_with(rcanon) {
                return (loc.clone(), true);
            }
        }
    }
    (ShortcutLocation::Other, false)
}

/// 写权限探测（R4）：以 write 模式打开（不截断、不创建），打开成功即视为可写。
fn probe_can_modify(p: &Path) -> bool {
    fs::OpenOptions::new().write(true).open(p).is_ok()
}

fn walk_lnk(dir: &Path, loc: ShortcutLocation, out: &mut Vec<(PathBuf, ShortcutLocation)>) {
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for ent in rd.flatten() {
        let p = ent.path();
        if p.is_dir() {
            walk_lnk(&p, loc.clone(), out);
        } else if p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false)
        {
            out.push((p, loc.clone()));
        }
    }
}

fn should_show_shortcut(path: &Path) -> bool {
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    name == "回收站"
        || name == "此电脑"
        || name == "recycle bin"
        || name == "this pc"
        || name.contains("kugou")
        || name.contains("酷狗")
}

// ---------------------------------------------------------------------------
// Shell COM 读写（仅 Windows）——见模块头部的线程模型说明
// ---------------------------------------------------------------------------

type LnkMeta = (Option<u16>, String, String);

#[cfg(target_os = "windows")]
fn read_all_lnk(paths: Vec<PathBuf>) -> Vec<Result<LnkMeta, String>> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
        IPersistFile, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};

    // 预先编码所有路径为宽字符（owned），线程内复用。
    let wides: Vec<Vec<u16>> = paths
        .iter()
        .map(|p| match p.to_str() {
            Some(s) => s.encode_utf16().chain(std::iter::once(0)).collect(),
            None => Vec::new(),
        })
        .collect();
    let n = paths.len();
    let (tx, rx) = std::sync::mpsc::channel::<Vec<Result<LnkMeta, String>>>();
    std::thread::spawn(move || {
        let mut out: Vec<Result<LnkMeta, String>> = Vec::with_capacity(n);
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let shell: IShellLinkW = match CoCreateInstance(&ShellLink, None, CLSCTX_ALL) {
                Ok(s) => s,
                Err(e) => {
                    let msg = format!("CoCreateInstance: {e}");
                    for _ in 0..n {
                        out.push(Err(msg.clone()));
                    }
                    CoUninitialize();
                    let _ = tx.send(out);
                    return;
                }
            };
            let persist: IPersistFile = match shell.cast() {
                Ok(p) => p,
                Err(e) => {
                    let msg = format!("cast IPersistFile: {e}");
                    for _ in 0..n {
                        out.push(Err(msg.clone()));
                    }
                    CoUninitialize();
                    let _ = tx.send(out);
                    return;
                }
            };
            for w in &wides {
                if w.is_empty() {
                    out.push(Err("path not utf-8".into()));
                    continue;
                }
                let pcw = PCWSTR::from_raw(w.as_ptr());
                if let Err(e) = persist.Load(pcw, STGM_READ) {
                    out.push(Err(format!("Load: {e}")));
                    continue;
                }
                let word: u16 = shell.GetHotkey().unwrap_or(0);
                let mut buf = [0u16; 260];
                let target = shell
                    .GetPath(&mut buf, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
                    .map(|_| widestr_to_string(&buf))
                    .unwrap_or_default();
                let mut abuf = [0u16; 1024];
                let args = shell
                    .GetArguments(&mut abuf)
                    .map(|_| widestr_to_string(&abuf))
                    .unwrap_or_default();
                out.push(Ok((if word == 0 { None } else { Some(word) }, target, args)));
            }
            CoUninitialize();
        }
        let _ = tx.send(out);
    });
    rx.recv()
        .unwrap_or_else(|_| (0..n).map(|_| Err("com thread panic".into())).collect())
}

#[cfg(not(target_os = "windows"))]
fn read_all_lnk(paths: Vec<PathBuf>) -> Vec<Result<LnkMeta, String>> {
    paths.into_iter().map(|_| Err("不支持当前系统".into())).collect()
}

/// 把单个 `.lnk` 的 Hotkey 改写为 `word`（`None` = 清空，写 0）。
#[cfg(target_os = "windows")]
fn write_lnk_hotkey(path: &Path, word: Option<u16>) -> Result<(), String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Foundation::BOOL;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
        IPersistFile, STGM_READWRITE,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    let path_str = path.to_str().ok_or("path not utf-8")?;
    let wide: Vec<u16> = path_str.encode_utf16().chain(std::iter::once(0)).collect();
    let word_v = word;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let res = (|| -> Result<(), String> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                let shell: IShellLinkW =
                    CoCreateInstance(&ShellLink, None, CLSCTX_ALL).map_err(|e| format!("CoCreateInstance: {e}"))?;
                let persist: IPersistFile =
                    shell.cast().map_err(|e| format!("cast IPersistFile: {e}"))?;
                let pcw = PCWSTR::from_raw(wide.as_ptr());
                // 先 Load 保留其它字段，再改 Hotkey，再 Save 回原路径。
                persist.Load(pcw, STGM_READWRITE).map_err(|e| format!("Load: {e}"))?;
                shell
                    .SetHotkey(word_v.unwrap_or(0))
                    .map_err(|e| format!("SetHotkey: {e}"))?;
                persist.Save(pcw, BOOL(1)).map_err(|e| format!("Save: {e}"))?;
            }
            Ok(())
        })();
        unsafe {
            CoUninitialize();
        }
        let _ = tx.send(res);
    });
    rx.recv().map_err(|e| format!("com thread: {e}"))?
}

#[cfg(not(target_os = "windows"))]
fn write_lnk_hotkey(_path: &Path, _word: Option<u16>) -> Result<(), String> {
    Err("不支持当前系统".into())
}

fn widestr_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

/// 读取单个 `.lnk` 当前 Hotkey（备份/显示用），失败返回 None。
fn read_word(path: &Path) -> Option<u16> {
    match read_all_lnk(vec![path.to_path_buf()]).get(0) {
        Some(Ok((w, _, _))) => *w,
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 备份 / 恢复（文档 §10.2 / §10.3）—— app_data_dir/shortcut-hotkey-backups
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
struct BackupEntry {
    original_path: String,
    backup_file: String,
    timestamp_ms: u64,
    prev_word: Option<u16>,
}

fn backup_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?
        .join("shortcut-hotkey-backups");
    fs::create_dir_all(&dir).map_err(|e| format!("create backup dir: {e}"))?;
    Ok(dir)
}

fn manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(backup_root(app)?.join("manifest.json"))
}

fn load_manifest(app: &AppHandle) -> Vec<BackupEntry> {
    let p = match manifest_path(app) {
        Ok(p) => p,
        Err(_) => return vec![],
    };
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
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

fn save_manifest(app: &AppHandle, entries: &[BackupEntry]) -> Result<(), String> {
    let p = manifest_path(app)?;
    let data = serde_json::to_string_pretty(entries).map_err(|e| format!("serialize: {e}"))?;
    atomic_write_json(&p, &data)
}

fn hidden_shortcuts_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join("shortcut-hotkey-hidden.json"))
}

fn normalize_hidden_path(path: &str) -> String {
    path.trim().to_lowercase()
}

fn load_hidden_shortcuts(app: &AppHandle) -> HashSet<String> {
    let p = match hidden_shortcuts_path(app) {
        Ok(p) => p,
        Err(_) => return HashSet::new(),
    };
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|s| normalize_hidden_path(&s))
        .filter(|s| !s.is_empty())
        .collect()
}

fn save_hidden_shortcuts(app: &AppHandle, hidden: &HashSet<String>) -> Result<(), String> {
    let p = hidden_shortcuts_path(app)?;
    let mut entries: Vec<String> = hidden.iter().cloned().collect();
    entries.sort();
    let data = serde_json::to_string_pretty(&entries).map_err(|e| format!("serialize: {e}"))?;
    atomic_write_json(&p, &data)
}

fn latest_backup_for(app: &AppHandle, path: &str) -> Option<BackupEntry> {
    let mut entries: Vec<BackupEntry> = load_manifest(app)
        .into_iter()
        .filter(|e| e.original_path == path)
        .collect();
    entries.sort_by_key(|e| e.timestamp_ms);
    entries.into_iter().last()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 修改/清空前用原始字节 `fs::copy` 备份（捕获修改前真实内容），并登记 manifest。
fn do_backup(app: &AppHandle, lnk_path: &Path, prev_word: Option<u16>) -> Result<(), String> {
    let root = backup_root(app)?;
    let path_str = lnk_path.to_str().ok_or("path not utf-8")?;
    let ts = now_ms();
    let backup_file = format!("{}-{ts}.lnk", sha256_hex(path_str));
    fs::copy(lnk_path, root.join(&backup_file)).map_err(|e| format!("backup copy: {e}"))?;
    let mut manifest = load_manifest(app);
    manifest.push(BackupEntry {
        original_path: path_str.to_string(),
        backup_file,
        timestamp_ms: ts,
        prev_word,
    });
    save_manifest(app, &manifest)
}

// ---------------------------------------------------------------------------
// 扫描 / 构造单项
// ---------------------------------------------------------------------------

/// 扫描全部白名单根目录的 `.lnk`，返回明细列表。非 Windows 返回空。
pub fn scan_shortcuts_internal(app: &AppHandle) -> Vec<ShortcutHotkeyItem> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        return vec![];
    }
    let mut found: Vec<(PathBuf, ShortcutLocation)> = Vec::new();
    for (loc, root) in allowed_roots() {
        walk_lnk(&root, loc, &mut found);
    }
    found.retain(|(p, _)| should_show_shortcut(p));
    let hidden = load_hidden_shortcuts(app);
    found.retain(|(p, _)| !hidden.contains(&normalize_hidden_path(&p.to_string_lossy())));
    let paths: Vec<PathBuf> = found.iter().map(|(p, _)| p.clone()).collect();
    let metas = read_all_lnk(paths);
    let backed: std::collections::HashSet<String> =
        load_manifest(app).into_iter().map(|e| e.original_path).collect();

    let mut out = Vec::with_capacity(found.len());
    for (i, (p, loc)) in found.iter().enumerate() {
        let path_str = p.to_string_lossy().to_string();
        let name = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let (word, target, args, ok) = match metas.get(i) {
            Some(Ok((w, t, a))) => (*w, t.clone(), a.clone(), true),
            _ => (None, String::new(), String::new(), false),
        };
        let hotkey = word
            .and_then(|w| word_to_accel(w))
            .map(|a| format_accel(&a))
            .unwrap_or_default();
        out.push(ShortcutHotkeyItem {
            id: path_str.clone(),
            name,
            hotkey,
            target_path: target,
            arguments: args,
            shortcut_path: path_str.clone(),
            location: loc.clone(),
            can_modify: probe_can_modify(p),
            status: if ok {
                ShortcutStatus::Ok
            } else {
                ShortcutStatus::ReadError
            },
            backup_available: backed.contains(&path_str),
        });
    }
    out
}

/// 重新读取单个 `.lnk` 构造明细（供 set/clear/restore 返回最新状态）。
fn build_item(app: &AppHandle, lnk_path: &Path) -> Result<ShortcutHotkeyItem, String> {
    let (location, allowed) = classify_path(lnk_path);
    let path_str = lnk_path
        .to_str()
        .ok_or("path not utf-8")?
        .to_string();
    let name = lnk_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let (word, target, args, ok) = match read_all_lnk(vec![lnk_path.to_path_buf()]).get(0) {
        Some(Ok((w, t, a))) => (*w, t.clone(), a.clone(), true),
        _ => (None, String::new(), String::new(), false),
    };
    let hotkey = word
        .and_then(|w| word_to_accel(w))
        .map(|a| format_accel(&a))
        .unwrap_or_default();
    let status = if !allowed {
        ShortcutStatus::OutsideWhitelist
    } else if !ok {
        ShortcutStatus::ReadError
    } else {
        ShortcutStatus::Ok
    };
    Ok(ShortcutHotkeyItem {
        id: path_str.clone(),
        name,
        hotkey,
        target_path: target,
        arguments: args,
        shortcut_path: path_str,
        location,
        can_modify: probe_can_modify(lnk_path),
        status,
        backup_available: latest_backup_for(app, lnk_path.to_str().unwrap_or("")).is_some(),
    })
}

fn reveal_in_explorer(path: &str) -> Result<bool, String> {
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{path}"))
        .spawn()
        .map(|_| true)
        .map_err(|e| format!("打开位置失败：{e}"))
}

// ---------------------------------------------------------------------------
// Tauri 命令（文档 §6.2）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn shortcut_hotkeys_scan(app: AppHandle) -> Result<Vec<ShortcutHotkeyItem>, String> {
    Ok(scan_shortcuts_internal(&app))
}

#[tauri::command]
pub fn shortcut_hotkey_set(
    app: AppHandle,
    shortcut_path: String,
    hotkey: String,
) -> Result<ShortcutHotkeyItem, String> {
    let path = PathBuf::from(&shortcut_path);
    let (_, allowed) = classify_path(&path);
    if !allowed {
        return Err("出于安全限制，Bugzia 不修改此位置".into());
    }
    let accel = parse_accel(&hotkey).ok_or_else(|| {
        "不支持的组合键，请输入类似 Ctrl+Alt+F5 的格式（不支持 Win 键）".to_string()
    })?;
    if accel.win {
        return Err("快捷方式热键不支持 Win 键".into());
    }
    if !(accel.ctrl || accel.alt || accel.shift) {
        return Err("快捷方式热键需至少包含一个修饰键（Ctrl/Alt/Shift）".into());
    }
    let word = accel_to_word(&accel).ok_or_else(|| "该组合键无法写入快捷方式".to_string())?;
    if !probe_can_modify(&path) {
        return Err("当前权限无法修改此快捷方式".into());
    }
    let prev = read_word(&path);
    do_backup(&app, &path, prev)?;
    write_lnk_hotkey(&path, Some(word))?;
    build_item(&app, &path)
}

#[tauri::command]
pub fn shortcut_hotkey_clear(app: AppHandle, shortcut_path: String) -> Result<ShortcutHotkeyItem, String> {
    let path = PathBuf::from(&shortcut_path);
    let (_, allowed) = classify_path(&path);
    if !allowed {
        return Err("出于安全限制，Bugzia 不修改此位置".into());
    }
    if !probe_can_modify(&path) {
        return Err("当前权限无法修改此快捷方式".into());
    }
    let prev = read_word(&path);
    do_backup(&app, &path, prev)?;
    write_lnk_hotkey(&path, None)?;
    build_item(&app, &path)
}

#[tauri::command]
pub fn shortcut_hotkey_restore(
    app: AppHandle,
    shortcut_path: String,
) -> Result<ShortcutHotkeyItem, String> {
    let path = PathBuf::from(&shortcut_path);
    let (_, allowed) = classify_path(&path);
    if !allowed {
        return Err("出于安全限制，Bugzia 不修改此位置".into());
    }
    let latest = latest_backup_for(&app, &shortcut_path)
        .ok_or_else(|| "没有可恢复的备份".to_string())?;
    let backup_path = backup_root(&app)?.join(&latest.backup_file);
    fs::copy(&backup_path, &path).map_err(|e| format!("恢复失败：{e}"))?;
    build_item(&app, &path)
}

#[tauri::command]
pub fn shortcut_hotkey_reveal(_app: AppHandle, shortcut_path: String) -> Result<bool, String> {
    reveal_in_explorer(&shortcut_path)
}

#[tauri::command]
pub fn shortcut_hotkey_hide(app: AppHandle, shortcut_path: String) -> Result<bool, String> {
    let normalized = normalize_hidden_path(&shortcut_path);
    if normalized.is_empty() {
        return Err("快捷方式路径为空".into());
    }
    let mut hidden = load_hidden_shortcuts(&app);
    hidden.insert(normalized);
    save_hidden_shortcuts(&app, &hidden)?;
    Ok(true)
}

#[tauri::command]
pub fn shortcut_hotkey_hidden_list(app: AppHandle) -> Result<Vec<ShortcutHotkeyItem>, String> {
    let mut paths: Vec<String> = load_hidden_shortcuts(&app).into_iter().collect();
    paths.sort();
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        out.push(build_item(&app, &PathBuf::from(path))?);
    }
    Ok(out)
}

#[tauri::command]
pub fn shortcut_hotkey_unhide(app: AppHandle, shortcut_path: String) -> Result<bool, String> {
    let normalized = normalize_hidden_path(&shortcut_path);
    if normalized.is_empty() {
        return Err("快捷方式路径为空".into());
    }
    let mut hidden = load_hidden_shortcuts(&app);
    let removed = hidden.remove(&normalized);
    save_hidden_shortcuts(&app, &hidden)?;
    Ok(removed)
}
