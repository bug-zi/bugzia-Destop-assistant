export const PET_DAILY_NOTICE = "pet:daily-notice";

export type DailyNoticeKind = "push" | "review";

export interface DailyNewsItem {
  key: string;
  title: string;
  link: string;
  source?: string;
  publishedAt?: string;
  summary?: string;
}

export interface DailyPushDigest {
  news: DailyNewsItem[];
  quote: string | null;
  quoteIndex: number | null;
  trivia: string | null;
  triviaIndex: number | null;
  fetchedAt: number;
}

export interface DailyDigestEntry {
  id: string;
  at: number;
  news: DailyNewsItem[];
  quote: string | null;
  quoteIndex: number | null;
  trivia: string | null;
  triviaIndex: number | null;
}

export interface PetDailyNotice {
  kind: DailyNoticeKind;
  text: string;
  receivedAt: number;
}

export type DailyActivityKind =
  | "ai"
  | "web"
  | "file"
  | "weather"
  | "trans"
  | "note"
  | "note-edit"
  | "note-pin"
  | "note-destroy"
  | "history"
  | "settings"
  | "help";

export interface DailyActivity {
  at: number;
  kind: DailyActivityKind;
  detail: string;
}

const ACTIVITY_KEY_PREFIX = "bugzia:daily:activity:";
const FIRED_KEY_PREFIX = "bugzia:daily:fired:";
const PUSH_SLOT_KEY_PREFIX = "bugzia:daily:push-slot:";
const DIGESTS_KEY = "bugzia:daily:digests";
const USED_KEY = "bugzia:daily:used";
const MAX_ACTIVITIES_PER_DAY = 240;
const MAX_DIGESTS = 80;
const MAX_USED_NEWS = 600;
const MAX_NEWS_AGE_MS = 48 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 15 * 60 * 1000;

export const DAILY_DIGEST_CHANGED = "daily:digest-changed";

export interface DailyUsedItems {
  newsKeys: string[];
  quoteIndices: number[];
  triviaIndices: number[];
}

export function localDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayStartMs(date = new Date()): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function rememberDailyActivity(kind: DailyActivityKind, detail: string): void {
  try {
    const key = ACTIVITY_KEY_PREFIX + localDateKey();
    const list = readDailyActivities();
    const next = [...list, { at: Date.now(), kind, detail: compactDetail(detail) }]
      .slice(-MAX_ACTIVITIES_PER_DAY);
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Activity logging is advisory; never block the user's actual command.
  }
}

export function readDailyActivities(date = new Date()): DailyActivity[] {
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY_PREFIX + localDateKey(date));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DailyActivity[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((it) => Number.isFinite(it.at) && typeof it.detail === "string");
  } catch {
    return [];
  }
}

export function hasDailyFired(kind: DailyNoticeKind, date = new Date()): boolean {
  try {
    return localStorage.getItem(firedKey(kind, date)) === "1";
  } catch {
    return false;
  }
}

export function markDailyFired(kind: DailyNoticeKind, date = new Date()): void {
  try {
    localStorage.setItem(firedKey(kind, date), "1");
  } catch {
    // Same as activity logging: firing the reminder should not depend on storage.
  }
}

export function currentPushSlotKey(date = new Date()): string {
  const hour = Math.floor(date.getHours() / 2) * 2;
  return `${localDateKey(date)}:${String(hour).padStart(2, "0")}`;
}

export function hasPushSlotFired(date = new Date()): boolean {
  try {
    return localStorage.getItem(PUSH_SLOT_KEY_PREFIX + currentPushSlotKey(date)) === "1";
  } catch {
    return false;
  }
}

export function markPushSlotFired(date = new Date()): void {
  try {
    localStorage.setItem(PUSH_SLOT_KEY_PREFIX + currentPushSlotKey(date), "1");
  } catch {
    // Reminder delivery should not depend on storage availability.
  }
}

export function msUntilNextTwoHourSlot(now = new Date()): number {
  const target = new Date(now);
  const nextHour = now.getHours() + (now.getHours() % 2 === 0 ? 2 : 1);
  target.setHours(nextHour, 0, 0, 0);
  return Math.max(1000, target.getTime() - now.getTime());
}

