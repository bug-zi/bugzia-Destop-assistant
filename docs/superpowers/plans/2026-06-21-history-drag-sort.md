# 历史对话拖拽排序 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给历史对话侧栏加拖拽排序，顺序持久化到 `conversations.json`，新对话落顶，不破坏锁/修/删/retention。

**Architecture:** 后端给 `Conversation` 加 `order` 字段，`list_conversations` 按 `(order asc, updated_at desc)` 排序，retention 与 order 解耦；新增 `reorder_conversations` 命令。前端用原生 HTML5 拖拽，drop 后乐观重排 + 异步落盘 + 失败回滚。

**Tech Stack:** Rust / Tauri v2, React 19, TypeScript。零新依赖（原生 HTML5 DnD）。

**验证策略:** 项目无测试框架（`package.json` 无 vitest/jest，`conversations.rs` 无 `#[cfg(test)]`，`CLAUDE.md` 验证闸口仅 tsc/cargo check/pnpm build + 手动验证）。故用「编译闸口 + 手动验证」替代 TDD，符合项目惯例与规则二。每个 Task 末尾过对应闸口再 commit。

**前置约定:** 所有 commit message 以 `feat(history):` 开头，并以 `Co-Authored-By: Claude <noreply@anthropic.com>` 收尾。本机 Rust 不在 PATH，运行 `cargo` 前先 `export PATH="$HOME/.cargo/bin:$PATH"`。

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `src-tauri/src/conversations.rs` | 持久化 + 排序 + retention + 命令 | `Conversation` 加 `order`；`list` 排序；`prune` 解耦；`upsert` 落顶；新增 `reorder_conversations` |
| `src-tauri/src/lib.rs` | 命令注册 | `use` + `invoke_handler` 注册 `reorder_conversations` |
| `src/features/conversations/conversations.ts` | 前端 invoke 封装 | 加 `reorderConversations` |
| `src/components/HistoryRail.tsx` | 历史侧栏 UI | 原生拖拽 state/handlers + 乐观更新 |
| `src/components/HistoryRail.css` | 样式 | `is-dragging` / `is-drag-over` / cursor |

---

## Task 1: 后端 — 建立 order 排序模型

**Files:**
- Modify: `src-tauri/src/conversations.rs`（Conversation 结构 40-55、list_conversations 196-200、prune 165-181、upsert 新建分支 243-254）

- [ ] **Step 1: `Conversation` 加 `order` 字段**

把 `conversations.rs` 的 `Conversation` 结构改为（在 `custom_title` 之后、`messages` 之前插入 `order`）:

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub locked: bool,
    /// User-set name override. When present it shadows `title` everywhere the
    /// conversation is listed, and is preserved across `upsert_conversation`
    /// (which otherwise re-derives `title` from the first user message every
    /// turn). `#[serde(default)]` so an older conversations.json still loads.
    #[serde(default)]
    pub custom_title: Option<String>,
    /// Manual sort order (smaller = higher in the list). Default 0 so an older
    /// conversations.json still loads; `list_conversations` falls back to
    /// `updated_at desc` when orders tie, so legacy data keeps its old order.
    /// New conversations get `min(order) - 1` (-> land on top). `reorder`
    /// compacts to `0..n`, which also converges any negative drift.
    #[serde(default)]
    pub order: i64,
    pub messages: Vec<ConvMessage>,
}
```

- [ ] **Step 2: `list_conversations` 按 order 排序**

把 `list_conversations` 改为加载后排序:

```rust
#[tauri::command]
pub fn list_conversations(app: AppHandle) -> Result<Vec<ConvSummary>, String> {
    let mut convs = load_all(&app)?;
    // Manual order asc; ties (e.g. legacy data where all orders default to 0)
    // fall back to updated_at desc, matching the pre-drag-sort behavior.
    convs.sort_by(|a, b| a.order.cmp(&b.order).then(b.updated_at.cmp(&a.updated_at)));
    Ok(convs.iter().map(summarize).collect())
}
```

- [ ] **Step 3: `prune` 重构为 keep-set（与 order 解耦）**

把 `prune`（retention）改为「只决定保留哪些，不重排磁盘顺序」:

```rust
/// Enforce retention: keep ALL locked + the most recent DEFAULT_KEEP_RECENT
/// unlocked (by updated_at desc). Ownership of `order`/display order now lives
/// in `list_conversations`; this fn only filters, so retained conversations
/// keep their order untouched (drop-induced holes don't affect order sorting).
fn prune(convs: Vec<Conversation>) -> Vec<Conversation> {
    let mut by_recency = convs.clone();
    // Newest first by updated_at; ties broken by created_at.
    by_recency.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(b.created_at.cmp(&a.created_at)));
    let mut keep: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut unlocked_kept = 0usize;
    for c in &by_recency {
        if c.locked {
            keep.insert(c.id.clone());
        } else if unlocked_kept < DEFAULT_KEEP_RECENT {
            keep.insert(c.id.clone());
            unlocked_kept += 1;
        }
        // else: unlocked beyond the cap -> not kept
    }
    convs.into_iter().filter(|c| keep.contains(&c.id)).collect()
}
```

- [ ] **Step 4: `upsert_conversation` 新建分支赋 order 落顶**

把 `upsert_conversation` 里的新建分支（`else { convs.push(Conversation { ... }) }`）改为带上 `order`:

```rust
    } else {
        // Land on top: smallest order wins in list_conversations.
        let min_order = convs.iter().map(|c| c.order).min().unwrap_or(0);
        convs.push(Conversation {
            id: id.clone(),
            title: derived_title,
            created_at: now,
            updated_at: now,
            locked: false,
            // No user rename yet — the auto-derived title is in effect.
            custom_title: None,
            order: min_order - 1,
            messages,
        });
    }
