import { openUrl } from "@tauri-apps/plugin-opener";

export type CommandMode = "ai" | "web" | "file";

export interface ParsedCommand {
  mode: CommandMode;
  query: string;
}

export interface SearchEngine {
  id: string;
  name: string;
  url: (q: string) => string;
}

/** Built-in engines per spec §3.2. Default engine is configurable later via Settings. */
export const SEARCH_ENGINES: SearchEngine[] = [
  {
    id: "google",
    name: "Google",
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: "bing",
    name: "Bing",
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: "baidu",
    name: "百度",
    url: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
  },
  {
    id: "perplexity",
    name: "Perplexity",
    url: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
  },
];

const DEFAULT_ENGINE = SEARCH_ENGINES[0];

/**
 * Parse raw input into a command per spec §8:
 *   plain text      -> AI chat
 *   `?...` / `/web` -> browser search
 *   `/file`         -> local file search
 *   `/ai`           -> force AI chat
 */
export function parseCommand(input: string): ParsedCommand {
  const text = input.trim();
  if (!text) return { mode: "ai", query: "" };
  if (text.startsWith("/web ")) return { mode: "web", query: text.slice(5).trim() };
  if (text.startsWith("/file ")) return { mode: "file", query: text.slice(6).trim() };
  if (text.startsWith("/ai ")) return { mode: "ai", query: text.slice(4).trim() };
  if (text.startsWith("?")) return { mode: "web", query: text.slice(1).trim() };
  return { mode: "ai", query: text };
}

/** Open a search for `query` in the user's default browser. */
export async function browserSearch(
  query: string,
  engine: SearchEngine = DEFAULT_ENGINE,
): Promise<void> {
  const q = query.trim();
  if (!q) return;
  await openUrl(engine.url(q));
}
