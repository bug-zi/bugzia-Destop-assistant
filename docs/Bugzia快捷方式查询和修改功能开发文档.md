# Bugzia 全系统快捷键管理中心开发文档

项目路径：`D:\Code\自创项目\bugzia桌面助手`\
\
目标功能：在 Bugzia 中建设全系统快捷键查询、冲突检测、修改、禁用和恢复能力\
\
备注：不包含功能：不显示、不管理任务栏 `Win+1`、`Win+2` 任务栏顺序快捷键

## 1. 功能定位

本功能的最终目标是把 Bugzia 做成一个 Windows 全系统快捷键管理中心。

它要解决的问题是：电脑里安装的软件越来越多，每个软件都可能注册全局快捷键或内置快捷键，用户很难知道哪个快捷键被谁占用、哪里发生冲突、哪些快捷键可以关闭。Bugzia 应该提供一个统一入口，尽可能发现、解释和管理这些快捷键。

最终形态包括：

- 查看 Windows 可检测到的快捷键。（包括 Bugzia 自己注册的快捷键。）
- 查看 `.lnk` 快捷方式文件里的 Hotkey 字段。
- 尽可能识别电脑已安装、正在运行或用户指定的软件快捷键配置，例如 PowerToys、AutoHotkey、编辑器和启动器、元气壁纸、酷狗音乐等应用。
- 探测应用注册的全局快捷键是否与用户指定组合冲突。
- 对可修改来源直接修改或清空。
- 对不可修改来源提供禁用拦截规则。
- 对高风险系统快捷键给出警告，不做破坏性默认操作。

需要明确的是：Windows 没有一个官方 API 可以让普通程序完整枚举“所有应用已经注册的全局快捷键”。因此 Bugzia 的设计不能承诺 100% 自动知道所有来源，而应该采用分层策略：

| 层级       | 能力                     | 示例                               |
| -------- | ---------------------- | -------------------------------- |
| 可直接读取和修改 | 能知道来源，也能写回配置           | `.lnk` 快捷方式、Bugzia 自身快捷键         |
| 可适配读取和修改 | 针对具体软件写适配器             | PowerToys、AutoHotkey、部分开源/明文配置软件 |
| 可探测冲突    | 能测试某组合是否已被占用，但不一定知道占用者 | 应用通过 `RegisterHotKey` 注册的快捷键     |
| 可拦截禁用    | 不能改源头，但可以由 Bugzia 拦截按键 | 部分第三方应用快捷键、普通组合键                 |
| 高风险或不可控  | 不建议或不能禁用               | `Ctrl+Alt+Delete`、部分系统安全快捷键      |

`.lnk` 快捷方式热键查询和修改是第一阶段落地功能，但不是项目终点。它应该作为“快捷键来源适配器”之一接入整体架构。

快捷键还必须按“作用域”分类。不是所有快捷键都会造成同样级别的冲突：

| 作用域 | 含义 | 冲突影响 |
| ------ | ---- | -------- |
| 全局 | 应用未获焦点时也能触发 | 最容易冲突，应优先管理 |
| 应用内 | 只有应用窗口获焦点时触发 | 通常只在该应用内冲突 |
| 窗口/面板内 | 只在某个页面、输入框或弹窗中触发 | 冲突范围较小 |
| 未知 | 只能探测到占用，无法确认作用域 | 需要用户确认或拦截兜底 |

## 2. 当前项目基础

Bugzia 当前技术栈适合承载该功能：

| 层       | 当前技术                                 |
| ------- | ------------------------------------ |
| 桌面框架    | Tauri v2                             |
| 前端      | React + TypeScript + Vite            |
| 后端      | Rust                                 |
| 设置存储    | `settings.json` + Rust `settings.rs` |
| 现有快捷键能力 | `tauri-plugin-global-shortcut`       |

已有相关文件：

| 文件                                       | 现状                                       |
| ---------------------------------------- | ---------------------------------------- |
| `src-tauri/src/lib.rs`                   | 已有 `register_hotkeys` / `reload_hotkeys` |
| `src-tauri/src/settings.rs`              | 已有 `HotkeySettings`                      |
| `src/features/settings/settingsTypes.ts` | 前端已有 `HotkeySettings` 镜像类型               |
| `src/components/SettingsPanel.tsx`       | 已有“快捷键”设置页                               |
| `src-tauri/permissions` 或 `capabilities` | 已有 Tauri v2 能力配置结构                       |

本功能建议复用现有“快捷键”入口，但扩展为“快捷键中心”。快捷方式热键只是其中一个数据源页面，后续应继续接入应用快捷键适配器、冲突探测和禁用规则。

## 3. 范围边界

### 3.1 最终能力范围

| 功能             | 说明                                     |
| -------------- | -------------------------------------- |
| 快捷键资产清单        | 汇总 Windows、Bugzia、快捷方式、常见软件配置中的快捷键     |
| 来源识别           | 标记快捷键来自哪个应用、哪个配置文件或哪个系统来源              |
| 冲突检测           | 找出相同组合键、相近组合键、与 Bugzia 快捷键冲突的项目        |
| 快捷方式热键管理       | 读取、修改、清空、恢复 `.lnk` Hotkey              |
| Bugzia 自身快捷键管理 | 管理召唤输入框、打开设置、桌宠、便笺等动作                  |
| 应用适配器          | 针对 PowerToys、AutoHotkey、常见编辑器/启动器做配置读取 |
| 占用探测           | 测试某个组合键是否可被 Bugzia 注册，用于判断是否已被占用       |
| 禁用规则           | 对无法修改源头的普通组合键，使用键盘 Hook 拦截             |
| 安全恢复           | 修改前备份原配置，支持一键恢复                        |
| 风险标注           | 对系统关键快捷键和高风险禁用操作给出明显警告                 |

### 3.2 第一阶段包含

| 功能             | 说明                                |
| -------------- | --------------------------------- |
| 扫描 `.lnk` 快捷方式 | 读取桌面、开始菜单中的快捷方式                   |
| 展示快捷方式热键       | 显示名称、快捷键、目标、位置、作用范围               |
| 只看有热键          | 默认只显示 Hotkey 非空的快捷方式              |
| 显示全部快捷方式       | 可选开关，便于给某个快捷方式新增热键                |
| 修改热键           | 修改 `.lnk` 的 Hotkey 字段             |
| 清空热键           | 将 Hotkey 置空，相当于禁用                 |
| 备份快捷方式         | 修改前复制原 `.lnk` 到 Bugzia 数据目录       |
| 恢复备份           | 从备份恢复原快捷方式                        |
| 刷新列表           | 修改后重新扫描                           |
| 基础冲突提示         | 与 Bugzia 自身快捷键、已检测 `.lnk` 热键做冲突检查 |

### 3.3 不做或暂不做

| 不做项               | 原因                 |
| ----------------- | ------------------ |
| 任务栏 `Win+数字` 对应应用 | 用户明确不需要            |
| 承诺完整枚举所有软件全局快捷键   | Windows 没有可靠公开 API |
| 第一阶段直接修改所有软件内部快捷键 | 软件内部配置格式不统一，需要逐个适配 |
| 默认强制禁用系统快捷键       | 风险高，容易影响系统操作       |
| 默认禁用未知来源快捷键       | 可能误伤用户正在使用的工作流     |

### 3.4 管理能力分级

Bugzia UI 中每条快捷键都应显示“管理能力等级”：

