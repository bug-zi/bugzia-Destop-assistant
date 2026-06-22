# Claude Code 接入说明（交给 Claude Code 自己执行）

> 你是 Claude Code。你的任务：在自己的用户级配置 `~/.claude/settings.json` 里加两段 hook，让 Bugzia 桌宠能在你「完成回合」或「需要用户确认」时收到通知。对接总览见同目录 `README.md`。
>
> 前提：Bugzia 桌面助手已经跑起来，并开启了「Agent 通知」总开关，接收器默认监听 `http://127.0.0.1:17890/agent-event`。如果 Bugzia 没开，下面的命令会连接失败、被静默吞掉，不影响你正常工作。

## 你要做的事

在 `~/.claude/settings.json`（Windows 上是 `C:\Users\<你>\.claude\settings.json`）的顶层 `hooks` 字段里，加 `Stop` 和 `Notification` 两个事件。如果已有 `hooks` 键，合并进去，不要覆盖已有 hook。

两段 hook 都是「把 stdin 的 payload JSON 原样 POST 给 Bugzia，然后 exit 0、丢弃输出」。来源用 `?source=claude` 标识。

## 配置内容

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --connect-timeout 1 --max-time 3 -X POST 'http://127.0.0.1:17890/agent-event?source=claude' -H 'Content-Type: application/json' --data @- >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt|idle_prompt|elicitation_dialog",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --connect-timeout 1 --max-time 3 -X POST 'http://127.0.0.1:17890/agent-event?source=claude' -H 'Content-Type: application/json' --data @- >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

可选：再追加 `StopFailure`（API/调用失败时通知桌宠「出错了」），与上面同款 command：

```json
    "StopFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --connect-timeout 1 --max-time 3 -X POST 'http://127.0.0.1:17890/agent-event?source=claude' -H 'Content-Type: application/json' --data @- >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
```

## 事件含义（确认你理解后再动手）

- `Stop`：你回答完毕、回合结束时触发。payload 带 `last_assistant_message` 和 `background_tasks`（非空=还有后台任务在跑，桌宠会据此区分「真空闲」和「暂停等后台」）。注意：`Stop` 不支持 matcher；`Stop` 的 exit 2 会让 Claude 继续对话——所以命令末尾必须 `|| true` 保证 exit 0，绝不能干扰你的正常停止。
- `Notification`：你发出通知时触发。matcher 限定在 `permission_prompt`（需要授权）、`idle_prompt`（闲置等待）、`elicitation_dialog`（需要用户填空）这几种「需要用户」的场景。`Notification` 不能阻塞，只做副作用。
- 通用 payload 字段：`session_id`、`transcript_path`、`cwd`、`hook_event_name`。

## 关键约束

- 命令必须 `exit 0` 且丢弃 stdout/stderr（`>/dev/null 2>&1 || true`），不能把输出回灌给 Claude，也不能非零退出。
- 必须带超时（`--connect-timeout 1 --max-time 3`）：Bugzia 没开时快速失败，绝不阻塞你的流程。
- `--data @-` 是把 hook 给你的 stdin JSON 原样作为 POST body。不要改 body，Bugzia 自己分类。
- 只加配置，不删不改用户已有的其它 hook。

## Windows 注意

上面的命令假设你的 hook 走 Git Bash（本机 Claude Code 用 Git Bash 执行 hook，`curl` / `/dev/null` / `|| true` 都可用）。确认方式：你正在运行的这个会话的 shell 就是 Git Bash，所以直接用上面的形式即可。

如果发现 hook 没有走 Git Bash（`/dev/null` 报错），改用 PowerShell wrapper：建一个 `C:\Users\<你>\.claude\hooks\bugzia-claude.ps1`：

```powershell
# Bugzia Claude Code bridge: forward hook stdin JSON to Bugzia pet.
try {
  $body = [Console]::In.ReadToEnd()
  if ($body) {
    Invoke-RestMethod -Uri 'http://127.0.0.1:17890/agent-event?source=claude' `
      -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 3 | Out-Null
  }
} catch {}
exit 0
```

然后把每条 `command` 换成：

```
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\<你>\.claude\hooks\bugzia-claude.ps1"
```

## 验证

1. 确认 `~/.claude/settings.json` 是合法 JSON（用 `python -m json.tool` 或任意校验器过一遍）。
2. 让 Bugzia 处于运行 + Agent 通知已开启状态。
3. 跑一个短任务（比如让它读一个文件并回答），回合结束（`Stop`）时，桌宠应弹出「Claude 完成了回合」之类气泡并切 happy 动作。
4. 触发一次需要授权的操作（`Notification` / permission_prompt），桌宠应弹出「Claude 需要你确认」之类气泡并切 surprise 动作。
5. 关掉 Bugzia 再跑一次，确认你的正常工作完全不受影响（连接失败被静默吞掉）。

## 完成定义

- `settings.json` 合法且包含 `Stop` + `Notification`（可选 `StopFailure`）。
- 回合结束和需要确认时，桌宠分别收到 done / needs 通知。
- Bugzia 关闭时，Claude Code 一切正常，无报错、无阻塞。
