# 桌面歌词显示功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Bugzia 桌面助手新增桌面歌词悬浮窗，在 Windows 播放酷狗/网易云等音乐时显示逐行同步歌词，支持位置记忆/颜色/字体/透明度/置顶/锁定穿透/单双行/翻译等自定义。

**Architecture:** Rust 后端（新增 `lyrics.rs` 模块）每 500ms 轮询 Windows SMTC 取媒体信息（歌名/艺术家/状态/进度），歌曲变化时调网易云非官方接口取 LRC + 翻译，通过 Tauri 事件 `lyrics://update` 推给新增的 `lyrics` 悬浮窗（复用现有 `result` 窗口模式：单 SPA 按 label 路由 + 运行时动态创建 + 无边框透明跳过任务栏 + 位置记忆）。

**Tech Stack:** Tauri v2 / Rust（`windows` crate WinRT SMTC、`reqwest` HTTP、`regex` LRC 解析）/ React 19 + TypeScript / Vite

**前置约定（执行者必读）：**
- 代码注释用英文（贴合现有 `settings.rs`/`lib.rs`/`CommandCard.tsx` 风格），UI 可见文案用中文
- 字段命名一律 snake_case，Rust serde JSON key 与 TS 接口字段完全一致
- 本机 Rust 不在 PATH，所有 cargo/tauri 命令前先：`export PATH="$HOME/.cargo/bin:$PATH"`
- 不破坏现有契约：不改动 Tauri 命令名/参数、`AppSettings` 旧字段；新功能全部增量、向后兼容（旧 settings.json 用 `#[serde(default)]` 兜底）
- 设计依据：`docs/superpowers/specs/2026-06-19-desktop-lyrics-design.md`（commit 9776912）

---

## File Structure

**新增：**
| 文件 | 责任 |
|---|---|
| `src-tauri/src/lyrics.rs` | SMTC 读取 + 网易云歌词获取 + LRC 解析 + 轮询任务 + 事件推送 + 窗口控制命令 |
| `src/components/LyricsWindow.tsx` + `.css` | lyrics 窗口根组件：监听事件、进度推进、渲染、手柄交互 |
| `src/features/lyrics/lyricsWindow.ts` | lyrics 窗口生命周期（get-or-create/show/hide/几何回调），仿 `resultWindow.ts` |

**修改（增量、向后兼容）：**
| 文件 | 改动 |
|---|---|
| `src-tauri/Cargo.toml` | 加 `windows`（cfg windows）、`regex` 依赖 |
| `src-tauri/src/settings.rs` | 加 `LyricsSettings` struct + Default + `AppSettings.lyrics` 字段 |
| `src-tauri/src/lib.rs` | `mod lyrics;` + 注册命令 + 托盘菜单项 + setup 自动恢复 |
| `src-tauri/capabilities/lyrics.json` | 新建 lyrics 窗口权限 |
| `src/App.tsx` | label 路由加 `lyrics` |
| `src/features/settings/settingsTypes.ts` | 加 `LyricsSettings` + `DEFAULT_LYRICS` + `SettingsPatch.lyrics` |
| `src/features/settings/settingsStore.ts` | `loadSettings` merge 加 `lyrics` |
| `src/components/SettingsPanel.tsx` | 新增"桌面歌词"分区 |
| `src/components/CommandCard.tsx` | 增量加 lyrics 几何记忆接线（仿 onResultGeometryChange） |

---

## Task 1: windows crate 依赖 + SMTC 探针命令

**目标（阶段 0 去风险）：** 验证 Windows SMTC 能读到酷狗/网易云当前播放的媒体信息。这是整个方案的地基，必须先打通。

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/lyrics.rs`

- [ ] **Step 1: 加 Cargo 依赖**

在 `src-tauri/Cargo.toml` 的 `[dependencies]` 末尾追加（`windows` 用 target gate，非 Windows 不拉）：

```toml
# Windows SMTC (System Media Transport Controls) for desktop lyrics media info.
# Media_Control = GlobalSystemMediaTransportControlsSessionManager; Foundation = IAsyncOperation.
[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = ["Media_Control", "Foundation", "Foundation_Collections"] }

[dependencies]
# LRC timestamp parsing for lyrics.
regex = "1"
```

注意：`regex` 加到已有 `[dependencies]` 下，不要新建第二个 `[dependencies]`。`[target.'cfg(windows)'.dependencies]` 是独立段。

- [ ] **Step 2: 创建 lyrics.rs 探针骨架**

创建 `src-tauri/src/lyrics.rs`：

```rust
//! Desktop lyrics: read now-playing media via Windows SMTC, fetch lyrics from
//! NetEase Cloud Music, parse LRC, poll + push updates to the lyrics window.
//!
//! Phase-0 probe: `lyrics_probe_media` prints the current SMTC session so we can
//! verify Kugou / NetEase register to SMTC before building any UI.

use serde::Serialize;
use tauri::AppHandle;

/// Snapshot of the currently-playing media, read from SMTC. `None` when no app
/// is playing (or SMTC is unavailable).
#[derive(Serialize, Clone, Debug, Default)]
pub struct MediaSnapshot {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// "playing" | "paused" | "stopped" | "unknown"
    pub state: String,
    pub position_ms: u64,
    pub duration_ms: u64,
}

/// Read the current SMTC session's media. Windows-only; stub on others so the
/// crate compiles cross-platform (the feature is Windows-exclusive regardless).
#[cfg(target_os = "windows")]
fn read_current_media() -> Option<MediaSnapshot> {
    use windows::core::Interface;
    use windows::Foundation::IAsyncOperation;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    };

    // RequestAsync() returns an IAsyncOperation; .get() blocks until resolved.
    let manager: GlobalSystemMediaTransportControlsSessionManager =
        GlobalSystemMediaTransportControlsSessionManager::RequestAsync().ok()?.get().ok()?;
    let session: GlobalSystemMediaTransportControlsSession = manager.GetCurrentSession().ok()?;

    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
    let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
    let album = props.AlbumTitle().map(|s| s.to_string()).unwrap_or_default();

    // PlaybackStatus is an enum (Closed / Opened / Changing / Stopped / Playing / Paused).
    let status = session.GetPlaybackInfo().ok();
    let state = match status.and_then(|i| i.PlaybackStatus().ok()) {
        Some(s) => format!("{:?}", s).to_lowercase(),
        None => "unknown".to_string(),
    };

    let timeline = session.GetTimelineProperties().ok();
    let (position_ms, duration_ms) = match timeline {
        Some(t) => (
            t.Position().map(|ts| (ts.TotalSeconds() * 1000.0) as u64).unwrap_or(0),
            t.EndTime().map(|ts| (ts.TotalSeconds() * 1000.0) as u64).unwrap_or(0),
        ),
        None => (0, 0),
    };

    // No active media (title empty) -> treat as "nothing playing".
    if title.is_empty() {
        return None;
    }
    let _ = IAsyncOperation::<()>::none; // keep Foundation import meaningful if unused
    Some(MediaSnapshot { title, artist, album, state, position_ms, duration_ms })
}

#[cfg(not(target_os = "windows"))]
fn read_current_media() -> Option<MediaSnapshot> {
    None
}

/// Phase-0 probe: log the current SMTC media so we can verify the data path.
/// Returns the snapshot (or None) for the caller to inspect.
#[tauri::command]
pub fn lyrics_probe_media() -> Option<MediaSnapshot> {
    let snap = read_current_media();
    match &snap {
        Some(s) => println!("[lyrics-probe] {} - {} [{}] {}/{}ms", s.title, s.artist, s.state, s.position_ms, s.duration_ms),
        None => println!("[lyrics-probe] no active media session"),
    }
    snap
}
```

- [ ] **Step 3: 注册模块和命令**

在 `src-tauri/src/lib.rs` 顶部模块声明区（第 1-4 行附近）加：

```rust
mod lyrics;
```

在 `lib.rs` 的 `invoke_handler!(...)` 宏里（第 122-139 行）加一行（紧跟 `weather::weather,` 之后）：

```rust
            lyrics::lyrics_probe_media,