```

- [ ] **Step 5: `cargo check` 验证编译**

Run:
```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo check
```
Expected: 编译通过，0 error（`order` 字段有 `#[serde(default)]`，旧 JSON 仍可加载）。

- [ ] **Step 6: commit**

```bash
git add src-tauri/src/conversations.rs
git commit -m "feat(history): 后端 order 排序模型（list 按 order 排、prune 与 order 解耦、新对话落顶）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 后端 — `reorder_conversations` 命令 + 注册

**Files:**
- Modify: `src-tauri/src/conversations.rs`（末尾追加命令）
- Modify: `src-tauri/src/lib.rs`（use 10-13、invoke_handler 243 后）

- [ ] **Step 1: 在 `conversations.rs` 末尾追加 `reorder_conversations`**

追加到文件末尾（`rename_conversation` 之后）:

```rust
/// Persist a new manual order. `ordered_ids` is the full id list in the desired
/// top-to-bottom order; each conversation's `order` is set to its index (0..n),
/// so smaller order sorts first. Ids not in the list keep their current order
/// (defensive — the frontend always sends the full list). Compacting to 0..n
/// also periodically converges any negative drift from new-top inserts.
#[tauri::command]
pub fn reorder_conversations(app: AppHandle, ordered_ids: Vec<String>) -> Result<(), String> {
    let mut convs = load_all(&app)?;
    for (idx, id) in ordered_ids.iter().enumerate() {
        if let Some(c) = convs.iter_mut().find(|c| &c.id == id) {
            c.order = idx as i64;
        }
    }
    save_all(&app, &convs)?;
    Ok(())
}
```

- [ ] **Step 2: `lib.rs` 的 `use conversations::{...}` 加 `reorder_conversations`**

把 `lib.rs:10-13` 的 use 改为:

```rust
use conversations::{
    delete_conversation, get_conversation, list_conversations, reorder_conversations,
    rename_conversation, set_conversation_locked, upsert_conversation,
};
```

- [ ] **Step 3: `lib.rs` 的 `invoke_handler!` 注册新命令**

在 `invoke_handler!` 里 `rename_conversation,`（lib.rs:243）之后加一行:

```rust
            rename_conversation,
            reorder_conversations,
            search_files,
```

- [ ] **Step 4: `cargo check` 验证编译 + 命令注册**

Run:
```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo check
```
Expected: 编译通过。`generate_context!` 会校验 invoke_handler 里列出的命令都存在；若 `reorder_conversations` 拼错或漏注册会在此报错。

- [ ] **Step 5: commit**

```bash
git add src-tauri/src/conversations.rs src-tauri/src/lib.rs
git commit -m "feat(history): 新增 reorder_conversations 命令并注册

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 前端 — `reorderConversations` 封装

