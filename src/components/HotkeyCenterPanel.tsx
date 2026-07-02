import { useEffect, useMemo, useState } from "react";
import type { HotkeySettings } from "../features/settings/settingsTypes";
import type {
  ConflictInfo,
  HotkeyEntry,
  HotkeyScope,
  ManualHotkeyInput,
  ShortcutHotkeyItem,
} from "../features/hotkeys/hotkeyTypes";
import {
  addManualHotkeyEntry,
  detectHotkeyConflicts,
  hideHotkeyCenterEntry,
  listHiddenHotkeyCenterEntries,
  removeManualHotkeyEntry,
  unhideHotkeyCenterEntry,
  updateManualHotkeyEntry,
} from "../features/hotkeys/hotkeyCenter";
import {
  clearShortcutHotkey,
  hideShortcutHotkey,
  listHiddenShortcutHotkeys,
  revealShortcut,
  restoreShortcutHotkey,
  scanShortcutHotkeys,
  setShortcutHotkey,
  unhideShortcutHotkey,
} from "../features/hotkeys/shortcutHotkeys";
import "./SettingsPanel.css";

/**
 * 快捷键中心：多标签壳（总览 / Bugzia / 快捷方式）。
 * - Bugzia 自身快捷键复用既有 settings 写流程（onPatchHotkey），不新增持久化。
 * - 快捷方式走独立的 .lnk COM 命令，绝不碰 settings.json。
 * - 总览由后端 detectHotkeyConflicts 预计算 display + 冲突状态，前端不解析。
 */
type Tab = "overview" | "conflicts" | "bugzia" | "windows" | "manual" | "shortcut" | "hidden";

interface Props {
  hotkey: HotkeySettings;
  onPatchHotkey: (p: Partial<HotkeySettings>) => void;
  hkErr: string | null;
  setHkErr: (s: string | null) => void;
}

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "总览" },
  { key: "conflicts", label: "冲突" },
  { key: "bugzia", label: "Bugzia" },
  { key: "windows", label: "Windows" },
  { key: "manual", label: "应用" },
  { key: "shortcut", label: "快捷方式" },
  { key: "hidden", label: "已隐藏" },
];

const isWindows = /win/i.test(navigator.userAgent);