```

- [ ] **Step 4: 编译验证**

Run（注意先加 PATH）：
```bash
export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo check
```
Expected: 编译通过。若 `windows` crate 报某个 feature 缺失（如 `TimeSpan` 相关），按报错在 `features = [...]` 里补（常见可能要 `"Globalization"`）。若 `PlaybackStatus` 的 Debug 格式不符，改用 `as i32` 转 string。

- [ ] **Step 5: 运行验证（关键去风险）**

Run：
```bash
export PATH="$HOME/.cargo/bin:$PATH" && pnpm tauri dev
```
打开酷狗或网易云播放任意一首歌，在主窗口输入栏触发任意会调用后端的操作（如输入天气命令），或临时在 `setup` 里加 `let _ = lyrics::lyrics_probe_media();` 调一次。观察终端日志。

Expected: 终端打印类似 `[lyrics-probe] 歌名 - 歌手 [playing] 12345/240000ms`。**若两个播放器都能读到，阶段 0 第一关通过；若读不到，需排查 SMTC 注册情况（见 Troubleshooting）。**

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lyrics.rs src-tauri/src/lib.rs
git commit -m "feat(lyrics): add SMTC media probe (phase 0)"
```

**Troubleshooting（读不到媒体时）：**
- 确认播放器正在**前台播放过**（SMTC 会话在首次播放后才注册）
- 确认系统音量合成器里能看到该播放器的会话
- 部分 UWP/浏览器播放会注册到不同 session，`GetCurrentSession` 取的是"最近活跃的"；若需要可改 `GetSessions()` 枚举全部

---

## Task 2: 网易云歌词探针命令

**目标（阶段 0 去风险第二关）：** 验证网易云非官方接口能搜到歌、能拿到 LRC + 翻译。

**Files:**
- Modify: `src-tauri/src/lyrics.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 加 fetch + parse 探针函数**

在 `lyrics.rs` 末尾追加（`regex` + `reqwest` 已在 Cargo 依赖）：

```rust
use serde::Deserialize;

#[derive(Serialize, Clone, Debug)]
pub struct LyricsLine {
    pub ms: u64,
    pub text: String,
    pub tr: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Lyrics {
    pub song_id: String,
    pub lines: Vec<LyricsLine>,
    pub source: String,
}

#[derive(Deserialize)]
struct NeSearchResp {
    result: Option<NeSearchResult>,
}
#[derive(Deserialize)]
struct NeSearchResult {
    songs: Option<Vec<NeSong>>,
}
#[derive(Deserialize)]
struct NeSong {
    id: u64,
    name: String,
}

#[derive(Deserialize)]
struct NeLyricResp {
    lrc: Option<NeLyricBody>,
    tlyric: Option<NeLyricBody>,
}
#[derive(Deserialize)]
struct NeLyricBody {
    lyric: Option<String>,
}

/// Phase-0 probe: search NetEase by title+artist, fetch LRC + translation, parse
/// and print. Verifies the whole lyric pipeline before wiring it into the poller.
async fn fetch_lyrics_probe(title: &str, artist: &str) -> Option<Lyrics> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (bugzia desktop lyrics probe)")
        .build()
        .ok()?;
    // 1) search -> first matching song id
    let search_url = format!(
        "https://music.163.com/api/search/get?s={}&type=1&limit=5",
        urlencode(&format!("{} {}", title, artist))
    );
    let resp: NeSearchResp = client.get(&search_url).send().await.ok()?.json().await.ok()?;
    let song = resp.result?.songs?.into_iter().next()?;
    // 2) lyric (lv=1 original, tv=-1 translation)
    let lyric_url = format!(
        "https://music.163.com/api/song/lyric?id={}&lv=1&kv=1&tv=-1",
        song.id
    );
    let lresp: NeLyricResp = client.get(&lyric_url).send().await.ok()?.json().await.ok()?;
    let lrc = lresp.lrc.and_then(|b| b.lyric).unwrap_or_default();
    let tlyric = lresp.tlyric.and_then(|b| b.lyric).unwrap_or_default();
    let lines = parse_lrc(&lrc, &tlyric);
    Some(Lyrics { song_id: song.id.to_string(), lines, source: "网易云音乐".to_string() })
}

fn urlencode(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' {
                c.to_string()
            } else {
                format!("%{:02X}", c as u32)
            }
        })
        .collect()
}

/// Parse "[mm:ss.xx]text" lines (possibly multiple timestamps per line) into
/// time-sorted LyricsLine[]. Translation lines are matched to originals by the
/// nearest timestamp (NetEase tlyric timestamps roughly align to lrc).
pub fn parse_lrc(lrc: &str, tlyric: &str) -> Vec<LyricsLine> {
    let re = regex::Regex::new(r"\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]").unwrap();
    let mut lines: Vec<LyricsLine> = Vec::new();
    for raw in lrc.lines() {
        // collect all leading timestamps on this line, the remainder is the text
        let mut text_start = 0;
        let mut times: Vec<u64> = Vec::new();
        while let Some(m) = re.find_at(raw, text_start) {
            if m.start() != text_start {
                break; // timestamp must be at the current scan position
            }
            let caps = re.captures_at(raw, text_start).unwrap();
            let min: u64 = caps[1].parse().unwrap_or(0);
            let sec: u64 = caps[2].parse().unwrap_or(0);
            let frac: u64 = caps.get(3).map(|m| {
                let s = m.as_str();
                let base = 10u64.pow(s.len() as u32);
                s.parse::<u64>().unwrap_or(0) * 1000 / base
            }).unwrap_or(0);
            times.push(min * 60_000 + sec * 1000 + frac);
            text_start = m.end();
        }
        if times.is_empty() {
            continue;
        }
        let text = raw[text_start..].trim().to_string();
        for ms in times {
            lines.push(LyricsLine { ms, text: text.clone(), tr: String::new() });
        }
    }
    lines.sort_by_key(|l| l.ms);

    // attach translations: parse tlyric, for each original find nearest ts
    let mut tr: Vec<(u64, String)> = Vec::new();
    for raw in tlyric.lines() {
        let mut text_start = 0;
        if let Some(m) = re.find_at(raw, 0) {
            if m.start() == 0 {
                let caps = re.captures_at(raw, 0).unwrap();
                let min: u64 = caps[1].parse().unwrap_or(0);
                let sec: u64 = caps[2].parse().unwrap_or(0);
                let frac: u64 = caps.get(3).map(|m| {
                    let s = m.as_str();
                    let base = 10u64.pow(s.len() as u32);
                    s.parse::<u64>().unwrap_or(0) * 1000 / base
                }).unwrap_or(0);
                text_start = m.end();
                tr.push((min * 60_000 + sec * 1000 + frac, raw[text_start..].trim().to_string()));
            }
        }
    }
    for line in &mut lines {
        if let Some(best) = tr.iter().min_by_key(|(t, _)| (*t as i64 - line.ms as i64).abs()) {
            // only attach if within 1.5s (avoid wildly misaligned translations)
            if (best.0 as i64 - line.ms as i64).unsigned_abs() <= 1500 {
                line.tr = best.1.clone();
            }
        }
    }
    lines
}

#[tauri::command]
async fn lyrics_probe_lyrics(title: String, artist: String) -> Option<Lyrics> {
    let lyrics = fetch_lyrics_probe(&title, &artist).await;
    match &lyrics {
        Some(l) => println!("[lyrics-probe] {} lines from {} (song {})", l.lines.len(), l.source, l.song_id),
        None => println!("[lyrics-probe] no lyrics for {} - {}", title, artist),
    }
    lyrics
}
```

- [ ] **Step 2: 注册命令**

`lib.rs` 的 `invoke_handler!` 加：
```rust
            lyrics::lyrics_probe_lyrics,
```

- [ ] **Step 3: 编译**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo check
```
Expected: 通过。

- [ ] **Step 4: 运行验证（关键去风险）**

临时手段验证：在 `lib.rs` 的 `setup(|app| {...})` 里临时加一段（验证后删除）：
```rust
tauri::async_runtime::spawn(async move {
    let _ = lyrics::fetch_lyrics_probe("晴天", "周杰伦").await;
});
```
Run `pnpm tauri dev`，观察终端。
Expected: 打印 `[lyrics-probe] N lines from 网易云音乐 (song xxx)`，N > 0。

**若拿不到：** 检查网络/代理；网易云接口偶尔限流，换首歌重试；确认 UA header 已带（上面已加）。

- [ ] **Step 5: 删除 setup 里的临时代码，Commit**

