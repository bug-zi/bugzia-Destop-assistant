import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../features/ai/chat";
import "./ChatView.css";

interface ChatViewProps {
  messages: ChatMessage[];
  generating: boolean;
  onStop: () => void;
  onClear: () => void;
}

/**
 * Streaming chat surface: a toolbar (stop / clear) and a message list with
 * Markdown-rendered assistant replies. Auto-scrolls while new tokens arrive.
 */
export default function ChatView({ messages, generating, onStop, onClear }: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, generating]);

  const empty = messages.length === 0;

  return (
    <div className="chat">
      <div className="chat-toolbar">
        {generating ? (
          <button className="chat-btn danger" type="button" onClick={onStop} title="停止生成">
            ⏹ 停止生成
          </button>
        ) : null}
        <button
          className="chat-btn"
          type="button"
          onClick={onClear}
          disabled={empty || generating}
          title="清空上下文"
        >
          🗑 清空上下文
        </button>
        {generating ? <span className="chat-typing">生成中…</span> : null}
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {empty ? (
          <div className="chat-empty">
            普通输入 → AI 对话（保留上下文）
            <br />
            <span className="chat-empty-sub">? 或 /web → 浏览器搜索 ｜ /file → 本地文件</span>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={"bubble " + m.role}>
              {m.role === "assistant" ? (
                <div className="bubble-md">
                  {m.content ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  ) : (
                    <span className="bubble-placeholder">{generating ? "…" : "(空)"}</span>
                  )}
                  {m.model ? (
                    <div className="bubble-model" title="网关实际回显的模型（非模型自报）">
                      {m.model}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="bubble-text">{m.content}</div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