| 等级 | 文案    | 含义                        |
| -- | ----- | ------------------------- |
| A  | 可直接修改 | Bugzia 能读取来源并写回，例如 `.lnk` |
| B  | 可适配修改 | 已知软件配置，可通过适配器修改           |
| C  | 可禁用拦截 | 不能改源头，但 Bugzia 可拦截该组合     |
| D  | 只能提示  | 能检测到或推断冲突，但不能可靠修改         |
| E  | 高风险   | 系统关键快捷键，不建议禁用             |

## 4. 用户界面设计

建议在设置窗口左侧导航中，将当前“快捷键”页面扩展为“快捷键中心”：

| 页面         | 内容                             |
| ---------- | ------------------------------ |
| 总览         | 快捷键数量、冲突数量、禁用规则数量、需要处理的风险项     |
| Bugzia 快捷键 | Bugzia 自身注册的全局快捷键              |
| 快捷方式热键     | `.lnk` 快捷方式 Hotkey 管理          |
| 应用快捷键      | PowerToys、AutoHotkey、常见软件配置适配器 |
| 冲突检测       | 按组合键聚合冲突，显示来源和处理建议             |
| 禁用规则       | Bugzia 拦截规则，适合无法直接修改源头的快捷键     |

也可以保留一个“快捷键”入口，内部用小型分段控制：

| 分段     | 内容               |
| ------ | ---------------- |
| 总览     | 全局统计与冲突          |
| Bugzia | 当前已有的“召唤输入框”等快捷键 |
| 快捷方式   | `.lnk` 热键查询和修改   |
| 应用     | 常见应用快捷键配置        |
| 禁用     | 拦截规则             |

### 4.1 快捷方式热键列表字段

| 字段  | 说明                           |
| --- | ---------------------------- |
| 快捷键 | 例如 `Alt+Shift+F5`，为空则显示“未设置” |
| 名称  | 快捷方式文件名，不含 `.lnk`            |
| 目标  | 程序路径、文件路径或 URL               |
| 位置  | 桌面、公共桌面、开始菜单、全局开始菜单          |
| 路径  | `.lnk` 文件完整路径                |
| 状态  | 可修改、不可修改、目标未解析等              |
| 操作  | 修改、清空、打开位置、恢复                |

### 4.2 全系统快捷键列表字段

全局列表需要统一展示不同来源的快捷键：

| 字段   | 说明                                            |
| ---- | --------------------------------------------- |
| 快捷键  | 例如 `Ctrl+Alt+F5`                              |
| 名称   | 功能名称，例如“打开 FinalShell 网站”                     |
| 来源应用 | Bugzia、Windows、PowerToys、AutoHotkey、VS Code 等 |
| 来源类型 | Bugzia、自定义快捷方式、应用配置、系统默认、探测占用、拦截规则            |
| 作用域  | 全局、应用内、窗口/面板内、未知                               |
| 管理能力 | A/B/C/D/E                                     |
| 冲突状态 | 无冲突、与 Bugzia 冲突、与应用冲突、未知占用                    |
| 置信度  | 高、中、低，用于区分“配置明确读取”和“推断/探测”结果                    |
| 当前状态 | 启用、禁用、只读、未知                                   |
| 操作   | 修改、清空、禁用、打开来源、恢复、忽略                           |

### 4.3 推荐交互

列表顶部：

- 搜索框：按名称、目标、路径过滤。
- 开关：只显示已设置快捷键。
- 来源过滤：Bugzia、快捷方式、应用、系统、禁用规则。
- 冲突过滤：只看冲突项。
- 按钮：刷新。

每行操作：

- “修改”按钮：打开小弹窗或行内编辑。
- “清空”按钮：清空 Hotkey 字段。
- “打开位置”按钮：在资源管理器中定位 `.lnk`。
- “恢复”按钮：如果有备份，恢复上一版。
- “禁用”按钮：如果来源不可直接修改，则创建 Bugzia 拦截规则。
- “忽略”按钮：冲突已知但用户选择保留时，隐藏提醒。

修改弹窗：

- 显示快捷方式名称和目标。
- 输入新快捷键，例如 `Ctrl+Alt+F9`。
- 提示支持格式。
- 保存前做格式校验。
- 保存成功后刷新列表。

### 4.4 文案建议

说明文案：

> Bugzia 会尽可能从 Windows、快捷方式文件和常见应用配置中发现快捷键。能直接修改的会提供修改入口；不能直接修改的会提供冲突提示或拦截禁用规则。

快捷方式页面说明：

> 这里管理的是 Windows 快捷方式文件中的“快捷键”字段。清空快捷键不会删除程序，也不会删除快捷方式本身，只会取消按键触发。

危险操作确认：

> 将清空此快捷方式的快捷键。快捷方式文件会先自动备份，可在本页面恢复。

拦截禁用说明：

> 此快捷键无法从源头修改。Bugzia 可以在后台拦截它，使按键不再传递给其他应用。该方式可能影响某些软件的正常操作，可随时关闭。

## 5. 数据模型

### 5.1 统一快捷键条目

建议新增 `src-tauri/src/hotkey_center.rs`，作为总入口；`.lnk` 相关读写放在 `src-tauri/src/shortcut_hotkeys.rs`，由 `hotkey_center` 调用。

