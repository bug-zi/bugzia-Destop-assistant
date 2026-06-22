# 历史对话拖拽排序 — 设计文档

- 日期: 2026-06-21
- 分支: feat/desktop-pet
- 相关提交: b2ba829（对话历史记录与锁定）、f66c6ea（对话内联重命名）
- 状态: 已确认，待实现

## 1. 背景与现状

历史对话记录侧栏（`src/components/HistoryRail.tsx`）已支持「锁 / 修（重命名）/ 删」。当前排序由后端决定：

- `src-tauri/src/conversations.rs` 中 `Conversation` 持久化于 `${app_config_dir}/conversations.json`（单文件 JSON 数组，原子写）。
- 现有字段: `id / title / created_at / updated_at / locked / custom_title / messages`，**无 order 字段**。
- `prune()`（conversations.rs:165-181）在每次 `upsert_conversation` 时按 `updated_at desc` 排序并写盘；`list_conversations` 直接按磁盘顺序返回。
- 前端 `HistoryRail.tsx` 直接渲染 `items`，不参与排序。
- Retention: 全部 `locked` 永久保留 + 最近 `DEFAULT_KEEP_RECENT = 10` 个 unlocked。

需求: 在不破坏锁/修/删的前提下，新增「拖拽排序」，顺序持久化。

## 2. 目标与非目标

### 目标
- 用户可拖拽历史项改变顺序，顺序持久化到 `conversations.json`，重启后保持。
- 新建对话落在列表顶部（符合「最新在顶」的现有习惯）。
- 不破坏现有锁/修/删/恢复/retention 行为。
- 不引入新的前端依赖（沿用项目零拖拽库现状，用原生 HTML5 DnD）。

### 非目标 (YAGNI)
- 不做「手动排序 / 按更新时间」双模式切换 —— 纯手动排序，未拖拽数据靠 tiebreaker 自动退回时间序。
- 不做跨分组、多选拖拽。
- 不做拖拽时的复杂占位动画（仅半透明 + 落点高亮指示线）。

## 3. 关键决策（已与用户对齐）

| 决策点 | 选择 |
|---|---|
| 排序模式 | 纯手动排序（order 覆盖时间序；未设置时 tiebreaker 退回 updated_at desc） |
| 新对话落点 | 顶部（order = 当前最小 order - 1） |
| 拖拽实现 | 原生 HTML5 拖拽（零新依赖） |
| order 分配策略 | A：紧凑 `0..n` + 新对话 `min-1`（允许负数，i64 安全） |
| ConvSummary 是否加 order | 否（保持前端契约形状不变，前端靠乐观更新本地重排） |

## 4. 后端设计 (`src-tauri/src/conversations.rs`)

### 4.1 数据结构
`Conversation` 新增字段（向后兼容，`#[serde(default)]`）:

```rust
#[serde(default)]
pub order: i64,   // 越小越靠前；默认 0
```

`ConvSummary` 不变。

### 4.2 `list_conversations`
改为先按 `(order asc, updated_at desc)` 排序，再 `summarize`:

```rust
let mut convs = load_all(&app)?;
convs.sort_by(|a, b| a.order.cmp(&b.order).then(b.updated_at.cmp(&a.updated_at)));
Ok(convs.iter().map(summarize).collect())
```

旧数据 `order` 全为 0 时，tiebreaker 退化为纯 `updated_at desc` —— 与现状逐字一致，零迁移。

### 4.3 `prune`（retention）
职责收窄为「决定保留哪些」，不再重排磁盘顺序:

```rust
fn prune(convs: Vec<Conversation>) -> Vec<Conversation> {
    // 选保留集: 全部 locked + 最近 DEFAULT_KEEP_RECENT 个 unlocked（按 updated_at desc）
    let mut by_recency = convs.clone();
    by_recency.sort_by(|a, b|
        b.updated_at.cmp(&a.updated_at).then(b.created_at.cmp(&a.created_at)));
    let mut keep: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut unlocked_kept = 0usize;
    for c in &by_recency {
        if c.locked {
            keep.insert(c.id.clone());
        } else if unlocked_kept < DEFAULT_KEEP_RECENT {
            keep.insert(c.id.clone());
            unlocked_kept += 1;
        }
    }
    convs.into_iter().filter(|c| keep.contains(&c.id)).collect()
}
```

保留项的原 `order` 不动；删除造成的 order 空洞不影响 list 排序。

### 4.4 `upsert_conversation`
- 新建分支: `order = convs.iter().map(|c| c.order).min().unwrap_or(0) - 1`（→ 落顶）。
- 更新已有分支: `order` 保持不变。

### 4.5 新命令 `reorder_conversations`

