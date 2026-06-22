import type { CommandMode } from "../search/command";

export const PET_INPUT_PREVIEW = "pet:input-preview";

export interface PetInputPreview {
  text: string;
  mode: CommandMode;
  at: number;
}

export interface PetInputReaction {
  line: string;
  kind: "happy" | "surprise" | "idle" | "annoyed" | "curious" | "protective" | "mocking";
}

export function pickPetInputReaction(text: string, mode: CommandMode): PetInputReaction | null {
  const value = text.trim();
  if (value.length < 4) return null;

  if (/累|困|烦|不想|摆烂|崩溃|难受/u.test(value)) {
    return { kind: "protective", line: "脸色不妙。准许你休息片刻。" };
  }
  if (/谢谢|太好了|漂亮|成功|搞定|完成/u.test(value)) {
    return { kind: "happy", line: "哼，偶尔也会说点像样的话。" };
  }
  if (/[?？]/u.test(value)) {
    return { kind: "curious", line: "又有疑问？说吧，人类。" };
  }

  switch (mode) {
    case "file":
      return { kind: "mocking", line: "找东西？别把桌面弄成废墟。" };
    case "weather":
      return { kind: "mocking", line: "连天气也要本女王替你盯着？" };
    case "trans":
      return { kind: "annoyed", line: "翻译？人类的语言真麻烦。" };
    case "web":
      return { kind: "curious", line: "想去外面找答案？动作快点。" };
    case "note":
      return { kind: "happy", line: "留下便签？这点谨慎还算不错。" };
    case "help":
      return { kind: "mocking", line: "连命令都要查？真拿你没办法。" };
    case "ai":
      if (value.length > 40) {
        return { kind: "curious", line: "问题倒是不短，希望你想清楚了。" };
      }
      return null;
    default:
      return null;
  }
}
