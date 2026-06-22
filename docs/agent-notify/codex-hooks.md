# Codex 接入说明（交给 Codex 自己执行）

> 你是 Codex。你的任务：在自己的用户级配置里加两样东西——一个 `notify` 程序（回合完成时通知）和一个 `PermissionRequest` hook（需要用户批准时通知），让 Bugzia 桌宠能收到信号。对接总览见同目录 `README.md`。
>
> 前提：Bugzia 桌面助手已运行，并开启「Agent 通知」总开关，接收器默认监听 `http://127.0.0.1:17890/agent-event`。Bugzia 没开时，下面的调用会失败、被静默吞掉，不影响你正常工作。

## 你要做的事（Windows，本机环境）

1. 在 `~/.codex/hooks/`（即 `C:\Users\<你>\.codex\hooks\`）下放两个 PowerShell 脚本。
2. 在 `~/.codex/config.toml`（即 `C:\Users\<你>\.codex\config.toml`）里登记 `notify` 程序和 `PermissionRequest` hook。
3. 用 `/hooks` 把新加的 hook trust 掉（Codex 对非托管 command hook 要求先 review+trust 才会运行）。

> 为什么用 wrapper 脚本而不是一行命令：Codex 的 hook 命令是 exec 式调用（程序 + 参数），不走 shell，所以重定向、管道、`||`、`;` 都不生效；必须用一个真实脚本来读输入、发请求、处理退出码。

## 第 1 步：放脚本

### `C:\Users\<你>\.codex\hooks\bugzia-codex-notify.ps1`

`notify` 程序用。Codex 把回合完成的 JSON 作为**单个 argv 参数**传进来（不是 stdin）：

```powershell
# Bugzia Codex notify bridge: forward agent-turn-complete JSON (argv) to Bugzia pet.
$json = $args[0]
if (-not $json) { exit 0 }
try {
  Invoke-RestMethod -Uri 'http://127.0.0.1:17890/agent-event?source=codex' `
    -Method Post -ContentType 'application/json' -Body $json -TimeoutSec 3 | Out-Null
} catch {}
exit 0
```

### `C:\Users\<你>\.codex\hooks\bugzia-codex-permission.ps1`

`PermissionRequest` hook 用。Codex 把 hook payload 放在 **stdin**：

```powershell
# Bugzia Codex permission bridge: forward approval-request JSON (stdin) to Bugzia pet.
try {
  $body = [Console]::In.ReadToEnd()
  if ($body) {
    Invoke-RestMethod -Uri 'http://127.0.0.1:17890/agent-event?source=codex' `
      -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 3 | Out-Null
  }
} catch {}
# 不输出任何 decision、exit 0 -> Codex 走正常审批流程，我们只做副作用通知。
exit 0
```

## 第 2 步：登记配置

编辑 `C:\Users\<你>\.codex\config.toml`，加入（若文件已有内容，合并、不要覆盖已有配置）：

```toml
# 完成：notify 程序在 agent-turn-complete 时触发
notify = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\Users\\<你>\\.codex\\hooks\\bugzia-codex-notify.ps1"]

# 需要你确认：PermissionRequest hook（仅副作用，不替用户做决定）
[[hooks.PermissionRequest]]
matcher = ".*"

