import { useEffect, useState } from "react";
import type {
  AgentNotifySettings,
  AppSettings,
  AppearanceSettings,
  AiSettings,
  NoteSettings,
  PetSettings,
  ResultAppearanceSettings,
  SearchSettings,
  SocialNotifySettings,
  WaveformSettings,
  WindowSettings,
} from "../features/settings/settingsTypes";
import { loadApiKey, saveApiKey, clearApiKey, testAiConnection } from "../features/settings/settingsStore";
import { SEARCH_ENGINES } from "../features/search/command";
import { open, message } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
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
  const patchWaveform = (p: Partial<WaveformSettings>) =>
    onChange({ ...settings, waveform: { ...settings.waveform, ...p } });
  const patchPet = (p: Partial<PetSettings>) =>
    onChange({ ...settings, pet: { ...settings.pet, ...p } });
  const patchNote = (p: Partial<NoteSettings>) =>
    onChange({ ...settings, note: { ...settings.note, ...p } });
  const patchAgentNotify = (p: Partial<AgentNotifySettings>) =>
    onChange({ ...settings, agent_notify: { ...settings.agent_notify, ...p } });
  const patchSocialNotify = (p: Partial<SocialNotifySettings>) =>
    onChange({ ...settings, social_notify: { ...settings.social_notify, ...p } });

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

  /** Open the reserved pet asset dir. The current default art is bundled, so
   *  files here do not override the displayed pet until config-based skins land. */
  async function handleOpenPetFolder() {
    try {
      const dir = await invoke<string>("pet_assets_dir");
      await openPath(dir);
    } catch (e) {
      console.error("[bugzia] open pet folder", e);
      // Surface the real error (e.g. ACL ForbiddenPath) so a failure isn't
      // silently swallowed — the button otherwise looks dead.
      void message(`无法打开素材文件夹：\n${String(e)}`, { title: "桌宠", kind: "error" });
    }
  }

  const a = settings.appearance;
  const r = settings.result;
  const ai = settings.ai;
  const wf = settings.waveform;
  const pet = settings.pet;
  const n = settings.note;
  const an = settings.agent_notify;
  const sn = settings.social_notify;

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
            <ColorField label="背景色"
              r={a.bg_r} g={a.bg_g} b={a.bg_b}
              onChange={(hex) => { const c = hexToRgb(hex); patchAppearance({ bg_r: c.r, bg_g: c.g, bg_b: c.b }); }} />
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
            <ColorField label="背景色"
              r={r.bg_r} g={r.bg_g} b={r.bg_b}
              onChange={(hex) => { const c = hexToRgb(hex); patchResult({ bg_r: c.r, bg_g: c.g, bg_b: c.b }); }} />
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
            <ColorField label="非锁定卡片颜色"
              r={r.unlocked_r} g={r.unlocked_g} b={r.unlocked_b}
              presets={UNLOCKED_COLOR_PRESETS}
              onChange={(hex) => { const c = hexToRgb(hex); patchResult({ unlocked_r: c.r, unlocked_g: c.g, unlocked_b: c.b }); }} />
            <ColorRow label="非锁定透明度" value={r.unlocked_a} min={0} max={0.8} step={0.01}
              fmt={(v) => v.toFixed(2)} onChange={(v) => patchResult({ unlocked_a: v })} />
            <ColorField label="锁定卡片颜色"
              r={r.locked_r} g={r.locked_g} b={r.locked_b}
              presets={LOCKED_COLOR_PRESETS}
              onChange={(hex) => { const c = hexToRgb(hex); patchResult({ locked_r: c.r, locked_g: c.g, locked_b: c.b }); }} />
            <ColorRow label="锁定透明度" value={r.locked_a} min={0} max={0.8} step={0.01}
              fmt={(v) => v.toFixed(2)} onChange={(v) => patchResult({ locked_a: v })} />
            <div className="hint">作用于历史对话侧栏的卡片：未锁定与已锁定各自可调颜色和透明度（半透明叠加）。点预设色块或用取色盘自选。</div>
          </section>

          {/* ── 桌面波形 ── */}
          <section className="settings-section">
            <h4>桌面波形</h4>
            <label className="check-row">
              <input type="checkbox" checked={wf.enabled}
                onChange={(e) => patchWaveform({ enabled: e.target.checked })} />
              启用桌面波形（采集系统声音，花瓣随音量飘落）
            </label>
            <label className="check-row">
              <input type="checkbox" checked={wf.always_on_top}
                onChange={(e) => patchWaveform({ always_on_top: e.target.checked })} />
              置顶显示
            </label>
            <label className="check-row">
              <input type="checkbox" checked={wf.locked}
                onChange={(e) => patchWaveform({ locked: e.target.checked })} />
              锁定（鼠标穿透，无法拖动）
            </label>
            <ColorRow label="透明度" value={wf.opacity} min={0.1} max={1} step={0.01}
              fmt={(v) => v.toFixed(2)} onChange={(v) => patchWaveform({ opacity: v })} />
            <ColorRow label="灵敏度" value={wf.sensitivity} min={0.1} max={3} step={0.1}
              fmt={(v) => `${v.toFixed(1)}×`} onChange={(v) => patchWaveform({ sensitivity: v })} />
            <ColorRow label="花瓣大小" value={wf.petal_size} min={4} max={40} step={1}
              fmt={(v) => `${v}px`} onChange={(v) => patchWaveform({ petal_size: v })} />
            <ColorRow label="花瓣密度" value={wf.petal_density} min={10} max={150} step={1}
              fmt={(v) => String(v)} onChange={(v) => patchWaveform({ petal_density: v })} />
            <ColorRow label="飘落速度" value={wf.drift_speed} min={0.2} max={3} step={0.1}
              fmt={(v) => `${v.toFixed(1)}×`} onChange={(v) => patchWaveform({ drift_speed: v })} />
            <ColorField label="主色"
              r={wf.color_r} g={wf.color_g} b={wf.color_b}
              onChange={(hex) => { const c = hexToRgb(hex); patchWaveform({ color_r: c.r, color_g: c.g, color_b: c.b }); }} />
            <ColorField label="高光"
              r={wf.accent_r} g={wf.accent_g} b={wf.accent_b}
              onChange={(hex) => { const c = hexToRgb(hex); patchWaveform({ accent_r: c.r, accent_g: c.g, accent_b: c.b }); }} />
            <div className="list-add-row">
              <button className="key-btn" type="button"
                onClick={() => patchWaveform({ x: -1, y: -1, w: 0 })}>
                重置位置
              </button>
            </div>
            <div className="hint">重置后按屏幕下方居中默认位置显示。</div>
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

          {/* ── 桌宠 ── */}
          <section className="settings-section">
            <h4>桌宠</h4>
            <label className="check-row">
              <input
                type="checkbox"
                checked={pet.enabled}
                onChange={(e) => patchPet({ enabled: e.target.checked })}
              />
              启用桌宠
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={pet.always_on_top}
                onChange={(e) => patchPet({ always_on_top: e.target.checked })}
              />
              置顶
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={pet.locked}
                onChange={(e) => patchPet({ locked: e.target.checked })}
              />
              锁定（鼠标穿透，不响应点击/拖动）
            </label>
            <ColorRow label="缩放" value={pet.scale} min={0.5} max={2} step={0.05}
              fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => patchPet({ scale: v })} />
            <ColorRow label="眨眼间隔" value={pet.blink_interval_ms} min={1000} max={10000} step={500}
              fmt={(v) => `${v}ms`} onChange={(v) => patchPet({ blink_interval_ms: v })} />
            <label className="check-row">
              <input
                type="checkbox"
                checked={pet.speech_enabled}
                onChange={(e) => patchPet({ speech_enabled: e.target.checked })}
              />
              随机说话
            </label>
            <ColorRow label="说话间隔" value={pet.speech_interval_ms} min={5000} max={60000} step={1000}
              fmt={(v) => `${(v / 1000).toFixed(0)}s`} onChange={(v) => patchPet({ speech_interval_ms: v })} />
            <label className="check-row">
              <input
                type="checkbox"
                checked={pet.ai_speech_enabled}
                onChange={(e) => patchPet({ ai_speech_enabled: e.target.checked })}
              />
              AI 即兴说话
            </label>
            <ColorRow label="闲置 AI 间隔" value={pet.ai_idle_interval_ms} min={30000} max={300000} step={5000}
              fmt={(v) => `${(v / 1000).toFixed(0)}s`} onChange={(v) => patchPet({ ai_idle_interval_ms: v })} />
            <ColorRow label="互动 AI 间隔" value={pet.ai_interaction_interval_ms} min={0} max={60000} step={1000}
              fmt={(v) => `${(v / 1000).toFixed(0)}s`} onChange={(v) => patchPet({ ai_interaction_interval_ms: v })} />
            <label className="check-row">
              <input
                type="checkbox"
                checked={pet.chat_enabled}
                onChange={(e) => patchPet({ chat_enabled: e.target.checked })}
              />
              双击对话输入
            </label>
            <Field label="口癖（每行一条）">
              <textarea
                className="f-input"
                rows={4}
                value={pet.speech_lines.join("\n")}
                onChange={(e) =>
                  patchPet({
                    speech_lines: e.target.value
                      .split("\n")
                      .filter((s, i, arr) => s !== "" || i < arr.length - 1),
                  })
                }
              />
              <div className="hint">点击桌宠或空闲时会随机冒一条。</div>
            </Field>
            <Field label="素材">
              <div className="list-add-row">
                <button className="key-btn" type="button" onClick={handleOpenPetFolder}>
                  打开素材文件夹…
                </button>
                <button
                  className="key-btn ghost"
                  type="button"
                  onClick={() => patchPet({ x: -1, y: -1 })}
                  title="下次显示时回到屏幕右下角"
                >
                  重置位置
                </button>
              </div>
              <div className="hint">
                当前默认使用内置新角色素材；完整精灵图换肤会在动作配置接入后启用。
              </div>
            </Field>
          </section>

          {/* ── 便笺 ── */}
          <section className="settings-section">
            <h4>便笺</h4>
            <ColorField label="底色"
              r={n.bg_r} g={n.bg_g} b={n.bg_b}
              presets={NOTE_BG_PRESETS}
              onChange={(hex) => { const c = hexToRgb(hex); patchNote({ bg_r: c.r, bg_g: c.g, bg_b: c.b }); }} />
            <ColorField label="字色"
              r={n.text_r} g={n.text_g} b={n.text_b}
              presets={NOTE_TEXT_PRESETS}
              onChange={(hex) => { const c = hexToRgb(hex); patchNote({ text_r: c.r, text_g: c.g, text_b: c.b }); }} />
            <ColorRow label="宽度" value={n.w} min={160} max={480} step={10}
              fmt={(v) => `${v}px`} onChange={(v) => patchNote({ w: v })} />
            <ColorRow label="高度" value={n.h} min={120} max={600} step={10}
              fmt={(v) => `${v}px`} onChange={(v) => patchNote({ h: v })} />
            <ColorRow label="圆角" value={n.radius} min={0} max={30} step={1}
              fmt={(v) => `${v}px`} onChange={(v) => patchNote({ radius: v })} />
            <ColorRow label="字号" value={n.font_size} min={10} max={28} step={1}
              fmt={(v) => `${v}px`} onChange={(v) => patchNote({ font_size: v })} />
            <ColorRow label="背景透明度" value={n.bg_alpha} min={0.1} max={1} step={0.01}
              fmt={(v) => v.toFixed(2)} onChange={(v) => patchNote({ bg_alpha: v })} />
            <ColorRow label="文字透明度" value={n.text_alpha} min={0.1} max={1} step={0.01}
              fmt={(v) => v.toFixed(2)} onChange={(v) => patchNote({ text_alpha: v })} />
            <div className="hint">作为新生成便笺的默认样式；已打开的便笺也会实时跟随变化。</div>
          </section>

          {/* ── Agent 通知 ── */}
          <section className="settings-section">
            <h4>Agent 通知</h4>
            <label className="check-row">
              <input
                type="checkbox"
                checked={an.enabled}
                onChange={(e) => patchAgentNotify({ enabled: e.target.checked })}
              />
              启用（接收 Claude Code / Codex 的完成与待审批事件，由桌宠冒泡提醒）
            </label>
            <Field label="端口">
              <input
                className="f-input"
                type="number"
                min={1024}
                max={65535}
                value={an.port}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) patchAgentNotify({ port: v });
                }}
              />
            </Field>
            <Field label="Token（可选）">
              <input
                className="f-input"
                type="password"
                value={an.token ?? ""}
                placeholder="留空则不校验；设置后调用方需带 ?token="
                onChange={(e) => patchAgentNotify({ token: e.target.value || null })}
              />
            </Field>
            <label className="check-row">
              <input
                type="checkbox"
                checked={an.on_done}
                onChange={(e) => patchAgentNotify({ on_done: e.target.checked })}
              />
              任务完成时提醒
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={an.on_needs}
                onChange={(e) => patchAgentNotify({ on_needs: e.target.checked })}
              />
              需要审批 / 指示时提醒
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={an.on_error}
                onChange={(e) => patchAgentNotify({ on_error: e.target.checked })}
              />
              出错时提醒
            </label>
            <ColorRow label="冷却" value={an.cooldown_ms} min={0} max={60000} step={1000}
              fmt={(v) => (v <= 0 ? "关" : `${(v / 1000).toFixed(0)}s`)}
              onChange={(v) => patchAgentNotify({ cooldown_ms: v })} />
            <label className="check-row">
              <input
                type="checkbox"
                checked={an.show_content}
                onChange={(e) => patchAgentNotify({ show_content: e.target.checked })}
              />
              气泡含内容摘要（会带出少量代理输出，注意隐私）
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={an.only_unfocused}
                onChange={(e) => patchAgentNotify({ only_unfocused: e.target.checked })}
              />
              仅在 Bugzia 未获焦点时提醒（正在看本应用时不打扰）
            </label>
            <div className="hint">
              事件由 Claude Code / Codex 的 hook POST 到本机此端口；运行中开启会立即生效，改端口或 token 需重启应用生效。hook 配置见 docs/agent-notify/。
            </div>
          </section>

          <section className="settings-section">
            <h4>社交通知</h4>
            <label className="check-row">
              <input
                type="checkbox"
                checked={sn.enabled}
                onChange={(e) => patchSocialNotify({ enabled: e.target.checked })}
              />
              启用（监听 Windows 通知中心里的微信 / QQ / 钉钉提醒）
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={sn.wechat}
                onChange={(e) => patchSocialNotify({ wechat: e.target.checked })}
              />
              微信
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={sn.qq}
                onChange={(e) => patchSocialNotify({ qq: e.target.checked })}
              />
              QQ
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={sn.dingtalk}
                onChange={(e) => patchSocialNotify({ dingtalk: e.target.checked })}
              />
              钉钉
            </label>
            <ColorRow label="冷却" value={sn.cooldown_ms} min={0} max={60000} step={1000}
              fmt={(v) => (v <= 0 ? "关" : `${(v / 1000).toFixed(0)}s`)}
              onChange={(v) => patchSocialNotify({ cooldown_ms: v })} />
            <label className="check-row">
              <input
                type="checkbox"
                checked={sn.show_content}
                onChange={(e) => patchSocialNotify({ show_content: e.target.checked })}
              />
              气泡含通知文字（会带出消息摘要，注意隐私）
            </label>
            <div className="hint">
              使用 Windows 通知中心权限；首次启用可能弹出系统授权。只有对应软件向系统通知中心发送提醒时，桌宠才能收到。
            </div>
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