```bash
git add src-tauri/src/lyrics.rs src-tauri/src/lib.rs
git commit -m "feat(lyrics): add NetEase lyric fetch + LRC parser probe (phase 0)"
```

---

## Task 3: parse_lrc 单元测试

**目标：** 给 LRC 解析加 Rust 内置单元测试，保证多时间戳行、翻译对齐、边界情况正确。这是少数能纯函数测试的部分。

**Files:**
- Modify: `src-tauri/src/lyrics.rs`

- [ ] **Step 1: 加测试模块**

在 `lyrics.rs` 末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_timestamp() {
        let lrc = "[00:01.20]hello\n[00:03.50]world";
        let lines = parse_lrc(lrc, "");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].ms, 1200);
        assert_eq!(lines[0].text, "hello");
        assert_eq!(lines[1].ms, 3500);
        assert_eq!(lines[1].text, "world");
    }

    #[test]
    fn parses_multiple_timestamps_per_line() {
        // [00:01.00][00:05.00]dup  -> two lines with same text
        let lrc = "[00:01.00][00:05.00]dup";
        let lines = parse_lrc(lrc, "");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], LyricsLine { ms: 1000, text: "dup".into(), tr: "".into() });
        assert_eq!(lines[1], LyricsLine { ms: 5000, text: "dup".into(), tr: "".into() });
    }

    #[test]
    fn handles_millisecond_fraction_of_varying_precision() {
        // .5 = 500ms, .50 = 500ms, .12 = 120ms
        let lines = parse_lrc("[00:00.5]a\n[00:01.50]b\n[00:02.12]c", "");
        assert_eq!(lines[0].ms, 500);
        assert_eq!(lines[1].ms, 1500);
        assert_eq!(lines[2].ms, 2120);
    }

    #[test]
    fn attaches_translation_within_tolerance() {
        let lrc = "[00:02.00]hello";
        let tlyric = "[00:02.10]你好";
        let lines = parse_lrc(lrc, tlyric);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].tr, "你好");
    }

    #[test]
    fn skips_misaligned_translation() {
        let lrc = "[00:02.00]hello";
        let tlyric = "[00:10.00]你好"; // 8s off -> dropped
        let lines = parse_lrc(lrc, tlyric);
        assert_eq!(lines[0].tr, "");
    }

    #[test]
    fn empty_input_yields_empty() {
        assert!(parse_lrc("", "").is_empty());
    }
}
```

- [ ] **Step 2: 运行测试**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test parse_lrc -- --nocapture
```
Expected: `6 passed`。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lyrics.rs
git commit -m "test(lyrics): unit-test LRC parser + translation alignment"
```

---

## Task 4: LyricsSettings 设置结构（Rust + TS 双侧）

**目标：** 把桌面歌词的所有设置项纳入现有 settings 模型，向后兼容（老配置自动补默认）。

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src/features/settings/settingsTypes.ts`
- Modify: `src/features/settings/settingsStore.ts`

- [ ] **Step 1: Rust 侧加 LyricsSettings**

在 `src-tauri/src/settings.rs` 的 `SystemSettings` 定义之后、`AppSettings` 之前，加：

```rust
/// Desktop-lyrics settings (the lyrics overlay window). Manual `Default` +
/// `#[serde(default)]` on the AppSettings field keep a legacy settings.json
/// (which lacks this section) loading instead of wiping it. Window geometry is
/// LOGICAL px; x/y = -1 sentinel = "never placed by user".
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LyricsSettings {
    pub enabled: bool,
    #[serde(default = "default_lyrics_pos")]
    pub x: i32,
    #[serde(default = "default_lyrics_pos")]
    pub y: i32,
    #[serde(default = "default_lyrics_w")]
    pub w: u32,
    #[serde(default)]
    pub font_family: String,
    #[serde(default = "default_lyrics_font_size")]
    pub font_size: u32,
    #[serde(default = "default_true")]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    pub played_r: u8,
    pub played_g: u8,
    pub played_b: u8,
    pub unplayed_r: u8,
    pub unplayed_g: u8,
    pub unplayed_b: u8,
    #[serde(default = "default_lyrics_opacity")]
    pub opacity: f32,
    #[serde(default = "default_true")]
    pub always_on_top: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(default = "default_lyrics_line_count")]
    pub line_count: u32,
    #[serde(default = "default_true")]
    pub show_translation: bool,
}

fn default_lyrics_pos() -> i32 { -1 }
fn default_lyrics_w() -> u32 { 600 }
fn default_lyrics_font_size() -> u32 { 28 }
fn default_lyrics_opacity() -> f32 { 1.0 }
fn default_lyrics_line_count() -> u32 { 1 }
fn default_true() -> bool { true }

impl Default for LyricsSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            x: default_lyrics_pos(),
            y: default_lyrics_pos(),
            w: default_lyrics_w(),
            font_family: String::new(),
            font_size: default_lyrics_font_size(),
            bold: true,
            italic: false,
            played_r: 0,
            played_g: 196,
            played_b: 255,
            unplayed_r: 220,
            unplayed_g: 220,
            unplayed_b: 220,
            opacity: default_lyrics_opacity(),
            always_on_top: true,
            locked: false,
            line_count: default_lyrics_line_count(),
            show_translation: true,
        }
    }
}
```

然后修改 `AppSettings` struct（第 249-263 行），加 lyrics 字段：

```rust
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub result: ResultAppearanceSettings,
    #[serde(default)]
    pub window: WindowSettings,
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default)]
    pub search: SearchSettings,
    #[serde(default)]
    pub system: SystemSettings,
    #[serde(default)]
    pub lyrics: LyricsSettings,
}
```

- [ ] **Step 2: TS 侧 mirror**

在 `src/features/settings/settingsTypes.ts` 的 `SystemSettings` 之后加：

```ts
export interface LyricsSettings {
  enabled: boolean;
  /** lyrics window X, LOGICAL px. -1 = never placed. */
  x: number;
  /** lyrics window Y, LOGICAL px. -1 = never placed. */
  y: number;
  /** lyrics window width, LOGICAL px. */
  w: number;
  /** font family; "" = system default */
  font_family: string;
  /** font size in px */
  font_size: number;
  bold: boolean;
  italic: boolean;
  played_r: number;
  played_g: number;
  played_b: number;
  unplayed_r: number;
  unplayed_g: number;
  unplayed_b: number;
  /** 0..1 window (lyrics text) opacity */
  opacity: number;
  always_on_top: boolean;
  /** locked = position fixed + mouse click-through */
  locked: boolean;
  /** 1 = current line only, 2 = current + next */
  line_count: number;
  /** show translation under each original line (NetEase tlyric) */
  show_translation: boolean;
}

export const DEFAULT_LYRICS: LyricsSettings = {
  enabled: false,
  x: -1,
  y: -1,
  w: 600,
  font_family: "",
  font_size: 28,
  bold: true,
  italic: false,
  played_r: 0,
  played_g: 196,
  played_b: 255,
  unplayed_r: 220,
  unplayed_g: 220,
  unplayed_b: 220,
  opacity: 1.0,
  always_on_top: true,
  locked: false,
  line_count: 1,
  show_translation: true,
};
```

`AppSettings` interface（第 95-102 行）加 `lyrics`：
```ts
export interface AppSettings {
  appearance: AppearanceSettings;
  result: ResultAppearanceSettings;
  window: WindowSettings;
  ai: AiSettings;
  search: SearchSettings;
  system: SystemSettings;
  lyrics: LyricsSettings;
}
```

`DEFAULT_SETTINGS`（第 160-167 行）加：
```ts
  lyrics: DEFAULT_LYRICS,
```

`SettingsPatch`（第 175-181 行）加 `lyrics`：
```ts
export interface SettingsPatch {
  appearance: AppearanceSettings;
  result: ResultAppearanceSettings;
  ai: AiSettings;
  search: SearchSettings;
  windowLocked: boolean;
  lyrics: LyricsSettings;
}
```

- [ ] **Step 3: settingsStore merge**

`src/features/settings/settingsStore.ts` 的 `loadSettings` merge 对象（第 9-16 行）加：
```ts
      lyrics: { ...DEFAULT_SETTINGS.lyrics, ...s.lyrics },
