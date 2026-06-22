export interface PetPreferences {
  nickname?: string;
  replyStyle?: "short" | "normal";
  updatedAt?: number;
}

export interface PetPreferenceLearning {
  preferences: PetPreferences;
  learnedLine: string | null;
}

const STORAGE_KEY = "bugzia.pet.preferences.v1";

export function loadPetPreferences(): PetPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PetPreferences;
    return {
      nickname: typeof parsed.nickname === "string" ? parsed.nickname : undefined,
      replyStyle: parsed.replyStyle === "short" || parsed.replyStyle === "normal" ? parsed.replyStyle : undefined,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : undefined,
    };
  } catch {
    return {};
  }
}

function savePetPreferences(preferences: PetPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preference memory is optional; storage failure should never break the pet.
  }
}

function cleanNickname(raw: string): string {
  return raw
    .replace(/[，。！？,.!?].*$/u, "")
    .replace(/[吧啊呀哦呢啦嘛]+$/u, "")
    .trim()
    .slice(0, 12);
}

export function learnPetPreferences(text: string, current: PetPreferences): PetPreferenceLearning {
  const input = text.trim();
  if (!input) return { preferences: current, learnedLine: null };

  if (/清除.*(记忆|偏好)|忘记.*(我|偏好|记忆)/u.test(input)) {
    const preferences = { updatedAt: Date.now() };
    savePetPreferences(preferences);
    return { preferences, learnedLine: "清掉了。哼，别后悔。" };
  }

  let preferences = current;
  const learned: string[] = [];
  const nicknameMatch = input.match(/(?:以后)?(?:叫我|称呼我|喊我|我的名字是|我叫)\s*([^\s，。！？,.!?]{1,16})/u);
  if (nicknameMatch) {
    const nickname = cleanNickname(nicknameMatch[1]);
    if (nickname) {
      preferences = { ...preferences, nickname, updatedAt: Date.now() };
      learned.push(`称呼你为${nickname}`);
    }
  }

  if (/回复短一点|说短一点|简短一点|少说点|话少一点/u.test(input)) {
    preferences = { ...preferences, replyStyle: "short", updatedAt: Date.now() };
    learned.push("回复更短");
  } else if (/回复正常|正常说|可以说详细一点|多说一点/u.test(input)) {
    preferences = { ...preferences, replyStyle: "normal", updatedAt: Date.now() };
    learned.push("正常回复");
  }

  if (learned.length === 0) return { preferences: current, learnedLine: null };
  savePetPreferences(preferences);
  return { preferences, learnedLine: `记住了，${learned.join("，")}。` };
}

export function summarizePetPreferences(preferences: PetPreferences): string {
  const parts: string[] = [];
  if (preferences.nickname) parts.push(`称呼用户为${preferences.nickname}`);
  if (preferences.replyStyle === "short") parts.push("回复尽量短");
  if (preferences.replyStyle === "normal") parts.push("回复保持正常长度");
  return parts.length > 0 ? parts.join("；") : "暂无长期偏好。";
}