/** Parse a #rrggbb hex string into RGB bytes. Shared by the card / result /
 * waveform color pickers; each call site maps it onto its own field names. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Preset swatches for the locked-card tint (history rail). One click applies;
 *  the native picker next to them selects any other color. Distinct hues so
 *  locked conversations read at a glance once tinted. */
const LOCKED_COLOR_PRESETS = [
  "#FFDE78", // 琥珀
  "#FF8787", // 珊瑚红（默认）
  "#FFA94D", // 橙
  "#69DB7C", // 绿
  "#38D9A9", // 青
  "#4DABF7", // 蓝
  "#9775FA", // 紫
  "#F783AC", // 粉
];

/** Preset swatches for the unlocked (resting) card tint (history rail). Light /
 *  neutral tones by default so the resting cards stay calm next to the vivid
 *  locked presets; one click applies, the native picker selects any other. */
const UNLOCKED_COLOR_PRESETS = [
  "#FFFFFF", // 白（默认）
  "#F5F5F5", // 浅灰
  "#E3F2FD", // 淡蓝
  "#F1F8E9", // 淡绿
  "#FFF8E1", // 淡黄
  "#FCE4EC", // 淡粉
  "#EDE7F6", // 淡紫
  "#263238", // 墨色（暗色卡片）
];