```
并确保 import 含 `DEFAULT_SETTINGS`（已有）。

- [ ] **Step 4: 双侧编译**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo check
cd .. && pnpm exec tsc --noEmit
```
Expected: 双侧 0 错误。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/settings.rs src/features/settings/settingsTypes.ts src/features/settings/settingsStore.ts
git commit -m "feat(lyrics): add LyricsSettings to AppSettings (Rust + TS)"
```

---

## Task 5: 后端轮询任务 + 事件推送

**目标：** 把 Task 1/2 的探针组合成正式的轮询循环，通过 `lyrics://update` 事件把媒体 + 歌词推给前端。

**Files:**
- Modify: `src-tauri/src/lyrics.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 加状态 + 轮询循环 + 正式 fetch_lyrics**

在 `lyrics.rs` 把探针 `fetch_lyrics_probe` 重命名为 `fetch_lyrics`（去掉 `_probe` 后缀，逻辑不变），并加状态与轮询：

```rust
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri::async_runtime::{self, JoinHandle};

pub struct LyricsState {
    current_song_key: Mutex<Option<String>>, // "title\u{0}artist" for change detection
    poll_handle: Mutex<Option<JoinHandle<()>>>,
}

impl Default for LyricsState {
    fn default() -> Self {
        Self { current_song_key: Mutex::new(None), poll_handle: Mutex::new(None) }
    }
}

#[derive(Serialize, Clone)]
struct LyricsUpdate<'a> {
    song_id: String,
    title: String,
    artist: String,
    state: String,
    position_ms: u64,
    duration_ms: u64,
    lyrics_status: Option<&'a str>,
    lyrics: Option<&'a Lyrics>,
}

/// The poll loop: read SMTC every 500ms; on song change fetch lyrics and emit a
/// full update; otherwise emit position-only. Runs in a tokio task; the SMTC
/// read is a blocking WinRT call so it is wrapped in spawn_blocking.
async fn poll_loop(app: AppHandle) {
    loop {
        async_runtime::sleep(Duration::from_millis(500)).await;
        let snap = async_runtime::spawn_blocking(read_current_media).await.ok().flatten();
        let Some(snap) = snap else {
            // nothing playing: clear song key so next play re-fetches lyrics
            if let Ok(mut k) = app.state::<LyricsState>().current_song_key.lock() {
                *k = None;
            }
            continue;
        };
        let key = format!("{}\u{0}{}", snap.title, snap.artist);
        let state = app.state::<LyricsState>();
        let changed = {
            let mut k = state.current_song_key.lock().unwrap();
            let was = k.clone();
            *k = Some(key.clone());
            was.as_deref() != Some(key.as_str())
        };

        let mut update = LyricsUpdate {
            song_id: String::new(),
            title: snap.title.clone(),
            artist: snap.artist.clone(),
            state: snap.state.clone(),
            position_ms: snap.position_ms,
            duration_ms: snap.duration_ms,
            lyrics_status: None,
            lyrics: None,
        };

        if changed {
            // fetch off the poll thread (async HTTP); cache by song key
            match fetch_lyrics(&snap.title, &snap.artist).await {
                Some(l) => {
                    update.song_id = l.song_id.clone();
                    update.lyrics_status = Some("ok");
                    update.lyrics = Some(&l); // borrow fails across await? -> see note
                }
                None => {
                    update.lyrics_status = Some("not_found");
                }
            }
            // NOTE: l must outlive update; if borrow-checker complains, clone l
            // into the LyricsState cache and reference it. (See Step 1b.)
        }

        let _ = app.emit("lyrics://update", &update);
    }
}
```

**Step 1b（生命周期修正）：** 上面 `update.lyrics = Some(&l)` 借用 `l` 在 `emit` 后释放是合法的（`l` 活到函数结束），但若 borrow checker 报错，改为把 `lyrics` 字段改成 `Option<Lyrics>`（owned，clone 一份）。即把 `LyricsUpdate` 的 `lyrics: Option<Lyrics>`（owned）并在 fetch 成功时 `update.lyrics = Some(l.clone())`。**采用 owned 版本**——把 struct 定义改成 `lyrics: Option<Lyrics>` 并去掉 `&'a` 生命周期，fetch 分支 `update.lyrics = Some(l);` 直接 move（l 不再后续使用）。`lyrics_status` 同理用 `Option<&'static str>`。

最终 `LyricsUpdate` 应为（owned，无生命周期）：

```rust
#[derive(Serialize, Clone)]
struct LyricsUpdate {
    song_id: String,
    title: String,
    artist: String,
    state: String,
    position_ms: u64,
    duration_ms: u64,
    lyrics_status: Option<&'static str>,
    lyrics: Option<Lyrics>,
}
```

fetch 成功分支：
```rust
            match fetch_lyrics(&snap.title, &snap.artist).await {
                Some(l) => {
                    update.song_id = l.song_id.clone();
                    update.lyrics_status = Some("ok");
                    update.lyrics = Some(l);
                }
                None => update.lyrics_status = Some("not_found"),
            }
```

- [ ] **Step 2: 注册 state + 启停命令**

`lyrics.rs` 末尾加启停命令：

```rust
/// Start the SMTC poll loop. Idempotent: no-op if already running.
#[tauri::command]
pub fn lyrics_start_polling(app: AppHandle) {
    let state = app.state::<LyricsState>();
    let mut handle = state.poll_handle.lock().unwrap();
    if handle.is_some() {
        return;
    }
    let app2 = app.clone();
    let h = async_runtime::spawn(async move { poll_loop(app2).await; });
    *handle = Some(h);
}

/// Stop the poll loop (on disable). Idempotent.
#[tauri::command]
pub fn lyrics_stop_polling(app: AppHandle) {
    let state = app.state::<LyricsState>();
    if let Some(h) = state.poll_handle.lock().unwrap().take() {
        h.abort();
    }
}
```

- [ ] **Step 3: lib.rs 注册**

`lib.rs` 的 `tauri::Builder` 链（第 116 行 `.manage(ai::ChatState::default())` 之后）加：
```rust
        .manage(lyrics::LyricsState::default())
```

`invoke_handler!` 加：
```rust
            lyrics::lyrics_start_polling,
            lyrics::lyrics_stop_polling,
```

（保留 Task 1/2 的 probe 命令注册，或此时移除 probe——建议保留到 Task 11 验证完再清理。）

- [ ] **Step 4: 编译**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo check
```
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lyrics.rs src-tauri/src/lib.rs
git commit -m "feat(lyrics): poll SMTC + emit lyrics://update events"
```

---

## Task 6: lyrics 窗口权限 + 生命周期

**目标：** 新建 lyrics 窗口的 capability + 前端窗口生命周期管理（仿 `resultWindow.ts`）。

**Files:**
- Create: `src-tauri/capabilities/lyrics.json`
- Create: `src/features/lyrics/lyricsWindow.ts`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: capabilities**

创建 `src-tauri/capabilities/lyrics.json`（仿 `result.json`）：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "lyrics",
  "description": "Capability for the desktop lyrics overlay window",
  "windows": ["lyrics"],
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-hide",
    "core:window:allow-show",
    "core:window:allow-set-focus",
    "core:window:allow-start-dragging",
    "core:event:allow-listen",
    "core:event:default"
  ]
}
```

- [ ] **Step 2: lyricsWindow.ts 生命周期**

创建 `src/features/lyrics/lyricsWindow.ts`（仿 `resultWindow.ts`，简化：歌词窗只记 x/y/w，无 h）：

