# Bugzia 接收器实现说明（本项目建设方阅读）

> 对接总览见 `README.md`。本文只讲 Bugzia 侧要建的东西。目标：起一个只绑 `127.0.0.1` 的 HTTP 接收器，收 Claude Code / Codex 转发来的事件，归一化后通过 Tauri 事件 `pet:agent-notify` 通知桌宠。

## 必须遵守（项目规则）

- 规则一：文档、注释、UI 文案一律不用 emoji。
- 规则二：**纯新增旁路，不动任何现有对外契约**。不删不改 Tauri 命令名、命令参数、`ChatEvent` / `AppSettings` 字段名与 JSON 形状；新设置字段全部可选、带 serde 默认。功能默认关闭，未开启时对现有行为零影响。
- 交付闸口：`tsc --noEmit`、`cargo check`、`pnpm build` 全绿；运行时行为用 `pnpm tauri dev` 手动确认。Rust 不在 PATH，先 `export PATH="$HOME/.cargo/bin:$PATH"`。

## 数据流

```
HTTP POST /agent-event?source=claude|codex
        |
        v
agent_notify.rs  -- 分类(按 source + body 字段) -->  PetAgentNotify
        |
        v
app_handle.emit("pet:agent-notify", payload)
        |
        v
PetWindow.tsx listen("pet:agent-notify")
        |  门控(锁定/睡眠/拖拽) + 冷却 + 可选失焦才报
        v
showPetNotice(line, "system") + setAction + setMood + 写短期记忆
```

## 接收端点契约（权威）

- `POST http://127.0.0.1:{port}/agent-event?source=claude|codex`
- Body：原生 JSON（Claude Code / Codex hook 的 stdin，或 Codex `notify` 的 argv JSON），原样读取
- 响应：永远 `204 No Content`（空 body），保证调用方不报错
- 非本路径请求返回 `404`；端口绑定失败只记日志，不崩溃

## 归一化事件结构

新增 Tauri 事件 `pet:agent-notify`，payload：

```ts
export type PetAgentNotify = {
  source: "claude" | "codex";
  kind: "done" | "needs" | "error" | "paused";
  title: string;        // 短标签，如 "Claude 完成了回合"
  summary?: string;     // 可选摘要，如 last message 片段（仅 showContent=true）
  tool?: string;        // Codex permission 的 tool_name
  sessionId?: string;
  receivedAt: number;   // epoch ms
};
```

## 分类规则（在 Rust 里实现）

`source` 来自 query。`kind` 来自 body 字段：

| source | body 判定 | kind | title | summary 来源 |
| --- | --- | --- | --- | --- |
| claude | `hook_event_name === "Stop"` 且 `background_tasks` 为空 | done | Claude 完成了回合 | `last_assistant_message` 片段 |
| claude | `hook_event_name === "Stop"` 且 `background_tasks` 非空 | paused | Claude 还在后台跑 | 无 |
| claude | `hook_event_name === "StopFailure"` | error | Claude 出错了 | 无 |
| claude | `hook_event_name === "Notification"` 且 `notification_type` ∈ {`permission_prompt`, `idle_prompt`, `elicitation_dialog`} | needs | `title` 或 "Claude 需要你确认" | `message` |
| codex | `type === "agent-turn-complete"`（notify） | paused | Codex 停下来了，去看看 | `last-assistant-message` 片段 |
| codex | `hook_event_name === "Stop"` | paused | Codex 停下来了，去看看 | `last_assistant_message` 片段 |
| codex | `hook_event_name === "PermissionRequest"` | needs | Codex 需要你批准 | `tool_input.description`，`tool` = `tool_name` |
| 其他 | 不识别 | （忽略，不 emit） | | |

> Codex 的 `agent-turn-complete` 与 `Stop` 都是**回合边界**信号：停在一步、停下来问你问题、被打断、被限流时都会触发，并不代表任务成功完成；Codex 没有可靠的「任务完成」事件，因此一律按 `paused` 处理（去确认），而非庆祝式的 `done`。Claude 的 `Stop` 才能凭 `background_tasks` 区分空闲（done）与「还在后台跑」（paused）。

处理约束：

- `summary` 截断到约 40 字符。
- 设置 `agent_notify_show_content = false`（默认）时，不携带 `summary`，只报 title（隐私优先）。
- 按设置里的 `on_done` / `on_needs` / `on_error` 开关过滤；关掉的 kind 不 emit。

## 要新增 / 修改的文件

### 1. `src-tauri/Cargo.toml`

新增依赖（推荐 `tiny_http`，同步、轻量、无需 async runtime）：

```toml
tiny_http = "0.12"
```

> 备选：不引依赖，用 `std::net::TcpListener` 手写极简 HTTP。但 `tiny_http` 更稳，建议采用。

### 2. `src-tauri/src/agent_notify.rs`（新建）