/** Preset swatches for the note background (default sakura deep red #9E1B32). */
const NOTE_BG_PRESETS = [
  "#C95877", // 玫粉（默认）
  "#1F3A2E", // 墨绿
  "#2C3E66", // 靛蓝
  "#B7791F", // 琥珀
  "#5B3A86", // 紫
  "#4A4A4A", // 灰
  "#1A1A1A", // 黑
  "#F5F5F5", // 白
];

/** Preset swatches for the note text color. */
const NOTE_TEXT_PRESETS = [
  "#FFFFFF", // 白（默认）
  "#F5F5F5", // 浅灰
  "#FFE8A3", // 暖黄
  "#FFD6E0", // 浅粉
  "#1A1A1A", // 黑
  "#9E1B32", // 深红
];

/** Label + native color picker row (背景色 / 主色 / 高光 / 锁定卡片颜色). Reuses
 *  the slider-row grid. When `presets` is provided, a row of swatch buttons is
 *  shown beneath the picker (one click applies); call sites that omit it render
 *  the exact same single .color-row as before, so existing color fields are
 *  unaffected. */
function ColorField(props: {
  label: string;
  r: number;
  g: number;
  b: number;
  /** Optional preset swatch hex strings rendered beneath the picker. */
  presets?: string[];
  onChange: (hex: string) => void;
}) {
  const { label, r, g, b, presets, onChange } = props;
  const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  const upper = hex.toUpperCase();
  // No presets -> original single-row layout (unchanged for bg / waveform fields).
  if (!presets || presets.length === 0) {
    return (
      <div className="color-row">
        <span className="color-label">{label}</span>
        <input
          className="color-picker"
          type="color"
          value={hex}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="color-value">{upper}</span>
      </div>
    );
  }
  return (
    <div className="color-field">
      <div className="color-row">
        <span className="color-label">{label}</span>
        <input
          className="color-picker"
          type="color"
          value={hex}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="color-value">{upper}</span>
      </div>
      <div className="color-presets">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            className={"color-swatch" + (p.toUpperCase() === upper ? " active" : "")}
            style={{ background: p }}
            title={p.toUpperCase()}
            aria-label={p.toUpperCase()}
            onClick={() => onChange(p)}
          />
        ))}
      </div>
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
