import { useEffect, useRef } from "react";
import type { FileResult } from "../features/result/resultTypes";
import "./FileResultsView.css";

interface FileResultsViewProps {
  /** The query these results answer (shown in the empty state). */
  query: string;
  results: FileResult[];
  /** True while the walk is in flight; shown instead of the "no results" line. */
  searching?: boolean;
  /** Open `path` with its default handler. */
  onOpen: (path: string) => void;
  /** Reveal `path` selected in the file explorer. */
  onReveal: (path: string) => void;
}

/** Generic document glyph (no emoji, per project rule one). The extension is
 *  rendered as text beside it so the type is still legible. */
function FileIcon({ ext }: { ext: string }) {
  return (
    <span className="file-icon" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
      {ext ? <span className="file-ext">{ext}</span> : null}
    </span>
  );
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function formatDate(ms: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return "";
  }
}

/**
 * Local file-search result list, rendered inside the result overlay when its
 * mode is "file". The whole row opens the file (large click target); a small
 * button reveals it in the containing folder. Auto-scrolls to top on a new
 * result set.
 */
export default function FileResultsView({ query, results, searching, onOpen, onReveal }: FileResultsViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, [query, results]);

  if (results.length === 0) {
    return (
      <div className="file-results">
        <div className="file-empty">{searching ? "搜索中…" : `未找到匹配 “${query}” 的文件`}</div>
      </div>
    );
  }

  return (
    <div className="file-results">
      <div className="file-scroll" ref={scrollRef}>
        {results.map((r) => (
          <div
            key={r.path}
            className="file-row"
            onDoubleClick={() => onOpen(r.path)}
            title={r.path}
          >
            <FileIcon ext={r.ext} />
            <div className="file-main">
              <div className="file-name">{r.name}</div>
              <div className="file-path">{r.path}</div>
            </div>
            <div className="file-side">
              <div className="file-meta-line">
                {formatDate(r.modified)}
                {r.size ? <span className="file-size">{formatSize(r.size)}</span> : null}
              </div>
              <div className="file-actions">
                <button className="file-btn" type="button" onClick={() => onOpen(r.path)} title="用默认程序打开">
                  打开
                </button>
                <button
                  className="file-btn"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReveal(r.path);
                  }}
                  title="在所在文件夹中定位"
                >
                  文件夹
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