```ts
/**
 * Desktop-lyrics overlay window lifecycle — MUST run in the MAIN window context
 * (main is the sole settings.json writer, and the geometry listeners are ACL-
 * checked against the caller = main). Mirrors resultWindow.ts but the overlay
 * only persists x/y/w (height is fixed by content).
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";

const LABEL = "lyrics";
const DEFAULT_W = 600;
const DEFAULT_H = 96;

export interface LyricsGeom {
  x: number;
  y: number;
  w: number;
}
export type LyricsGeomPatch = Partial<LyricsGeom>;

let geomCb: ((patch: LyricsGeomPatch) => void) | null = null;
let geomAttached = false;
let suppressGeomPersist = false;

export function onLyricsGeometryChange(cb: (patch: LyricsGeomPatch) => void): void {
  geomCb = cb;
}

function attachGeometryIfNeeded(win: WebviewWindow): void {
  if (geomAttached) return;
  geomAttached = true;
  win.onResized(async ({ payload }) => {
    if (suppressGeomPersist || !geomCb) return;
    try {
      const sf = await win.scaleFactor();
      geomCb({ w: Math.round(payload.width / sf) });
    } catch {
      geomAttached = false;
    }
  }).catch(() => { geomAttached = false; });
  win.onMoved(async ({ payload }) => {
    if (suppressGeomPersist || !geomCb) return;
    try {
      const sf = await win.scaleFactor();
      geomCb({ x: Math.round(payload.x / sf), y: Math.round(payload.y / sf) });
    } catch {
      geomAttached = false;
    }
  }).catch(() => { geomAttached = false; });
}

export async function ensureLyricsWindow(): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) {
    attachGeometryIfNeeded(existing);
    return existing;
  }
  const win = new WebviewWindow(LABEL, {
    title: "Bugzia 歌词",
    width: DEFAULT_W,
    height: DEFAULT_H,
    resizable: true,
    decorations: false,
    transparent: true,
    shadow: false,
    skipTaskbar: true,
    visible: false,
  });
  await new Promise<void>((resolve, reject) => {
    win.once("tauri://created", () => resolve());
    win.once("tauri://error", (e) => reject(new Error("lyrics window creation failed: " + String(e))));
  });
  attachGeometryIfNeeded(win);
  return win;
}

/** Default placement: horizontally centered, lower-third of the screen. */
async function defaultPlacement(): Promise<void> {
  const main = getCurrentWindow();
  const lyrics = (await WebviewWindow.getByLabel(LABEL)) ?? (await ensureLyricsWindow());
  const sf = await main.scaleFactor();
  const { currentMonitor } = await import("@tauri-apps/api/window");
  const mon = await currentMonitor();
  const waW = mon ? mon.size.width / sf : DEFAULT_W;
  const waH = mon ? mon.size.height / sf : 800;
  const w = DEFAULT_W;
  const x = Math.round((waW - w) / 2);
  const y = Math.round(waH * 0.7);
  suppressGeomPersist = true;
  try {
    await lyrics.setPosition(new LogicalPosition(x, y));
    await lyrics.setSize(new LogicalSize(w, DEFAULT_H));
  } finally {
    setTimeout(() => { suppressGeomPersist = false; }, 60);
  }
}

export async function showLyricsWindow(saved?: LyricsGeom, opts?: { alwaysOnTop?: boolean }): Promise<void> {
  const lyrics = await ensureLyricsWindow();
  if (opts?.alwaysOnTop !== undefined) {
    await lyrics.setAlwaysOnTop(opts.alwaysOnTop).catch(() => {});
  }
  if (saved && saved.x >= 0 && saved.y >= 0) {
    suppressGeomPersist = true;
    try {
      await lyrics.setPosition(new LogicalPosition(saved.x, saved.y));
      if (saved.w) await lyrics.setSize(new LogicalSize(Math.max(200, saved.w), DEFAULT_H));
    } finally {
      setTimeout(() => { suppressGeomPersist = false; }, 60);
    }
  } else {
    await defaultPlacement();
  }
  try {
    await lyrics.show();
  } catch (e) {
    console.error("[bugzia] show lyrics window", e);
  }
}

export async function hideLyricsWindow(): Promise<void> {
  const lyrics = await WebviewWindow.getByLabel(LABEL);
  if (!lyrics) return;
  try {
    await lyrics.hide();
  } catch (e) {
    console.error("[bugzia] hide lyrics window", e);
  }
}
```

- [ ] **Step 3: App.tsx 路由**

`src/App.tsx` 加 lyrics 分支（仿现有 result/settings）：

```ts
import LyricsWindow from "./components/LyricsWindow";
// ...
function App() {
  const label = getCurrentWindow().label;
  if (label === "result") return <ResultWindow />;
  if (label === "settings") return <SettingsWindow />;
  if (label === "lyrics") return <LyricsWindow />;
  return <CommandCard />;
}
```

- [ ] **Step 4: 编译验证**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo check
cd .. && pnpm exec tsc --noEmit
```
Expected: cargo 通过（generate_context 会校验新建的 capabilities/lyrics.json）；tsc 通过。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/capabilities/lyrics.json src/features/lyrics/lyricsWindow.ts src/App.tsx
git commit -m "feat(lyrics): lyrics window capability + lifecycle (no rendering yet)"
```

---

## Task 7: LyricsWindow 渲染组件

**目标：** 歌词窗口的 React 组件——监听事件、本地推进进度、渲染当前行/下一行/翻译、应用外观。此任务后能看见歌词（先用命令行/设置手动 enabled 触发）。

**Files:**
- Create: `src/components/LyricsWindow.tsx`
- Create: `src/components/LyricsWindow.css`

- [ ] **Step 1: LyricsWindow.tsx**

创建 `src/components/LyricsWindow.tsx`：

```tsx
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { loadSettings } from "../features/settings/settingsStore";
import type { AppSettings, LyricsSettings } from "../features/settings/settingsTypes";
import "./LyricsWindow.css";

interface LyricsLine { ms: number; text: string; tr: string; }
interface Lyrics { song_id: string; lines: LyricsLine[]; source: string; }
interface LyricsUpdate {
  song_id: string;
  title: string;
  artist: string;
  state: "playing" | "paused" | "stopped" | "unknown";
  position_ms: number;
  duration_ms: number;
  lyrics_status?: "ok" | "loading" | "not_found" | "error";
  lyrics?: Lyrics;
}

/** Binary-search the index of the last line whose ms <= position. */
function findCurrentLine(lines: LyricsLine[], posMs: number): number {
  if (!lines.length) return -1;
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].ms <= posMs) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;

export default function LyricsWindow() {
  const [settings, setSettings] = useState<LyricsSettings | null>(null);
  const [update, setUpdate] = useState<LyricsUpdate | null>(null);
  const [posMs, setPosMs] = useState(0);

  const lyricsRef = useRef<Lyrics | null>(null);
  const songIdRef = useRef<string>("");
  const stateRef = useRef<string>("stopped");
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number>(0);
  const posRef = useRef<number>(0);

  // load appearance settings
  useEffect(() => {
    let alive = true;
    loadSettings().then((s: AppSettings) => { if (alive) setSettings(s.lyrics); });
    return () => { alive = false; };
  }, []);

  // live-apply when settings window changes lyrics
  useEffect(() => {
    let off: (() => void) | undefined;
    (async () => {
      const un = await listen<{ lyrics?: LyricsSettings }>("lyrics://settings", (ev) => {
        if (ev.payload.lyrics) setSettings(ev.payload.lyrics);
      });
      off = un;
    })();
    return () => { off?.(); };
  }, []);

  // listen for media updates
  useEffect(() => {
    let off: (() => void) | undefined;
    (async () => {
      off = await listen<LyricsUpdate>("lyrics://update", (ev) => {
        const u = ev.payload;
        if (u.song_id && u.song_id !== songIdRef.current) {
          songIdRef.current = u.song_id;
          lyricsRef.current = u.lyrics ?? null;
        } else if (u.lyrics) {
          lyricsRef.current = u.lyrics;
        }
        stateRef.current = u.state;
        posRef.current = u.position_ms;
        setPosMs(u.position_ms);
        setUpdate(u);
      });
    })();
    return () => { off?.(); };
  }, []);

  // local progress advance via rAF while playing
  useEffect(() => {
    const tick = (ts: number) => {
      if (stateRef.current === "playing") {
        if (lastTsRef.current) {
          posRef.current += ts - lastTsRef.current;
          setPosMs(posRef.current);
        }
        lastTsRef.current = ts;
      } else {
        lastTsRef.current = 0;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  if (!settings) return null;

  const lines = lyricsRef.current?.lines ?? [];
  const idx = findCurrentLine(lines, posMs);
  const showNext = settings.line_count >= 2 && idx + 1 < lines.length;
  const showTr = settings.show_translation;
  const cur = idx >= 0 ? lines[idx] : null;
  const next = showNext ? lines[idx + 1] : null;

  const fontFamily = settings.font_family || undefined;
  const fontSize = settings.font_size;
  const trSize = Math.round(fontSize * 0.7);

  let body: React.ReactNode;
  if (!update || (!update.title && stateRef.current === "unknown")) {
    body = <div className="lyrics-status">未在播放</div>;
  } else if (!lines.length) {
    body = <div className="lyrics-status">{
      update.lyrics_status === "not_found" ? "未找到这首歌的歌词" : "歌词加载中..."
    }</div>;
  } else {
    body = (
      <>
        {cur && (
          <div className="lyrics-line lyrics-current">
            <div style={{ fontFamily, fontSize, fontWeight: settings.bold ? 700 : 400, fontStyle: settings.italic ? "italic" : "normal", color: rgb(settings.played_r, settings.played_g, settings.played_b) }}>
              {cur.text}
            </div>
            {showTr && cur.tr && (
              <div className="lyrics-tr" style={{ fontFamily, fontSize: trSize, color: rgb(settings.played_r, settings.played_g, settings.played_b) }}>{cur.tr}</div>
            )}
          </div>
        )}
        {next && (
          <div className="lyrics-line lyrics-next">
            <div style={{ fontFamily, fontSize, fontWeight: settings.bold ? 700 : 400, fontStyle: settings.italic ? "italic" : "normal", color: rgb(settings.unplayed_r, settings.unplayed_g, settings.unplayed_b) }}>
              {next.text}
            </div>
            {showTr && next.tr && (
              <div className="lyrics-tr" style={{ fontFamily, fontSize: trSize, color: rgb(settings.unplayed_r, settings.unplayed_g, settings.unplayed_b) }}>{next.tr}</div>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="lyrics-root" style={{ opacity: settings.opacity }}>
      <div className="lyrics-drag" data-tauri-drag-region />
      {body}
    </div>
  );
}
```

