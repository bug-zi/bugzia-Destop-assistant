import { useEffect, useState } from "react";
import type {
  AppSettings,
  AppearanceSettings,
  AiSettings,
  ResultAppearanceSettings,
  SearchSettings,
  WindowSettings,
} from "../features/settings/settingsTypes";
import { loadApiKey, saveApiKey, clearApiKey, testAiConnection } from "../features/settings/settingsStore";
import { SEARCH_ENGINES } from "../features/search/command";
import { open } from "@tauri-apps/plugin-dialog";
import "./SettingsPanel.css";

interface SettingsPanelProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onClose: () => void;
}

export default function SettingsPanel({ settings, onChange, onClose }: SettingsPanelProps) {
  const patchAppearance = (p: Partial<AppearanceSettings>) =>
    onChange({ ...settings, appearance: { ...settings.appearance, ...p } });
  const patchAi = (p: Partial<AiSettings>) =>
    onChange({ ...settings, ai: { ...settings.ai, ...p } });
  const patchSearch = (p: Partial<SearchSettings>) =>
    onChange({ ...settings, search: { ...settings.search, ...p } });
  const patchWindow = (p: Partial<WindowSettings>) =>
    onChange({ ...settings, window: { ...settings.window, ...p } });
  const patchResult = (p: Partial<ResultAppearanceSettings>) =>
    onChange({ ...settings, result: { ...settings.result, ...p } });

  // API key lives in the OS keyring, separate from the JSON settings, so it has
  // its own local state + explicit save.
  const [apiKey, setApiKey] = useState("");
  const [keyLoaded, setKeyLoaded] = useState(false);
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Connectivity test ("测试连接") state.
  const [testing, setTesting] = useState(false);
  const [testRes, setTestRes] = useState<{ ok: boolean; text: string } | null>(null);
  // Draft text for the "忽略目录名" add-row before it's committed to the list.
  const [ignoreDraft, setIgnoreDraft] = useState("");

  useEffect(() => {
    let alive = true;
    loadApiKey().then((k) => {
      if (!alive) return;
      setApiKey(k ?? "");
      setKeyLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function handleSaveKey() {
    const ok = await saveApiKey(apiKey.trim());
    setKeyMsg({ ok, text: ok ? "已安全保存到系统凭据管理器" : "保存失败，见控制台" });
  }

  async function handleClearKey() {
    await clearApiKey();
    setApiKey("");
    setKeyMsg({ ok: true, text: "已清除" });
  }

  /** Probe the live BaseURL / Model / API Key with a minimal request. */
  async function handleTest() {
    setTesting(true);
    setTestRes(null);
    const r = await testAiConnection(settings.ai.base_url, settings.ai.model, apiKey);
    setTesting(false);
    if (r.ok) {
      const bits = [r.model ? `实际模型: ${r.model}` : "", r.reply ? `回复: ${r.reply}` : ""].filter(
        Boolean,
      );
      setTestRes({ ok: true, text: `✓ 连通成功${bits.length ? " · " + bits.join(" · ") : ""}` });
    } else {
      setTestRes({ ok: false, text: `✗ ${r.message || "连接失败"}` });
    }
  }

  /** Native folder picker -> append a directory to index_dirs (dedup, case-insensitive). */
  async function handlePickDir() {
    let picked: string | null;
    try {
      picked = await open({ directory: true, multiple: false });
    } catch (e) {
      console.error("[bugzia] pick directory failed", e);
      return;
    }
    if (!picked) return;
    const dirs = settings.search.index_dirs;
    const lower = picked.toLowerCase();
    if (dirs.some((d) => d.toLowerCase() === lower)) return;
    patchSearch({ index_dirs: [...dirs, picked] });
  }

  function removeIndexDir(index: number) {
    patchSearch({ index_dirs: settings.search.index_dirs.filter((_, i) => i !== index) });
  }

  /** Commit the ignore-segment draft (trim, dedup case-insensitively). */
  function addIgnoreDir() {
    const seg = ignoreDraft.trim();
    setIgnoreDraft("");
    if (!seg) return;
    const segs = settings.search.ignore_dirs;
    if (segs.some((s) => s.toLowerCase() === seg.toLowerCase())) return;
    patchSearch({ ignore_dirs: [...segs, seg] });
  }

  function removeIgnoreDir(index: number) {
    patchSearch({ ignore_dirs: settings.search.ignore_dirs.filter((_, i) => i !== index) });
  }

  const a = settings.appearance;
  const r = settings.result;
  const ai = settings.ai;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-drag" data-tauri-drag-region title="拖动设置窗口" />
        <div className="settings-head">
          <span className="settings-title">设置</span>
          <button className="settings-close" type="button" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>

        <div className="settings-body">
          {/* ── 卡片 ── */}
          <section className="settings-section">
            <h4>卡片</h4>
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.window.locked}
                onChange={(e) => patchWindow({ locked: e.target.checked })}
              />
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                strokeLinejoin="round" aria-hidden="true">
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              锁定位置与大小（锁定后无法拖动或拉伸卡片）
            </label>
          </section>

          {/* ── 外观 ── */}
          <section className="settings-section">
            <h4>外观</h4>
            <ColorRow label="R 红" value={a.bg_r} min={0} max={255} step={1}
              onChange={(v) => patchAppearance({ bg_r: v })} />
            <ColorRow label="G 绿" value={a.bg_g} min={0} max={255} step={1}
              onChange={(v) => patchAppearance({ bg_g: v })} />
            <ColorRow label="B 蓝" value={a.bg_b} min={0} max={255} step={1}
              onChange={(v) => patchAppearance({ bg_b: v })} />
            <ColorRow label="透明度" value={a.bg_a} min={0} max={1} step={0.01}
              fmt={(v) => v.toFixed(2)} onChange={(v) => patchAppearance({ bg_a: v })} />
            <ColorRow label="模糊" value={a.blur} min={0} max={40} step={1}
              fmt={(v) => `${v}px`} onChange={(v) => patchAppearance({ blur: v })} />
            <ColorRow label="圆角" value={a.radius} min={0} max={30} step={1}
              fmt={(v) => `${v}px`} onChange={(v) => patchAppearance({ radius: v })} />
            <ColorRow label="字号" value={a.font_scale} min={0.8} max={1.6} step={0.05}
              fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => patchAppearance({ font_scale: v })} />
          </section>

          {/* ── 结果面板 ── */}
          <section className="settings-section">
            <h4>结果面板</h4>
            <ColorRow label="透明度" value={r.bg_a} min={0} max={1} step={0.01}
              fmt={(v) => v.toFixed(2)} onChange={(v) => patchResult({ bg_a: v })} />
            <ColorRow label="圆角" value={r.radius} min={0} max={30} step={1}
              fmt={(v) => `${v}px`} onChange={(v) => patchResult({ radius: v })} />
            <ColorRow label="模糊" value={r.blur} min={0} max={40} step={1}
              fmt={(v) => `${v}px`} onChange={(v) => patchResult({ blur: v })} />
            <ColorRow label="字号" value={r.font_scale} min={0.8} max={1.6} step={0.05}
              fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => patchResult({ font_scale: v })} />
            <ColorRow label="行间距" value={r.row_gap} min={0} max={16} step={1}
              fmt={(v) => `${v}px`} onChange={(v) => patchResult({ row_gap: v })} />
            <ColorRow label="列表项圆角" value={r.item_radius} min={0} max={20} step={1}
              fmt={(v) => `${v}px`} onChange={(v) => patchResult({ item_radius: v })} />
            <ColorRow label="行内边距" value={r.row_pad} min={0} max={16} step={1}
              fmt={(v) => `${v}px`} onChange={(v) => patchResult({ row_pad: v })} />
            <ColorRow label="悬停高亮" value={r.hover_alpha} min={0} max={1} step={0.01}
              fmt={(v) => v.toFixed(2)} onChange={(v) => patchResult({ hover_alpha: v })} />
            <ColorRow label="滚动条宽度" value={r.scrollbar_w} min={4} max={14} step={1}
              fmt={(v) => `${v}px`} onChange={(v) => patchResult({ scrollbar_w: v })} />
          </section>

          {/* ── AI ── */}
          <section className="settings-section">
            <h4>AI 接口</h4>
            <Field label="Provider 名称">
              <input className="f-input" value={ai.provider_name} placeholder="例如 OpenAI / 中转"
                onChange={(e) => patchAi({ provider_name: e.target.value })} />
            </Field>
            <Field label="Base URL">
              <input className="f-input" value={ai.base_url} placeholder="https://api.openai.com/v1"
                onChange={(e) => patchAi({ base_url: e.target.value })} />
            </Field>
            <Field label="Model">
              <input className="f-input" value={ai.model} placeholder="gpt-4o-mini"
                onChange={(e) => patchAi({ model: e.target.value })} />
            </Field>
            <Field label="API Key">
              <div className="key-row">
                <input className="f-input" type="password" value={apiKey}
                  placeholder={keyLoaded ? "未设置" : "加载中…"}
                  onChange={(e) => setApiKey(e.target.value)} />
                <button className="key-btn" type="button" onClick={handleSaveKey}>保存</button>
                <button className="key-btn ghost" type="button" onClick={handleClearKey}>清除</button>
              </div>
              {keyMsg && <div className={"key-msg " + (keyMsg.ok ? "ok" : "err")}>{keyMsg.text}</div>}
              <div className="hint">仅存系统凭据管理器，不写入 JSON。</div>
            </Field>
            <Field label="连通测试">
              <div className="key-row">
                <button className="key-btn" type="button" onClick={handleTest} disabled={testing}>
                  {testing ? "测试中…" : "测试连接"}
                </button>
              </div>
              {testRes && (
                <div className={"key-msg " + (testRes.ok ? "ok" : "err")}>{testRes.text}</div>
              )}
              <div className="hint">用当前 BaseURL / Model / API Key 发一条最小请求验证。</div>
            </Field>
            <Field label="System Prompt">
              <textarea className="f-input" rows={3} value={ai.system_prompt}
                placeholder="你是一个简洁的桌面助手，默认中文回答。"
                onChange={(e) => patchAi({ system_prompt: e.target.value })} />
            </Field>
            <ColorRow label="Temperature" value={ai.temperature} min={0} max={2} step={0.1}
              fmt={(v) => v.toFixed(1)} onChange={(v) => patchAi({ temperature: v })} />
            <label className="check-row">
              <input type="checkbox" checked={ai.stream}
                onChange={(e) => patchAi({ stream: e.target.checked })} />
              流式输出
            </label>
          </section>

          {/* ── 搜索 ── */}
          <section className="settings-section">
            <h4>搜索</h4>
            <Field label="默认搜索引擎">
              <select className="f-input" value={settings.search.default_engine}
                onChange={(e) => patchSearch({ default_engine: e.target.value })}>
                {SEARCH_ENGINES.map((eng) => (
                  <option key={eng.id} value={eng.id}>{eng.name}</option>
                ))}
              </select>
            </Field>
            <Field label="自定义搜索 URL">
              <input className="f-input" value={settings.search.custom_engine_url}
                placeholder="https://example.com/search?q= (用 {q} 占位)"
                onChange={(e) => patchSearch({ custom_engine_url: e.target.value })} />
            </Field>

            <Field label="搜索范围目录">
              <div className="list-add-row">
                <button className="key-btn" type="button" onClick={handlePickDir}>选择文件夹…</button>
              </div>
              <StringList items={settings.search.index_dirs} onRemove={removeIndexDir} />
              <div className="hint">桌面 / 文档 / 下载 默认已包含；点上方按钮追加其它目录。</div>
            </Field>

            <Field label="忽略目录名">
              <div className="list-add-row">
                <input className="f-input" value={ignoreDraft}
                  placeholder="例如 temp、缓存、备份"
                  onChange={(e) => setIgnoreDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addIgnoreDir();
                    }
                  }} />
                <button className="key-btn" type="button" onClick={addIgnoreDir}>添加</button>
              </div>
              <StringList items={settings.search.ignore_dirs} onRemove={removeIgnoreDir} />
              <div className="hint">按目录名最后一段匹配、忽略大小写；node_modules / .git 等已内置忽略。</div>
            </Field>

            <ColorRow label="结果上限" value={settings.search.max_results} min={1} max={500} step={1}
              fmt={(v) => String(v)} onChange={(v) => patchSearch({ max_results: v })} />
          </section>
        </div>
      </div>
    </div>
  );
}

/** Slider + numeric readout row, used for color / size / temperature. */
function ColorRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const { label, value, min, max, step, fmt, onChange } = props;
  return (
    <div className="color-row">
      <span className="color-label">{label}</span>
      <input
        className="color-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="color-value">{fmt ? fmt(value) : value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

/** Removable list of string items (搜索范围目录 / 忽略目录名). Empty -> nothing. */
function StringList({ items, onRemove }: { items: string[]; onRemove: (index: number) => void }) {
  if (!items.length) return null;
  return (
    <ul className="str-list">
      {items.map((it, i) => (
        <li className="str-list-item" key={`${i}:${it}`}>
          <span className="str-list-text" title={it}>{it}</span>
          <button className="str-list-del" type="button" title="删除" onClick={() => onRemove(i)}>
            删除
          </button>
        </li>
      ))}
    </ul>
  );
}
