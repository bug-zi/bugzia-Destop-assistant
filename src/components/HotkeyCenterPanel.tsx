import { useEffect, useMemo, useState } from "react";
import type { HotkeySettings } from "../features/settings/settingsTypes";
import type {
  ConflictInfo,
  HotkeyEntry,
  HotkeyScope,
  HotkeySourceType,
  ManualHotkeyInput,
  ObservedHotkeyEntry,
  RunningAppInfo,
  ShortcutHotkeyItem,
} from "../features/hotkeys/hotkeyTypes";
import {
  addManualHotkeyEntry,
  detectHotkeyConflicts,
  hideHotkeyCenterEntry,
  getHotkeyObserverStatus,
  listHiddenHotkeyCenterEntries,
  listObservedHotkeys,
  listRunningApps,
  promoteObservedHotkey,
  removeManualHotkeyEntry,
  removeObservedHotkey,
  setHotkeyObserverEnabled,
  unhideHotkeyCenterEntry,
  updateAppConfigHotkeyEntry,
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
type Tab =
  | "overview"
  | "conflicts"
  | "bugzia"
  | "windows"
  | "manual"
  | "shortcut"
  | "supplement"
  | "hidden";

interface Props {
  hotkey: HotkeySettings;
  onPatchHotkey: (p: Partial<HotkeySettings>) => void;
  hkErr: string | null;
  setHkErr: (s: string | null) => void;
}

interface SupplementEditTarget {
  entry: HotkeyEntry;
  token: number;
}

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "总览" },
  { key: "conflicts", label: "冲突" },
  { key: "bugzia", label: "Bugzia" },
  { key: "windows", label: "Windows" },
  { key: "manual", label: "应用" },
  { key: "shortcut", label: "快捷方式" },
  { key: "supplement", label: "手动补充" },
  { key: "hidden", label: "已隐藏" },
];

const isWindows = /win/i.test(navigator.userAgent);

function isApplicationHotkeySource(source: HotkeySourceType): boolean {
  return source === "Manual" || source === "AppConfig" || source === "AppBuiltin";
}

