# 桌面歌词显示功能 设计文档

- 日期：2026-06-19
- 状态：已通过 brainstorming 评审，待 writing-plans 拆解实现计划
- 范围：给 Bugzia 桌面助手新增桌面歌词悬浮窗，在 Windows 上播放酷狗/网易云等音乐时显示逐行同步歌词

---

## 1. 背景与目标

用户希望在桌面助手现有能力之外，附加一个"桌面歌词"效果：当电脑播放音乐（酷狗、网易云等）时，在桌面悬浮显示当前歌词，并支持丰富的外观自定义与交互。

核心价值在于复用项目已有的悬浮窗基础设施，以低侵入方式接入，不破坏任何现有功能。

## 2. 需求清单（已确认）

功能要求：

- 悬浮窗形式，桌面任意位置可拖动，位置跨重启记忆
- 已播放 / 未播放 两种歌词颜色分别可调（语义见 4.2）
- 字体、字号、粗体、斜体可调
- 窗口整体透明度可调
- 可置顶（只在桌面最上层显示）
- 单行 / 双行显示可切换
- 英文歌词同步显示翻译（双语），翻译为独立开关
- 可"固定"：锁定 = 位置固定 + 鼠标穿透（点击落到下层窗口）

操作模型（复用现有架构）：

- 主窗口（CommandCard）加桌面歌词开关入口
- 托盘菜单加"桌面歌词"项
- 详细外观设置进现有 SettingsPanel 新建分区
- 悬浮窗带轻量手柄（拖动 / 锁定 / 置顶）

## 3. 关键决策（澄清结论）

| 决策点 | 结论 |
|---|---|
| 功能范围 | 完整歌词同步（逐行滚动高亮），非 MVP |
| 翻译来源 | 来自歌词源（网易云 tlyric），非读取播放器内部开关；有则双语，无则仅原文 |
| "固定"含义 | 锁定 + 鼠标穿透（setIgnoreCursorEvents），解锁靠托盘菜单 / 主窗口开关 / 全局快捷键 |
| 单双行 vs 翻译 | 两者解耦：line_count（1 或 2）是独立选项；show_translation 是独立开关，开启时每句原文下方挂译文 |
| 操作组织 | 复用现有架构（主窗口入口 + 托盘 + SettingsPanel 分区 + 悬浮窗手柄） |
| 运行模型 | 方案 A：Rust 后端每 500ms 轮询 SMTC + 推送 Tauri 事件，前端只渲染 |
| 进度高亮 | 逐行高亮（非逐字渐变），逐字留作未来增强 |
| 平台 | Windows 专属（SMTC），macOS/Linux 二期按平台分模块适配 |

## 4. 架构与数据流

### 4.1 系统组成

桌面歌词复用现有"单 SPA 按窗口 label 路由 + 运行时动态创建窗口"模式，新增 `lyrics` 窗口和 `lyrics.rs` 后端模块（与 `weather.rs` 同级）。

- main 窗口（CommandCard）：桌面歌词开关入口；是窗口几何的唯一写入者（沿用 result 窗口约定）
- Rust 后端 lyrics.rs：SMTC 轮询 + 网易云歌词获取（搜索 → LRC → tlyric 翻译）+ 歌词缓存 + 窗口控制命令 + 事件推送
- lyrics 窗口（LyricsWindow.tsx）：监听事件 → 渲染当前行/下一行/翻译；本地 requestAnimationFrame 推进进度高亮；轻量手柄（拖动/锁定/置顶）

### 4.2 数据流（事件驱动）

后端单一事件 `lyrics://update`。歌曲变化时附带完整歌词；未变化时只带进度，节省 IPC：

```
歌曲变化时：{ song_id, title, artist, state, position_ms, duration_ms,
              lyrics_status, lyrics: { song_id, lines: [{ms, text, tr}], source } }
仅进度推进：{ song_id, state, position_ms, duration_ms }   // 无 lyrics 字段
```

- 后端每 500ms 读一次 SMTC；若 title+artist 变了 → 拉网易云歌词 → 解析成 lines[] 缓存 → 事件带 lyrics 一起推
- 歌曲没变 → 只推 position_ms，前端用它在 lines[] 里二分定位当前行
- 前端两次事件之间用本地计时器推进 position_ms（每帧 +deltaTime），下次事件到达时校正，避免歌词抖动

颜色语义（逐行高亮）：

- played 色 = 当前正在唱的那一行（高亮主色，随播放实时跟踪）
- unplayed 色 = 双行模式下预览的下一句（暗色）
- 已唱完的行滚走、不显示，实际只有"当前行"和"下一行"两种颜色状态

## 5. 数据结构与设置

### 5.1 AppSettings 新增 lyrics section

