import { openUrl } from "@tauri-apps/plugin-opener";

export type CommandMode = "ai" | "web" | "file" | "weather" | "trans" | "note" | "help";

export interface ParsedCommand {
  mode: CommandMode;
  query: string;
}

export interface SearchEngine {
  id: string;
  name: string;
  url: (q: string) => string;
}

/**
 * Declarative command registry (spec §8). `parseCommand` walks this table, so
 * adding a new `/command` only means appending an entry here — no more if-else
 * branches to touch. `description` powers `/help`.
 *
 * Triggers:
 *   `<prefix> <arg>`  -> { mode, query: arg }   (e.g. "/weather 北京")
 *   `<prefix>`        -> { mode, query: "" }    (e.g. "/help", argless)
 *   alias matches work the same way. The single-char "?" alias is special-cased
 *   in `parseCommand` so `?北京` (no space) also resolves to web, matching legacy.
 */
export interface CommandDef {
  mode: CommandMode;
  /** Leading trigger incl. the slash, e.g. "/weather". Omit on the AI default. */
  prefix?: string;
  /** Extra triggers, e.g. "?" (web). */
  aliases?: string[];
  /** Shown by `/help`. */
  description: string;
  /** Hidden from `/help` (still parsed). */
  hidden?: boolean;
  /** True if the command runs with NO argument (e.g. `/help`). The slash-palette
   *  uses this so Enter on an argless item submits immediately, while arg-taking
   *  commands are filled as `<trigger> ` for the user to type the query. */
  argless?: boolean;
}

export const COMMANDS: CommandDef[] = [
  { mode: "web", prefix: "/web", aliases: ["?"], description: "用默认浏览器搜索" },
  { mode: "file", prefix: "/file", description: "搜索本地文件" },
  { mode: "ai", prefix: "/ai", description: "强制 AI 对话" },
  { mode: "weather", prefix: "/weather", description: "查询城市天气" },
  { mode: "trans", prefix: "/trans", description: "翻译文本（中英自动互译）" },
  { mode: "note", prefix: "/note", description: "在桌面生成一张便笺" },
  { mode: "help", prefix: "/help", description: "查看所有命令", argless: true },
];

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
 * Parse raw input into a command by walking `COMMANDS` (spec §8):
 *   plain text      -> AI chat
 *   `?...` / `/web` -> browser search
 *   `/file`         -> local file search
 *   `/ai`           -> force AI chat
 *   `/weather`      -> city weather
 *   `/trans`        -> translate
 *   `/help`         -> list commands
 *
 * Behavior for the legacy prefixes (web/file/ai/?) is byte-for-byte preserved;
 * see the regression cases in the plan's verification section.
 */
export function parseCommand(input: string): ParsedCommand {
  const text = input.trim();
  if (!text) return { mode: "ai", query: "" };

  // The single-char "?" alias has no space requirement ("?北京" is valid), so it
  // is resolved before the registry sweep. Everything past the "?" is the query.
  if (text.startsWith("?")) {
    return { mode: "web", query: text.slice(1).trim() };
  }

  // Registry sweep: longest-prefix-first isn't needed (no prefix is a prefix of
  // another in COMMANDS), so a stable forward scan is enough.
  for (const c of COMMANDS) {
    if (!c.prefix) continue;
    const triggers = [c.prefix, ...(c.aliases ?? [])];
    for (const t of triggers) {
      // Argless hit, e.g. "/help" exactly.
      if (text === t) return { mode: c.mode, query: "" };
      // "<prefix> <arg>" hit.
      if (text.startsWith(t + " ")) {
        return { mode: c.mode, query: text.slice(t.length + 1).trim() };
      }
    }
  }

  // Fallback: treat the whole line as an AI prompt.
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

/** One row in the slash-command palette. `argless` mirrors `CommandDef.argless`. */
export interface SlashPaletteItem {
  trigger: string;
  mode: CommandMode;
  description: string;
  argless: boolean;
}

/**
 * Build the palette's filtered item list for a raw input string. Rules:
 *   - only when the input starts with "/" and has NO space yet (the command
 *     token is still being typed; once a space is present the command is chosen
 *     and the palette steps aside);
 *   - a trigger (prefix or alias) matches when it starts with the typed text,
 *     case-insensitively, so "/W" still finds "/web";
 *   - only slash-style triggers are surfaced (the "?" alias is a convenience
 *     shortcut, not a slash command, so it never appears here);
 *   - order follows COMMANDS (stable), so the palette's arrangement is fixed.
 *
 * Returns an empty array whenever the input does not qualify, which the caller
 * treats as "palette closed".
 */
export function slashPaletteItems(input: string): SlashPaletteItem[] {
  const v = input.trim().toLowerCase();
  if (!v.startsWith("/") || v.includes(" ")) return [];
  const out: SlashPaletteItem[] = [];
  for (const c of COMMANDS) {
    const triggers = [c.prefix, ...(c.aliases ?? [])].filter(
      (t): t is string => !!t && t.startsWith("/"),
    );
    for (const trigger of triggers) {
      if (trigger.toLowerCase().startsWith(v)) {
        out.push({
          trigger,
          mode: c.mode,
          description: c.description,
          argless: !!c.argless,
        });
      }
    }
  }
  return out;
}
