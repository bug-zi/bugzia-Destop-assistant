import { useEffect, useRef } from "react";
import type { CommandMode } from "../features/search/command";
import "./CommandCard.css";

interface InputBarProps {
  value: string;
  locked: boolean;
  /** One-line status (生成中 / 已回复 / 错误 / ...) shown without stretching the
   *  bar. Empty string hides it. */
  statusText?: string;
  onChange: (value: string) => void;
  /** Submit the typed text. `forceMode` overrides the prefix parse (set by the
   *  Ctrl/Alt+Enter shortcuts): "web" for Ctrl+Enter, "file" for Alt+Enter. */
  onSubmit: (forceMode?: CommandMode) => void;
  onOpenSettings: () => void;
  /** Esc in the bar: hide the result overlay (main decides, respecting pin). */
  onHideResult: () => void;
  /** Click the spark (star) on the left: toggle the result overlay open/closed. */
  onToggleResult: () => void;
  /** Whether the result overlay is currently open — drives the spark's active look. */
  resultOpen: boolean;
}

function SparkIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill={active ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export default function InputBar({
  value,
  locked,
  statusText,
  onChange,
  onSubmit,
  onOpenSettings,
  onHideResult,
  onToggleResult,
  resultOpen,
}: InputBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Ctrl+L focuses + selects the input from anywhere in the bar (plan §8).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="bar-row">
      {/* 隐形拖动层：删掉可见 grip 后，拖输入框之外的空白处移动窗口。与
          input/button 同级（非祖先）故不吞它们的 mousedown（见项目踩坑笔记）；
          locked 时禁用拖动。 */}
      <div
        className="drag-layer"
        data-tauri-drag-region={locked ? undefined : true}
        title={locked ? "位置已锁定" : "拖动卡片"}
      />
      {/* Spark (star) toggles the result overlay: click to show, click again to
          hide. Filled + highlighted while the overlay is open. */}
      <button
        className={`spark${resultOpen ? " active" : ""}`}
        type="button"
        onClick={onToggleResult}
        title={resultOpen ? "收起结果框" : "展开结果框"}
        aria-pressed={resultOpen}
      >
        <SparkIcon active={resultOpen} />
      </button>
      <input
        ref={inputRef}
        className="input"
        value={value}
        placeholder="Ask or search..."
        spellCheck={false}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            // Ctrl+Enter -> browser search, Alt+Enter -> file search, else
            // prefix parse (default AI). Plan §8 shortcuts.
            if (e.ctrlKey) onSubmit("web");
            else if (e.altKey) onSubmit("file");
            else onSubmit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onHideResult();
          }
        }}
      />
      {statusText ? <span className="status" title={statusText}>{statusText}</span> : null}
      <button
        className="gear"
        type="button"
        title={locked ? "已锁定位置（设置中解锁）" : "设置"}
        onClick={onOpenSettings}
      >
        <GearIcon />
      </button>
    </div>
  );
}
