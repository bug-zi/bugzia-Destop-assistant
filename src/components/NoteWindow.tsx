import { useEffect, useRef, useState, type PointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { applyNoteVars } from "../features/appearance/appearance";
import { DEFAULT_NOTE, type NoteSettings } from "../features/settings/settingsTypes";
import {
  NOTE_CHANGED,
  NOTE_DESTROY_CONFIRM,
  NOTE_DESTROYED,
  NOTE_HYDRATE,
  NOTE_PINNED,
  NOTE_PINNED_SYNC,
  NOTE_READY,
  NOTE_SETTINGS,
  noteIdFromLabel,
} from "../features/note/noteTypes";
import "./NoteWindow.css";

/**
 * A single desktop sticky-note overlay. Hydrates from the main window on mount
 * (content + style defaults), reports edits / geometry / pin / destroy back up,
 * and never writes notes.json itself (main is the sole writer). Click the body
 * to edit; the header has 钉住 / 复制 / 销毁.
 */
export default function NoteWindow() {
  const id = noteIdFromLabel(getCurrentWindow().label);
  const [content, setContent] = useState("");
  const [pinned, setPinned] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmingDestroy, setConfirmingDestroy] = useState(false);
  const [settings, setSettings] = useState<NoteSettings>(DEFAULT_NOTE);
  const draftRef = useRef("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const destroySentRef = useRef(false);

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
        await listen<{ id?: string; content: string; pinned?: boolean; settings: NoteSettings }>(NOTE_HYDRATE, (ev) => {
          if (!alive) return;
          // [临时诊断] 记录本窗口收到的每一条 hydrate，便于定位多便笺内容串台。
          // 验证后移除。
          console.debug("[bugzia-note] hydrate", { self: id, from: ev.payload.id, content: ev.payload.content });
          // 多实例便笺共用 NOTE_HYDRATE 事件名——必须校验 id，只接受发给自己的
          // hydrate。否则一旦事件投递溢出（别家便笺的 hydrate 到达本窗口），本
          // 窗口内容会被那条的 content 覆盖，表现为"最后一张覆盖前面所有"。
          if (ev.payload.id !== undefined && ev.payload.id !== id) {
            console.warn("[bugzia-note] 收到别家 hydrate，已忽略", { self: id, from: ev.payload.id });
            return;
          }
          const content = ev.payload.content ?? "";
          setContent(content);
          draftRef.current = content;
          // 同步初始钉住态：快捷键呼出的便笺创建即为 pinned，重启恢复的 pinned
          // 便笺也走这里——让按钮高亮与实际层级一致，否则用户不知它已置顶。
          setPinned(ev.payload.pinned ?? false);
          const s = ev.payload.settings ?? DEFAULT_NOTE;
          setSettings(s);
          applyNoteVars(s);
          // 新建空便笺直接进入编辑态，但等窗口完成显示/定位后再真正聚焦。
          // 过早 focus 会让 Windows 中文输入法拿不到稳定光标位置，候选窗
          // 可能退回到屏幕左上角。
          if (content === "") {
            setEditing(true);
            void focusTextareaWhenWindowReady("start");
          }
        }),
      );
      offs.push(
        await listen<{ id: string }>(NOTE_DESTROY_CONFIRM, (ev) => {
          if (!alive || ev.payload.id !== id) return;
          requestDestroy();
        }),
      );
      offs.push(
        await listen<NoteSettings>(NOTE_SETTINGS, (ev) => {
          if (!alive) return;
          setSettings(ev.payload);
          applyNoteVars(ev.payload);
        }),
      );
      offs.push(
        await listen<{ id: string; pinned: boolean }>(NOTE_PINNED_SYNC, (ev) => {
          if (!alive) return;
          // 多实例便笺共用事件名——只接受发给自己的（main 召唤升级本便笺时同步）。
          if (ev.payload.id !== id) return;
          setPinned(ev.payload.pinned);
        }),
      );
    })();
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!confirmingDestroy) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key === "y") {
        e.preventDefault();
        e.stopPropagation();
        confirmDestroy();
      } else if (key === "n") {
        e.preventDefault();
        e.stopPropagation();
        cancelDestroy();
      }
    };
    requestAnimationFrame(() => confirmRef.current?.focus());
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [confirmingDestroy]);

  function focusTextarea(selection: "start" | "end") {
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      const pos = selection === "start" ? 0 : ta.value.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  async function focusTextareaWhenWindowReady(selection: "start" | "end") {
    const win = getCurrentWindow();
    for (let i = 0; i < 20; i++) {
      const visible = await win.isVisible().catch(() => true);
      if (visible) break;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
    }
    await win.setFocus().catch(() => {});
    window.setTimeout(() => focusTextarea(selection), 50);
  }

  function startEdit() {
    draftRef.current = content;
    setEditing(true);
    focusTextarea("end");
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

  function requestDestroy() {
    commitEdit();
    setConfirmingDestroy(true);
    void getCurrentWindow().setFocus().catch(() => {});
  }

  function confirmDestroy() {
    if (destroySentRef.current) return;
    destroySentRef.current = true;
    void emit(NOTE_DESTROYED, { id }).finally(() => {
      getCurrentWindow().close().catch((e) => console.error("[bugzia] close note", e));
    });
  }

  function cancelDestroy() {
    setConfirmingDestroy(false);
  }

  function handleConfirmPointer(e: PointerEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement | null;
    const action = target?.closest<HTMLButtonElement>("[data-note-confirm]")?.dataset.noteConfirm;
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === "yes") confirmDestroy();
    else cancelDestroy();
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
            onClick={requestDestroy}
          >
            销毁
          </button>
        </div>
      </div>

      <div
        className="note-body"
        onClick={(e) => {
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
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
          />
        ) : (
          <div className="note-text">{content || "点击编辑…"}</div>
        )}
      </div>

      {confirmingDestroy && (
        <div
          ref={confirmRef}
          className="note-confirm"
          role="dialog"
          aria-modal="true"
          aria-label="确认删除便笺"
          tabIndex={-1}
          onPointerDownCapture={handleConfirmPointer}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div className="note-confirm-panel">
            <div className="note-confirm-title">真的要删除吗？</div>
            <div className="note-confirm-actions">
              <button
                type="button"
                className="note-confirm-btn yes"
                data-note-confirm="yes"
              >
                Y
              </button>
              <button
                type="button"
                className="note-confirm-btn no"
                data-note-confirm="no"
              >
                N
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