- [ ] **Step 2: CSS**

创建 `src/components/LyricsWindow.css`：

```css
.lyrics-root {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-family: "Microsoft YaHei", system-ui, sans-serif;
  text-align: center;
  user-select: none;
}
.lyrics-drag {
  position: absolute;
  inset: 0;
  z-index: 0;
}
.lyrics-line { position: relative; z-index: 1; line-height: 1.25; }
.lyrics-tr { margin-top: 2px; opacity: 0.85; }
.lyrics-status {
  position: relative; z-index: 1;
  font-size: 18px; color: #888;
}
```

- [ ] **Step 3: 编译**

```bash
pnpm exec tsc --noEmit && pnpm build
```
Expected: 0 错误。

- [ ] **Step 4: 手动验证（临时触发）**

在 `lib.rs` 的 `setup` 临时加：
```rust
let _ = lyrics::lyrics_start_polling(app.handle().clone());
```
在 CommandCard 的启动 effect 临时加 `showLyricsWindow()`（import from features/lyrics/lyricsWindow）。
Run `pnpm tauri dev`，播放音乐。
Expected: 屏幕上出现歌词悬浮窗，当前行随播放滚动高亮，翻译在下方。**这是第一次能看见歌词。**

- [ ] **Step 5: 删除临时触发代码，Commit**

```bash
git add src/components/LyricsWindow.tsx src/components/LyricsWindow.css
git commit -m "feat(lyrics): render lyrics overlay (current/next line + translation)"
```

---

## Task 8: 设置面板"桌面歌词"分区

**目标：** 在 SettingsPanel 加桌面歌词设置 UI（enabled + 外观全部项），复用现有 ColorRow/Field/check-row 组件。

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: 加 import 和 patchLyrics**

`src/components/SettingsPanel.tsx` 顶部 import 类型加 `LyricsSettings`：
```ts
import type {
  AppSettings, AppearanceSettings, AiSettings, LyricsSettings,
  ResultAppearanceSettings, SearchSettings, WindowSettings,
} from "../features/settings/settingsTypes";
```

在组件内 `patchResult` 之后加：
```ts
  const patchLyrics = (p: Partial<LyricsSettings>) =>
    onChange({ ...settings, lyrics: { ...settings.lyrics, ...p } });
```

`const r = settings.result;` 之后加：
```ts
  const ly = settings.lyrics;
```

- [ ] **Step 2: 加分区 JSX**

在"搜索"分区（`{/* ── 搜索 ── */}` section）之后、`</div>`（settings-body 闭合）之前加：

```tsx
          {/* ── 桌面歌词 ── */}
          <section className="settings-section">
            <h4>桌面歌词</h4>
            <label className="check-row">
              <input type="checkbox" checked={ly.enabled}
                onChange={(e) => patchLyrics({ enabled: e.target.checked })} />
              启用桌面歌词
            </label>
            <label className="check-row">
              <input type="checkbox" checked={ly.always_on_top}
                onChange={(e) => patchLyrics({ always_on_top: e.target.checked })} />
              置顶显示
            </label>
            <label className="check-row">
              <input type="checkbox" checked={ly.show_translation}
                onChange={(e) => patchLyrics({ show_translation: e.target.checked })} />
              显示翻译（有则双语）
            </label>
            <label className="check-row">
              <input type="checkbox" checked={ly.line_count >= 2}
                onChange={(e) => patchLyrics({ line_count: e.target.checked ? 2 : 1 })} />
              双行显示（当前 + 下一句）
            </label>
            <Field label="字体">
              <input className="f-input" value={ly.font_family} placeholder="留空 = 系统默认"
                onChange={(e) => patchLyrics({ font_family: e.target.value })} />
            </Field>
            <label className="check-row">
              <input type="checkbox" checked={ly.bold}
                onChange={(e) => patchLyrics({ bold: e.target.checked })} />
              粗体
            </label>
            <label className="check-row">
              <input type="checkbox" checked={ly.italic}
                onChange={(e) => patchLyrics({ italic: e.target.checked })} />
              斜体
            </label>
            <ColorRow label="字号" value={ly.font_size} min={12} max={72} step={1}
              fmt={(v) => `${v}px`} onChange={(v) => patchLyrics({ font_size: v })} />
            <ColorRow label="已播放 R" value={ly.played_r} min={0} max={255} step={1}
              onChange={(v) => patchLyrics({ played_r: v })} />
            <ColorRow label="已播放 G" value={ly.played_g} min={0} max={255} step={1}
              onChange={(v) => patchLyrics({ played_g: v })} />
            <ColorRow label="已播放 B" value={ly.played_b} min={0} max={255} step={1}
              onChange={(v) => patchLyrics({ played_b: v })} />
            <ColorRow label="未播放 R" value={ly.unplayed_r} min={0} max={255} step={1}
              onChange={(v) => patchLyrics({ unplayed_r: v })} />
            <ColorRow label="未播放 G" value={ly.unplayed_g} min={0} max={255} step={1}
              onChange={(v) => patchLyrics({ unplayed_g: v })} />
            <ColorRow label="未播放 B" value={ly.unplayed_b} min={0} max={255} step={1}
              onChange={(v) => patchLyrics({ unplayed_b: v })} />
            <ColorRow label="透明度" value={ly.opacity} min={0} max={1} step={0.05}
              fmt={(v) => v.toFixed(2)} onChange={(v) => patchLyrics({ opacity: v })} />
          </section>
```

- [ ] **Step 3: 编译 + 构建**

```bash
pnpm exec tsc --noEmit && pnpm build
```
Expected: 0 错误。

- [ ] **Step 4: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(lyrics): desktop-lyrics section in settings panel"
```

---

## Task 9: 托盘菜单开关 + 窗口控制命令 + setup 自动恢复

**目标：** 让桌面歌词能真正开关——托盘菜单项 + 窗口控制 Rust 命令（toggle/locked/always_on_top）+ 应用启动时按 settings 自动恢复。

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/lyrics.rs`

- [ ] **Step 1: lyrics.rs 加窗口控制命令**

在 `lyrics.rs` 末尾加（这些命令有完整窗口访问权，不受 caller capability 限制）：