[[hooks.PermissionRequest.hooks]]
type = "command"
command = 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\<你>\.codex\hooks\bugzia-codex-permission.ps1"'
timeout = 10
```

> 把 `<你>` 替换成实际用户名（本机是 `Administrator`）。
> `notify` 是数组形式，Codex 会自动把 JSON 作为最后一个参数追加进去，脚本里用 `$args[0]` 读。
> `matcher = ".*"` 表示对所有需要批准的工具都触发。

## 第 3 步：trust hook

启动 Codex 后运行 `/hooks`，检查刚加的 `PermissionRequest` hook 是否处于「待信任」状态，确认 trust。`notify` 程序属于独立配置项，一般不进 hook trust 流程，但若 `/hooks` 里有任何报红，一并 trust。

## 事件含义（确认理解后再动手）

- `notify`：目前 Codex 只对 `agent-turn-complete`（一个回合结束 / agent 停下等待）触发。payload 字段：`type`、`thread-id`、`turn-id`、`cwd`、`input-messages`、`last-assistant-message`。这对应桌宠的「done」。
- `PermissionRequest`：当 Codex **即将向用户请求批准**（shell 提权、受管网络批准等）时触发；对不需要批准的命令不触发。payload 带 `tool_name`、`tool_input`、`hook_event_name="PermissionRequest"`。我们只把 payload 转发给 Bugzia，**不返回任何 decision**，于是 Codex 照常走它原本的审批弹窗——桌宠只是多嘴提醒一句「Codex 需要你批准」。这对应桌宠的「needs」。
- 因此「需要你确认」的覆盖范围取决于你的 `approval_policy`：如果你的策略很少需要批准，needs 通知就少；这是符合预期的。

## 关键约束

- 两个脚本都必须 `exit 0`，且不往 stdout 打印业务文本。
  - `notify` 脚本：stdout 会被 Codex 忽略，但仍建议保持干净。
  - `PermissionRequest` 脚本：**不要**输出 `{"hookSpecificOutput":{"decision":...}}`，否则会替用户自动放行/拒绝。保持空 stdout，让 Codex 走正常流程。
- 必须带超时（`-TimeoutSec 3`）：Bugzia 没开时快速失败，绝不阻塞。
- 只加配置和脚本，不删不改用户已有的其它 `notify` / hook。如果用户已有 `notify`，告知用户二选一或合并，不要静默覆盖。

## 备选：不用 notify，只用 Stop hook

如果不想用 `notify` 程序，也可以用 `Stop` hook 覆盖「完成」场景。但 Codex 的 `Stop` hook 有个硬约束：**exit 0 时必须在 stdout 输出合法 JSON**（纯文本会被判无效）。脚本末尾要 `Write-Output '{}'`。`bugzia-codex-permission.ps1` 改造一份读 stdin 的 `bugzia-codex-stop.ps1`，末尾加：

```powershell
Write-Output '{}'
```

配置改为：

```toml
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\<你>\.codex\hooks\bugzia-codex-stop.ps1"'
timeout = 10
```

推荐仍用 `notify`（语义清晰、无 stdout JSON 陷阱），`Stop` hook 作为备选。

## macOS / Linux 变体（本机用不到，备查）

`~/.codex/hooks/bugzia-codex-notify.sh`（argv）：

```sh
#!/usr/bin/env sh
[ -n "$1" ] || exit 0
curl -s --connect-timeout 1 --max-time 3 -X POST 'http://127.0.0.1:17890/agent-event?source=codex' \
  -H 'Content-Type: application/json' --data "$1" >/dev/null 2>&1 || true
```

`~/.codex/hooks/bugzia-codex-permission.sh`（stdin）：

```sh
#!/usr/bin/env sh
curl -s --connect-timeout 1 --max-time 3 -X POST 'http://127.0.0.1:17890/agent-event?source=codex' \
  -H 'Content-Type: application/json' --data @- >/dev/null 2>&1 || true
```

`chmod +x` 后配置：

```toml
notify = ["/Users/<你>/.codex/hooks/bugzia-codex-notify.sh"]

[[hooks.PermissionRequest]]
matcher = ".*"
[[hooks.PermissionRequest.hooks]]
type = "command"
command = "/Users/<你>/.codex/hooks/bugzia-codex-permission.sh"
timeout = 10
```

## 验证

1. 让 Bugzia 处于运行 + Agent 通知已开启状态。
2. 跑一个短回合，结束时桌宠应弹出「Codex 完成了回合」之类气泡并切 happy 动作（done）。
3. 触发一次需要批准的操作，桌宠应弹出「Codex 需要你批准」之类气泡并切 surprise 动作（needs），同时 Codex 自己的审批弹窗照常出现（我们没替它做决定）。
4. 关掉 Bugzia 再跑一次，确认 Codex 正常工作（请求失败被静默吞掉，回合/审批不受影响）。
5. 用 `/hooks` 确认 hook 状态为已信任。

## 完成定义

- `~/.codex/config.toml` 登记了 `notify`（或 `Stop` hook）和 `PermissionRequest` hook。
- 两个 wrapper 脚本就位、可执行。
- `/hooks` 里相关 hook 已 trust。
- 回合结束和需要批准时，桌宠分别收到 done / needs 通知。
- Bugzia 关闭时，Codex 一切正常，无报错、无阻塞、审批流程不被替答。
