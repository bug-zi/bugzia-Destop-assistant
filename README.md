# Bugzia 桌面助手

> 一块常驻桌面的浅白玻璃长条：输入即问、即搜、即聊。

Bugzia 是一个轻量级桌面 AI 工具。桌面上常驻的是一个**半透明、无边框、不进任务栏**的长条输入框；AI 回复、文件搜索结果等长内容会进入独立的临时结果浮层，不再把主输入框拉成大矩形。

它支持 OpenAI-compatible AI 接口、流式对话、本地文件名搜索、浏览器搜索、外观实时调节、系统托盘、全局快捷键和开机自启。API Key 走系统凭据管理器安全存储，不写入普通配置文件。

技术栈：**Tauri v2 · React 19 · TypeScript · Vite 7 · Rust**

> 开发进度与逐任务说明见 [`docs/开发进度.md`](docs/开发进度.md)，产品方案见 [`docs/桌面AI对话框工具制作方案.md`](docs/桌面AI对话框工具制作方案.md)，多窗口优化方案见 [`docs/双窗口长条与结果浮层优化方案.md`](docs/双窗口长条与结果浮层优化方案.md)。

---

## 目录

- [功能特性](#功能特性)
- [项目结构](#项目结构)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [使用说明](#使用说明)
- [配置说明](#配置说明)
- [技术架构](#技术架构)
- [开发状态](#开发状态)
- [开发须知](#开发须知)
- [常见问题](#常见问题)

---

## 功能特性

### 桌面常驻长条

- 主窗口固定为搜索框长条形态，默认尺寸约为 `420 x 64`，最大高度限制为 `72`。
- 透明、无边框、不占任务栏，默认不置顶，会被其它窗口覆盖，符合桌面挂件定位。
- 拖动手柄自由摆放，可在设置中锁定位置。
- 主窗口位置、宽度、锁定状态会持久化，重启后恢复。
- AI 回复与搜索结果进入独立结果浮层，主长条不再因为交互内容变成大矩形。

### 三窗口架构

应用现在由三个 Tauri 窗口组成，三个窗口都加载同一个 `index.html`，由 `App.tsx` 按窗口 label 路由：

| 窗口 | label | 根组件 | 作用 |
|---|---|---|---|
| 主长条 | `main` | `CommandCard` | 常驻桌面输入入口、短状态、设置入口、AI/搜索分发 |
| 结果浮层 | `result` | `ResultWindow` | AI 对话、文件搜索结果、停止/清空/固定/关闭 |
| 设置弹窗 | `settings` | `SettingsWindow` | 外观、AI、搜索、锁定位置等设置 |

结果窗口按需动态创建，靠近主长条定位，隐藏时不销毁，从而保留前端镜像状态并减少重新打开的延迟。

### AI 流式对话

- 兼容 OpenAI `/chat/completions` 协议。
- Rust 后端使用 `reqwest` 发送请求，并解析 SSE 流式响应。
- 通过 Tauri `Channel<ChatEvent>` 将 token 增量推回前端。
- 支持连续对话、停止生成、清空上下文。
- 支持 Markdown 渲染，包括 GFM 表格、列表、代码块。
- 会记录服务端响应里实际回传的 model，便于确认网关实际服务的模型。
- 设置页提供“测试连接”，可用当前 Base URL、Model、API Key 发起最小请求验证。

### 搜索分发

- 纯文本或 `/ai` 走 AI 对话。
- `?关键词` 或 `/web 关键词` 调用默认浏览器搜索。
- `/file 关键词` 走本地文件名搜索，并在结果浮层中展示。
- 支持 `Ctrl+Enter` 强制浏览器搜索。
- 支持 `Alt+Enter` 强制本地文件搜索。

浏览器搜索内置 Google、Bing、百度、Perplexity，也支持自定义搜索 URL，用 `{q}` 作为关键词占位符。

### 本地文件搜索

- 第一版为实时文件名搜索，不做全文索引。
- 默认扫描 Desktop、Documents、Downloads。
- 可通过设置模型扩展自定义索引目录、忽略目录和最大结果数。
- 自动跳过常见重目录，例如 `node_modules`、`.git`、`target`、`dist`、`.venv`。
- 搜索结果包含文件名、路径、扩展名、类型、大小、修改时间。
- 支持打开文件、在 Explorer 中定位文件。

### 系统集成

- 系统托盘菜单支持显示主窗口、切换开机自启、退出应用。
- 全局快捷键 `Alt+Space` 可从任意位置唤起并聚焦主长条。
- 开机自启状态会与设置中的用户意图同步。

### 可定制外观

通过设置页滑块即可调整，改动会实时应用到当前窗口，并通过主窗口持久化：

- 背景色 R / G / B / 透明度
- 背景模糊
- 圆角
- 字号缩放

### 安全存储

- API Key 只存系统凭据管理器，服务名为 `com.bugzia.deskcard`，用户名为 `openai_api_key`。
- API Key 不写入 `settings.json`，运行时也不打印日志。
- 其余配置以 JSON 原子写盘，先写临时文件再 rename，避免进程中断导致半写入。

---

## 项目结构

```text
bugzia桌面助手/
├─ src/
│  ├─ App.tsx                              # 按 Tauri window label 路由三个窗口根组件
│  ├─ main.tsx                             # React 入口
│  ├─ components/
│  │  ├─ CommandCard.tsx/.css              # 主长条：输入、短状态、窗口位置、设置写盘、AI/搜索分发
│  │  ├─ InputBar.tsx                      # 输入框、拖动手柄、星形切换结果框、设置按钮、快捷键
│  │  ├─ ResultWindow.tsx/.css             # 结果浮层：AI 对话 / 文件结果 / 固定 / 关闭
│  │  ├─ ChatView.tsx/.css                 # 对话气泡、停止/清空、Markdown 渲染
│  │  ├─ FileResultsView.tsx/.css          # 本地文件搜索结果列表
│  │  ├─ SettingsWindow.tsx                # 设置弹窗根：广播设置变更，不直接写盘
│  │  └─ SettingsPanel.tsx/.css            # 设置表单
│  ├─ features/
│  │  ├─ ai/chat.ts                        # AI 流式对话 IPC Channel 封装
│  │  ├─ appearance/appearance.ts          # 外观 CSS 变量应用
│  │  ├─ result/resultTypes.ts             # 主窗口与结果窗口事件协议
│  │  ├─ result/resultWindow.ts            # 结果窗口创建、定位、显示、隐藏
│  │  ├─ search/command.ts                 # 命令解析、浏览器搜索、搜索引擎
│  │  └─ settings/
│  │     ├─ settingsTypes.ts               # 设置类型和默认值
│  │     ├─ settingsStore.ts               # 设置、API Key、连接测试 invoke 封装
│  │     └─ settingsWindow.ts              # 设置窗口动态创建/聚焦
│  └─ styles/theme.css                     # 玻璃主题 CSS 变量
├─ src-tauri/
│  ├─ src/
│  │  ├─ lib.rs                            # Tauri Builder、命令注册、托盘、全局快捷键、自启
│  │  ├─ ai.rs                             # OpenAI-compatible SSE 流式对话
│  │  ├─ file_search.rs                    # 本地文件名搜索、打开文件、Explorer 定位
│  │  ├─ settings.rs                       # 配置读写、keyring API Key 安全存储
│  │  └─ main.rs                           # Tauri 入口
│  ├─ capabilities/
│  │  ├─ default.json                      # main 窗口权限
│  │  ├─ result.json                       # result 窗口权限
│  │  └─ settings.json                     # settings 窗口权限
│  ├─ Cargo.toml                           # Rust 依赖
│  └─ tauri.conf.json                      # 主窗口和构建配置
├─ docs/                                   # 产品方案、开发进度、多窗口优化方案
├─ index.html
├─ vite.config.ts
├─ tsconfig.json
└─ package.json
```

---

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 18 或更高 | 前端运行时 |
| pnpm | 最新稳定版 | 包管理器，项目使用 `pnpm-lock.yaml` |
| Rust / cargo | 稳定通道 | 编译 Tauri 后端 |
| Windows | 10 / 11 | 当前主要面向 Windows，API Key 使用 Windows 凭据管理器 |

其它平台需要为 `keyring` 启用对应平台后端，并确认透明窗口、托盘、快捷键、自启能力在目标系统上的支持情况。

---

## 快速开始

```bash
# 1. 安装前端依赖
pnpm install

# 2. 若 Rust 不在 PATH，把 cargo 加入 PATH
export PATH="$HOME/.cargo/bin:$PATH"

# 3. 启动开发模式
pnpm tauri dev
```

开发模式使用 Vite 固定端口 `1520`，对应配置在 [vite.config.ts](vite.config.ts) 和 [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) 中。

### 打包发布

```bash
pnpm tauri build
```

产物在 `src-tauri/target/release/bundle/`。

---

## 使用说明

### 1. 配置 AI 接口

打开主长条右侧设置按钮，进入“AI 接口”，填写：

| 字段 | 说明 | 示例 |
|---|---|---|
| Base URL | OpenAI-compatible 接口根地址，实际请求会拼接 `/chat/completions` | `https://api.openai.com/v1` |
| Model | 模型名 | `gpt-4o-mini` |
| API Key | 接口密钥，点“保存”写入系统凭据管理器 | `sk-...` |
| System Prompt | 系统提示词 | `你是一个简洁的桌面助手，默认中文回答。` |
| Temperature | 采样温度，范围 0 到 2 | `0.7` |
| 流式输出 | 是否逐字输出 | 勾选 |

Bugzia 兼容任何符合 OpenAI Chat Completions 协议的服务，包括官方 OpenAI、各类中转服务，以及本地兼容端点。Base URL 应指向 API 根路径，例如 `/v1`，不要填写管理后台页面地址。

### 2. 输入指令

| 输入 | 动作 |
|---|---|
| `你好` | 发给 AI，结果显示在结果浮层 |
| `/ai 帮我润色一段话` | 强制走 AI 对话 |
| `?北京天气` | 用默认引擎在浏览器搜索 |
| `/web 北京天气` | 浏览器搜索 |
| `/file 论文` | 本地文件名搜索 |

快捷键：

| 快捷键 | 动作 |
|---|---|
| `Enter` | 按前缀分发，默认 AI |
| `Ctrl+Enter` | 强制浏览器搜索 |
| `Alt+Enter` | 强制本地文件搜索 |
| `Esc` | 隐藏未固定的结果浮层 |
| `Ctrl+L` | 聚焦并选中主输入框 |
| `Alt+Space` | 全局唤起并聚焦主长条 |

### 3. 结果浮层操作

- 主长条左侧的星形按钮：点击展开结果浮层，再次点击收起；浮层打开时星形填充高亮，始终反映浮层真实可见性。
- “停止生成”：中断当前流式输出。
- “清空上下文”：清空 Rust 端会话上下文，并清空结果窗口消息。
- “固定”：固定后按 Esc 不会隐藏结果窗口。
- “关闭”：隐藏结果窗口，不清空上下文。

### 4. 本地文件搜索

输入 `/file 关键词` 或使用 `Alt+Enter` 强制文件搜索。结果浮层会显示匹配文件，支持：

- 双击或点击“打开”用默认程序打开。
- 点击“文件夹”在 Explorer 中定位。

当前实现为实时文件名搜索，不做文件全文索引。

### 5. 调整外观与位置

- 设置页“外观”可调背景色、透明度、模糊、圆角、字号。
- 设置页“卡片”可锁定位置。
- 主长条左侧拖动手柄用于移动主窗口。
- 结果窗口顶部也有拖动区域，用户可临时移动结果浮层。

### 6. 系统托盘与开机自启

托盘菜单提供：

- 显示 Bugzia
- 开机自启
- 退出

应用启动时会读取 `settings.system.autostart` 并同步到 OS 自启状态。托盘中切换自启会更新设置并同步系统状态。

---

## 配置说明

### 配置文件位置

| 内容 | 存储位置 |
|---|---|
| 外观 / 窗口 / AI 非密信息 / 搜索 / 系统设置 | `%APPDATA%\com.bugzia.deskcard\settings.json` |
| API Key | Windows 凭据管理器，服务名 `com.bugzia.deskcard`，用户名 `openai_api_key` |

### 默认值摘录

```jsonc
{
  "appearance": {
    "bg_r": 255,
    "bg_g": 255,
    "bg_b": 255,
    "bg_a": 0.34,
    "blur": 18,
    "radius": 12,
    "font_scale": 1
  },
  "window": {
    "x": 0,
    "y": 0,
    "w": 0,
    "h": 0,
    "expanded": false,
    "locked": false,
    "result_h": 360
  },
  "ai": {
    "provider_name": "",
    "base_url": "",
    "model": "",
    "system_prompt": "",
    "temperature": 0.7,
    "stream": true
  },
  "search": {
    "default_engine": "google",
    "custom_engine_url": "",
    "index_dirs": [],
    "ignore_dirs": [],
    "max_results": 50
  },
  "system": {
    "autostart": true
  }
}
```

---

## 技术架构

Bugzia 是一个 Tauri 桌面应用：React 前端负责 UI、状态镜像和窗口间事件；Rust 后端负责本地能力、AI 请求代理、文件搜索和系统集成。

```text
main window
  CommandCard
    ├─ parseCommand()
    ├─ streamChat() -> Rust chat command -> SSE -> Channel<ChatEvent>
    ├─ search_files() -> Rust file_search
    ├─ openSettingsWindow()
    └─ showResultWindow()

result window
  ResultWindow
    ├─ ChatView
    └─ FileResultsView

settings window
  SettingsWindow
    └─ SettingsPanel
```

### 窗口通信

主窗口是 AI 流式请求和 `settings.json` 的权威写入者。结果窗口是展示镜像，设置窗口只广播 patch。

- `settings:updated`：设置窗口广播外观、AI、搜索、锁定状态，主窗口合并并持久化。
- `result:ready` / `result:replay`：结果窗口挂载后请求主窗口重放当前视图。
- `result:chat-*`：主窗口把 AI 流式事件转发给结果窗口。
- `command:*`：结果窗口请求主窗口停止生成、清空上下文、关闭浮层、同步固定状态。

### 后端命令

主要 Tauri 命令：

- `load_settings` / `save_settings`
- `save_api_key` / `load_api_key` / `clear_api_key`
- `chat` / `stop_chat` / `clear_context` / `get_messages`
- `test_ai_connection`
- `search_files` / `open_file` / `reveal_file`

### 权限模型

`capabilities/` 按窗口拆分授权：

- `default.json`：主窗口拥有创建 WebView、显示/隐藏、定位、改尺寸、聚焦、浏览器 opener 等权限。
- `result.json`：结果窗口只拥有自身显示/隐藏/关闭、聚焦、拖动等权限。
- `settings.json`：设置窗口只拥有关闭、聚焦、拖动等权限。

定位和改大小由主窗口发起，避免结果窗口获得过宽权限。

---

## 开发状态

| 模块 | 状态 |
|---|---|
| 透明无边框主长条 | 完成 |
| 主窗口拖动、锁定、位置记忆 | 完成 |
| 设置独立窗口与配置持久化 | 完成 |
| API Key 系统凭据管理器存储 | 完成 |
| AI 流式对话、停止、清空、上下文 | 完成，仍需真实端点手动验证 |
| AI 连接测试 | 完成 |
| 结果浮层窗口 | 完成，仍需桌面手动验证 |
| 浏览器搜索 | 完成 |
| 本地文件名搜索 | 完成 |
| 文件打开与 Explorer 定位 | 完成 |
| 系统托盘 | 完成 |
| `Alt+Space` 全局快捷键 | 完成 |
| 开机自启同步 | 完成 |

详细拆解见 [`docs/开发进度.md`](docs/开发进度.md)。

---

## 开发须知

- 本机 Rust 不在 PATH 时，运行 `cargo` / `tauri` 命令前先执行 `export PATH="$HOME/.cargo/bin:$PATH"`。
- Vite 开发端口为 `1520`，如果以后被占用，需要同步修改 [vite.config.ts](vite.config.ts) 和 [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)。
- `pnpm tauri dev` 首次可能全量编译 Rust 依赖，之后增量编译会快很多。
- `src-tauri/target/`、`dist/`、`node_modules/` 为构建产物或依赖目录，不应作为主要源码阅读入口。

常用脚本：

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 仅启动 Vite 前端 |
| `pnpm build` | `tsc` 类型检查并构建前端 |
| `pnpm tauri dev` | 开发模式，启动前端和 Tauri 后端 |
| `pnpm tauri build` | 打包发布版 |

建议交付前验证：

```bash
pnpm build
cd src-tauri
cargo check
```

涉及窗口、托盘、快捷键、文件打开、AI 流式等运行时行为时，还需要用 `pnpm tauri dev` 做桌面手动验证。

---

## 常见问题

**Q：为什么输入后主窗口不展开了？**
A：这是当前设计目标。主窗口始终保持桌面长条形态，AI 回复和文件搜索结果进入独立结果浮层，避免破坏桌面美感。

**Q：对话报错“未配置 BaseURL / Model / API Key”？**
A：打开设置，在“AI 接口”里填写 Base URL、Model、API Key，并保存 API Key。三者缺一不可。

**Q：服务器返回 HTML 或解析失败？**
A：通常是 Base URL 写成了管理后台地址，或缺少 `/v1` 这一级 API 根路径。设置页的“测试连接”会给出更直接的诊断。

**Q：API Key 保存在哪？安全吗？**
A：保存在 Windows 凭据管理器，不写入 `settings.json`。可用 `cmdkey /list` 查看系统凭据条目。

**Q：本地文件搜索为什么搜不到某些文件？**
A：当前只做文件名搜索，不做全文索引；搜索深度有限，并会跳过隐藏目录和常见重目录。后续可通过 `search.index_dirs`、`search.ignore_dirs`、`search.max_results` 扩展搜索范围和结果数。

**Q：能不能不置顶？**
A：默认就是不置顶。Bugzia 是桌面挂件，不是强压在所有窗口上方的工作台。

**Q：开机自启在哪里关？**
A：通过系统托盘菜单的“开机自启”项切换。应用启动时会同步这个设置到系统自启状态。

---

## 许可

本项目为个人自创项目，默认不开源许可。如需使用或二次开发，请先与作者联系。