```rust
use tauri::webview::WebviewWindow;

fn lyrics_win(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("lyrics")
}

/// Enable/disable lyrics: on enable -> ensure main-side creation is driven from
/// the frontend (main owns window lifecycle). Here we only start/stop polling +
/// toggle the window. Persistence of `enabled` is the caller's job.
#[tauri::command]
pub fn lyrics_set_enabled(app: AppHandle, enabled: bool) {
    if enabled {
        lyrics_start_polling(app.clone());
        if let Some(w) = lyrics_win(&app) {
            let _ = w.show();
        }
    } else {
        lyrics_stop_polling(app.clone());
        if let Some(w) = lyrics_win(&app) {
            let _ = w.hide();
        }
    }
}

/// Lock = position fixed + mouse click-through. Persisted by caller; here we
/// apply the window effect and broadcast lock-changed so the overlay re-shows
/// its handle on unlock.
#[tauri::command]
pub fn lyrics_set_locked(app: AppHandle, locked: bool) -> Result<(), String> {
    let w = lyrics_win(&app).ok_or("lyrics window not found")?;
    w.set_ignore_cursor_events(locked).map_err(|e| e.to_string())?;
    let _ = app.emit("lyrics://lock-changed", locked);
    Ok(())
}

#[tauri::command]
pub fn lyrics_set_always_on_top(app: AppHandle, top: bool) -> Result<(), String> {
    let w = lyrics_win(&app).ok_or("lyrics window not found")?;
    w.set_always_on_top(top).map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 2: lib.rs 注册命令**

`invoke_handler!` 加：
```rust
            lyrics::lyrics_set_enabled,
            lyrics::lyrics_set_locked,
            lyrics::lyrics_set_always_on_top,
