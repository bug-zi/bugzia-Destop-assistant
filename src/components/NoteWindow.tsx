import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { applyNoteVars } from "../features/appearance/appearance";
import { DEFAULT_NOTE, type NoteSettings } from "../features/settings/settingsTypes";
import {
  NOTE_CHANGED,
  NOTE_DESTROYED,
  NOTE_HYDRATE,
  NOTE_PINNED,
  NOTE_READY,
  NOTE_SETTINGS,
  noteIdFromLabel,
} from "../features/note/noteTypes";
import "./NoteWindow.css";

/**
 * A single desktop sticky-note overlay. Hydrates from the main window on mount
 * (content + style defaults), reports edits / geometry / pin / destroy back up,
 * and never writes notes.json itself (main is the sole writer). Double-click the
 * body to edit; the header has 钉住 / 复制 / 销毁.
 */
export default function NoteWindow() {
  const id = noteIdFromLabel(getCurrentWindow().label);
  const [content, setContent] = useState("");
  const [pinned, setPinned] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [settings, setSettings] = useState<NoteSettings>(DEFAULT_NOTE);
  const draftRef = useRef("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Announce ourselves on mount so main hydrates us (mirrors result:ready).
  useEffect(() => {
    void emit(NOTE_READY, { id });
  }, [id]);

  // Hydrate (content + style) + live style updates from main.
  useEffect(() => {
    let alive = true;
    const offs: UnlistenFn[] = [];
    (async () => {
      offs.push(
        await listen<{ content: string; settings: NoteSettings }>(NOTE_HYDRATE, (ev) => {
          if (!alive) return;
          setContent(ev.payload.content ?? "");
          draftRef.current = ev.payload.content ?? "";
          const s = ev.payload.settings ?? DEFAULT_NOTE;
          setSettings(s);
          applyNoteVars(s);
        }),
      );
      offs.push(
        await listen<NoteSettings>(NOTE_SETTINGS, (ev) => {
          if (!alive) return;
          setSettings(ev.payload);
          applyNoteVars(ev.payload);
        }),
      );
    })();
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  }, []);

  function startEdit() {
    draftRef.current = content;
    setEditing(true);
    // Focus on next paint once the textarea is mounted.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    });
  }

  function commitEdit() {
    const next = draftRef.current;
    setEditing(false);
    if (next !== content) {
      setContent(next);
      void emit(NOTE_CHANGED, { id, content: next });
    }
  }

  function cancelEdit() {
    setEditing(false);
    draftRef.current = content;
  }

  function togglePin() {
    const next = !pinned;
    setPinned(next);
    void emit(NOTE_PINNED, { id, pinned: next });
  }

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      console.error("[bugzia] copy note", e);
    }
  }

  function destroy() {
    void emit(NOTE_DESTROYED, { id }).finally(() => {
      getCurrentWindow().close().catch((e) => console.error("[bugzia] close note", e));
    });
  }

  // Header drag: start a native move on pointerdown, but let the buttons work by
  // stopping their pointerdown from bubbling (no data-tauri-drag-region — it eats
  // clicks, same lesson as PetWindow).
  function onHeaderPointerDown() {
    getCurrentWindow()
      .startDragging()
      .catch((e) => console.error("[bugzia] startDragging", e));
  }

  const rgba = (r: number, g: number, b: number, a: number) => `rgba(${r}, ${g}, ${b}, ${a})`;

  return (
    <div
      className={"note-root" + (pinned ? " is-pinned" : "")}
      style={{
        background: rgba(settings.bg_r, settings.bg_g, settings.bg_b, settings.bg_alpha),
        color: rgba(settings.text_r, settings.text_g, settings.text_b, settings.text_alpha),
        borderRadius: settings.radius,
        fontSize: settings.font_size,
      }}
    >
      <div className="note-header" onPointerDown={onHeaderPointerDown}>
        <span className="note-grip" aria-hidden="true" />
        <div className="note-actions">
          <button
            type="button"
            className={"note-btn pin" + (pinned ? " active" : "")}
            title={pinned ? "取消钉住" : "钉住（置顶并保留）"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={togglePin}
          >
            钉住
          </button>
          <button
            type="button"
            className="note-btn copy"
            title="复制内容"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void copyContent()}
          >
            {copied ? "已复制" : "复制"}
          </button>
          <button
            type="button"
            className="note-btn destroy"
            title="销毁便笺"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={destroy}
          >
            销毁
          </button>
        </div>
      </div>

      <div
        className="note-body"
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (!editing) startEdit();
        }}
      >
        {editing ? (
          <textarea
            ref={taRef}
            className="note-textarea"
            defaultValue={draftRef.current}
            style={{
              color: rgba(settings.text_r, settings.text_g, settings.text_b, settings.text_alpha),
              fontSize: settings.font_size,
            }}
            onChange={(e) => (draftRef.current = e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
          />
        ) : (
          <div className="note-text">{content || "双击编辑…"}</div>
        )}
      </div>
    </div>
  );
}