职责：起线程绑定 `127.0.0.1:{port}`，循环收请求，分类后 emit。骨架：

```rust
use serde_json::Value;
use std::thread;
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Response, Server};

const PATH: &str = "/agent-event";

pub fn start(app: AppHandle, port: u16, token: Option<String>) {
    let addr = format!("127.0.0.1:{port}");
    let server = match Server::http(&addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[agent_notify] bind {addr} failed: {e}; feature disabled");
            return;
        }
    };
    println!("[agent_notify] listening on http://{addr}{PATH}");

    thread::spawn(move || {
        for mut req in server.incoming_requests() {
            // 只处理 POST /agent-event
            if req.method() != &Method::Post || !req.url().starts_with(PATH) {
                let _ = req.respond(Response::empty(404));
                continue;
            }

            // 解析 source 与 token
            let url = req.url().to_string();
            let source = parse_query(&url, "source");
            if let Some(t) = &token {
                if parse_query(&url, "token") != Some(t.clone()) {
                    let _ = req.respond(Response::empty(401));
                    continue;
                }
            }

            // 读 body
            let mut body = String::new();
            if req.as_reader().read_to_string(&mut body).is_err() {
                let _ = req.respond(Response::empty(400));
                continue;
            }

            if let Ok(json) = serde_json::from_str::<Value>(&body) {
                if let Some(payload) = classify(&source, &json) {
                    let _ = app.emit("pet:agent-notify", payload);
                }
            }
            let _ = req.respond(Response::empty(204));
        }
    });
}

// classify: 按「分类规则」表把原生 JSON 映射成 PetAgentNotify payload（serde_json::Value）。
// 返回 None 表示忽略。
fn classify(source: &Option<String>, body: &Value) -> Option<Value> {
    // TODO: 按 README 分类表实现。done/needs/error/paused。
    // 注意 summary 截断 + showContent 过滤由调用方设置传入；MVP 可先不过滤，前端再判。
    None
}

fn parse_query(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    for kv in q.split('&') {
        if let Some((k, v)) = kv.split_once('=') {
            if k == key {
                return Some(v.to_string());
            }
        }
    }
    None
}
```

实现要点：

- `classify` 落地「分类规则」整张表；`done/needs/error/paused` 都要支持。
- `summary` 截断到 40 字符。
- 读取设置里的 `on_done/on_needs/on_error` 做过滤（可在 emit 前判，也可在 `classify` 入参传开关）。
- 只绑 `127.0.0.1`，绝不绑 `0.0.0.0`。

### 3. `src-tauri/src/lib.rs`

在 `setup` 钩子里读取设置，启用时调 `agent_notify::start(...)`：

```rust
let app_handle = app.handle().clone();
let settings = app.state::<SettingsState>(); // 沿用项目现有设置读取方式
let cfg = settings.read(); // 或现有的取值方式
if cfg.agent_notify_enabled {
    agent_notify::start(
        app_handle,
        cfg.agent_notify_port,
        cfg.agent_notify_token.clone(),
    );
}
```

> 具体取设置的方式对齐项目里现有写法（`settings.rs` 里如何暴露给 `lib.rs`）。只启动一次，不要重复绑定。

### 4. `src-tauri/src/settings.rs`

新增字段（全部 `#[serde(default)]`，向后兼容）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `agent_notify_enabled` | bool | false | 总开关 |
| `agent_notify_port` | u16 | 17890 | 监听端口 |
| `agent_notify_token` | Option<String> | None | 可选校验 token |
| `agent_notify_on_done` | bool | true | 完成时通知 |
| `agent_notify_on_needs` | bool | true | 需要确认时通知 |
| `agent_notify_on_error` | bool | true | 出错时通知 |
| `agent_notify_cooldown_ms` | u64 | 8000 | 同类通知最小间隔 |
| `agent_notify_show_content` | bool | false | 是否在气泡里显示内容摘要（隐私） |
| `agent_notify_only_unfocused` | bool | true | 仅在主/桌宠窗口失焦时弹（防刷屏） |

### 5. `src/features/settings/settingsTypes.ts`

镜像上面字段（全部可选，带默认值），保持与 `AppSettings` 的 JSON 形状一致。

### 6. `src/features/petAgent/petAgentNotify.ts`（新建）

```ts
import type { ActionKey, MoodKey } from "./petTypes"; // 复用现有动作/情绪类型

export type PetAgentNotifyKind = "done" | "needs" | "error" | "paused";

export type PetAgentNotify = {
  source: "claude" | "codex";
  kind: PetAgentNotifyKind;
  title: string;
  summary?: string;
  tool?: string;
  sessionId?: string;
  receivedAt: number;
};

// kind -> 动作 / 情绪
export const AGENT_NOTIFY_MOOD: Record<
  PetAgentNotifyKind,
  { action: ActionKey; mood: MoodKey }
> = {
  done: { action: "happy", mood: "pleased" },
  needs: { action: "surprise", mood: "curious" },
  error: { action: "surprise", mood: "annoyed" },
  paused: { action: "idle", mood: "neutral" },
};
```