字段命名一律 snake_case，与 Rust serde JSON key 完全一致；颜色沿用现有 appearance 的 RGB 分量风格（非 hex）；窗口几何沿用 result 的 sentinel 约定（-1 = 从未放置）。

```ts
interface LyricsSettings {
  enabled: boolean;          // 总开关：决定 lyrics 窗口是否创建/显示
  x: number;                 // 窗口 X，LOGICAL px，-1 = 从未放置（默认位置）
  y: number;                 // 窗口 Y，LOGICAL px，-1 = 从未放置
  w: number;                 // 窗口宽度，LOGICAL px
  font_family: string;       // "" = 系统默认字体
  font_size: number;         // px
  bold: boolean;
  italic: boolean;
  played_r: number;          // 当前高亮行颜色 R 0..255
  played_g: number;
  played_b: number;
  unplayed_r: number;        // 预览下一行颜色 R 0..255
  unplayed_g: number;
  unplayed_b: number;
  opacity: number;           // 0..1 整体透明度（作用于歌词文字容器）
  always_on_top: boolean;    // 置顶
  locked: boolean;           // 锁定 = 位置固定 + 鼠标穿透
  line_count: number;        // 1 = 仅当前句, 2 = 当前句 + 下一句
  show_translation: boolean; // 翻译开关（翻译来自网易云 tlyric）
}
```

默认值：

```ts
DEFAULT_LYRICS = {
  enabled: false,
  x: -1, y: -1,
  w: 600,
  font_family: "",
  font_size: 28,
  bold: true, italic: false,
  played_r: 0,   played_g: 196, played_b: 255,   // 亮蓝（当前行）
  unplayed_r: 220, unplayed_g: 220, unplayed_b: 220, // 浅灰（下一行）
  opacity: 1.0,
  always_on_top: true,
  locked: false,
  line_count: 1,             // 默认单行
  show_translation: true,    // 默认开翻译（有则显示）
};
```

### 5.2 歌词数据结构（事件 payload）

```ts
interface LyricsLine {
  ms: number;    // 该行起始时间戳（毫秒）
  text: string;  // 原文
  tr: string;    // 翻译（网易云 tlyric，无则空串）
}

interface Lyrics {
  song_id: string;          // 网易云 songId（前端据此判断要不要换歌）
  lines: LyricsLine[];
  source: string;           // "网易云音乐" / "未找到" 等来源描述
}

interface LyricsUpdate {
  song_id: string;
  title: string;
  artist: string;
  state: "playing" | "paused" | "stopped" | "unknown";
  position_ms: number;
  duration_ms: number;       // 0 = 未知
  lyrics_status?: "ok" | "loading" | "not_found" | "error";
  lyrics?: Lyrics;           // 仅歌曲变化时附带
}
```

`lyrics_status` 让前端在加载中 / 没找到 / 出错时给出提示文案。

### 5.3 对现有代码的影响（向后兼容）

- AppSettings 加 lyrics 字段 → 旧 settings.json 无此字段时，settingsStore 的防御性 merge + Rust 侧 `#[serde(default)]` 兜底，老用户升级自动补默认值，不破坏现有配置
- SettingsPatch（settings 窗口广播用）加 lyrics 字段，main 合并时纳入，与现有 appearance/result/ai/search 同机制
- settingsStore.loadSettings 的 merge 列表加一项 lyrics

## 6. 前端组件与交互

### 6.1 组件职责划分（对称于 result 窗口）

`src/features/lyrics/lyricsWindow.ts`（运行在 main 窗口上下文）：

- ensureLyricsWindow()：get-or-create，decorations:false / transparent:true / skipTaskbar:true / alwaysOnTop:initial / visible:false，定位后再 show
- showLyricsWindow(saved)：有保存位置就恢复，否则默认居中偏下
- hideLyricsWindow()
- onLyricsGeometryChange(cb)：attach onMoved/onResized，main 是唯一写入者，拖动后把 x/y/w 持久化进 settings

`src/components/LyricsWindow.tsx`（lyrics 窗口内部）：

- 监听 lyrics://update → 维护 currentUpdate 状态
- 进度推进 + 行定位 + 渲染
- 轻量手柄（拖动 / 锁定 / 置顶）

App.tsx 加一行路由：`if (label === "lyrics") return <LyricsWindow />;`

### 6.2 进度推进与行定位

- 收到 LyricsUpdate，存 songId / lyrics / state / positionMs / durationMs
- state === "playing" 时启动 requestAnimationFrame 循环：每帧 positionMs += (now - lastFrame)，重新算当前行；paused/stopped 时停循环
- 每次新事件到达，用 payload.position_ms 覆盖本地值，消除漂移（500ms 一次校正，肉眼看不出跳）
- 行定位：在 lines[] 里二分找最后一个 ms <= positionMs 的 index = 当前行
- songId 变 → 重置 position、替换 lines