统一条目结构：

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct HotkeyEntry {
    pub id: String,
    pub accelerator: String,
    pub title: String,
    pub app_name: String,
    pub source_type: HotkeySourceType,
    pub scope: HotkeyScope,
    pub manage_level: ManageLevel,
    pub enabled: Option<bool>,
    pub conflict: ConflictState,
    pub confidence: DetectionConfidence,
    pub source_path: Option<String>,
    pub target: Option<String>,
    pub actions: Vec<HotkeyAction>,
    pub note: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub enum HotkeySourceType {
    Bugzia,
    ShortcutLink,
    AppConfig,
    SystemDefault,
    ProbedOccupied,
    BlockRule,
    Manual,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub enum HotkeyScope {
    Global,
    AppLocal,
    WindowLocal,
    Unknown,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub enum ManageLevel {
    DirectModify,
    AdapterModify,
    Blockable,
    ReadOnly,
    HighRisk,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub enum DetectionConfidence {
    High,
    Medium,
    Low,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub enum ConflictState {
    None,
    Duplicate,
    ConflictsWithBugzia,
    OccupiedUnknownSource,
    Ignored,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub enum HotkeyAction {
    Modify,
    Clear,
    Disable,
    Enable,
    Block,
    Unblock,
    RevealSource,
    Restore,
    IgnoreConflict,
}
```

### 5.2 快捷方式热键条目

`.lnk` 仍保留专用结构，便于修改和恢复。

核心结构：

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ShortcutHotkeyItem {
    pub id: String,
    pub name: String,
    pub hotkey: String,
    pub target_path: String,
    pub arguments: String,
    pub shortcut_path: String,
    pub location: ShortcutLocation,
    pub can_modify: bool,
    pub status: ShortcutStatus,
    pub backup_available: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub enum ShortcutLocation {
    UserDesktop,
    PublicDesktop,
    UserStartMenu,
    CommonStartMenu,
    Other,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub enum ShortcutStatus {
    Ok,
    TargetUnresolved,
    AccessDenied,
    ReadError,
}
```

### 5.3 前端类型

建议新增：

```text
src/features/hotkeys/hotkeyCenter.ts
src/features/hotkeys/shortcutHotkeys.ts
src/features/hotkeys/hotkeyTypes.ts
```

统一类型：

```ts
export interface HotkeyEntry {
  id: string;
  accelerator: string;
  title: string;
  app_name: string;
  source_type: HotkeySourceType;
  scope: HotkeyScope;
  manage_level: ManageLevel;
  enabled: boolean | null;
  conflict: ConflictState;
  confidence: DetectionConfidence;
  source_path: string | null;
  target: string | null;
  actions: HotkeyAction[];
  note: string | null;
}

export type HotkeySourceType =
  | "Bugzia"
  | "ShortcutLink"
  | "AppConfig"
  | "SystemDefault"
  | "ProbedOccupied"
  | "BlockRule"
  | "Manual";

export type HotkeyScope =
  | "Global"
  | "AppLocal"
  | "WindowLocal"
  | "Unknown";

export type ManageLevel =
  | "DirectModify"
  | "AdapterModify"
  | "Blockable"
  | "ReadOnly"
  | "HighRisk";

export type ConflictState =
  | "None"
  | "Duplicate"
  | "ConflictsWithBugzia"
  | "OccupiedUnknownSource"
  | "Ignored";

export type DetectionConfidence =
  | "High"
  | "Medium"
  | "Low";
```

快捷方式专用类型：

```ts
export interface ShortcutHotkeyItem {
  id: string;
  name: string;
  hotkey: string;
  target_path: string;
  arguments: string;
  shortcut_path: string;
  location: ShortcutLocation;
  can_modify: boolean;
  status: ShortcutStatus;
  backup_available: boolean;
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
  | "ReadError";
```

## 6. 后端命令设计

### 6.1 快捷键中心命令

| 命令                               | 参数                                    | 返回                 | 作用           |
| -------------------------------- | ------------------------------------- | ------------------ | ------------ |
| `hotkey_center_scan`             | `include_disabled: bool`              | `Vec<HotkeyEntry>` | 汇总所有已支持来源    |
| `hotkey_center_detect_conflicts` | 无                                     | `Vec<HotkeyEntry>` | 返回带冲突状态的列表   |
| `hotkey_probe_accelerator`       | `accelerator: String`                 | `ProbeResult`      | 探测某个快捷键是否可注册 |
| `hotkey_block_rule_add`          | `accelerator: String, reason: String` | `HotkeyEntry`      | 添加拦截禁用规则     |
| `hotkey_block_rule_remove`       | `id: String`                          | `bool`             | 删除拦截规则       |
| `hotkey_block_rules_list`        | 无                                     | `Vec<HotkeyEntry>` | 查看当前禁用规则     |
| `hotkey_conflict_ignore`         | `entry_id: String`                    | `bool`             | 忽略某条冲突提示     |
| `hotkey_manual_entry_add`        | `ManualHotkeyEntry`                   | `HotkeyEntry`      | 用户手动登记某应用快捷键 |
| `hotkey_manual_entry_remove`     | `id: String`                          | `bool`             | 删除用户手动登记项    |

探测返回结构：

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ProbeResult {
    pub accelerator: String,
    pub available: bool,
    pub reason: String,
}
```

### 6.2 快捷方式命令

新增 Tauri commands：

| 命令                        | 参数                                      | 返回                        | 作用          |
| ------------------------- | --------------------------------------- | ------------------------- | ----------- |
| `shortcut_hotkeys_scan`   | `include_empty: bool`                   | `Vec<ShortcutHotkeyItem>` | 扫描快捷方式      |
| `shortcut_hotkey_set`     | `shortcut_path: String, hotkey: String` | `ShortcutHotkeyItem`      | 设置或修改热键     |
| `shortcut_hotkey_clear`   | `shortcut_path: String`                 | `ShortcutHotkeyItem`      | 清空热键        |
| `shortcut_hotkey_restore` | `shortcut_path: String`                 | `ShortcutHotkeyItem`      | 恢复最近备份      |
| `shortcut_hotkey_reveal`  | `shortcut_path: String`                 | `bool`                    | 在资源管理器中定位文件 |

### 6.3 应用适配器命令

应用适配器不建议一次性全做，而是逐个增加。

| 命令                        | 参数                                      | 返回                     | 作用            |
| ------------------------- | --------------------------------------- | ---------------------- | ------------- |
| `app_hotkey_sources_list` | 无                                       | `Vec<AppHotkeySource>` | 查看当前支持的软件适配器  |
| `app_hotkeys_scan`        | `source_id: Option<String>`             | `Vec<HotkeyEntry>`     | 扫描应用配置快捷键     |
| `app_hotkey_set`          | `entry_id: String, accelerator: String` | `HotkeyEntry`          | 修改适配器支持的应用快捷键 |
| `app_hotkey_disable`      | `entry_id: String`                      | `HotkeyEntry`          | 禁用适配器支持的应用快捷键 |
| `app_hotkey_detect_installed_apps` | 无                               | `Vec<AppCandidate>`    | 检测可能需要适配的已安装/运行应用 |
| `app_hotkey_adapter_set_enabled` | `source_id: String, enabled: bool` | `bool`                 | 开关某个应用适配器 |

注册位置：

`src-tauri/src/lib.rs`

```rust
mod hotkey_center;
mod shortcut_hotkeys;

use hotkey_center::{
    hotkey_block_rule_add,
    hotkey_block_rule_remove,
    hotkey_block_rules_list,
    hotkey_center_detect_conflicts,
    hotkey_center_scan,
    hotkey_conflict_ignore,
    hotkey_probe_accelerator,
};
use shortcut_hotkeys::{
    shortcut_hotkey_clear,
    shortcut_hotkey_restore,
    shortcut_hotkey_reveal,
    shortcut_hotkey_set,
    shortcut_hotkeys_scan,
};
```

并添加到 `tauri::generate_handler!`。

## 7. Windows `.lnk` 热键读写方案

`.lnk` 是第一阶段最稳定的数据源。它可以直接读取、修改、清空和恢复，适合作为整个快捷键中心的第一块可交付能力。

### 7.1 推荐实现方式

使用 Windows Shell Link COM 接口：

- `IShellLinkW`
- `IPersistFile`
- `GetHotkey`
- `SetHotkey`
- `GetPath`
- `GetArguments`

Rust 中可以使用 `windows` crate 调用。

当前项目已经依赖 `windows = "0.56"`，但现有 feature 不够，需要补充：

```toml
windows = { version = "0.56", features = [
  "Win32_Foundation",
  "Win32_System_Com",
  "Win32_System_Diagnostics_ToolHelp",
  "Win32_UI_Shell",
  "Win32_UI_WindowsAndMessaging",
] }
```

如果 `IShellLinkW` 相关类型需要更细 feature，再按编译报错补充。

### 7.2 快捷键编码

Shell Link Hotkey 是一个 `WORD`：

- 低字节：虚拟键码
- 高字节：修饰键

常用修饰键：

| 修饰键     | 标志                |
| ------- | ----------------- |
| `Shift` | `HOTKEYF_SHIFT`   |
| `Ctrl`  | `HOTKEYF_CONTROL` |
| `Alt`   | `HOTKEYF_ALT`     |

注意：

- `.lnk` 快捷方式热键通常要求包含 `Ctrl`、`Alt`、`Shift` 等修饰键。
- Windows 快捷方式属性页中常见格式是 `Ctrl+Alt+X`。
- `Win` 键不属于 `.lnk` Hotkey 字段的常规支持范围。

### 7.3 字符串格式

前端统一使用：

```text
Ctrl+Alt+F5
Ctrl+Shift+K
Alt+Shift+F5
```

后端需要提供双向转换：

```rust
fn hotkey_word_to_string(value: u16) -> String;
fn hotkey_string_to_word(input: &str) -> Result<u16, String>;
```

转换规则：

- 大小写不敏感。
- 支持 `Ctrl` / `Control`。
- 支持 `Alt`。
- 支持 `Shift`。
- 支持 `F1` 到 `F24`。
- 支持字母 `A` 到 `Z`。
- 支持数字 `0` 到 `9`。
- 空字符串表示清空。
- 不支持 `Win`，遇到时返回明确错误。

## 8. 应用快捷键发现与管理策略

### 8.1 Windows 的关键限制

很多应用会通过 Win32 `RegisterHotKey` 注册全局快捷键，或者使用低级键盘 Hook 监听按键。Windows 没有公开 API 允许另一个普通应用完整枚举这些注册项。

因此，Bugzia 无法保证自动列出“所有应用注册的所有快捷键及来源”。可行策略是：

| 策略         | 能力             | 局限         |
| ---------- | -------------- | ---------- |
| 配置适配器      | 能知道来源，能读写      | 需要逐个软件适配   |
| 注册探测       | 能知道某个组合键是否已被占用 | 不一定知道占用者是谁 |
| 进程/窗口关联    | 可辅助推断占用者       | 不可靠，只能作为提示 |
| 键盘 Hook 拦截 | 可禁用部分按键传递      | 不能修改源头，需常驻 |
| 用户标注       | 用户手动补充来源       | 依赖用户确认     |

### 8.2 应用适配器机制

建议把每类软件做成一个 Hotkey Source Adapter。

统一接口：

```rust
pub trait HotkeySourceAdapter {
    fn source_id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn is_available(&self) -> bool;
    fn scan(&self) -> Result<Vec<HotkeyEntry>, String>;
    fn set(&self, entry_id: &str, accelerator: &str) -> Result<HotkeyEntry, String>;
    fn disable(&self, entry_id: &str) -> Result<HotkeyEntry, String>;
}
```

适配器优先级：

| 优先级 | 软件/来源                      | 原因                 |
| --- | -------------------------- | ------------------ |
| P0  | Bugzia 自身快捷键               | 项目已有能力，完全可控        |
| P0  | `.lnk` 快捷方式                | Windows 原生可读写，风险低  |
| P1  | AutoHotkey                 | 很多用户用它自定义热键，脚本通常明文 |
| P1  | PowerToys Keyboard Manager | 常见键盘映射/快捷键管理工具     |
| P2  | VS Code / Cursor           | 快捷键配置多，冲突常见，配置可读   |
| P2  | Windows Terminal           | 配置文件可读，快捷键可查       |
| P3  | 浏览器扩展/应用内部快捷键              | 生态复杂，后续按需适配        |

### 8.2.1 应用发现策略

Bugzia 不应全盘扫描所有文件来猜快捷键来源，而应使用低噪声、可解释的应用发现方式：

| 来源 | 作用 | 备注 |
| ---- | ---- | ---- |
| 正在运行进程 | 找出当前可能占用全局快捷键的应用 | 通过进程名、窗口标题、可执行文件路径识别 |
| 开机启动项 | 找出常驻后台工具 | 包括启动文件夹和注册表 Run 项 |
| 开始菜单快捷方式 | 发现已安装桌面应用 | 只读取 `.lnk` 元数据 |
| 已知配置路径 | 判断适配器是否可用 | 例如 PowerToys、AutoHotkey、VS Code |
| 用户手动添加 | 补充无法自动识别的软件 | 适合元气壁纸、酷狗音乐、截图/录屏工具等闭源应用 |

候选应用结构：

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AppCandidate {
    pub id: String,
    pub name: String,
    pub exe_path: Option<String>,
    pub process_name: Option<String>,
    pub window_title: Option<String>,
    pub detection_source: Vec<String>,
    pub adapter_source_id: Option<String>,
    pub likely_hotkey_owner: bool,
    pub note: Option<String>,
}
```

应用发现的目标不是直接断言“这个应用一定注册了某快捷键”，而是：

- 告诉用户哪些应用可能参与快捷键冲突。
- 决定哪些适配器可启用。
- 为未知占用提供线索，例如“当前运行的快捷键类应用：PowerToys、AutoHotkey、某录屏工具”。
- 支持用户手动把“未知占用”标注为某个应用。

### 8.2.2 闭源应用处理策略

对元气壁纸、酷狗音乐、微信、QQ、截图/录屏工具这类闭源软件，通常不要直接改写其私有配置。推荐流程：

1. 通过进程/启动项/开始菜单识别它们是否存在。
2. 如果有公开设置入口，提供“打开应用设置/打开安装目录/显示处理建议”。
3. 如果无法读取配置，则标记为 `ReadOnly` 或 `Blockable`。
4. 用户确认不需要该快捷键时，创建 Bugzia 拦截规则。
5. 用户能手动标注“这个未知占用来自某应用”，用于后续冲突说明。

这类应用的 UI 文案应避免说“已读取该应用快捷键”，除非适配器真的读到了配置。更准确的说法是：

> Bugzia 无法直接读取此应用的快捷键配置。你可以在应用内关闭该快捷键，或让 Bugzia 拦截这个组合键。

### 8.3 AutoHotkey 适配器

扫描范围：

- 正在运行的 AutoHotkey 进程命令行。
- 启动目录中的 `.ahk`、`.lnk`。
- 用户指定的 `.ahk` 脚本路径。

识别规则：

- 解析 `^`、`!`、`+`、`#` 等修饰符。
- 识别 `::` 热字符串。
- 识别 `Hotkey` 命令的简单形式。

管理策略：

- 第一版只读扫描。
- 第二版支持禁用某条规则：注释对应行并备份原文件。
- 对复杂脚本只提示“需要手动处理”，不自动改写。

### 8.4 PowerToys 适配器

扫描范围：

- `%LOCALAPPDATA%\Microsoft\PowerToys`
- `%APPDATA%\Microsoft\PowerToys`

管理策略：

- 读取 Keyboard Manager 配置。
- 展示键盘重映射和快捷键重映射。
- 修改前备份配置文件。
- 写回后提示用户重启 PowerToys 或等待其自动重载。

### 8.5 VS Code / Cursor 适配器

扫描范围：

- `%APPDATA%\Code\User\keybindings.json`
- `%APPDATA%\Cursor\User\keybindings.json`
- Insiders 或便携版路径后续补充。

管理策略：

- 读取用户自定义快捷键。
- 标记内置默认快捷键为“只读提示”，不尝试完整导出。
- 修改只针对用户 `keybindings.json`。

### 8.6 占用探测

对于未知来源的全局快捷键，可以做“可注册性探测”：

1. 用户输入一个组合键。
2. Bugzia 尝试通过 Tauri global shortcut 或 Win32 `RegisterHotKey` 注册。
3. 如果注册失败，说明大概率已经被系统或应用占用。
4. 立即释放探测注册。
5. UI 显示“已被占用，来源未知”。

注意：

- 这只能探测指定组合键，不是全量扫描。
- 不应暴力枚举大量组合键，避免影响系统和用户输入。
- 探测失败不一定能知道占用者。

### 8.7 拦截禁用

当快捷键来源不可修改，但用户明确想禁用，可以创建 Bugzia 拦截规则。

实现方式：

- Windows 使用 `WH_KEYBOARD_LL` 低级键盘 Hook。
- 匹配用户配置的组合键。
- 命中后返回非零值，阻止事件继续传递。

安全限制：

- 默认不拦截系统关键组合。
- 拦截规则必须可一键关闭。
- Bugzia 退出后拦截自动失效。
- UI 必须显示“这是拦截，不是源头修改”。

高风险默认禁止：

| 快捷键               | 原因                       |
| ----------------- | ------------------------ |
| `Ctrl+Alt+Delete` | Windows 安全序列，普通应用不能也不应拦截 |
| `Win+L`           | 锁屏，涉及安全                  |
| `Ctrl+Shift+Esc`  | 任务管理器，应保留救援入口            |
| `Alt+Tab`         | 核心窗口切换，拦截风险高             |
| `Win+R`           | 核心系统入口，默认不建议禁用           |

## 9. 扫描目录

只扫描以下目录，避免全盘扫描：

| 位置     | 路径                                                    |
| ------ | ----------------------------------------------------- |
| 用户桌面   | `%USERPROFILE%\Desktop`                               |
| 公共桌面   | `%PUBLIC%\Desktop`                                    |
| 用户开始菜单 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs`     |
| 全局开始菜单 | `%ProgramData%\Microsoft\Windows\Start Menu\Programs` |

Rust 中建议通过环境变量解析：

```rust
std::env::var("USERPROFILE")
std::env::var("PUBLIC")
std::env::var("APPDATA")
std::env::var("ProgramData")
```

只递归扫描 `.lnk` 文件。

## 10. 安全策略

### 10.1 路径白名单

修改命令必须检查 `shortcut_path` 是否在允许目录中。

允许：

- 用户桌面
- 公共桌面
- 用户开始菜单
- 全局开始菜单

不允许：

- 任意用户输入路径
- 系统目录中的未知 `.lnk`
- 网络路径
- 相对路径

实现要点：

```rust
fn is_allowed_shortcut_path(path: &Path) -> bool {
    // canonicalize 后判断是否位于允许根目录内
}
```

如果路径不在白名单中，直接返回错误：

```text
不允许修改此快捷方式位置
```

### 10.2 修改前备份

每次修改或清空前，复制原 `.lnk` 到：

```text
app_data_dir/shortcut-hotkey-backups/
```

建议备份文件名：

```text
{sha256(shortcut_path)}-{timestamp}.lnk
```

同时保存索引：

```json
{
  "shortcut_path": "C:\\...",
  "backup_path": "C:\\...",
  "created_at": "2026-07-01T12:00:00+08:00",
  "operation": "set",
  "old_hotkey": "Alt+Shift+F5",
  "new_hotkey": ""
}
```

### 10.3 恢复策略

恢复时：

1. 找到该 `shortcut_path` 最近一次备份。
2. 检查目标路径仍在白名单内。
3. 用备份覆盖当前 `.lnk`。
4. 重新读取并返回最新 `ShortcutHotkeyItem`。

### 10.4 权限处理

有些全局开始菜单或公共桌面快捷方式可能需要管理员权限才能修改。

处理方式：

- 扫描时仍显示。
- `can_modify` 根据实际写权限或试探判断。
- 修改失败时显示错误，不自动提权。
- 后续可增加“以管理员身份重启 Bugzia”功能。

## 11. 前端实现方案

### 11.1 新增文件建议

```text
src/features/hotkeys/hotkeyCenter.ts
src/features/hotkeys/hotkeyTypes.ts
src/features/hotkeys/shortcutHotkeys.ts
src/components/HotkeyCenterPanel.tsx
src/components/HotkeyCenterPanel.css
src-tauri/src/shortcut_hotkeys.rs
src-tauri/src/hotkey_center.rs
```

### 11.2 `hotkeyCenter.ts`

封装统一入口：

```ts
import { invoke } from "@tauri-apps/api/core";
import type { HotkeyEntry, ProbeResult } from "./hotkeyTypes";

export async function scanHotkeyCenter(includeDisabled: boolean) {
  return invoke<HotkeyEntry[]>("hotkey_center_scan", { includeDisabled });
}

export async function detectHotkeyConflicts() {
  return invoke<HotkeyEntry[]>("hotkey_center_detect_conflicts");
}

export async function probeAccelerator(accelerator: string) {
  return invoke<ProbeResult>("hotkey_probe_accelerator", { accelerator });
}

export async function addBlockRule(accelerator: string, reason: string) {
  return invoke<HotkeyEntry>("hotkey_block_rule_add", { accelerator, reason });
}

export async function removeBlockRule(id: string) {
  return invoke<boolean>("hotkey_block_rule_remove", { id });
}
```

### 11.3 `shortcutHotkeys.ts`

封装 Tauri invoke：

```ts
import { invoke } from "@tauri-apps/api/core";

export async function scanShortcutHotkeys(includeEmpty: boolean) {
  return invoke<ShortcutHotkeyItem[]>("shortcut_hotkeys_scan", { includeEmpty });
}

export async function setShortcutHotkey(shortcutPath: string, hotkey: string) {
  return invoke<ShortcutHotkeyItem>("shortcut_hotkey_set", { shortcutPath, hotkey });
}

export async function clearShortcutHotkey(shortcutPath: string) {
  return invoke<ShortcutHotkeyItem>("shortcut_hotkey_clear", { shortcutPath });
}

export async function restoreShortcutHotkey(shortcutPath: string) {
  return invoke<ShortcutHotkeyItem>("shortcut_hotkey_restore", { shortcutPath });
}
```

### 11.4 组件状态

```ts
const [entries, setEntries] = useState<HotkeyEntry[]>([]);
const [loading, setLoading] = useState(false);
const [includeEmpty, setIncludeEmpty] = useState(false);
const [includeDisabled, setIncludeDisabled] = useState(true);
const [sourceFilter, setSourceFilter] = useState<HotkeySourceType | "all">("all");
const [conflictOnly, setConflictOnly] = useState(false);
const [query, setQuery] = useState("");
const [error, setError] = useState<string | null>(null);
```

### 11.5 快捷方式保存流程

```text
用户输入新快捷键
  -> 前端做基础格式校验
  -> 调用 shortcut_hotkey_set
  -> 后端备份 .lnk
  -> 后端写入 Hotkey
  -> 后端重新读取该项
  -> 前端更新列表
```

### 11.6 快捷方式清空流程

```text
用户点击清空
  -> 二次确认
  -> 调用 shortcut_hotkey_clear
  -> 后端备份 .lnk
  -> 后端 SetHotkey(0)
  -> 前端刷新列表
```

### 11.7 未知来源禁用流程

```text
用户输入想禁用的快捷键
  -> Bugzia 提示“这是拦截，不是源头修改”
  -> 用户确认
  -> 调用 hotkey_block_rule_add
  -> 后端保存规则
  -> 后端刷新键盘 Hook 规则表
  -> 全局列表出现一条 BlockRule
```

## 12. Tauri Capability 配置

如果通过设置窗口调用这些命令，需要给 `settings` capability 增加 invoke 权限。

当前文件：

```text
src-tauri/capabilities/settings.json
```

新增命令权限时，按项目已有 schema 生成情况处理。若当前项目默认允许全部 invoke，则无需额外增加；若 Tauri 生成的 ACL 要求声明命令，需要加入对应 command 权限。

建议保持最小权限：

```json
{
  "identifier": "hotkey-center:allow-scan"
},
{
  "identifier": "shortcut-hotkeys:allow-scan"
}
```

实际权限 identifier 需按 Tauri 生成规则或项目当前命令权限模式确认。

## 13. 错误处理

### 13.1 常见错误

| 错误        | 用户提示                            |
| --------- | ------------------------------- |
| 文件不存在     | 快捷方式已不存在，请刷新列表                  |
| 没有权限      | 当前权限无法修改此快捷方式                   |
| 路径不允许     | 出于安全限制，Bugzia 不修改此位置            |
| 快捷键格式错误   | 请输入类似 Ctrl+Alt+F5 的格式           |
| 不支持 Win 键 | 快捷方式热键不支持 Win 键                 |
| COM 读取失败  | 无法读取该快捷方式，可能已损坏                 |
| 保存失败      | 修改失败，原文件已保留                     |
| 探测失败      | 无法确认该快捷键是否被占用                   |
| 来源未知      | 该快捷键可能被其他应用占用，但 Windows 未提供来源信息 |
| 不支持自动修改   | 此应用快捷键暂不支持自动修改，可创建禁用规则或手动处理     |
| 高风险快捷键    | 该快捷键涉及系统核心操作，Bugzia 默认不禁用       |

### 13.2 失败不应破坏原文件

写入流程必须是：

1. 读取原文件成功。
2. 备份成功。
3. 写入新 Hotkey。
4. 保存 `.lnk`。
5. 重新读取验证。

如果步骤 3 到 5 失败，应提示用户可尝试恢复备份。

### 13.3 拦截失败不应影响键盘

键盘 Hook 或拦截规则异常时：

- Bugzia 应记录错误。
- 自动停用有问题的规则。
- 不应导致键盘无法输入。
- 托盘菜单应提供“暂停所有快捷键拦截”入口。

## 14. 测试清单

### 14.1 手动测试

| 场景               | 期望                    |
| ---------------- | --------------------- |
| 扫描当前用户开始菜单       | 能列出已有 Hotkey 的 `.lnk` |
| 开启“显示全部”         | 能列出没有 Hotkey 的 `.lnk` |
| 设置 `Ctrl+Alt+F9` | Windows 快捷方式属性中显示一致   |
| 清空快捷键            | Windows 快捷方式属性中显示“无”  |
| 恢复备份             | 原 Hotkey 恢复           |
| 修改无权限快捷方式        | 显示权限错误，不崩溃            |
| 输入 `Win+K`       | 明确提示不支持               |
| 输入乱码或空格          | 返回格式错误                |
| 删除某个 `.lnk` 后刷新  | 列表自动消失                |
| 扫描 Bugzia 自身快捷键  | 能看到召唤输入框快捷键           |
| 输入一个已被占用组合键探测    | 显示不可用或来源未知            |
| 添加普通禁用规则         | 按下该组合键后不再传递给应用        |
| 关闭禁用规则           | 该组合键恢复正常              |
| 高风险快捷键禁用         | 默认阻止并显示风险说明           |

### 14.2 回归测试

| 场景           | 期望                  |
| ------------ | ------------------- |
| 现有召唤输入框快捷键   | 不受影响                |
| 设置保存         | 不覆盖其他设置             |
| 启动 Bugzia    | 不因为快捷方式扫描失败而启动失败    |
| 非 Windows 平台 | 功能隐藏或显示“不支持当前系统”    |
| Hook 初始化失败   | Bugzia 仍能启动，只禁用拦截功能 |
| 应用适配器读取失败    | 只影响该来源，不影响总列表       |

## 15. 分阶段开发计划

### 阶段 1：快捷方式热键只读扫描

目标：

- 新增 Rust 模块。
- 扫描四个目录。
- 读取 `.lnk` 名称、目标、Hotkey、路径。
- 前端展示列表。

完成标准：

- 能看到本机已有快捷方式热键。
- 默认只显示 Hotkey 非空项。

### 阶段 2：快捷方式清空、修改和恢复

目标：

- 实现 `shortcut_hotkey_set`。
- 实现 `shortcut_hotkey_clear`。
- 修改前备份。
- 前端支持修改弹窗和清空确认。

完成标准：

- 能在 Bugzia 内清空或修改 `.lnk` 热键。
- Windows 快捷方式属性页能看到同步变化。
- 能恢复修改前备份。

### 阶段 3：统一快捷键中心

目标：

- 新增 `HotkeyEntry` 统一模型。
- 汇总 Bugzia 自身快捷键和 `.lnk` 快捷方式。
- 加入冲突检测。
- UI 支持来源过滤和冲突过滤。

完成标准：

- 能在一个页面看到 Bugzia 和快捷方式两类来源。
- 相同快捷键组合会被标记冲突。

### 阶段 4：应用快捷键适配器

目标：

- 增加 AutoHotkey 只读扫描。
- 增加 PowerToys Keyboard Manager 扫描。
- 增加 VS Code / Cursor 用户 keybindings 扫描。
- 将适配器结果纳入统一列表。

完成标准：

- 能识别常见软件自带或用户配置的快捷键。
- 对暂不支持修改的项目标注为“只读”或“可拦截”。

### 阶段 5：占用探测

目标：

- 实现 `hotkey_probe_accelerator`。
- 用户输入快捷键时自动探测是否可注册。
- 对未知占用显示“来源未知”。

完成标准：

- 用户在新增或修改快捷键前能知道是否可能冲突。
- 探测后立即释放注册，不长期占用按键。

### 阶段 6：禁用拦截规则

目标：

- 实现 Windows 低级键盘 Hook。
- 保存和加载禁用规则。
- UI 支持添加、暂停、删除拦截规则。
- 托盘提供“暂停所有拦截”。

完成标准：

- 用户能禁用普通应用快捷键。
- Bugzia 退出后禁用自动失效。
- 高风险系统快捷键默认不允许禁用。

## 16. 推荐最终页面结构

```text
设置
  通用
    卡片
    快捷键中心
      总览
      Bugzia 快捷键
      快捷方式热键
      应用快捷键
      冲突检测
      禁用规则
  显示
  桌面组件
  AI 与搜索
  通知
```

总览页面：

```text
[刷新] [只看冲突] [搜索快捷键或应用...]

总快捷键 42    冲突 3    可直接修改 8    可拦截 12    高风险 2

快捷键        名称              来源        能力        冲突        操作
Alt+Space     召唤输入框        Bugzia      可直接修改  无          修改
Alt+Shift+F5  FinalShell网站     快捷方式    可直接修改  无          修改 清空
Ctrl+Alt+P    某应用快捷键       AutoHotkey  可适配修改  与 Bugzia   禁用 打开来源
Ctrl+Alt+X    未知占用           探测        可拦截      来源未知    创建禁用规则
```

快捷方式热键页面：

```text
[搜索快捷方式...] [只显示已设置快捷键: 开] [刷新]

快捷键        名称              目标                  位置          操作
Alt+Shift+F5  FinalShell网站     http://...            开始菜单      修改 清空 打开位置
未设置        Chrome            chrome.exe            开始菜单      设置 打开位置
```

禁用规则页面：

```text
[新增禁用规则...] [暂停所有拦截]

快捷键        原因              状态      操作
Ctrl+Alt+X    与常用软件冲突     启用      暂停 删除
```

## 17. 结论

该功能非常适合加到 Bugzia 中，原因是：

- Bugzia 已经是常驻桌面助手。
- 项目已有全局快捷键插件和设置页。
- Rust 后端适合调用 Windows Shell Link API。
- Bugzia 的桌面助手定位适合承担“快捷键冲突管家”的角色。

最终目标可以是全系统快捷键管理中心，但实现必须分阶段推进。第一阶段先做 `.lnk` 快捷方式热键查询和修改，因为它可控、可备份、可验证；随后接入 Bugzia 自身快捷键、应用配置适配器、占用探测和拦截禁用。这样既能满足“找出冲突、禁用没用快捷键”的终局需求，也能避免一开始就陷入 Windows 无法完整枚举所有应用热键的技术陷阱。

## 附录 A：全系统快捷键来源地图

Bugzia 要做“全系统快捷键管理中心”，必须把快捷键来源拆清楚。不同来源的读取方式、修改方式和风险完全不同。

| 来源                  | 示例                         | 读取方式            | 修改方式                     | 禁用方式            | 优先级 |
| ------------------- | -------------------------- | --------------- | ------------------------ | --------------- | --- |
| Bugzia 自身快捷键        | `Alt+Space` 召唤输入框          | `settings.json` | 直接修改 Bugzia 设置           | 直接停用            | P0  |
| Windows `.lnk` 快捷方式 | 开始菜单、桌面快捷方式                | Shell Link COM  | `IShellLinkW::SetHotkey` | 清空 Hotkey       | P0  |
| Windows 默认快捷键       | `Win+E`、`Win+R`            | 内置表             | 少数可通过策略/注册表              | 不建议默认禁用         | P1  |
| PowerToys           | Keyboard Manager 映射        | 读取 PowerToys 配置 | 写回配置，重载 PowerToys        | 删除/禁用映射         | P1  |
| AutoHotkey          | `.ahk` 脚本                  | 解析脚本            | 注释/改写规则                  | 注释规则或 Bugzia 拦截 | P1  |
| VS Code / Cursor    | `keybindings.json`         | 读取 JSON         | 写回用户配置                   | 删除/注释用户配置       | P2  |
| Windows Terminal    | `settings.json` actions    | 读取 JSON         | 写回配置                     | 删除绑定或置空         | P2  |
| 浏览器/扩展              | Chrome extension shortcuts | 浏览器内部配置，路径复杂    | 通常不建议直接改                 | Bugzia 拦截       | P3  |
| 闭源应用全局热键            | 微信、QQ、录屏、截图工具等             | 通常无法枚举          | 取决于应用设置                  | Bugzia 拦截       | P3  |
| 低级键盘 Hook 应用        | 各类启动器/增强工具                 | 无通用读取方式         | 取决于应用                    | Bugzia 拦截       | P3  |

推荐原则：

- 能从源头安全修改的，优先修改源头。
- 不能从源头修改但用户明确要禁用的，才使用拦截规则。
- 来源未知时，不要假装知道归属；显示“未知占用”，让用户选择探测或拦截。
- 对系统关键快捷键默认只提示风险，不主动禁用。

## 附录 B：冲突检测算法

### B.1 标准化快捷键

所有来源读到的快捷键都先标准化成统一格式：

```text
Ctrl+Alt+F5
Ctrl+Shift+P
Alt+Space
Win+E
```

标准化规则：

- 修饰键顺序固定：`Ctrl`、`Alt`、`Shift`、`Win`。
- 大小写统一。
- `Control` 统一成 `Ctrl`。
- `CommandOrControl` 在 Windows 上统一成 `Ctrl`。
- `Option` 在 Windows 上统一成 `Alt`。
- 空格键统一成 `Space`。
- 字母统一大写。

Rust 中建议有一个专用类型：

```rust
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct NormalizedAccelerator {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win: bool,
    pub key: String,
}
```

### B.2 冲突分类

| 冲突类型        | 判断方式                 | 示例                                  |
| ----------- | -------------------- | ----------------------------------- |
| 精确冲突        | 标准化后完全相同             | Bugzia 和 AutoHotkey 都用 `Ctrl+Alt+P` |
| 与 Bugzia 冲突 | 任意来源与 Bugzia 自身快捷键相同 | `Alt+Space` 被其他工具占用                 |
| 已知应用冲突      | 两个已知来源相同             | PowerToys 与 `.lnk` 同时用一个组合          |
| 未知占用        | 探测注册失败但来源不明          | 用户输入 `Ctrl+Alt+X` 后探测不可用            |
| 高风险冲突       | 涉及系统关键快捷键            | 用户想禁用 `Win+L`                       |

### B.2.1 作用域与置信度

冲突检测不能只看快捷键字符串，还要看作用域和置信度：

| 情况 | 冲突等级 | 说明 |
| ---- | -------- | ---- |
| 两个全局快捷键完全相同 | 高 | 基本一定冲突 |
| Bugzia 全局快捷键与应用全局快捷键相同 | 高 | 应优先提示 |
| 全局快捷键与应用内快捷键相同 | 中 | 可能不冲突，但用户会困惑 |
| 两个不同应用内快捷键相同 | 低 | 通常只有各自应用获焦点时生效 |
| 探测失败但来源未知 | 中 | 确认被占用，但不能确认归属 |
| 用户手动标注来源 | 中 | 依赖用户输入，显示为“用户标注” |

`DetectionConfidence` 建议这样设置：

| 置信度 | 来源 |
| ------ | ---- |
| High | 明确配置文件、Bugzia 设置、`.lnk` COM 字段 |
| Medium | RegisterHotKey 探测、进程/窗口辅助推断、用户手动标注 |
| Low | 从窗口标题、应用名称、非结构化文本推断 |

### B.3 冲突检测流程

```text
扫描所有已支持来源
  -> 转换为 HotkeyEntry
  -> 标准化 accelerator
  -> 按 accelerator 分组
  -> 结合 scope 判断冲突等级
  -> 结合 confidence 标注可信度
  -> 组内数量 > 1 标记 Duplicate
  -> 组内含 Bugzia 全局快捷键标记 ConflictsWithBugzia
  -> 合并用户忽略列表
  -> 输出给前端
```

### B.4 用户忽略列表

有些冲突是用户故意保留的，例如一个快捷键在不同上下文中不冲突。需要支持忽略：

```json
{
  "ignored_conflicts": [
    {
      "accelerator": "Ctrl+Alt+P",
      "entry_ids": ["bugzia.open_palette", "vscode.user.keybindings.12"],
      "created_at": "2026-07-01T12:00:00+08:00",
      "reason": "用户确认保留"
    }
  ]
}
```

## 附录 C：禁用拦截实现细节

### C.1 为什么需要拦截

有些应用的快捷键无法从源头读取或修改。例如某些聊天软件、截图工具、录屏工具、启动器会在运行时注册快捷键，但配置不公开。对这类快捷键，Bugzia 只能提供“拦截禁用”。

### C.2 Windows Hook 方案

使用 Win32 低级键盘 Hook：

```text
SetWindowsHookExW(WH_KEYBOARD_LL, ...)
```

处理流程：

```text
键盘事件进入 Hook
  -> 读取当前按键和修饰键状态
  -> 组合成标准化快捷键
  -> 查询 Bugzia 禁用规则表
  -> 如果命中，返回 1 阻止事件继续传递
  -> 如果未命中，调用 CallNextHookEx
```

需要补充的 `windows` crate features：

```toml
"Win32_UI_Input_KeyboardAndMouse"
```

可能还需要：

```toml
"Win32_System_LibraryLoader"
```

### C.3 拦截规则结构

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct HotkeyBlockRule {
    pub id: String,
    pub accelerator: String,
    pub enabled: bool,
    pub reason: String,
    pub created_at: String,
    pub risk_level: BlockRiskLevel,
    pub applies_when: BlockAppliesWhen,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub enum BlockRiskLevel {
    Normal,
    Caution,
    HighRisk,
    Forbidden,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub enum BlockAppliesWhen {
    Always,
    ForegroundProcessIn(Vec<String>),
    ForegroundProcessNotIn(Vec<String>),
}
```

`BlockAppliesWhen` 用来控制拦截范围：

| 模式 | 用途 |
| ---- | ---- |
| `Always` | 全局禁用该组合键 |
| `ForegroundProcessIn` | 只在指定应用位于前台时禁用 |
| `ForegroundProcessNotIn` | 除指定应用外都禁用 |

推荐默认值是 `Always`，但高级设置里应允许用户限制到某个应用。这样可以解决“只想禁用某软件的快捷键，不想影响其他软件”的场景。

### C.4 风险分级

| 风险级别      | 行为               |
| --------- | ---------------- |
| Normal    | 可直接创建拦截规则        |
| Caution   | 二次确认             |
| HighRisk  | 默认不允许，除非用户开启高级模式 |
| Forbidden | 不允许拦截            |

默认 Forbidden：

- `Ctrl+Alt+Delete`

默认 HighRisk：

- `Win+L`
- `Alt+Tab`
- `Ctrl+Shift+Esc`
- `Win+R`
- `Win+E`

### C.5 托盘救援入口

因为 Bugzia 是常驻桌面助手，托盘菜单必须有：

```text
暂停所有快捷键拦截
```

这是防止误配规则后影响输入的救援入口。即使设置窗口打不开，也可以从托盘关闭拦截。

## 附录 D：应用适配器开发规范

每个应用适配器都必须满足这些要求：

1. 只读取明确属于该应用的配置路径。
2. 修改前必须备份。
3. 不能理解的复杂配置不要自动改写。
4. 写入后重新读取验证。
5. UI 必须标注来源文件路径。
6. 失败只影响该适配器，不影响整个快捷键中心。

### D.1 适配器元信息

```rust
pub struct HotkeyAdapterInfo {
    pub source_id: String,
    pub display_name: String,
    pub available: bool,
    pub read_supported: bool,
    pub write_supported: bool,
    pub disable_supported: bool,
    pub config_paths: Vec<String>,
    pub note: Option<String>,
}
```

### D.2 适配器开发顺序

建议顺序：

1. Bugzia 自身。
2. `.lnk` 快捷方式。
3. AutoHotkey 只读扫描。
4. PowerToys 只读扫描。
5. VS Code / Cursor 用户配置扫描。
6. AutoHotkey 简单规则禁用。
7. PowerToys 配置修改。
8. VS Code / Cursor 用户配置修改。

这样可以先把“冲突看见”做出来，再逐步增加“直接修改”。

## 附录 E：隐私与权限边界

快捷键中心会读取一些本机信息，例如进程名、窗口标题、开始菜单快捷方式、应用配置文件路径。必须把隐私边界写清楚：

| 数据 | 用途 | 存储策略 |
| ---- | ---- | -------- |
| 进程名 | 辅助判断可能的快捷键来源 | 默认不持久化，除非用户手动标注 |
| 窗口标题 | 辅助识别前台应用 | 默认不持久化 |
| 快捷方式路径 | 读取 `.lnk` Hotkey | 可存储在扫描缓存或备份索引 |
| 应用配置路径 | 适配器读取快捷键 | 只存路径和状态，不复制内容，除非备份 |
| 用户手动登记项 | 冲突检测 | 存入 `manual-entries.json` |
| 拦截规则 | 禁用快捷键 | 存入 `block-rules.json` |

原则：

- 所有数据只在本机处理。
- 不上传快捷键、窗口标题、进程列表或配置内容。
- 修改第三方配置前必须显示来源路径并备份。
- 读取闭源应用私有配置时必须谨慎；没有明确格式时只提示，不自动改写。
- 管理员权限不是默认要求；只有修改公共桌面、全局开始菜单或系统级配置时才提示需要管理员权限。

## 附录 F：本地数据存储设计

不要把所有快捷键写进 `settings.json`。建议拆成多个文件，避免设置文件膨胀，也方便恢复。

存储目录：

```text
app_config_dir/
  settings.json
  hotkey-center/
    block-rules.json
    ignored-conflicts.json
    manual-entries.json
    adapter-state.json

app_data_dir/
  shortcut-hotkey-backups/
  app-hotkey-backups/
```

### F.1 `block-rules.json`

```json
{
  "version": 1,
  "rules": [
    {
      "id": "block-ctrl-alt-x",
      "accelerator": "Ctrl+Alt+X",
      "enabled": true,
      "reason": "与常用应用冲突",
      "created_at": "2026-07-01T12:00:00+08:00",
      "risk_level": "Normal",
      "applies_when": {
        "type": "Always"
      }
    }
  ]
}
```

### F.2 `manual-entries.json`

用于保存用户手动登记的应用快捷键。它不代表 Bugzia 已经能修改该应用，只是把用户确认的信息纳入冲突检测。

```json
{
  "version": 1,
  "entries": [
    {
      "id": "manual-kugou-play-pause",
      "app_name": "酷狗音乐",
      "title": "播放/暂停",
      "accelerator": "Ctrl+Alt+P",
      "scope": "Global",
      "source_type": "Manual",
      "manage_level": "Blockable",
      "confidence": "Medium",
      "note": "用户从酷狗音乐设置中确认"
    }
  ]
}
```

对应需要给 `HotkeySourceType` 增加：

```rust
Manual,
```

手动登记项支持：

- 参与冲突检测。
- 作为未知占用的来源说明。
- 一键创建拦截规则。
- 不支持直接修改源应用，除非后续有对应适配器。

### F.3 `adapter-state.json`

用于记录每个适配器是否启用、上次扫描时间、失败原因：

```json
{
  "version": 1,
  "sources": {
    "autohotkey": {
      "enabled": true,
      "last_scan_at": "2026-07-01T12:00:00+08:00",
      "last_error": null
    },
    "powertoys": {
      "enabled": true,
      "last_scan_at": null,
      "last_error": "未发现配置目录"
    }
  }
}
```

## 附录 G：第一版验收标准

第一版不必完成所有终局能力，但必须为终局架构留接口。

最低可交付标准：

- 有“快捷键中心”页面。
- 能显示 Bugzia 自身快捷键。
- 能扫描 `.lnk` 快捷方式热键。
- 能修改、清空、恢复 `.lnk` 热键。
- 能做 Bugzia 与 `.lnk` 的基础冲突检测。
- 不包含任务栏 `Win+数字`。
- 文案明确说明“部分应用快捷键需要适配器或拦截规则”。

不合格标准：

- 只做一个孤立的 `.lnk` 页面，没有统一 `HotkeyEntry` 模型。
- 没有备份恢复。
- UI 暗示能完整枚举所有应用快捷键。
- 默认允许禁用高风险系统快捷键。
- 拦截规则没有托盘救援入口。