**Files:**
- Modify: `src/features/conversations/conversations.ts`（末尾追加）

- [ ] **Step 1: 加 `reorderConversations` 函数**

追加到 `conversations.ts` 末尾（`deriveTitle` 之后）。注意 Tauri 自动把 Rust 的 `ordered_ids` 映射为 JS 的 `orderedIds`:

```ts
/**
 * Persist a new manual order. Pass the full conversation-id list in the
 * desired top-to-bottom order. The backend reassigns each conversation's
 * `order` to its index (0..n). Called from the history rail after a drag.
 */
export function reorderConversations(orderedIds: string[]): Promise<void> {
  return invoke("reorder_conversations", { orderedIds });
}
```

- [ ] **Step 2: `tsc --noEmit` 验证类型**

Run:
```bash
pnpm exec tsc --noEmit
```
Expected: 0 error。

- [ ] **Step 3: commit**

```bash
git add src/features/conversations/conversations.ts
git commit -m "feat(history): 前端 reorderConversations invoke 封装

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 前端 — HistoryRail 拖拽交互 + 乐观更新

**Files:**
- Modify: `src/components/HistoryRail.tsx`

- [ ] **Step 1: import 加 `reorderConversations`**

把 `HistoryRail.tsx:3-9` 的 import 改为:

```tsx
import {
  listConversations,
  setConversationLocked,
  deleteConversation,
  renameConversation,
  reorderConversations,
  type ConvSummary,
} from "../features/conversations/conversations";
```

- [ ] **Step 2: 加拖拽 state**

在 `HistoryRail` 组件内（`renamingIdRef` 那一行之后）加两个 state:

```tsx
  /** Index of the item being dragged, or null. */
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  /** Index of the item the pointer is currently hovering over, or null. */
  const [overIndex, setOverIndex] = useState<number | null>(null);
```

- [ ] **Step 3: 加 `commitReorder`（乐观更新 + 失败回滚）**

在 `resume` 函数之前加:

```tsx
  /** Drop handler: splice the dragged item to the hover position (optimistic),
   *  persist the full id order, and roll back on failure. Index is corrected
   *  when dragging downward because removing the source shifts the target. */
  const commitReorder = async () => {
    if (dragIndex === null || overIndex === null || dragIndex === overIndex) {
      setDragIndex(null);
      setOverIndex(null);
      return;
    }
    const next = [...items];
    const [moved] = next.splice(dragIndex, 1);
    const target = dragIndex < overIndex ? overIndex - 1 : overIndex;
    next.splice(target, 0, moved);
    setItems(next);
    setDragIndex(null);
    setOverIndex(null);
    try {
      await reorderConversations(next.map((c) => c.id));
      // Sync any other open rails. Main ignores this ping (it only re-derives
      // titles on its own upserts) — harmless either way.
      emit(EV.HISTORY_CHANGED).catch(logErr("emit history-changed"));
    } catch (e) {
      logErr("reorder conversations")(e);
      await refresh(); // Roll back to the backend's truth.
    }
  };