export default function HotkeyCenterPanel({ hotkey, onPatchHotkey, hkErr, setHkErr }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [entries, setEntries] = useState<HotkeyEntry[]>([]);
  const [hiddenEntries, setHiddenEntries] = useState<HotkeyEntry[]>([]);
  const [shortcuts, setShortcuts] = useState<ShortcutHotkeyItem[]>([]);
  const [hiddenShortcuts, setHiddenShortcuts] = useState<ShortcutHotkeyItem[]>([]);
  const [shortcutsLoaded, setShortcutsLoaded] = useState(false);
  const [supplementEditTarget, setSupplementEditTarget] = useState<SupplementEditTarget | null>(null);
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
    const overrides = entries.filter((e) => e.conflict.is_system_override).length;
    const modifiable = entries.filter((e) => e.can_modify).length;
    return { total, conflicts, overrides, modifiable };
  }, [entries]);

  function openSupplementEditor(entry: HotkeyEntry) {
    setSupplementEditTarget({ entry, token: Date.now() + Math.random() });
    setTab("supplement");
  }

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
          entries={entries}
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
          entries={entries.filter((e) => isApplicationHotkeySource(e.source_type))}
          busy={busy}
          setBusy={setBusy}
          onChange={refreshEntries}
          onEditEntry={openSupplementEditor}
        />
      )}

      {tab === "shortcut" && (
        <ShortcutTab
          items={shortcuts}
          hiddenItems={hiddenShortcuts}
          byId={byId}
          entries={entries}
          busy={busy}
          setBusy={setBusy}
          onChange={refreshShortcuts}
        />
      )}

      {tab === "supplement" && (
        <SupplementTab
          allEntries={entries}
          editTarget={supplementEditTarget}
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
  stats: { total: number; conflicts: number; overrides: number; modifiable: number };
  onJump: (t: Tab) => void;
}) {
  return (
    <div className="hk-overview">
      <div className="hk-stats">
        <Stat label="总数" value={stats.total} />
        <Stat label="冲突" value={stats.conflicts} tone={stats.conflicts > 0 ? "warn" : "ok"} />
        <Stat label="覆盖" value={stats.overrides} tone={stats.overrides > 0 ? "note" : "ok"} />
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
          <div className={"hk-row" + entryStateClass(e)} key={e.id}>
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
        真冲突表示运行时可能互相抢占；覆盖表示自定义快捷键接管了 Windows 原有低风险系统键。
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
  const systemOverrideGroups = useMemo(() => {
    const groups = new Map<string, HotkeyEntry[]>();
    for (const e of entries) {
      if (!e.conflict.is_system_override || !e.display) continue;
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
        <Stat
          label="覆盖系统"
          value={systemOverrideGroups.length}
          tone={systemOverrideGroups.length > 0 ? "note" : "ok"}
        />
        <Stat label="高风险" value={highRisk.length} tone={highRisk.length > 0 ? "warn" : "ok"} />
      </div>
      {msg && <div className={"key-msg " + (msg.ok ? "ok" : "err")}>{msg.text}</div>}

      <div className="hk-list">
        {duplicateGroups.length === 0 && systemOverrideGroups.length === 0 && highRisk.length === 0 && (
          <div className="hk-empty">目前没有真正冲突、系统键覆盖或高风险系统键。</div>
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

        {systemOverrideGroups.map((group) => {
          const withBugzia = group.some((e) => e.source_type === "Bugzia");
          return (
            <div className="hk-conflict-group" key={`override.${group[0].display}`}>
              <div className="hk-conflict-head">
                <span className="hk-kbd">{group[0].display}</span>
                <span className="hk-badge override">
                  {withBugzia ? "Bugzia 已接管" : "覆盖系统键"}
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
        真冲突会互相抢占；系统键覆盖表示自定义快捷键已接管 Windows 原行为，例如 Alt+Space 被 Bugzia 用来召唤输入框。
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
          <button className="key-btn" type="button" disabled={busy} onClick={() => onJump("supplement")}>
            编辑登记
          </button>
        )}
        {entry.source_type === "AppConfig" && (
          <button className="key-btn" type="button" disabled={busy} onClick={() => onJump("supplement")}>
            编辑配置
          </button>
        )}
        {entry.source_type === "AppBuiltin" && (
          <button className="key-btn" type="button" disabled={busy} onClick={() => onJump("manual")}>
            查看应用
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
  return entry.source_type === "WindowsSystem" || isApplicationHotkeySource(entry.source_type);
}

function entryStateClass(entry: HotkeyEntry): string {
  if (entry.conflict.is_duplicate) return " dup";
  if (entry.conflict.is_system_override) return " override";
  return "";
}

function itemStateClass(entry: HotkeyEntry): string {
  if (entry.conflict.is_duplicate || entry.manage_level === "HighRisk") return " warn";
  if (entry.conflict.is_system_override) return " notice";
  return "";
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "note" }) {
  return (
    <div className={"hk-stat" + (tone ? ` ${tone}` : "")}>
      <span className="hk-stat-num">{value}</span>
      <span className="hk-stat-label">{label}</span>
    </div>
  );
}

function HotkeyStatusDot({ c, active }: { c?: ConflictInfo; active: boolean }) {
  const state = c?.is_duplicate ? "conflict" : c?.is_system_override ? "override" : active ? "ok" : "idle";
  const label =
    state === "conflict"
      ? "有真正冲突"
      : state === "override"
        ? c?.conflicts_with_bugzia
          ? "Bugzia 已接管 Windows 系统键"
          : "覆盖 Windows 系统键"
        : active
          ? "已启用且无真正冲突"
          : "未启用且无真正冲突";
  return <span className={`hk-status-dot ${state}`} title={label} aria-label={label} />;
}

function keyNameForCapture(key: string): string | null {
  if (key.length === 1) {
    if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
    switch (key) {
      case ".":
      case ",":
      case ";":
      case "/":
      case "\\":
      case "`":
      case "=":
        return key;
      case "+":
        return "Plus";
      case "-":
        return "Minus";
      case "*":
        return "*";
      default:
        return null;
    }
  }
  switch (key) {
    case " ":
    case "Space":
    case "Spacebar":
      return "Space";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "PageUp":
    case "PageDown":
    case "Home":
    case "End":
    case "Insert":
    case "PrintScreen":
    case "Pause":
    case "NumLock":
    case "ScrollLock":
    case "CapsLock":
      return key;
    case "Escape":
      return null;
    case "Control":
    case "Alt":
    case "Shift":
    case "Meta":
      return null;
    default:
      return key;
  }
}

function acceleratorFromEvent(e: React.KeyboardEvent<HTMLInputElement>): string | null {
  const key = keyNameForCapture(e.key);
  if (!key) return null;
  const parts: string[] = [];
  if (e.metaKey) parts.push("Win");
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

function HotkeyCaptureInput({
  value,
  placeholder,
  onChange,
  onCommit,
  onCancel,
  autoFocus,
  className = "f-input",
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onCommit?: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  className?: string;
}) {
  return (
    <input
      className={className}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (
          e.key === "Enter" &&
          onCommit &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.shiftKey &&
          !e.metaKey
        ) {
          e.preventDefault();
          onCommit();
          return;
        }
        if (e.key === "Escape") {
          if (onCancel) {
            e.preventDefault();
            onCancel();
            return;
          }
          e.currentTarget.blur();
          return;
        }
        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          onChange("");
          return;
        }
        const next = acceleratorFromEvent(e);
        if (!next) return;
        e.preventDefault();
        onChange(next);
      }}
    />
  );
}

function findDisplayConflicts(
  entries: HotkeyEntry[],
  value: string,
  scope: HotkeyScope,
  appName: string,
  processName: string,
  excludeIds: string[] = [],
): HotkeyEntry[] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return [];
  const exclude = new Set(excludeIds);
  return entries.filter((e) => {
    if (exclude.has(e.id)) return false;
    return (
      e.display.trim().toLowerCase() === normalized &&
      scopesMayOverlap(scope, appName, processName, e.scope, e.app_name, e.process_name ?? "")
    );
  });
}

function scopesMayOverlap(
  leftScope: HotkeyScope,
  leftApp: string,
  leftProcess: string,
  rightScope: HotkeyScope,
  rightApp: string,
  rightProcess: string,
): boolean {
  if (
    leftScope === "Global" ||
    leftScope === "Unknown" ||
    rightScope === "Global" ||
    rightScope === "Unknown"
  ) {
    return true;
  }
  const leftIdentity = (leftProcess.trim() || leftApp.trim()).toLowerCase();
  const rightIdentity = (rightProcess.trim() || rightApp.trim()).toLowerCase();
  return leftIdentity === rightIdentity;
}

function isLowRiskWindowsSystemEntry(entry: HotkeyEntry): boolean {
  return entry.source_type === "WindowsSystem" && entry.manage_level !== "HighRisk";
}

function HotkeyConflictHint({
  entries,
  value,
  sourceType,
  scope,
  appName,
  processName = "",
  excludeIds,
}: {
  entries: HotkeyEntry[];
  value: string;
  sourceType: HotkeySourceType;
  scope: HotkeyScope;
  appName: string;
  processName?: string;
  excludeIds?: string[];
}) {
  const candidates = findDisplayConflicts(entries, value, scope, appName, processName, excludeIds);
  const overrides = candidates.filter(
    (e) => sourceType !== "WindowsSystem" && isLowRiskWindowsSystemEntry(e),
  );
  const conflicts = candidates.filter((e) => !overrides.includes(e));
  if (conflicts.length === 0 && overrides.length === 0) return null;
  const text = conflicts
    .slice(0, 3)
    .map((e) => `${e.app_name} / ${e.title}`)
    .join("；");
  const more = conflicts.length > 3 ? ` 等 ${conflicts.length} 项` : "";
  if (conflicts.length > 0) {
    return <div className="key-msg err">已登记冲突：{text}{more}</div>;
  }
  const overrideText = overrides
    .slice(0, 3)
    .map((e) => e.title)
    .join("；");
  const overrideMore = overrides.length > 3 ? ` 等 ${overrides.length} 项` : "";
  return <div className="key-msg warn">将覆盖 Windows 系统键：{overrideText}{overrideMore}</div>;
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
  entries,
}: {
  hotkey: HotkeySettings;
  onPatchHotkey: (p: Partial<HotkeySettings>) => void;
  hkErr: string | null;
  setHkErr: (s: string | null) => void;
  byId: Map<string, HotkeyEntry>;
  entries: HotkeyEntry[];
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
        <HotkeyCaptureInput
          value={hotkey.summon}
          placeholder="alt+space"
          onChange={(value) => {
            setHkErr(null);
            onPatchHotkey({ summon: value });
          }}
        />
        <HotkeyConflictHint
          entries={entries}
          value={hotkey.summon}
          sourceType="Bugzia"
          scope="Global"
          appName="Bugzia"
          excludeIds={["bugzia.summon"]}
        />
      </Field>
      <Field label="召唤便笺">
        <HotkeyCaptureInput
          value={hotkey.note}
          placeholder="alt+n"
          onChange={(value) => {
            setHkErr(null);
            onPatchHotkey({ note: value });
          }}
        />
        <HotkeyConflictHint
          entries={entries}
          value={hotkey.note}
          sourceType="Bugzia"
          scope="Global"
          appName="Bugzia"
          excludeIds={["bugzia.note"]}
        />
      </Field>
      <Field label="直接新建便笺">
        <HotkeyCaptureInput
          value={hotkey.note_create}
          placeholder="alt+shift+n"
          onChange={(value) => {
            setHkErr(null);
            onPatchHotkey({ note_create: value });
          }}
        />
        <HotkeyConflictHint
          entries={entries}
          value={hotkey.note_create}
          sourceType="Bugzia"
          scope="Global"
          appName="Bugzia"
          excludeIds={["bugzia.note_create"]}
        />
      </Field>
      <Field label="销毁当前便笺">
        <HotkeyCaptureInput
          value={hotkey.note_destroy}
          placeholder="alt+w"
          onChange={(value) => {
            setHkErr(null);
            onPatchHotkey({ note_destroy: value });
          }}
        />
        <HotkeyConflictHint
          entries={entries}
          value={hotkey.note_destroy}
          sourceType="Bugzia"
          scope="Global"
          appName="Bugzia"
          excludeIds={["bugzia.note_destroy"]}
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
          <div className={"hk-item" + itemStateClass(e)} key={e.id}>
            <div className="hk-item-main">
              <div className="hk-item-name" title={e.title}>
                {e.title}
                {e.manage_level === "HighRisk" && <span className="hk-status">（高风险）</span>}
                {e.conflict.is_system_override && (
                  <span className="hk-status">
                    {e.conflict.conflicts_with_bugzia ? "（被 Bugzia 覆盖）" : "（被自定义键覆盖）"}
                  </span>
                )}
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
  process_name: "",
  window_title_match: "",
  title: "",
  accelerator: "",
  scope: "Global",
  notes: "",
};

interface AppHotkeyGroup {
  key: string;
  appName: string;
  processes: string[];
  running: boolean;
  modifiableCount: number;
  enabledModifiableCount: number;
  entries: HotkeyEntry[];
}

function runningAppKey(app: RunningAppInfo): string {
  return `${app.pid}:${app.process_name}:${app.window_title}`;
}

function appNameFromProcess(processName: string): string {
  return processName.replace(/\.exe$/i, "") || processName;
}

function applicationGroupName(entry: HotkeyEntry): string {
  const appName = entry.app_name.trim();
  if (appName) return appName;
  const processName = entry.process_name?.trim();
  return processName ? appNameFromProcess(processName) : "未命名应用";
}

function applicationGroupKey(entry: HotkeyEntry): string {
  return applicationGroupName(entry).toLowerCase();
}

function applicationSourceOrder(source: HotkeySourceType): number {
  switch (source) {
    case "AppConfig":
      return 0;
    case "AppBuiltin":
      return 1;
    case "Manual":
      return 2;
    default:
      return 3;
  }
}

function formatGroupProcesses(processes: string[]): string {
  if (processes.length === 0) return "未记录进程名";
  if (processes.length <= 2) return processes.join(" / ");
  return `${processes.slice(0, 2).join(" / ")} 等 ${processes.length} 个进程`;
}

function appGroupDomId(index: number): string {
  return `hk-app-group-${index}`;
}

function isManualEntryRunning(
  entry: HotkeyEntry,
  runningApps: RunningAppInfo[],
  runningProcessNames: Set<string>,
): boolean {
  const processName = entry.process_name?.trim().toLowerCase();
  if (processName) return runningProcessNames.has(processName);
  const appName = entry.app_name.trim().toLowerCase();
  if (!appName) return false;
  return runningApps.some((app) => {
    const processStem = appNameFromProcess(app.process_name).trim().toLowerCase();
    return processStem === appName || app.window_title.trim().toLowerCase().includes(appName);
  });
}

function formatSeenTime(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString();
}

function ManualTab({
  entries,
  busy,
  setBusy,
  onChange,
  onEditEntry,
}: {
  entries: HotkeyEntry[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  onChange: () => Promise<void>;
  onEditEntry: (entry: HotkeyEntry) => void;
}) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [runningApps, setRunningApps] = useState<RunningAppInfo[]>([]);

  useEffect(() => {
    let alive = true;
    async function refresh() {
      const apps = await listRunningApps();
      if (alive) {
        setRunningApps(apps);
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const runningProcessNames = useMemo(
    () => new Set(runningApps.map((app) => app.process_name.trim().toLowerCase()).filter(Boolean)),
    [runningApps],
  );

  const appGroups = useMemo(() => {
    const groups = new Map<string, AppHotkeyGroup>();
    for (const entry of entries) {
      const key = applicationGroupKey(entry);
      const processName = entry.process_name?.trim();
      const existing = groups.get(key);
      if (existing) {
        existing.entries.push(entry);
        if (processName && !existing.processes.includes(processName)) existing.processes.push(processName);
      } else {
        groups.set(key, {
          key,
          appName: applicationGroupName(entry),
          processes: processName ? [processName] : [],
          running: false,
          modifiableCount: 0,
          enabledModifiableCount: 0,
          entries: [entry],
        });
      }
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        running: group.entries.some((entry) => isManualEntryRunning(entry, runningApps, runningProcessNames)),
        modifiableCount: group.entries.filter((entry) => entry.can_modify).length,
        enabledModifiableCount: group.entries.filter((entry) => entry.can_modify && entry.display).length,
        entries: [...group.entries].sort(
          (a, b) =>
            applicationSourceOrder(a.source_type) - applicationSourceOrder(b.source_type) ||
            a.title.localeCompare(b.title, "zh-Hans-CN") ||
            a.display.localeCompare(b.display),
        ),
      }))
      .sort(
        (a, b) =>
          Number(b.running) - Number(a.running) ||
          a.appName.localeCompare(b.appName, "zh-Hans-CN"),
      );
  }, [entries, runningApps, runningProcessNames]);

  function scrollToAppGroup(index: number) {
    document
      .getElementById(appGroupDomId(index))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function manualInputFromEntry(entry: HotkeyEntry, accelerator: string): ManualHotkeyInput {
    return {
      app_name: entry.app_name,
      process_name: entry.process_name ?? "",
      window_title_match: entry.window_title_match ?? "",
      title: entry.title,
      accelerator,
      scope: entry.scope,
      notes: entry.target ?? "",
    };
  }

  async function clearModifiableEntry(entry: HotkeyEntry) {
    if (entry.source_type === "AppConfig") {
      await updateAppConfigHotkeyEntry(entry.id, "");
      return;
    }
    if (entry.source_type === "Manual") {
      await updateManualHotkeyEntry(entry.id, manualInputFromEntry(entry, ""));
      return;
    }
    throw new Error("这条快捷键没有可写回的禁用方式");
  }

  async function disableHotkey(entry: HotkeyEntry) {
    if (!entry.can_modify || !entry.display) return;
    if (!window.confirm(`确定禁用「${entry.app_name} / ${entry.title}」的快捷键？\n\n记录会保留，快捷键会清空为未设置。`)) return;
    setBusy(true);
    try {
      await clearModifiableEntry(entry);
      setMsg({ ok: true, text: `已禁用 ${entry.app_name} / ${entry.title}` });
      await onChange();
    } catch (err) {
      setMsg({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function disableAppGroup(group: AppHotkeyGroup) {
    const targets = group.entries.filter((entry) => entry.can_modify && entry.display);
    if (targets.length === 0) return;
    if (!window.confirm(`确定禁用「${group.appName}」下 ${targets.length} 个可修改快捷键？\n\n只会清空可写回的快捷键；只读目录不会被修改。`)) return;
    setBusy(true);
    try {
      for (const entry of targets) {
        await clearModifiableEntry(entry);
      }
      setMsg({ ok: true, text: `已禁用 ${group.appName} 的 ${targets.length} 个可修改快捷键` });
      await onChange();
    } catch (err) {
      setMsg({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function removeManual(e: HotkeyEntry) {
    if (!window.confirm(`确定删除「${e.app_name} / ${e.title}」这条手动登记？`)) return;
    setBusy(true);
    try {
      await removeManualHotkeyEntry(e.id);
      await onChange();
    } catch (err) {
      setMsg({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function hideManual(e: HotkeyEntry) {
    if (!window.confirm(`确定隐藏「${e.app_name} / ${e.title}」？\n\n它会保留来源记录，可在“已隐藏”里恢复。`)) return;
    setBusy(true);
    try {
      await hideHotkeyCenterEntry(e.id);
      await onChange();
    } catch (err) {
      setMsg({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hk-shortcut">
      {msg && <div className={"key-msg " + (msg.ok ? "ok" : "err")}>{msg.text}</div>}

      {appGroups.length === 0 ? (
        <div className="hk-list">
          <div className="hk-empty">还没有应用快捷键记录。</div>
        </div>
      ) : (
        <div className="hk-app-browser">
          <nav className="hk-app-nav" aria-label="应用快捷键导航">
            <div className="hk-app-nav-title">应用</div>
            {appGroups.map((group, index) => (
              <button
                className="hk-app-nav-item"
                type="button"
                key={group.key}
                title={group.appName}
                onClick={() => scrollToAppGroup(index)}
              >
                <span className="hk-app-nav-name">{group.appName}</span>
                <span className="hk-app-nav-count">{group.entries.length}</span>
              </button>
            ))}
          </nav>
          <div className="hk-list hk-app-content">
            {appGroups.map((group, index) => (
              <div className="hk-app-group" id={appGroupDomId(index)} key={group.key}>
                <div className="hk-app-group-head">
                  <div className="hk-app-group-main">
                    <div className="hk-app-group-title" title={group.appName}>
                      {group.appName}
                      {group.running && <span className="hk-status">（运行中）</span>}
                    </div>
                    <div className="hk-app-group-meta" title={formatGroupProcesses(group.processes)}>
                      {formatGroupProcesses(group.processes)} / {group.entries.length} 个快捷键
                    </div>
                  </div>
                  <div className="hk-app-group-actions">
                    <span className="hk-src">{group.modifiableCount} 可修改</span>
                    {group.enabledModifiableCount > 0 && (
                      <button className="key-btn ghost" type="button" disabled={busy} onClick={() => void disableAppGroup(group)}>
                        禁用可修改
                      </button>
                    )}
                  </div>
                </div>
                <div className="hk-app-group-list">
                  {group.entries.map((e) => (
                    <div className={"hk-item" + itemStateClass(e)} key={e.id}>
                      <div className="hk-item-main">
                        <div className="hk-item-name" title={e.title}>{e.title}</div>
                        <div className="hk-item-target">
                          {sourceText(e.source_type)} / {scopeText(e.scope)}
                          {e.process_name ? ` / ${e.process_name}` : ""}
                          {e.window_title_match ? ` / ${e.window_title_match}` : ""}
                          {e.target ? ` / ${e.target}` : ""}
                        </div>
                      </div>
                      <div className="hk-item-actions">
                        <span className="hk-kbd">{e.display || "未设置"}</span>
                        <HotkeyStatusDot c={e.conflict} active={Boolean(e.display)} />
                        {e.can_modify ? (
                          <>
                            <button className="key-btn" type="button" disabled={busy} onClick={() => onEditEntry(e)}>
                              编辑
                            </button>
                            {e.display && (
                              <button className="key-btn ghost" type="button" disabled={busy} onClick={() => void disableHotkey(e)}>
                                禁用
                              </button>
                            )}
                            {e.source_type === "Manual" && (
                              <button className="key-btn ghost" type="button" disabled={busy} onClick={() => void removeManual(e)}>
                                删除
                              </button>
                            )}
                          </>
                        ) : (
                          <span className="hk-src">{levelText(e.manage_level)}</span>
                        )}
                        {canCenterHide(e) && (
                          <button className="key-btn ghost" type="button" disabled={busy} onClick={() => void hideManual(e)}>
                            隐藏
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="hint">
        应用页会合并内置默认、适配读取和手动登记；能写回的项目会显示编辑入口，只读项目仍参与查询和冲突检测。
      </div>
    </div>
  );
}

function SupplementTab({
  allEntries,
  editTarget,
  busy,
  setBusy,
  onChange,
}: {
  allEntries: HotkeyEntry[];
  editTarget: SupplementEditTarget | null;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onChange: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<ManualHotkeyInput>(EMPTY_MANUAL_INPUT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingSourceType, setEditingSourceType] = useState<HotkeySourceType | null>(null);
  const [runningApps, setRunningApps] = useState<RunningAppInfo[]>([]);
  const [observedHotkeys, setObservedHotkeys] = useState<ObservedHotkeyEntry[]>([]);
  const [observerEnabled, setObserverEnabled] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    async function refresh() {
      const [apps, observed, status] = await Promise.all([
        listRunningApps(),
        listObservedHotkeys(),
        getHotkeyObserverStatus(),
      ]);
      if (alive) {
        setRunningApps(apps);
        setObservedHotkeys(observed);
        setObserverEnabled(status.enabled);
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!editTarget) return;
    editEntry(editTarget.entry);
  }, [editTarget?.token]);

  function patchDraft(p: Partial<ManualHotkeyInput>) {
    setDraft((cur) => ({ ...cur, ...p }));
    setMsg(null);
  }

  async function refreshRunningApps() {
    const apps = await listRunningApps();
    setRunningApps(apps);
  }

  async function refreshObserved() {
    const [observed, status] = await Promise.all([
      listObservedHotkeys(),
      getHotkeyObserverStatus(),
    ]);
    setObservedHotkeys(observed);
    setObserverEnabled(status.enabled);
  }

  function chooseRunningApp(key: string) {
    const app = runningApps.find((item) => runningAppKey(item) === key);
    if (!app) return;
    patchDraft({
      app_name: appNameFromProcess(app.process_name),
      process_name: app.process_name,
      window_title_match: app.window_title,
    });
  }

  function editEntry(e: HotkeyEntry) {
    setEditingId(e.id);
    setEditingSourceType(e.source_type);
    setDraft({
      app_name: e.app_name,
      process_name: e.process_name ?? "",
      window_title_match: e.window_title_match ?? "",
      title: e.title,
      accelerator: e.display,
      scope: e.scope,
      notes: e.target ?? "",
    });
    setMsg(null);
  }

  function resetDraft() {
    setEditingId(null);
    setEditingSourceType(null);
    setDraft(EMPTY_MANUAL_INPUT);
    setMsg(null);
  }

  async function saveManual() {
    setBusy(true);
    try {
      if (editingId && editingSourceType === "AppConfig") {
        await updateAppConfigHotkeyEntry(editingId, draft.accelerator);
      } else if (editingId) {
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

  const editingIsAppConfig = editingSourceType === "AppConfig";

  async function toggleObserver() {
    setBusy(true);
    try {
      const next = await setHotkeyObserverEnabled(!observerEnabled);
      setObserverEnabled(next.enabled);
      setObservedHotkeys(await listObservedHotkeys());
      setMsg({
        ok: true,
        text: next.enabled ? "已开始观察记录应用快捷键。" : "已停止观察记录。",
      });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function promoteObserved(entry: ObservedHotkeyEntry) {
    setBusy(true);
    try {
      await promoteObservedHotkey(entry.id);
      setObservedHotkeys(await listObservedHotkeys());
      await onChange();
      setMsg({ ok: true, text: `已登记 ${entry.app_name} / ${entry.accelerator}` });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function removeObserved(entry: ObservedHotkeyEntry) {
    setBusy(true);
    try {
      await removeObservedHotkey(entry.id);
      setObservedHotkeys(await listObservedHotkeys());
      setMsg(null);
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hk-shortcut">
      <div className="hk-manual-form">
        <div className="hk-filters">
          <button className="key-btn" type="button" disabled={busy} onClick={() => void toggleObserver()}>
            {observerEnabled ? "停止观察" : "开始观察"}
          </button>
          <button className="key-btn ghost" type="button" disabled={busy} onClick={() => void refreshObserved()}>
            刷新记录
          </button>
          <span className="hk-src">
            {observerEnabled ? "观察中：切到目标应用后直接使用快捷键" : "未开启观察记录"}
          </span>
        </div>
        {msg && <div className={"key-msg " + (msg.ok ? "ok" : "err")}>{msg.text}</div>}
        <div className="hk-list">
          {observedHotkeys.length === 0 && (
            <div className="hk-empty">还没有观察到应用快捷键。</div>
          )}
          {observedHotkeys.slice(0, 12).map((entry) => (
            <div className="hk-item notice" key={entry.id}>
              <div className="hk-item-main">
                <div className="hk-item-name" title={entry.window_title}>
                  {entry.app_name}
                  <span className="hk-status">（{entry.count} 次）</span>
                </div>
                <div className="hk-item-target">
                  {entry.process_name} / {entry.window_title}
                  {entry.last_seen_ms ? ` / 最近 ${formatSeenTime(entry.last_seen_ms)}` : ""}
                </div>
              </div>
              <div className="hk-item-actions">
                <span className="hk-kbd">{entry.accelerator}</span>
                <button
                  className="key-btn"
                  type="button"
                  disabled={busy}
                  onClick={() => void promoteObserved(entry)}
                >
                  登记
                </button>
                <button
                  className="key-btn ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void removeObserved(entry)}
                >
                  忽略
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="hk-filters">
        <select className="f-input hk-search" defaultValue="" onChange={(e) => chooseRunningApp(e.target.value)}>
          <option value="">选择运行中的应用来填充进程名</option>
          {runningApps.map((app) => (
            <option value={runningAppKey(app)} key={runningAppKey(app)}>
              {appNameFromProcess(app.process_name)} / {app.window_title}
            </option>
          ))}
        </select>
        <button className="key-btn ghost" type="button" disabled={busy} onClick={() => void refreshRunningApps()}>
          刷新运行中
        </button>
      </div>
      <div className="hk-manual-form">
        <Field label="应用">
          <input
            className="f-input"
            value={draft.app_name}
            placeholder="例如 酷狗音乐"
            disabled={editingIsAppConfig}
            onChange={(e) => patchDraft({ app_name: e.target.value })}
          />
        </Field>
        <Field label="进程名">
          <input
            className="f-input"
            value={draft.process_name}
            placeholder="例如 KuGou.exe、Pogget.exe"
            disabled={editingIsAppConfig}
            onChange={(e) => patchDraft({ process_name: e.target.value })}
          />
        </Field>
        <Field label="窗口标题">
          <input
            className="f-input"
            value={draft.window_title_match}
            placeholder="可选：用于识别运行中的窗口"
            disabled={editingIsAppConfig}
            onChange={(e) => patchDraft({ window_title_match: e.target.value })}
          />
        </Field>
        <Field label="功能">
          <input
            className="f-input"
            value={draft.title}
            placeholder="例如 播放 / 暂停"
            disabled={editingIsAppConfig}
            onChange={(e) => patchDraft({ title: e.target.value })}
          />
        </Field>
        <Field label="快捷键">
          <HotkeyCaptureInput
            value={draft.accelerator}
            placeholder="例如 Alt+K、Win+Shift+S"
            onChange={(value) => patchDraft({ accelerator: value })}
          />
          <HotkeyConflictHint
            entries={allEntries}
            value={draft.accelerator}
            sourceType={editingIsAppConfig ? "AppConfig" : "Manual"}
            scope={draft.scope}
            appName={draft.app_name}
            processName={draft.process_name}
            excludeIds={editingId ? [editingId] : []}
          />
        </Field>
        <Field label="作用域">
          <select
            className="f-input"
            value={draft.scope}
            disabled={editingIsAppConfig}
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
            disabled={editingIsAppConfig}
            onChange={(e) => patchDraft({ notes: e.target.value })}
          />
        </Field>
        {editingIsAppConfig && (
          <div className="hint">当前编辑的是应用配置项，只会写回这一个快捷键字段。</div>
        )}
        <div className="hk-jump">
          <button className="key-btn" type="button" disabled={busy} onClick={() => void saveManual()}>
            {editingIsAppConfig ? "保存到应用配置" : editingId ? "保存修改" : "添加登记"}
          </button>
          {editingId && (
            <button className="key-btn ghost" type="button" disabled={busy} onClick={resetDraft}>
              取消编辑
            </button>
          )}
        </div>
      </div>
      <div className="hint">
        观察记录会统计你在前台应用中实际按过的快捷组合；登记后进入应用页，并参与冲突检测。
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
          <div className={"hk-item" + itemStateClass(e)} key={e.id}>
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
        这里管理的是 Windows 系统目录、应用配置、应用内置和手动登记快捷键的隐藏项；快捷方式的隐藏项仍在“快捷方式”标签内恢复。
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
    case "AppConfig":
      return "应用配置";
    case "AppBuiltin":
      return "应用内置";
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
  entries,
  busy,
  setBusy,
  onChange,
}: {
  items: ShortcutHotkeyItem[];
  hiddenItems: ShortcutHotkeyItem[];
  byId: Map<string, HotkeyEntry>;
  entries: HotkeyEntry[];
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
                    <HotkeyCaptureInput
                      className="f-input hk-edit"
                      value={editVal}
                      placeholder="如 Ctrl+Alt+F9"
                      autoFocus
                      onChange={setEditVal}
                      onCommit={() => void applyEdit(it)}
                      onCancel={() => {
                        setEditPath(null);
                        setEditVal("");
                      }}
                    />
                    <HotkeyConflictHint
                      entries={entries}
                      value={editVal}
                      sourceType="ShortcutLink"
                      scope="Global"
                      appName={entry?.app_name ?? it.name}
                      processName={entry?.process_name ?? ""}
                      excludeIds={[it.shortcut_path]}
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