### 6.3 渲染规则

| 设置 | 渲染行为 |
|---|---|
| line_count=1 | 只渲染当前行（played 色） |
| line_count=2 | 当前行（played 色）+ 下一行（unplayed 色） |
| show_translation=true 且该行 tr 非空 | 原文下方挂翻译行，字号 = 主字号 x 0.7，跟随原文行颜色 |
| 字体外观 | font_family / font_size / bold / italic 全部内联 style |
| opacity | 作用于歌词容器的 CSS opacity（实时生效，无需重启窗口） |
| 无媒体/未找到 | 显示状态文案："未在播放" / "歌词加载中..." / "未找到这首歌的歌词" |

### 6.4 手柄与锁定/解锁流转

```
未锁定 (locked=false)
  鼠标移入 → 手柄淡入 [ 拖动条 ][置顶][锁定]
  拖动条 → startDragging (capability 直给)
  置顶   → invoke lyrics_set_always_on_top(toggle)
  锁定   → invoke lyrics_set_locked(true)
            ↓ Rust: setIgnoreCursorEvents(true) + 持久化 locked=true
已锁定 (locked=true)
  鼠标穿透，手柄隐藏，点击落到下层窗口
  解锁途径（三选一，产品标配）：
    托盘菜单"锁定桌面歌词"项（勾选态，仿 autostart）
    主窗口开关关掉再开
    全局快捷键 Ctrl+Alt+L（可选）
            ↓ invoke lyrics_set_locked(false)
            ↓ Rust: setIgnoreCursorEvents(false) + emit lyrics://lock-changed
            ↓ 前端收到事件 → 重新显示手柄
```

### 6.5 权限 / capability 规划

沿用 result 窗口的 ACL 哲学（Tauri v2 ACL 按调用者窗口 capability 检查）：

- capabilities/lyrics.json：core:default + window:allow-close/hide/show/set-focus/start-dragging
- 走 Rust 命令（任意调用者、有完整窗口访问权）：lyrics_set_locked / lyrics_set_always_on_top / lyrics_toggle_enabled
- 几何记忆在 main 上下文 attach 监听（main 有 set-position 权限），lyrics 窗口自身不碰 setPosition

### 6.6 LRC 解析放在后端

后端 lyrics.rs 拿到网易云返回的原 LRC + tlyric 后，在 Rust 侧解析合并成 lines[{ms, text, tr}] 再随事件推给前端，避免把原始 LRC 字符串传到前端再解析。

## 7. 后端实现

### 7.1 lyrics.rs 结构

```rust
pub struct LyricsState {
    current_song_id: Mutex<Option<String>>,
    poll_handle: Mutex<Option<JoinHandle<()>>>,
}

#[cfg(target_os = "windows")]
mod smtc {
    // GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?
    //   .get()?.GetCurrentSession()
    //   .TryGetMediaPropertiesAsync()?.get()  -> Title / Artist / AlbumTitle
    //   .GetPlaybackInfo()                     -> PlaybackStatus
    //   .GetTimelineProperties()               -> Position / EndTime
    pub fn read_current() -> Option<MediaSnapshot> { ... }
}

async fn fetch_lyrics(title: &str, artist: &str) -> Option<Lyrics> { ... } // 搜索拿 songId -> 拉 LRC + tlyric -> 合并
fn parse_lrc(lrc: &str, tlyric: &str) -> Vec<LyricsLine> { ... }

async fn poll_loop(app: AppHandle) {
    loop {
        sleep(500ms);
        if let Some(snap) = smtc::read_current() {
            // song_id 变了 -> fetch_lyrics -> emit update{ ..., lyrics }
            // 没变        -> emit update{ position_ms, state }   // 不带 lyrics
        }
    }
}
```

### 7.2 Tauri 命令清单（注册进 lib.rs）

| 命令 | 作用 |
|---|---|
| lyrics_toggle_enabled(enabled) | true → 创建+显示窗口+启动轮询；false → 隐藏+停轮询 |
| lyrics_set_locked(locked) | setIgnoreCursorEvents + 持久化 + emit lyrics://lock-changed |
| lyrics_set_always_on_top(top) | 切换置顶（仿 set_result_always_on_top） |

启动时机：setup 时若 settings.lyrics.enabled，自动创建窗口 + 启动轮询；toggle 命令负责运行时启停。轮询用 tauri::async_runtime::spawn（Tauri 2 自带 tokio，不单独加 tokio 依赖）。

### 7.3 网易云歌词接口