export function msUntilNextLocalTime(hhmm: string, now = new Date()): number {
  const { h, m } = parseTime(hhmm);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return Math.max(1000, target.getTime() - now.getTime());
}

export function listDailyDigests(): DailyDigestEntry[] {
  try {
    const raw = localStorage.getItem(DIGESTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DailyDigestEntry[];
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed
      .filter((it) => Number.isFinite(it.at) && Array.isArray(it.news))
      .map((it) => ({ ...it, news: it.news.filter((item) => isFreshNews(item, now)) }))
      .filter((it) => it.news.length > 0 || Boolean(it.quote) || Boolean(it.trivia))
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export function appendDailyDigest(entry: Omit<DailyDigestEntry, "id">): DailyDigestEntry {
  const full: DailyDigestEntry = {
    ...entry,
    id: `${entry.at}-${Math.random().toString(36).slice(2, 8)}`,
  };
  const next = [full, ...listDailyDigests()].slice(0, MAX_DIGESTS);
  localStorage.setItem(DIGESTS_KEY, JSON.stringify(next));
  rememberDailyUsed(full);
  return full;
}

export function readDailyUsed(): DailyUsedItems {
  try {
    const raw = localStorage.getItem(USED_KEY);
    if (!raw) return { newsKeys: [], quoteIndices: [], triviaIndices: [] };
    const parsed = JSON.parse(raw) as DailyUsedItems;
    return {
      newsKeys: Array.isArray(parsed.newsKeys) ? parsed.newsKeys.filter(Boolean) : [],
      quoteIndices: Array.isArray(parsed.quoteIndices)
        ? parsed.quoteIndices.filter(Number.isFinite)
        : [],
      triviaIndices: Array.isArray(parsed.triviaIndices)
        ? parsed.triviaIndices.filter(Number.isFinite)
        : [],
    };
  } catch {
    return { newsKeys: [], quoteIndices: [], triviaIndices: [] };
  }
}

export function activityKindLabel(kind: DailyActivityKind): string {
  switch (kind) {
    case "ai":
      return "AI 对话";
    case "web":
      return "网页搜索";
    case "file":
      return "文件搜索";
    case "weather":
      return "天气查询";
    case "trans":
      return "翻译";
    case "note":
      return "便笺";
    case "note-edit":
      return "编辑便笺";
    case "note-pin":
      return "钉住便笺";
    case "note-destroy":
      return "销毁便笺";
    case "history":
      return "历史对话";
    case "settings":
      return "设置";
    case "help":
      return "帮助";
    default:
      return "行动";
  }
}

export function compactDetail(text: string, max = 80): string {
  const s = text.replace(/\s+/g, " ").trim();
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join("")}...` : s;
}

function firedKey(kind: DailyNoticeKind, date: Date): string {
  return `${FIRED_KEY_PREFIX}${kind}:${localDateKey(date)}`;
}

function rememberDailyUsed(entry: DailyDigestEntry): void {
  try {
    const used = readDailyUsed();
    const newsKeys = [
      ...used.newsKeys,
      ...entry.news.map((item) => item.key).filter(Boolean),
    ].slice(-MAX_USED_NEWS);
    const quoteIndices = entry.quoteIndex == null
      ? used.quoteIndices
      : [...used.quoteIndices, entry.quoteIndex];
    const triviaIndices = entry.triviaIndex == null
      ? used.triviaIndices
      : [...used.triviaIndices, entry.triviaIndex];
    localStorage.setItem(
      USED_KEY,
      JSON.stringify({
        newsKeys: [...new Set(newsKeys)],
        quoteIndices: [...new Set(quoteIndices)],
        triviaIndices: [...new Set(triviaIndices)],
      }),
    );
  } catch {
    // Used-set persistence is best effort; content generation still proceeds.
  }
}

function isFreshNews(item: DailyNewsItem, now: number): boolean {
  const published = Date.parse(item.publishedAt ?? "");
  return Number.isFinite(published)
    && published <= now + FUTURE_SKEW_MS
    && now - published <= MAX_NEWS_AGE_MS;
}

function parseTime(hhmm: string): { h: number; m: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return { h: 23, m: 0 };
  const h = Math.min(23, Math.max(0, Number(match[1])));
  const m = Math.min(59, Math.max(0, Number(match[2])));
  return { h, m };
}
