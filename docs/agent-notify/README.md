# Agent 通知接入说明（总览）

## 目标

让 Bugzia 桌宠在 Claude Code 或 Codex 这类编码 agent「完成工作」或「需要用户确认」时主动弹出通知。

## 架构

```
Claude Code / Codex  --(hook/notify 触发)--> curl / PowerShell --POST--> Bugzia 本地 HTTP 接收器
                                                                          (127.0.0.1:17890/agent-event)
                                                                                | 归一化分类
                                                                                v
                                                                        Tauri 事件 pet:agent-notify
                                                                                v
                                                                        PetWindow 监听 -> 桌宠弹气泡 + 切动作
```

三端只通过一个本地 HTTP 端点耦合，互不感知彼此实现。

## 协议约定（三端共同遵守）

- 地址：`http://127.0.0.1:17890/agent-event`
- 方法：`POST`，`Content-Type: application/json`
- 来源：用 query 参数 `?source=claude` 或 `?source=codex` 标识
- Body：直接转发各 agent 的原生 hook / notify JSON，不做改动
- 响应：任意 2xx，body 可空；接收端永远返回成功，避免拖累 agent
- 超时：调用方必须带超时（≤3 秒），失败静默 exit 0，不影响 agent 流程
- Bugzia 未运行时：连接失败被吞掉，无副作用
- 安全：只绑 `127.0.0.1`，可选 token 校验（Bugzia 设置里配）

## 三份文档分工

| 对象 | 文档 | 职责 |
| --- | --- | --- |
| Bugzia 项目 | `bugzia-receiver.md` | 实现本地 HTTP 接收器 + `pet:agent-notify` 通道 + 语料 + 设置 |
| Claude Code | `claude-code-hooks.md` | 在 `~/.claude/settings.json` 加 `Stop` / `Notification` hook |
| Codex | `codex-hooks.md` | 在 `~/.codex/` 配 `notify` 程序 + `PermissionRequest` hook |

## 落地顺序

1. 先做 Bugzia 侧接收器（`bugzia-receiver.md`），用 `curl` 自测能看到桌宠跳出来。
2. 再配 Claude Code（`claude-code-hooks.md`），端到端验证。
3. 最后配 Codex（`codex-hooks.md`）。

默认端口 `17890`，可在 Bugzia 设置里改；改了之后两侧 hook 里的端口要同步改。

## 事件语义对照

| 用户感知 | Claude Code 信号 | Codex 信号 | 桌宠动作 |
| --- | --- | --- | --- |
| 干完活了 / 空闲 | `Stop`（无后台任务） | `notify` 的 `agent-turn-complete` 或 `Stop` hook | happy + pleased |
| 还在后台跑 | `Stop`（`background_tasks` 非空） | （Codex 无对应） | idle + neutral |
| 需要你确认 | `Notification`（permission / idle / elicitation） | `PermissionRequest` hook | surprise + curious |
| 出错了 | `StopFailure` | （Codex 无专用失败事件） | surprise + annoyed |