```

- [ ] **Step 4: item 容器加 `draggable` + 事件 + 拖拽 className**

把 `items.map((c) => {`（HistoryRail.tsx:137）改为带 index，并把 `<div key={c.id} className=...>`（HistoryRail.tsx:140）改为:

```tsx
          items.map((c, i) => {
            const editing = editingId === c.id;
            const dragging = dragIndex === i;
            const dragOver = overIndex === i && dragIndex !== null && dragIndex !== i;
            return (
              <div
                key={c.id}
                className={
                  "history-item" +
                  (c.locked ? " is-locked" : "") +
                  (dragging ? " is-dragging" : "") +
                  (dragOver ? " is-drag-over" : "")
                }
                draggable={!editing}
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => {
                  e.preventDefault(); // allow drop
                  setOverIndex(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  void commitReorder();
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
              >
```

（其内部的 `editing ? (...) : (...)` 分支保持不变。）

- [ ] **Step 5: `tsc --noEmit` 验证类型**

Run:
```bash
pnpm exec tsc --noEmit
```
Expected: 0 error。

- [ ] **Step 6: commit**

```bash
git add src/components/HistoryRail.tsx
git commit -m "feat(history): HistoryRail 原生拖拽排序 + 乐观更新

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 前端 — HistoryRail.css 拖拽视觉反馈

**Files:**
- Modify: `src/components/HistoryRail.css`（追加到末尾）

- [ ] **Step 1: 追加拖拽状态样式**

在 `HistoryRail.css` 末尾追加:

```css
/* Drag-to-reorder states. .is-dragging fades the source; .is-drag-over marks
 * the drop target with a top accent line. Native HTML5 DnD only — no library. */
.history-item {
  cursor: grab;
}

.history-item:active {
  cursor: grabbing;
}

.history-item.is-dragging {
  opacity: 0.4;
}

.history-item.is-drag-over {
  box-shadow: inset 0 2px 0 rgba(0, 0, 0, 0.45);
}

/* While renaming, the row is an input field — grab cursor would mislead. */
.history-item:has(.history-item-edit) {
  cursor: default;
}
```

- [ ] **Step 2: `pnpm build` 验证（tsc + Vite 构建）**

Run:
```bash
pnpm build
```
Expected: 构建成功，产出 `dist/`，0 error。

- [ ] **Step 3: commit**

```bash
git add src/components/HistoryRail.css
git commit -m "feat(history): 拖拽视觉反馈样式（半透明/落点指示线/抓取光标）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 集成验证闸口

**Files:** 无（纯验证，无代码改动；若发现问题回到对应 Task 修复）

- [ ] **Step 1: 前端类型闸口**

Run:
```bash
pnpm exec tsc --noEmit
```
Expected: 0 error。

- [ ] **Step 2: 后端编译闸口（含 generate_context / capabilities 校验）**

Run:
```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo check
```
Expected: 0 error。

- [ ] **Step 3: 前端构建闸口**

Run:
```bash
pnpm build
```
Expected: 产出 `dist/`，0 error。

- [ ] **Step 4: 手动验证（pnpm tauri dev）**

Run:
```bash
export PATH="$HOME/.cargo/bin:$PATH" && pnpm tauri dev
```
逐项确认（全部通过才算交付）:

1. 历史栏有多条对话时，按住某项拖动 → 出现半透明 + 落点指示线；松手后顺序即时更新。
2. 拖拽后关闭再重开历史栏 → 顺序保持（已持久化）。
3. 重启应用 → 顺序仍保持（写入了 `conversations.json`，可打开该文件确认有 `order` 字段）。
4. 发起新对话 → 新对话落在列表顶部。
5. 锁 / 修（重命名）/ 删 / 恢复  四个既有操作均正常，无回归。
6. 编辑中（重命名 input 显示）的项不能被拖动（`draggable={!editing}`）。
7. Retention 仍按更新时间删：构造 >10 个 unlocked 对话，确认超量的旧 unlocked 被清理（locked 不受影响）。
8. 旧 `conversations.json`（无 `order` 字段）首次加载 → 列表顺序与改动前一致（tiebreaker 退回 updated_at desc）。

- [ ] **Step 5: 若 Step 1-4 全绿，无需额外 commit**

（本 Task 不产生代码改动；若验证中发现缺陷，回到对应 Task 修复并 commit。）

---

## Self-Review 记录

- **Spec 覆盖**: spec §4（后端 order 字段 / list 排序 / prune 解耦 / upsert 落顶 / reorder 命令）→ Task 1+2；spec §5（前端封装 / 拖拽 / CSS）→ Task 3+4+5；spec §6（兼容性）→ 由 `#[serde(default)]` + list tiebreaker + 纯新增命令覆盖；spec §7（验证闸口）→ Task 6。无遗漏。
- **占位符扫描**: 无 TBD/TODO/vague；每个 code step 给出完整代码。
- **类型/命名一致性**: `order: i64`（Rust）/ `reorder_conversations` / `reorderConversations` / `orderedIds` 在前后端任务间一致；`commitReorder` 索引校正与 spec §5.2 一致。
- **顺序注意**: Task 1 必须先于 Task 2（reorder 命令依赖 `order` 字段与 `save_all`）；Task 3-5 可在 Task 2 后任意顺序，但建议按序（先封装再 UI 再样式）。