export default function HotkeyCenterPanel({ hotkey, onPatchHotkey, hkErr, setHkErr }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [entries, setEntries] = useState<HotkeyEntry[]>([]);
  const [hiddenEntries, setHiddenEntries] = useState<HotkeyEntry[]>([]);
  const [shortcuts, setShortcuts] = useState<ShortcutHotkeyItem[]>([]);
  const [hiddenShortcuts, setHiddenShortcuts] = useState<ShortcutHotkeyItem[]>([]);
  const [shortcutsLoaded, setShortcutsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  // 总览数据：挂载 + Bugzia 快捷键变化时刷新（后者让冲突徽标跟上输入框编辑）。
  useEffect(() => {
    let alive = true;
    Promise.all([detectHotkeyConflicts(), listHiddenHotkeyCenterEntries()]).then(([e, h]) => {
      if (alive) {
        setEntries(e);
        setHiddenEntries(h);
      }
    });
    return () => {
      alive = false;
    };
  }, [hotkey.summon, hotkey.note, hotkey.note_create, hotkey.note_destroy]);

  // 快捷方式明细：首次切到该标签时拉取一次。
  useEffect(() => {
    if (tab !== "shortcut" || shortcutsLoaded || !isWindows) return;
    let alive = true;
    Promise.all([scanShortcutHotkeys(), listHiddenShortcutHotkeys()]).then(([s, h]) => {
      if (alive) {
        setShortcuts(s);
        setHiddenShortcuts(h);
        setShortcutsLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [tab, shortcutsLoaded]);

  const byId = useMemo(() => {
    const m = new Map<string, HotkeyEntry>();
    for (const e of entries) m.set(e.id, e);
    return m;
  }, [entries]);

  async function refreshShortcuts() {
    const [s, h, e] = await Promise.all([
      scanShortcutHotkeys(),
      listHiddenShortcutHotkeys(),
      detectHotkeyConflicts(),
    ]);
    setShortcuts(s);
    setHiddenShortcuts(h);
    setEntries(e);
  }

  async function refreshEntries() {
    const [e, h] = await Promise.all([
      detectHotkeyConflicts(),
      listHiddenHotkeyCenterEntries(),
    ]);
    setEntries(e);
    setHiddenEntries(h);
  }

  const stats = useMemo(() => {
    const total = entries.length;
    const conflicts = entries.filter((e) => e.conflict.is_duplicate).length;
    const modifiable = entries.filter((e) => e.can_modify).length;
    return { total, conflicts, modifiable };
  }, [entries]);

  return (
    <section className="settings-section hk-panel">
      <h4>快捷键中心</h4>
      <div className="hk-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={"hk-tab" + (tab === t.key ? " active" : "")}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <OverviewTab entries={entries} stats={stats} onJump={setTab} />
      )}

      {tab === "conflicts" && (
        <ConflictTab
          entries={entries}
          busy={busy}
          setBusy={setBusy}
          onChange={refreshEntries}
          onJump={setTab}
        />
      )}

      {tab === "bugzia" && (
        <BugziaTab
          hotkey={hotkey}
          onPatchHotkey={onPatchHotkey}
          hkErr={hkErr}
          setHkErr={setHkErr}
          byId={byId}
        />
      )}

      {tab === "windows" && (
        <WindowsTab
          entries={entries.filter((e) => e.source_type === "WindowsSystem")}
          busy={busy}
          setBusy={setBusy}
          onChange={refreshEntries}
        />
      )}

      {tab === "manual" && (
        <ManualTab
          entries={entries.filter((e) => e.source_type === "Manual")}
          busy={busy}
          setBusy={setBusy}
          onChange={refreshEntries}
        />
      )}

      {tab === "hidden" && (
        <HiddenTab
          entries={hiddenEntries}
          busy={busy}
          setBusy={setBusy}
          onChange={refreshEntries}
        />
      )}

      {tab === "shortcut" && (
        <ShortcutTab
          items={shortcuts}
          hiddenItems={hiddenShortcuts}
          byId={byId}
          busy={busy}
          setBusy={setBusy}
          onChange={refreshShortcuts}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 总览
// ---------------------------------------------------------------------------

function OverviewTab({
  entries,
  stats,
  onJump,
}: {
  entries: HotkeyEntry[];
  stats: { total: number; conflicts: number; modifiable: number };
  onJump: (t: Tab) => void;
}) {
  return (
    <div className="hk-overview">
      <div className="hk-stats">
        <Stat label="总数" value={stats.total} />
        <Stat label="冲突" value={stats.conflicts} tone={stats.conflicts > 0 ? "warn" : "ok"} />
        <Stat label="可修改" value={stats.modifiable} />
      </div>
      <div className="hk-table">
        <div className="hk-row hk-head">
          <span>快捷键</span>
          <span>名称</span>
          <span>来源</span>
          <span>状态</span>
        </div>
        {entries.length === 0 && <div className="hk-empty">暂无数据，或扫描失败。</div>}
        {entries.map((e) => (
          <div className={"hk-row" + (e.conflict.is_duplicate ? " dup" : "")} key={e.id}>
            <span className="hk-kbd">{e.display || "未设置"}</span>
            <span className="hk-name" title={e.title}>{e.title}</span>
            <span className="hk-src">{e.app_name}</span>
            <span className="hk-conf">
              <HotkeyStatusDot c={e.conflict} active={Boolean(e.display)} />
            </span>
          </div>
        ))}
      </div>
      <div className="hint">
        Bugzia 自身键与桌面 / 开始菜单的快捷方式热键都会列出。冲突可在对应标签里修改。
      </div>
      <div className="hk-jump">
        <button className="key-btn" type="button" onClick={() => onJump("conflicts")}>
          查看冲突
        </button>
        <button className="key-btn" type="button" onClick={() => onJump("bugzia")}>
          管理 Bugzia 快捷键
        </button>
        <button className="key-btn ghost" type="button" onClick={() => onJump("shortcut")}>
          管理快捷方式热键
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 冲突处理
// ---------------------------------------------------------------------------

function ConflictTab({
  entries,
  busy,
  setBusy,
  onChange,
  onJump,
}: {
  entries: HotkeyEntry[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  onChange: () => Promise<void>;
  onJump: (t: Tab) => void;
}) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const duplicateGroups = useMemo(() => {
    const groups = new Map<string, HotkeyEntry[]>();
    for (const e of entries) {
      if (!e.conflict.is_duplicate || !e.display) continue;
      const key = e.display.toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    return [...groups.values()].sort((a, b) => a[0].display.localeCompare(b[0].display));
  }, [entries]);
  const highRisk = useMemo(
    () =>
      entries
        .filter((e) => e.manage_level === "HighRisk")
        .sort((a, b) => a.display.localeCompare(b.display)),
    [entries],
  );

  async function hideEntry(e: HotkeyEntry) {
    if (!canCenterHide(e)) return;
    if (!window.confirm(`确定隐藏「${e.app_name} / ${e.title}」？\n\n可在“已隐藏”里恢复。`)) return;
    setBusy(true);
    try {
      await hideHotkeyCenterEntry(e.id);
      setMsg(null);
      await onChange();
    } catch (err) {
      setMsg({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hk-conflict">
      <div className="hk-stats">
        <Stat label="冲突组" value={duplicateGroups.length} tone={duplicateGroups.length > 0 ? "warn" : "ok"} />
        <Stat label="冲突条目" value={entries.filter((e) => e.conflict.is_duplicate).length} />
        <Stat label="高风险" value={highRisk.length} tone={highRisk.length > 0 ? "warn" : "ok"} />
      </div>
      {msg && <div className={"key-msg " + (msg.ok ? "ok" : "err")}>{msg.text}</div>}

      <div className="hk-list">
        {duplicateGroups.length === 0 && highRisk.length === 0 && (
          <div className="hk-empty">目前没有重复冲突或高风险系统键。</div>
        )}

        {duplicateGroups.map((group) => {
          const withBugzia = group.some((e) => e.source_type === "Bugzia");
          return (
            <div className="hk-conflict-group" key={group[0].display}>
              <div className="hk-conflict-head">
                <span className="hk-kbd">{group[0].display}</span>
                <span className={"hk-badge " + (withBugzia ? "bugzia" : "dup")}>
                  {withBugzia ? "与 Bugzia 冲突" : "重复占用"}
                </span>
              </div>
              {group.map((e) => (
                <ConflictEntryRow
                  key={e.id}
                  entry={e}
                  busy={busy}
                  onJump={onJump}
                  onHide={() => void hideEntry(e)}
                />
              ))}
            </div>
          );
        })}

        {highRisk.length > 0 && (
          <div className="hk-conflict-group">
            <div className="hk-conflict-head">
              <span>Windows 高风险系统键</span>
              <span className="hk-badge bugzia">只读</span>
            </div>
            {highRisk.map((e) => (
              <ConflictEntryRow
                key={e.id}
                entry={e}
                busy={busy}
                onJump={onJump}
                onHide={() => void hideEntry(e)}
              />
            ))}
          </div>
        )}
      </div>
      <div className="hint">
        冲突页会聚合相同组合键和高风险系统键。Windows 系统键只能作为参考；应用登记和 Bugzia 快捷键可到对应标签处理。
      </div>
    </div>
  );
}

function ConflictEntryRow({
  entry,
  busy,
  onJump,
  onHide,
}: {
  entry: HotkeyEntry;
  busy: boolean;
  onJump: (t: Tab) => void;
  onHide: () => void;
}) {
  return (
    <div className="hk-conflict-row">
      <div className="hk-item-main">
        <div className="hk-item-name" title={entry.title}>{entry.title}</div>
        <div className="hk-item-target">
          {entry.app_name} / {sourceText(entry.source_type)} / {scopeText(entry.scope)}
        </div>
      </div>
      <div className="hk-item-actions">
        <HotkeyStatusDot c={entry.conflict} active={Boolean(entry.display)} />
        {entry.source_type === "Bugzia" && (
          <button className="key-btn" type="button" disabled={busy} onClick={() => onJump("bugzia")}>
            编辑 Bugzia
          </button>
        )}
        {entry.source_type === "Manual" && (
          <button className="key-btn" type="button" disabled={busy} onClick={() => onJump("manual")}>
            编辑登记
          </button>
        )}
        {entry.source_type === "ShortcutLink" && (
          <button className="key-btn" type="button" disabled={busy} onClick={() => onJump("shortcut")}>
            管理快捷方式
          </button>
        )}
        {entry.source_type === "WindowsSystem" && (
          <button className="key-btn" type="button" disabled={busy} onClick={() => onJump("windows")}>
            查看 Windows
          </button>
        )}
        {canCenterHide(entry) && (
          <button className="key-btn ghost" type="button" disabled={busy} onClick={onHide}>
            隐藏
          </button>
        )}
      </div>
    </div>
  );
}

function canCenterHide(entry: HotkeyEntry): boolean {
  return entry.source_type === "WindowsSystem" || entry.source_type === "Manual";
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" }) {
  return (
    <div className={"hk-stat" + (tone ? ` ${tone}` : "")}>
      <span className="hk-stat-num">{value}</span>
      <span className="hk-stat-label">{label}</span>
    </div>
  );
}

function HotkeyStatusDot({ c, active }: { c?: ConflictInfo; active: boolean }) {
  const state = c?.is_duplicate ? "conflict" : active ? "ok" : "idle";
  const label = state === "conflict" ? "有冲突" : active ? "已启用且无冲突" : "未启用且无冲突";
  return <span className={`hk-status-dot ${state}`} title={label} aria-label={label} />;
}

// ---------------------------------------------------------------------------
// Bugzia 自身快捷键（复用既有 settings 写流程）
// ---------------------------------------------------------------------------

function BugziaTab({
  hotkey,
  onPatchHotkey,
  hkErr,
  setHkErr,
  byId,
}: {
  hotkey: HotkeySettings;
  onPatchHotkey: (p: Partial<HotkeySettings>) => void;
  hkErr: string | null;
  setHkErr: (s: string | null) => void;
  byId: Map<string, HotkeyEntry>;
}) {
  return (
    <div className="hk-bugzia">
      <div className="hk-readonly-row">
        <ReadonlyKey
          label="召唤输入框"
          entry={byId.get("bugzia.summon")}
        />
        <ReadonlyKey label="召唤便笺" entry={byId.get("bugzia.note")} />
        <ReadonlyKey label="直接新建便笺" entry={byId.get("bugzia.note_create")} />
        <ReadonlyKey label="销毁当前便笺" entry={byId.get("bugzia.note_destroy")} />
      </div>
      <Field label="召唤输入框">
        <input
          className="f-input"
          value={hotkey.summon}
          placeholder="alt+space"
          onChange={(e) => {
            setHkErr(null);
            onPatchHotkey({ summon: e.target.value });
          }}
        />
      </Field>
      <Field label="召唤便笺">
        <input
          className="f-input"
          value={hotkey.note}
          placeholder="alt+n"
          onChange={(e) => {
            setHkErr(null);
            onPatchHotkey({ note: e.target.value });
          }}
        />
      </Field>
      <Field label="直接新建便笺">
        <input
          className="f-input"
          value={hotkey.note_create}
          placeholder="alt+shift+n"
          onChange={(e) => {
            setHkErr(null);
            onPatchHotkey({ note_create: e.target.value });
          }}
        />
      </Field>
      <Field label="销毁当前便笺">
        <input
          className="f-input"
          value={hotkey.note_destroy}
          placeholder="alt+w"
          onChange={(e) => {
            setHkErr(null);
            onPatchHotkey({ note_destroy: e.target.value });
          }}
        />
      </Field>
      {hkErr && <div className="key-msg err">{hkErr}</div>}
      <div className="hint">
        召唤键 / 便笺键再按一次即隐藏（切换）。便笺键：有便笺显示则全部收起，否则呼出，一条都没有则新建空白便笺。直接新建便笺：无论已有几张，都新建一张空白。销毁当前便笺：销毁当前聚焦的那张（没有聚焦便笺则无效）。格式为修饰键加按键，如 alt+space、alt+n、ctrl+shift+p。修改后即时生效。
      </div>
    </div>
  );
}

function ReadonlyKey({ label, entry }: { label: string; entry?: HotkeyEntry }) {
  return (
    <div className="hk-readonly">
      <span className="hk-readonly-label">{label}</span>
      <span className="hk-kbd">{entry?.display || "未设置"}</span>
      <HotkeyStatusDot c={entry?.conflict} active={Boolean(entry?.display)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Windows 系统快捷键（只读目录）
// ---------------------------------------------------------------------------

function WindowsTab({
  entries,
  busy,
  setBusy,
  onChange,
}: {
  entries: HotkeyEntry[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  onChange: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const q = query.trim().toLowerCase();
  const filtered = entries.filter((e) => {
    if (!q) return true;
    return (
      e.display.toLowerCase().includes(q) ||
      e.title.toLowerCase().includes(q) ||
      e.app_name.toLowerCase().includes(q)
    );
  });

  async function hideEntry(e: HotkeyEntry) {
    if (!window.confirm(`确定隐藏「${e.title}」？\n\n它会从总览和 Windows 列表消失，可在“已隐藏”里恢复。`)) return;
    setBusy(true);
    try {
      await hideHotkeyCenterEntry(e.id);
      setMsg(null);
      await onChange();
    } catch (err) {
      setMsg({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hk-shortcut">
      <div className="hk-filters">
        <input
          className="f-input hk-search"
          value={query}
          placeholder="搜索 Windows 快捷键 / 功能 / 分类"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {msg && <div className={"key-msg " + (msg.ok ? "ok" : "err")}>{msg.text}</div>}
      <div className="hk-list">
        {filtered.length === 0 && <div className="hk-empty">暂无匹配的 Windows 快捷键。</div>}
        {filtered.map((e) => (
          <div className={"hk-item" + (e.manage_level === "HighRisk" ? " warn" : "")} key={e.id}>
            <div className="hk-item-main">
              <div className="hk-item-name" title={e.title}>
                {e.title}
                {e.manage_level === "HighRisk" && <span className="hk-status">（高风险）</span>}
              </div>
              <div className="hk-item-target">{e.app_name}</div>
            </div>
            <div className="hk-item-actions">
              <span className="hk-kbd">{e.display}</span>
              <HotkeyStatusDot c={e.conflict} active={Boolean(e.display)} />
              <span className="hk-src">{levelText(e.manage_level)}</span>
              <button className="key-btn ghost" type="button" disabled={busy} onClick={() => void hideEntry(e)}>
                隐藏
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="hint">
        Windows 系统快捷键是只读参考目录，用于冲突判断；高风险系统键不提供修改或禁用入口。
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 手动登记应用功能快捷键
// ---------------------------------------------------------------------------

const EMPTY_MANUAL_INPUT: ManualHotkeyInput = {
  app_name: "",
  title: "",
  accelerator: "",
  scope: "Global",
  notes: "",
};

function ManualTab({
  entries,
  busy,
  setBusy,
  onChange,
}: {
  entries: HotkeyEntry[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  onChange: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<ManualHotkeyInput>(EMPTY_MANUAL_INPUT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function patchDraft(p: Partial<ManualHotkeyInput>) {
    setDraft((cur) => ({ ...cur, ...p }));
    setMsg(null);
  }

  function editEntry(e: HotkeyEntry) {
    setEditingId(e.id);
    setDraft({
      app_name: e.app_name,
      title: e.title,
      accelerator: e.display,
      scope: e.scope,
      notes: e.target ?? "",
    });
    setMsg(null);
  }

  function resetDraft() {
    setEditingId(null);
    setDraft(EMPTY_MANUAL_INPUT);
    setMsg(null);
  }

  async function saveManual() {
    setBusy(true);
    try {
      if (editingId) {
        await updateManualHotkeyEntry(editingId, draft);
      } else {
        await addManualHotkeyEntry(draft);
      }
      resetDraft();
      await onChange();
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function removeManual(e: HotkeyEntry) {
    if (!window.confirm(`确定删除「${e.app_name} / ${e.title}」这条手动登记？`)) return;
    setBusy(true);
    try {
      await removeManualHotkeyEntry(e.id);
      if (editingId === e.id) resetDraft();
      await onChange();
    } catch (err) {
      setMsg({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function hideManual(e: HotkeyEntry) {
    if (!window.confirm(`确定隐藏「${e.app_name} / ${e.title}」？\n\n它会保留登记数据，可在“已隐藏”里恢复。`)) return;
    setBusy(true);
    try {
      await hideHotkeyCenterEntry(e.id);
      if (editingId === e.id) resetDraft();
      await onChange();
    } catch (err) {
      setMsg({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hk-shortcut">
      <div className="hk-manual-form">
        <Field label="应用">
          <input
            className="f-input"
            value={draft.app_name}
            placeholder="例如 酷狗音乐"
            onChange={(e) => patchDraft({ app_name: e.target.value })}
          />
        </Field>
        <Field label="功能">
          <input
            className="f-input"
            value={draft.title}
            placeholder="例如 播放 / 暂停"
            onChange={(e) => patchDraft({ title: e.target.value })}
          />
        </Field>
        <Field label="快捷键">
          <input
            className="f-input"
            value={draft.accelerator}
            placeholder="例如 Alt+K、Win+Shift+S"
            onChange={(e) => patchDraft({ accelerator: e.target.value })}
          />
        </Field>
        <Field label="作用域">
          <select
            className="f-input"
            value={draft.scope}
            onChange={(e) => patchDraft({ scope: e.target.value as HotkeyScope })}
          >
            <option value="Global">全局</option>
            <option value="AppLocal">应用内</option>
            <option value="WindowLocal">窗口内</option>
            <option value="Unknown">未知</option>
          </select>
        </Field>
        <Field label="备注">
          <input
            className="f-input"
            value={draft.notes}
            placeholder="可选：来源、配置位置或说明"
            onChange={(e) => patchDraft({ notes: e.target.value })}
          />
        </Field>
        {msg && <div className={"key-msg " + (msg.ok ? "ok" : "err")}>{msg.text}</div>}
        <div className="hk-jump">
          <button className="key-btn" type="button" disabled={busy} onClick={() => void saveManual()}>
            {editingId ? "保存修改" : "添加登记"}
          </button>
          {editingId && (
            <button className="key-btn ghost" type="button" disabled={busy} onClick={resetDraft}>
              取消编辑
            </button>
          )}
        </div>
      </div>

      <div className="hk-list">
        {entries.length === 0 && <div className="hk-empty">还没有手动登记的应用快捷键。</div>}
        {entries.map((e) => (
          <div className={"hk-item" + (e.conflict.is_duplicate ? " warn" : "")} key={e.id}>
            <div className="hk-item-main">
              <div className="hk-item-name" title={e.title}>{e.title}</div>
              <div className="hk-item-target">
                {e.app_name} / {scopeText(e.scope)}
                {e.target ? ` / ${e.target}` : ""}
              </div>
            </div>
            <div className="hk-item-actions">
              <span className="hk-kbd">{e.display}</span>
              <HotkeyStatusDot c={e.conflict} active={Boolean(e.display)} />
              <button className="key-btn" type="button" disabled={busy} onClick={() => editEntry(e)}>
                编辑
              </button>
              <button className="key-btn ghost" type="button" disabled={busy} onClick={() => void removeManual(e)}>
                删除
              </button>
              <button className="key-btn ghost" type="button" disabled={busy} onClick={() => void hideManual(e)}>
                隐藏
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="hint">
        手动登记适合暂时无法自动读取配置的应用快捷键；登记后会进入总览，并参与冲突检测。
      </div>
    </div>
  );
}

function HiddenTab({
  entries,
  busy,
  setBusy,
  onChange,
}: {
  entries: HotkeyEntry[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  onChange: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const q = query.trim().toLowerCase();
  const filtered = entries.filter((e) => {
    if (!q) return true;
    return (
      e.display.toLowerCase().includes(q) ||
      e.title.toLowerCase().includes(q) ||
      e.app_name.toLowerCase().includes(q)
    );
  });

  async function restoreEntry(e: HotkeyEntry) {
    setBusy(true);
    try {
      await unhideHotkeyCenterEntry(e.id);
      setMsg(null);
      await onChange();
    } catch (err) {
      setMsg({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hk-shortcut">
      <div className="hk-filters">
        <input
          className="f-input hk-search"
          value={query}
          placeholder="搜索已隐藏快捷键 / 应用 / 来源"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {msg && <div className={"key-msg " + (msg.ok ? "ok" : "err")}>{msg.text}</div>}
      <div className="hk-list">
        {filtered.length === 0 && <div className="hk-empty">暂无已隐藏的 Windows 或应用快捷键。</div>}
        {filtered.map((e) => (
          <div className={"hk-item" + (e.conflict.is_duplicate ? " warn" : "")} key={e.id}>
            <div className="hk-item-main">
              <div className="hk-item-name" title={e.title}>{e.title}</div>
              <div className="hk-item-target">
                {e.app_name} / {sourceText(e.source_type)} / {scopeText(e.scope)}
              </div>
            </div>
            <div className="hk-item-actions">
              <span className="hk-kbd">{e.display || "未设置"}</span>
              <HotkeyStatusDot c={e.conflict} active={Boolean(e.display)} />
              <button className="key-btn" type="button" disabled={busy} onClick={() => void restoreEntry(e)}>
                恢复显示
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="hint">
        这里管理的是 Windows 系统目录和手动登记应用快捷键的隐藏项；快捷方式的隐藏项仍在“快捷方式”标签内恢复。
      </div>
    </div>
  );
}

function scopeText(scope: HotkeyScope): string {
  switch (scope) {
    case "Global":
      return "全局";
    case "AppLocal":
      return "应用内";
    case "WindowLocal":
      return "窗口内";
    default:
      return "未知";
  }
}

function levelText(level: HotkeyEntry["manage_level"]): string {
  switch (level) {
    case "DirectModify":
      return "可修改";
    case "AdapterModify":
      return "适配修改";
    case "Blockable":
      return "可拦截";
    case "HighRisk":
      return "高风险";
    default:
      return "只读";
  }
}

function sourceText(source: HotkeyEntry["source_type"]): string {
  switch (source) {
    case "WindowsSystem":
      return "Windows";
    case "Manual":
      return "手动登记";
    case "ShortcutLink":
      return "快捷方式";
    default:
      return "Bugzia";
  }
}

// ---------------------------------------------------------------------------
// 快捷方式（.lnk COM 读写）
// ---------------------------------------------------------------------------

function ShortcutTab({
  items,
  hiddenItems,
  byId,
  busy,
  setBusy,
  onChange,
}: {
  items: ShortcutHotkeyItem[];
  hiddenItems: ShortcutHotkeyItem[];
  byId: Map<string, HotkeyEntry>;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onChange: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [onlySet, setOnlySet] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [editPath, setEditPath] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [rowErr, setRowErr] = useState<{ path: string; msg: string } | null>(null);

  if (!isWindows) {
    return <div className="hk-empty">此功能仅在 Windows 上可用。</div>;
  }

  const q = query.trim().toLowerCase();
  const currentItems = showHidden ? hiddenItems : items;
  const filtered = currentItems.filter((it) => {
    if (onlySet && !it.hotkey) return false;
    if (!q) return true;
    return (
      it.name.toLowerCase().includes(q) ||
      it.target_path.toLowerCase().includes(q) ||
      it.hotkey.toLowerCase().includes(q) ||
      it.shortcut_path.toLowerCase().includes(q)
    );
  });

  async function applyEdit(it: ShortcutHotkeyItem) {
    const val = editVal.trim();
    if (!val) {
      setRowErr({ path: it.shortcut_path, msg: "请输入快捷键，如 Ctrl+Alt+F9" });
      return;
    }
    setBusy(true);
    try {
      await setShortcutHotkey(it.shortcut_path, val);
      setEditPath(null);
      setEditVal("");
      setRowErr(null);
      await onChange();
    } catch (e) {
      setRowErr({ path: it.shortcut_path, msg: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function handleClear(it: ShortcutHotkeyItem) {
    if (!window.confirm(`确定清空「${it.name}」的热键？修改前会自动备份，可点「恢复」还原。`)) return;
    setBusy(true);
    try {
      await clearShortcutHotkey(it.shortcut_path);
      await onChange();
    } catch (e) {
      setRowErr({ path: it.shortcut_path, msg: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore(it: ShortcutHotkeyItem) {
    setBusy(true);
    try {
      await restoreShortcutHotkey(it.shortcut_path);
      await onChange();
    } catch (e) {
      setRowErr({ path: it.shortcut_path, msg: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function handleHide(it: ShortcutHotkeyItem) {
    if (!window.confirm(`确定从快捷键中心删除「${it.name}」？\n\n这只会隐藏此条记录，不会删除系统里的快捷方式文件。`)) return;
    if (!window.confirm(`再次确认：以后快捷键中心将不再显示「${it.name}」。`)) return;
    setBusy(true);
    try {
      await hideShortcutHotkey(it.shortcut_path);
      setRowErr(null);
      await onChange();
    } catch (e) {
      setRowErr({ path: it.shortcut_path, msg: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function handleUnhide(it: ShortcutHotkeyItem) {
    setBusy(true);
    try {
      await unhideShortcutHotkey(it.shortcut_path);
      setRowErr(null);
      await onChange();
    } catch (e) {
      setRowErr({ path: it.shortcut_path, msg: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hk-shortcut">
      <div className="hk-filters">
        <input
          className="f-input hk-search"
          value={query}
          placeholder="搜索名称 / 目标 / 热键"
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="check-row hk-toggle">
          <input type="checkbox" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} />
          只显示已设置
        </label>
        <button
          className={"key-btn ghost" + (showHidden ? " active" : "")}
          type="button"
          onClick={() => {
            setShowHidden((v) => !v);
            setEditPath(null);
            setEditVal("");
            setRowErr(null);
          }}
          disabled={busy}
        >
          {showHidden ? "当前显示" : `已隐藏 ${hiddenItems.length}`}
        </button>
        <button className="key-btn ghost" type="button" onClick={onChange} disabled={busy}>
          {busy ? "刷新中…" : "刷新"}
        </button>
      </div>

      <div className="hk-list">
        {filtered.length === 0 && (
          <div className="hk-shortcut-empty">
            <div className="hk-empty">
              {showHidden
                ? "暂无已隐藏的快捷方式。"
                : "未扫描到桌面 / 开始菜单下的快捷方式（含热键或可设置）。"}
            </div>
          </div>
        )}
        {filtered.map((it) => {
          const entry = byId.get(it.id);
          const editing = editPath === it.shortcut_path;
          const err = rowErr?.path === it.shortcut_path ? rowErr.msg : null;
          return (
            <div className={"hk-item" + (it.status !== "Ok" ? " warn" : "")} key={it.shortcut_path}>
              <div className="hk-item-main">
                <div className="hk-item-name" title={it.name}>
                  {it.name}
                  {it.status !== "Ok" && <span className="hk-status">{statusText(it.status)}</span>}
                </div>
                <div className="hk-item-target" title={it.target_path}>
                  {it.target_path || "（目标未知）"}
                </div>
                {err && <div className="key-msg err">{err}</div>}
              </div>
              <div className="hk-item-actions">
                {editing ? (
                  <>
                    <input
                      className="f-input hk-edit"
                      value={editVal}
                      placeholder="如 Ctrl+Alt+F9"
                      autoFocus
                      onChange={(e) => setEditVal(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void applyEdit(it);
                        } else if (e.key === "Escape") {
                          setEditPath(null);
                          setEditVal("");
                        }
                      }}
                    />
                    <button
                      className="key-btn"
                      type="button"
                      disabled={busy}
                      onClick={() => void applyEdit(it)}
                    >
                      应用
                    </button>
                    <button
                      className="key-btn ghost"
                      type="button"
                      onClick={() => {
                        setEditPath(null);
                        setEditVal("");
                      }}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <span className="hk-kbd">{it.hotkey || "未设置"}</span>
                    <HotkeyStatusDot c={entry?.conflict} active={Boolean(it.hotkey)} />
                    {!showHidden && (
                      <>
                        <button
                          className="key-btn"
                          type="button"
                          disabled={!it.can_modify || busy}
                          title={it.can_modify ? "修改热键" : "无写入权限"}
                          onClick={() => {
                            setEditPath(it.shortcut_path);
                            setEditVal(it.hotkey);
                            setRowErr(null);
                          }}
                        >
                          修改
                        </button>
                        <button
                          className="key-btn ghost"
                          type="button"
                          disabled={!it.can_modify || !it.hotkey || busy}
                          onClick={() => void handleClear(it)}
                        >
                          清空
                        </button>
                      </>
                    )}
                    <button
                      className="key-btn ghost"
                      type="button"
                      disabled={busy}
                      onClick={() => void revealShortcut(it.shortcut_path)}
                    >
                      打开位置
                    </button>
                    {showHidden ? (
                      <button
                        className="key-btn"
                        type="button"
                        disabled={busy}
                        onClick={() => void handleUnhide(it)}
                      >
                        恢复显示
                      </button>
                    ) : (
                      <>
                        <button
                          className="key-btn ghost"
                          type="button"
                          disabled={!it.backup_available || busy}
                          title={it.backup_available ? "恢复最近备份" : "无可用备份"}
                          onClick={() => void handleRestore(it)}
                        >
                          恢复
                        </button>
                        <button
                          className="key-btn ghost"
                          type="button"
                          disabled={busy}
                          title="从快捷键中心隐藏，不删除快捷方式文件"
                          onClick={() => void handleHide(it)}
                        >
                          删除
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="hint">
        仅扫描桌面 / 开始菜单下的快捷方式；修改前自动备份，可用「恢复」还原。含 Win 的组合 .lnk 不支持。
      </div>
    </div>
  );
}

function statusText(s: ShortcutHotkeyItem["status"]): string {
  switch (s) {
    case "TargetUnresolved":
      return "（目标失效）";
    case "AccessDenied":
      return "（无权限）";
    case "ReadError":
      return "（读取失败）";
    case "OutsideWhitelist":
      return "（白名单外）";
    default:
      return "";
  }
}

// 本面板自用的小字段组件（SettingsPanel 的 Field 未导出，这里本地复刻一份）。
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}
