# CLAUDE.md — Bugzia 桌面助手 项目指令

本项目为 Bugzia 桌面助手（Tauri v2 + React 19 + TypeScript + Vite + Rust）。
在为本项目编写或修改代码时，必须遵守以下规则。

---

## 规则一：不使用 emoji

- 代码、注释、提交信息、文档（含 README、docs、CLAUDE.md）、用户可见的 UI 文案中，一律不使用 emoji / 表情图标。
- 例外：**仅**当需求明确要求、或是在还原既有 UI 中已存在的 emoji（如输入框拖动手柄、对话工具栏里的符号）时，才可保留；新增内容一律用纯文字表述。

---

## 规则二：新增 / 更新功能时不得破坏既有功能

任何改动在交付前，必须确认没有回归既有行为。要求：

1. **先理清影响面**：改动某个模块前，先确认它被哪些地方调用、改动会波及哪些既有功能（前端 → `src/`，后端 → `src-tauri/src/`）。
2. **不删不改既有对外契约**：Tauri 命令名、命令参数、`ChatEvent` / `AppSettings` 等数据结构的字段名与 JSON 形状必须保持向后兼容；如确需破坏性变更，需在 PR / 提交说明里显式标注。
3. **交付前过一遍验证闸口**，全部通过才算完成：
   - `tsc --noEmit`（前端类型检查，0 错误）
   - `cargo check`（后端编译 + `generate_context` 校验 conf/capabilities）
   - `pnpm build`（前端构建出 `dist/`）
   - 涉及运行时行为改动的，另用 `pnpm tauri dev` 在桌面手动确认既有交互（窗口位置记忆、外观实时生效、AI 流式对话、搜索分发）仍然正常。
4. **增量改动**：优先小步、可回滚的改动；不确定时先保留旧实现，新功能走旁路开关，确认无影响后再清理。

---

## 附：常用命令速查

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 仅启动前端（Vite） |
| `pnpm tauri dev` | 开发模式（前端 + Rust 后端） |
| `pnpm build` | `tsc` 类型检查 + Vite 构建 |
| `cargo check`（在 `src-tauri/` 下） | 后端编译检查 |

> 注：本机 Rust 不在 PATH，执行 `cargo` / `tauri` 命令前先 `export PATH="$HOME/.cargo/bin:$PATH"`。
