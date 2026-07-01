import { useEffect, useMemo, useState } from "react";
import type { HotkeySettings } from "../features/settings/settingsTypes";
import type { ConflictInfo, HotkeyEntry, ShortcutHotkeyItem } from "../features/hotkeys/hotkeyTypes";
import { detectHotkeyConflicts } from "../features/hotkeys/hotkeyCenter";
import {
  clearShortcutHotkey,
  revealShortcut,
  restoreShortcutHotkey,
  scanShortcutHotkeys,
  setShortcutHotkey,
} from "../features/hotkeys/shortcutHotkeys";
import "./SettingsPanel.css";

/**
 * 快捷键中心：多标签壳（总览 / Bugzia / 快捷方式）。
 * - Bugzia 自身快捷键复用既有 settings 写流程（onPatchHotkey），不新增持久化。
 * - 快捷方式走独立的 .lnk COM 命令，绝不碰 settings.json。
 * - 总览由后端 detectHotkeyConflicts 预计算 display + 冲突状态，前端不解析。
 */
type Tab = "overview" | "bugzia" | "shortcut";

interface Props {
  hotkey: HotkeySettings;
  onPatchHotkey: (p: Partial<HotkeySettings>) => void;
  hkErr: string | null;
  setHkErr: (s: string | null) => void;
}

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "总览" },
  { key: "bugzia", label: "Bugzia" },
  { key: "shortcut", label: "快捷方式" },
];

const isWindows = /win/i.test(navigator.userAgent);

export default function HotkeyCenterPanel({ hotkey, onPatchHotkey, hkErr, setHkErr }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [entries, setEntries] = useState<HotkeyEntry[]>([]);
  const [shortcuts, setShortcuts] = useState<ShortcutHotkeyItem[]>([]);
  const [shortcutsLoaded, setShortcutsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  // 总览数据：挂载 + Bugzia 快捷键变化时刷新（后者让冲突徽标跟上输入框编辑）。
  useEffect(() => {
    let alive = true;
    detectHotkeyConflicts().then((e) => {
      if (alive) setEntries(e);
    });
    return () => {
      alive = false;
    };
  }, [hotkey.summon, hotkey.note]);

  // 快捷方式明细：首次切到该标签时拉取一次。
  useEffect(() => {
    if (tab !== "shortcut" || shortcutsLoaded || !isWindows) return;
    let alive = true;
    scanShortcutHotkeys().then((s) => {
      if (alive) {
        setShortcuts(s);
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
    const [s, e] = await Promise.all([scanShortcutHotkeys(), detectHotkeyConflicts()]);
    setShortcuts(s);
    setEntries(e);
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

      {tab === "bugzia" && (
        <BugziaTab
          hotkey={hotkey}
          onPatchHotkey={onPatchHotkey}
          hkErr={hkErr}
          setHkErr={setHkErr}
          byId={byId}
        />
      )}

      {tab === "shortcut" && (
        <ShortcutTab
          items={shortcuts}
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
          <span>冲突</span>
        </div>
        {entries.length === 0 && <div className="hk-empty">暂无数据，或扫描失败。</div>}
        {entries.map((e) => (
          <div className={"hk-row" + (e.conflict.is_duplicate ? " dup" : "")} key={e.id}>
            <span className="hk-kbd">{e.display || "未设置"}</span>
            <span className="hk-name" title={e.title}>{e.title}</span>
            <span className="hk-src">{e.app_name}</span>
            <span className="hk-conf">
              <ConflictBadge c={e.conflict} />
            </span>
          </div>
        ))}
      </div>
      <div className="hint">
        Bugzia 自身键与桌面 / 开始菜单的快捷方式热键都会列出。冲突可在对应标签里修改。
      </div>
      <div className="hk-jump">
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

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" }) {
  return (
    <div className={"hk-stat" + (tone ? ` ${tone}` : "")}>
      <span className="hk-stat-num">{value}</span>
      <span className="hk-stat-label">{label}</span>
    </div>
  );
}

function ConflictBadge({ c }: { c: ConflictInfo }) {
  if (!c.is_duplicate) return <span className="hk-badge mute">无</span>;
  if (c.conflicts_with_bugzia) return <span className="hk-badge bugzia">与 Bugzia 冲突</span>;
  return <span className="hk-badge dup">重复</span>;
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
      {hkErr && <div className="key-msg err">{hkErr}</div>}
      <div className="hint">
        召唤键 / 便笺键再按一次即隐藏（切换）。便笺键：有便笺显示则全部收起，否则呼出，一条都没有则新建空白便笺。格式为修饰键加按键，如 alt+space、alt+n、ctrl+shift+p。修改后即时生效。
      </div>
    </div>
  );
}

function ReadonlyKey({ label, entry }: { label: string; entry?: HotkeyEntry }) {
  return (
    <div className="hk-readonly">
      <span className="hk-readonly-label">{label}</span>
      <span className="hk-kbd">{entry?.display || "未设置"}</span>
      {entry && <ConflictBadge c={entry.conflict} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 快捷方式（.lnk COM 读写）
// ---------------------------------------------------------------------------

function ShortcutTab({
  items,
  byId,
  busy,
  setBusy,
  onChange,
}: {
  items: ShortcutHotkeyItem[];
  byId: Map<string, HotkeyEntry>;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onChange: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [onlySet, setOnlySet] = useState(false);
  const [editPath, setEditPath] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [rowErr, setRowErr] = useState<{ path: string; msg: string } | null>(null);

  if (!isWindows) {
    return <div className="hk-empty">此功能仅在 Windows 上可用。</div>;
  }
  if (!items.length) {
    return (
      <div className="hk-shortcut-empty">
        <div className="hk-empty">未扫描到桌面 / 开始菜单下的快捷方式（含热键或可设置）。</div>
        <button className="key-btn" type="button" onClick={onChange} disabled={busy}>
          {busy ? "刷新中…" : "重新扫描"}
        </button>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const filtered = items.filter((it) => {
    if (onlySet && !it.hotkey) return false;
    if (!q) return true;
    return (
      it.name.toLowerCase().includes(q) ||
      it.target_path.toLowerCase().includes(q) ||
      it.hotkey.toLowerCase().includes(q)
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
        <button className="key-btn ghost" type="button" onClick={onChange} disabled={busy}>
          {busy ? "刷新中…" : "刷新"}
        </button>
      </div>

      <div className="hk-list">
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
                    {entry && <ConflictBadge c={entry.conflict} />}
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
                    <button
                      className="key-btn ghost"
                      type="button"
                      disabled={busy}
                      onClick={() => void revealShortcut(it.shortcut_path)}
                    >
                      打开位置
                    </button>
                    <button
                      className="key-btn ghost"
                      type="button"
                      disabled={!it.backup_available || busy}
                      title={it.backup_available ? "恢复最近备份" : "无可用备份"}
                      onClick={() => void handleRestore(it)}
                    >
                      恢复
                    </button>
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