> 类型名（`ActionKey` / `MoodKey`）对齐 `petAgent` 里现有定义；若项目里叫别的名字，按实际的来。

### 7. `src/features/petAgent/petCorpus.ts`

新增语料桶，按 `kind` × `source` 分句，复用现有语料选择工具。示例方向：

- done / claude：Claude 那家伙交差了，去看看。
- done / codex：Codex 跑完了，别让它干等。
- needs / claude：喂，Claude 在等你一句话。
- needs / codex：Codex 要你点头才肯动。
- error：有个 agent 报错了，别装没看见。
- paused：后台还在跑，先别走开。

### 8. `src/components/PetWindow.tsx`

在现有 `pet:input-preview` 监听旁，新增：

```ts
listen<PetAgentNotify>("pet:agent-notify", (e) => {
  const n = e.payload;
  // 门控：锁定时跳过；拖拽中跳过；睡眠中允许（气泡可见）
  // 冷却：按 kind 维护 lastTime，小于 agent_notify_cooldown_ms 则跳过
  // 失焦判断：agent_notify_only_unfocused 且窗口处于焦点时跳过
  // 过滤：on_done/on_needs/on_error 开关
  // 选语料 -> showPetNotice(line, "system")
  // setAction + setMood 用 AGENT_NOTIFY_MOOD[n.kind]
  // 写入短期记忆（沿用 petMemory）
});
```

实现要点：

- 门控、冷却、优先级沿用现有 `petInput` / `showPetNotice` 那套机制，提示优先级用 `system`（不抢用户主动交互）。
- `agent_notify_only_unfocused`：用 Tauri 的窗口焦点 API 判断主窗口或桌宠窗口是否失焦；失焦才弹，避免用户正盯着屏幕还被刷。
- 锁定（鼠标穿透）时建议跳过（避免无意义打扰）；睡眠时允许（气泡照常显示）。

### 9. `src/components/SettingsPanel.tsx`

「桌宠」区域下新增「Agent 通知」小节：

- 启用 Agent 通知（总开关）
- 端口（仅启用时可编辑）
- 校验 token（可选）
- 完成时通知 / 需要确认时通知 / 出错时通知（三个 checkbox）
- 通知冷却（毫秒）
- 显示内容摘要（隐私开关）
- 仅失焦时通知

> 改端口需重启应用生效（接收器只在启动时绑定）。

## 自测（curl）

启用总开关后，`pnpm tauri dev` 运行，依次执行，观察桌宠：

```bash
# Claude 完成
curl -s -X POST 'http://127.0.0.1:17890/agent-event?source=claude' \
  -H 'Content-Type: application/json' \
  -d '{"hook_event_name":"Stop","last_assistant_message":"测试通过","background_tasks":[],"session_id":"t1","cwd":"D:/x"}'

# Claude 需要确认
curl -s -X POST 'http://127.0.0.1:17890/agent-event?source=claude' \
  -H 'Content-Type: application/json' \
  -d '{"hook_event_name":"Notification","notification_type":"permission_prompt","title":"权限请求","message":"允许执行该命令吗？","session_id":"t2","cwd":"D:/x"}'

# Codex 完成（notify 形态）
curl -s -X POST 'http://127.0.0.1:17890/agent-event?source=codex' \
  -H 'Content-Type: application/json' \
  -d '{"type":"agent-turn-complete","thread-id":"t3","turn-id":"1","cwd":"D:/x","last-assistant-message":"已完成"}'

# Codex 需要批准
curl -s -X POST 'http://127.0.0.1:17890/agent-event?source=codex' \
  -H 'Content-Type: application/json' \
  -d '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -rf build","description":"删除构建产物"},"session_id":"t4","cwd":"D:/x"}'
```

预期：每条都让桌宠弹对应气泡并切换动作/情绪；冷却期内重复的同类被跳过。

## 风险与边界

- 端口冲突：绑定失败只记日志、功能关闭，不崩应用。
- 刷屏：靠冷却 + 仅失焦通知 + kind 开关三层过滤。
- 隐私：默认不显示内容摘要；任何日志都不要落盘完整 message。
- 多会话并发：`sessionId` 可选用于去重，MVP 不做强制。
- 桌宠未开 / 窗口未创建：事件 emit 了但无人监听，无副作用。
- 锁定状态：建议跳过通知。

## 完成定义

- 三个闸口全绿（`cargo check` / `pnpm build` / `tsc --noEmit`）。
- 默认关闭时，现有所有交互回归正常（窗口记忆、外观、AI 流式、搜索分发）。
- 上面四条 curl 自测全部能触发桌宠对应反馈。
- 设置面板可开关并改端口，重启后生效。