```rust
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

- 入参为前端拖拽后的完整 id 序列；后端按索引重赋 `order = 0..n`。
- 未出现在 `ordered_ids` 中的对话保持原 order（理论上不会发生，前端传全量；防御性处理）。
- 在 `lib.rs` 的 `invoke_handler!` 注册 `reorder_conversations`。

## 5. 前端设计

### 5.1 `src/features/conversations/conversations.ts`
新增封装（Tauri 自动 `ordered_ids → orderedIds`）:

```ts
/** Persist a new manual order. Pass the full id list in the desired top-to-bottom order. */
export function reorderConversations(orderedIds: string[]): Promise<void> {
  return invoke("reorder_conversations", { orderedIds });
}
```

`ConvSummary` 接口不变。

### 5.2 `src/components/HistoryRail.tsx`
新增拖拽状态与处理:

```ts
const [dragIndex, setDragIndex] = useState<number | null>(null);
const [overIndex, setOverIndex] = useState<number | null>(null);
```

每个 `history-item`:
- `draggable={!editing}`（编辑中的项禁拖，避免与重命名 input 冲突）。
- `onDragStart={() => setDragIndex(i)}`
- `onDragOver={(e) => { e.preventDefault(); setOverIndex(i); }}`
- `onDrop={() => void commitReorder()}`
- `onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}`

`commitReorder`（乐观更新 + 失败回滚）。语义: drop 到 `overIndex` 项上时，dragged 项占据该项的视觉位置（原项及之后整体下移）:

```ts
const commitReorder = async () => {
  if (dragIndex === null || overIndex === null || dragIndex === overIndex) {
    setDragIndex(null); setOverIndex(null); return;
  }
  const next = [...items];
  const [moved] = next.splice(dragIndex, 1);
  // 拖向下方时(dragIndex < overIndex), 移除后目标位左移一位, 需校正;
  // 否则直接用 overIndex。校正后 dragged 占据 overIndex 的视觉位置。
  const target = dragIndex < overIndex ? overIndex - 1 : overIndex;
  next.splice(target, 0, moved);
  setItems(next);                 // 乐观: 立即重排
  setDragIndex(null); setOverIndex(null);
  try {
    await reorderConversations(next.map((c) => c.id));
    emit(EV.HISTORY_CHANGED).catch(logErr("emit history-changed")); // 同步其他 rail
  } catch (e) {
    logErr("reorder conversations")(e);
    await refresh();              // 失败回滚到后端真值
  }
};
```

### 5.3 `src/components/HistoryRail.css`
新增状态样式:
- `.history-item.is-dragging` —— 半透明（`opacity: 0.4`）。
- `.history-item.is-drag-over` —— 顶部高亮指示线（`box-shadow: inset 0 2px 0 <accent>` 或顶部 border）。
- 拖拽手柄: `.history-item` `cursor: grab`（拖拽中 `cursor: grabbing`）。可加一个纯文字 grip 标记（如 `≡`，非 emoji）。

`className` 拼接:
```tsx
className={
  "history-item" + (c.locked ? " is-locked" : "")
  + (dragIndex === i ? " is-dragging" : "")
  + (overIndex === i && dragIndex !== null && dragIndex !== i ? " is-drag-over" : "")
}
```

## 6. 向后兼容（项目规则二）

- `Conversation.order` 加 `#[serde(default)]` → 旧 `conversations.json` 正常加载。
- `list_conversations` 返回类型 `Vec<ConvSummary>` 形状不变（不加字段）。
- `reorder_conversations` 为纯新增命令；现有 5 个命令（list / get / upsert / set_locked / delete / rename）签名不变。
- Retention 语义（locked 全留 + 10 个最近 unlocked）不变，仅不再借 prune 重排磁盘。
- 排序兼容: 旧数据首启时，list 的 tiebreaker 保证显示顺序与现状一致，用户无感。

## 7. 验证闸口（交付前全部通过）

1. `tsc --noEmit` —— 前端类型检查，0 错误。
2. `cargo check`（在 `src-tauri/` 下，先 `export PATH="$HOME/.cargo/bin:$PATH"`）—— 后端编译 + `generate_context` 校验命令注册。
3. `pnpm build` —— 前端构建出 `dist/`。
4. `pnpm tauri dev` 手动确认:
   - 拖拽换序，松手后顺序即时更新。
   - 刷新 / 重开历史栏 / 重启应用后顺序保持。
   - 新建对话落在列表顶部。
   - 锁 / 修 / 删 / 恢复 均不回归。
   - retention 仍按更新时间删除超量 unlocked（构造 >10 个 unlocked 验证）。
   - 旧 `conversations.json`（无 order 字段）首次加载显示顺序正确。

## 8. 风险与缓解

- **risk**: 拖拽手柄与现有 锁/修/删 按钮的事件冲突。
  **缓解**: `draggable` 放在容器 div 上；按钮 click 不会触发 drag（drag 需按住并移动）。编辑中 `editingId===c.id` 的项禁用 draggable。
- **risk**: order 长期使用趋负发散。
  **缓解**: 每次 `reorder_conversations` 将 order 紧凑化为 `0..n`，周期性收敛；i64 范围足够。
- **risk**: 多个 rail 同时打开时顺序不同步。
  **缓解**: reorder 成功后 `emit(EV.HISTORY_CHANGED)`，其他 rail 的 listener 会 refresh。
- **risk**: 乐观更新后后端持久化失败导致 UI 与磁盘不一致。
  **缓解**: catch 后 `refresh()` 回滚到后端真值。