```

- [ ] **Step 3: 托盘菜单加"桌面歌词"项**

`lib.rs` 的 `build_tray`（第 53-93 行）改造。在 `quit_item` 之前加一个 lyrics 勾选项，仿 `autostart_item`：

```rust
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let want_autostart = load_settings(app.clone()).map(|s| s.system.autostart).unwrap_or(true);
    let want_lyrics = load_settings(app.clone()).map(|s| s.lyrics.enabled).unwrap_or(false);

    let show_item = MenuItem::with_id(app, "show", "显示 Bugzia", true, None::<&str>)?;
    let autostart_item =
        CheckMenuItem::with_id(app, "autostart", "开机自启", true, want_autostart, None::<&str>)?;
    let lyrics_item =
        CheckMenuItem::with_id(app, "lyrics", "桌面歌词", true, want_lyrics, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let autostart_for_handler = autostart_item.clone();
    let lyrics_for_handler = lyrics_item.clone();
    let items: &[&dyn IsMenuItem<Wry>] = &[&show_item, &autostart_item, &lyrics_item, &quit_item];
    let menu = Menu::with_items(app, items)?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().expect("missing default window icon"))
        .tooltip("Bugzia")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => focus_main(app),
            "quit" => app.exit(0),
            "autostart" => {
                let mut s = load_settings(app.clone()).unwrap_or_default();
                s.system.autostart = !s.system.autostart;
                let next = s.system.autostart;
                let _ = save_settings(app.clone(), s);
                let mgr = app.state::<AutoLaunchManager>();
                let _ = if next { mgr.enable() } else { mgr.disable() };
                let _ = autostart_for_handler.set_checked(next);
            }
            "lyrics" => {
                // Toggle lyrics enabled intent, persist, mirror window + polling,
                // and update the check mark. The lyrics window is created from the
                // MAIN window context (ACL); here we drive only enable/disable.
                let mut s = load_settings(app.clone()).unwrap_or_default();
                s.lyrics.enabled = !s.lyrics.enabled;
                let next = s.lyrics.enabled;
                let _ = save_settings(app.clone(), s);
                let _ = lyrics::lyrics_set_enabled(app.clone(), next);
                let _ = lyrics_for_handler.set_checked(next);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
```

- [ ] **Step 4: setup 自动恢复 + main 端窗口创建接线**

托盘的 `lyrics_set_enabled` 需要 lyrics 窗口已存在。窗口创建属 main 上下文。在 `CommandCard.tsx` 增量加 lyrics 接线（**严格照 onResultGeometryChange 范式，不动其它逻辑**）。

`CommandCard.tsx` 顶部 import 加：
```ts
import {
  hideLyricsWindow, onLyricsGeometryChange, showLyricsWindow,
} from "../features/lyrics/lyricsWindow";
```

在已有的 `// ── persist the result window's geometry ...` effect（第 296-305 行）之后，新增一个 effect：

```tsx
  // ── desktop lyrics: reflect settings.lyrics.enabled (show/hide + polling) and
  //    persist the lyrics overlay's geometry when the USER moves/resizes it.
  //    Main is the sole settings.json writer. ──
  useEffect(() => {
    onLyricsGeometryChange((g) => {
      const patch: Partial<WindowSettings> = {};
      // store into lyrics.* via a dedicated patch helper below
      const cur = settingsRef.current;
      if (!cur) return;
      const next = {
        ...cur,
        lyrics: {
          ...cur.lyrics,
          ...(g.x !== undefined ? { x: g.x } : {}),
          ...(g.y !== undefined ? { y: g.y } : {}),
          ...(g.w !== undefined ? { w: g.w } : {}),
        },
      };
      update(next);
    });
  }, [update]);

  useEffect(() => {
    const cur = settingsRef.current;
    if (!cur || !cur.lyrics.enabled) return;
    void showLyricsWindow(
      { x: cur.lyrics.x, y: cur.lyrics.y, w: cur.lyrics.w },
      { alwaysOnTop: cur.lyrics.always_on_top },
    ).catch(logErr("show lyrics"));
    void invoke("lyrics_set_enabled", { enabled: true }).catch(logErr("lyrics enable"));
  }, [settings?.lyrics.enabled]); // eslint-disable-line react-hooks/exhaustive-deps
```

注意：第二个 effect 依赖 `settings?.lyrics.enabled`，仅在 enabled 翻转时触发 show + polling。`invoke` 已在文件顶部 import。

- [ ] **Step 5: 编译**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo check
cd .. && pnpm exec tsc --noEmit
```
Expected: 双侧通过。

- [ ] **Step 6: 手动验证**

Run `pnpm tauri dev`：
- 托盘菜单出现"桌面歌词"勾选项；勾选 → 歌词窗出现 + 轮询启动；取消 → 窗口隐藏
- 重启应用 → 若上次 enabled，歌词窗自动恢复

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/lyrics.rs src/components/CommandCard.tsx
git commit -m "feat(lyrics): tray toggle + window control commands + auto-restore"
```

---

## Task 10: 手柄交互 + 锁定/解锁流转 + 实时外观

**目标：** 完善悬浮窗手柄（拖动/锁定/置顶）、锁定后解锁流转、设置面板改动实时生效到歌词窗。

**Files:**
- Modify: `src/components/LyricsWindow.tsx`
- Modify: `src/components/SettingsPanel.tsx`
- Modify: `src/components/CommandCard.tsx`

- [ ] **Step 1: LyricsWindow 加手柄 + 锁定/解锁监听**

把 Task 7 的 `return` 块替换为带手柄版本，并加锁定状态监听。在组件内 `if (!settings) return null;` 之前加：

```tsx
  const [locked, setLocked] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    let off: (() => void) | undefined;
    (async () => {
      off = await listen<boolean>("lyrics://lock-changed", (ev) => setLocked(ev.payload));
    })();
    return () => { off?.(); };
  }, []);

  // sync initial locked from settings
  useEffect(() => { setLocked(settings.locked); }, [settings.locked]);

  async function handleLock() {
    try {
      await invoke("lyrics_set_locked", { locked: true });
      setLocked(true);
    } catch (e) { console.error("[bugzia] lock", e); }
  }
  async function toggleTop() {
    const next = !settings.always_on_top;
    try {
      await invoke("lyrics_set_always_on_top", { top: next });
      // mirror to settings via the lyrics://settings broadcast handled in main
    } catch (e) { console.error("[bugzia] top", e); }
  }
```

需要 import：`import { invoke } from "@tauri-apps/api/core";`（文件顶部）。

把 `return (` 块改为：

```tsx
  return (
    <div
      className="lyrics-root"
      style={{ opacity: settings.opacity }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {!locked && (
        <div className="lyrics-handle" style={{ opacity: hovered ? 1 : 0 }}>
          <div className="lyrics-drag" data-tauri-drag-region />
          <button className="lyrics-btn" type="button" title="置顶" onClick={() => void toggleTop()}>
            {settings.always_on_top ? "取消置顶" : "置顶"}
          </button>
          <button className="lyrics-btn" type="button" title="锁定（鼠标穿透，托盘解锁）" onClick={() => void handleLock()}>
            锁定
          </button>
        </div>
      )}
      {body}
    </div>
  );
```

CSS 追加到 `LyricsWindow.css`：
```css
.lyrics-handle {
  position: absolute; top: -28px; left: 0; right: 0;
  display: flex; justify-content: center; gap: 8px;
  transition: opacity 0.15s;
  z-index: 2;
}
.lyrics-btn {
  font-size: 12px; padding: 2px 8px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.3); background: rgba(0,0,0,0.5);
  color: #fff; cursor: pointer;
}
```

- [ ] **Step 2: 解锁入口（托盘已有"桌面歌词"，再加一个"解锁歌词"动作）**

锁定后鼠标穿透，只能靠托盘/快捷键解锁。在 `lib.rs` 托盘菜单再加一项常驻菜单项（非勾选）"解锁歌词"，点击调 `lyrics_set_locked(false)` + 把 settings.lyrics.locked 置 false：

在 `build_tray` 的 items 里 `lyrics_item` 后加：
```rust
    let unlock_item = MenuItem::with_id(app, "unlock", "解锁歌词", true, None::<&str>)?;
```
items 数组加 `&unlock_item`，菜单事件加分支：
```rust
            "unlock" => {
                let mut s = load_settings(app.clone()).unwrap_or_default();
                s.lyrics.locked = false;
                let _ = save_settings(app.clone(), s);
                let _ = lyrics::lyrics_set_locked(app.clone(), false);
            }
```

- [ ] **Step 3: 设置面板改动实时广播到歌词窗**

`SettingsPanel.tsx` 在 `patchLyrics` 里、`onChange` 之后，同时 emit 一个事件给 lyrics 窗口（和给 main 的 settings:updated 并行）。最简单：在 `SettingsPanel` 的 `onChange` 调用处之后追加广播——实际 `onChange` 已经触发 settings:updated（main 监听）。main 收到后需再转发 lyrics 外观给 lyrics 窗。

在 `CommandCard.tsx` 的 `settings:updated` 监听（第 231-244 行）里，merge 后加一行广播 lyrics 外观给 lyrics 窗：

```ts
        const merged: AppSettings = {
          ...cur,
          appearance: ev.payload.appearance,
          result: ev.payload.result,
          ai: ev.payload.ai,
          search: ev.payload.search,
          lyrics: ev.payload.lyrics,
          window: { ...cur.window, locked: ev.payload.windowLocked },
        };
        update(merged);
        applyAppearanceVars(merged.appearance);
        // forward lyrics appearance to the lyrics overlay (live update)
        emit("lyrics://settings", { lyrics: merged.lyrics }).catch(logErr("emit lyrics settings"));
```

（`emit` 已在文件顶部 import；`SettingsPatch` 已含 lyrics，见 Task 4。）

- [ ] **Step 4: 编译 + 构建**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo check
cd .. && pnpm exec tsc --noEmit && pnpm build
```
Expected: 全通过。

- [ ] **Step 5: 手动验证**

Run `pnpm tauri dev`，开启歌词：
- 鼠标移到歌词窗上方 → 手柄出现（置顶/锁定按钮）
- 拖动手柄空白区 → 移动窗口，位置记忆
- 点"锁定"→ 手柄消失、鼠标穿透（点击落到下层）
- 托盘"解锁歌词"→ 手柄恢复
- 设置面板改颜色/字号/透明度 → 歌词窗实时变化

- [ ] **Step 6: Commit**

```bash
git add src/components/LyricsWindow.tsx src/components/LyricsWindow.css src/components/CommandCard.tsx src-tauri/src/lib.rs
git commit -m "feat(lyrics): handle + lock/unlock flow + live appearance sync"
```

---

## Task 11: 最终兼容性验证闸口（规则二）

**目标：** 跑完 CLAUDE.md 规则二的全部验证闸口，确认无回归。清理探针临时代码。

**Files:**
- Modify: `src-tauri/src/lyrics.rs`（可选：移除 probe 命令）
- Modify: `src-tauri/src/lib.rs`（移除 probe 注册，若保留也无害）

- [ ] **Step 1: 清理探针**

若不再需要 `lyrics_probe_media` / `lyrics_probe_lyrics`，从 `lyrics.rs` 删除两个 `#[tauri::command]` 探针函数及 `fetch_lyrics_probe`（保留 `fetch_lyrics`、`parse_lrc`、`read_current_media`）。从 `lib.rs` invoke_handler 移除两条 probe 注册。保留单元测试。

- [ ] **Step 2: 前端类型检查**

```bash
pnpm exec tsc --noEmit
```
Expected: 0 错误。

- [ ] **Step 3: 后端编译**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo check
```
Expected: 通过（含 generate_context 校验所有 capabilities）。

- [ ] **Step 4: 前端构建**

```bash
cd .. && pnpm build
```
Expected: 出 `dist/`，0 错误。

- [ ] **Step 5: 单元测试**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test
```
Expected: parse_lrc 全部测试通过。

- [ ] **Step 6: 运行时回归手动确认（最关键）**

Run `pnpm tauri dev`，逐项确认既有功能无回归：
- 主窗口 Alt+Space 唤起、位置记忆正常
- 外观设置实时生效
- AI 流式对话正常（开 result 窗、流式输出、停止）
- /file 搜索分发正常
- /weather、/trans 正常
- 设置窗口开关、API Key 存取正常
- 托盘"开机自启"仍正常

再确认新功能：
- 桌面歌词开关（托盘 + 设置面板）正常
- 酷狗 + 网易云播放都能显示歌词、进度同步、翻译
- 锁定/解锁、置顶、颜色/字号/透明度、单双行、字体、粗斜体全部生效
- 位置跨重启记忆

- [ ] **Step 7: 最终 Commit**

```bash
git add -A
git commit -m "chore(lyrics): cleanup probes + pass all verification gates"
```

---

## Self-Review（写计划后自查）

**1. Spec coverage：**
- 悬浮窗拖动 + 位置记忆 → Task 6（lyricsWindow.ts 几何）+ Task 9（main 接线）✓
- 已播放/未播放颜色、字体/字号/粗斜体、透明度 → Task 4（结构）+ Task 8（UI）+ Task 7（渲染）✓
- 置顶 → Task 9（命令）+ Task 8（UI）✓
- 单行/双行 + 翻译 → Task 7（渲染逻辑）+ Task 8（UI）✓
- 锁定+穿透 + 解锁 → Task 9（命令）+ Task 10（手柄/解锁）✓
- 操作入口（托盘 + 设置面板）→ Task 8 + Task 9 ✓
- SMTC 媒体获取 → Task 1（探针）+ Task 5（轮询）✓
- 网易云歌词 + 翻译 → Task 2（探针）+ Task 5 ✓
- 事件推送 + 进度推进 → Task 5 + Task 7 ✓
- 向后兼容（serde default）→ Task 4 ✓
- 验证闸口 → Task 11 ✓

**2. Placeholder scan：** 无 TBD/TODO；每个代码步骤都给了完整代码；验证步骤给了精确命令 + 预期。Task 5 Step 1b 的"若 borrow checker 报错"给了确定的替代方案（采用 owned 版本），不是悬而未决。

**3. Type consistency：**
- `LyricsSettings` 字段在 Rust（Task 4 Step 1）与 TS（Task 4 Step 2）完全对应（snake_case 一致）✓
- `LyricsUpdate` 字段：Rust（Task 5）`song_id/title/artist/state/position_ms/duration_ms/lyrics_status/lyrics` 与 TS（Task 7）`LyricsUpdate` 一致 ✓
- 命令名：`lyrics_probe_media`/`lyrics_probe_lyrics`/`lyrics_start_polling`/`lyrics_stop_polling`/`lyrics_set_enabled`/`lyrics_set_locked`/`lyrics_set_always_on_top` 在定义任务和注册任务中一致 ✓
- 事件名：`lyrics://update`/`lyrics://lock-changed`/`lyrics://settings` 全程一致 ✓
- `findCurrentLine`、`rgb` 在 Task 7 定义并在同文件使用 ✓

**4. 已知风险与对应：** Task 1/2 是硬去风险门槛（设计 §9 阶段 0）；Task 5 Step 1b 明确了借用生命周期处理；windows crate feature 按编译报错补齐已在 Task 1 Step 4 说明。