- 搜索：GET https://music.163.com/api/search/get?s={title}+{artist}&type=1&limit=5，取匹配 songId（可校验 artist 提高准确度）
- 歌词：GET https://music.163.com/api/song/lyric?id={songId}&lv=1&kv=1&tv=-1，解析 lrc.lyric（原文）+ tlyric.lyric（翻译）
- 接口为非官方公开接口，需带合适 UA/参数；可能限流，做缓存 + lyrics_status 容错

### 7.4 Cargo 依赖

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = ["Media_Control", "Foundation"] }
```

Media_Control 提供 SMTC 类型，Foundation 提供 IAsyncOperation（WinRT 异步 .get()）。实际 feature 按编译报错补齐（可能要 Foundation_Collections）。cfg(windows) 保证非 Windows 不拉这依赖。reqwest 已有，复用。

## 8. 文件清单

新增：

| 文件 | 作用 |
|---|---|
| src-tauri/src/lyrics.rs | SMTC 轮询 + 网易云歌词获取 + 窗口控制命令 + 事件推送 |
| src/components/LyricsWindow.tsx + .css | 歌词窗口根组件 |
| src/features/lyrics/lyricsWindow.ts | lyrics 窗口生命周期（仿 resultWindow.ts） |
| src-tauri/capabilities/lyrics.json | lyrics 窗口权限 |

改动（全部向后兼容、不破坏现有契约）：

| 文件 | 改动 |
|---|---|
| src-tauri/src/lib.rs | mod lyrics; + 注册新命令 + 托盘菜单项 |
| src-tauri/src/settings.rs | AppSettings 加 LyricsSettings（serde default） |
| src-tauri/Cargo.toml | 加 windows crate（cfg windows） |
| src/App.tsx | label 路由加 lyrics |
| src/features/settings/settingsTypes.ts | AppSettings 加 lyrics + DEFAULT_LYRICS + SettingsPatch 加 lyrics |
| src/features/settings/settingsStore.ts | loadSettings merge 加 lyrics |
| src/components/SettingsPanel.tsx | 新增"桌面歌词"分区 |
| src/components/CommandCard.tsx | 主窗口加桌面歌词开关入口 |

## 9. 分阶段实施

| 阶段 | 内容 | 去风险点 |
|---|---|---|
| 0 探针 | 加 windows crate，写 lyrics_probe 命令读 SMTC 打印；reqwest 实测网易云歌词接口。零 UI | 最关键：验证酷狗/网易云都能被 SMTC 读到、网易云接口能用。任一不通，方案要调整 |
| 1 数据骨架 | lyrics.rs 轮询 + emit 事件；AppSettings 加 lyrics（serde default）；日志验证 payload | 事件链路通 |
| 2 歌词窗口 | lyricsWindow.ts + LyricsWindow.tsx + App 路由 + capabilities/lyrics.json；渲染/进度/单双行/翻译/颜色 | 能看见歌词 |
| 3 设置+入口 | SettingsPanel 桌面歌词分区；CommandCard 开关；托盘菜单项；手柄 | 全套可操作 |
| 4 打磨 | 状态文案、错误兜底、歌词缓存、位置记忆、跨重启恢复 | 体验完整 |

阶段 0 是硬门槛：SMTC 和网易云接口必须先在真实环境验证通，再往下做。

## 10. 风险登记

- SMTC 在个别旧 Win10 或某些播放器版本可能未注册 → 阶段 0 探针验证
- 网易云接口限流/变更 → 歌词缓存 + lyrics_status 容错 + 未来加手动换歌
- 歌词匹配错歌 → 显示 source，未来加手动搜索入口
- windows crate 首次编译慢（几分钟）→ 接受，一次性成本
- 仅 Windows → 已标注，macOS/Linux 各走 MPNowPlaying/MPRIS，二期按平台分模块

## 11. 兼容性验证（CLAUDE.md 规则二闸口，全部通过才算完成）

- tsc --noEmit：0 错误
- cargo check（含 generate_context 校验新建的 capabilities/lyrics.json）
- pnpm build 出 dist/
- pnpm tauri dev 手动确认：既有功能无回归（窗口位置记忆、外观实时生效、AI 流式、搜索分发）+ 桌面歌词新功能正常

注：本机 Rust 不在 PATH，执行 cargo/tauri 命令前先 `export PATH="$HOME/.cargo/bin:$PATH"`。

## 12. 未来增强（不在本期）

- 逐字渐变高亮（依赖逐字 LRC，多数歌曲无逐字数据）
- 跨平台：macOS（MPNowPlayingInfoCenter）/ Linux（MPRIS）按平台分模块
- 手动搜索/换歌入口（应对匹配错歌）
- 酷狗/QQ音乐歌词源 fallback
- 歌词悬浮窗主题跟随项目外观设置
