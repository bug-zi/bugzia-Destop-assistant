import { askOnce } from "../ai/chat";
import { PET_CORPUS, type PetSpeechScene } from "./petCorpus";
import { buildPetPrompt } from "./petPersona";

export type PetAiAction =
  | "idle"
  | "happy"
  | "surprise"
  | "wake"
  | "annoyed"
  | "curious"
  | "protective"
  | "mocking";
export type PetMood =
  | "neutral"
  | "pleased"
  | "annoyed"
  | "curious"
  | "sleepy"
  | "protective"
  | "mocking";

export interface PetAiReply {
  line: string;
  action: PetAiAction;
  mood: PetMood;
}

function pickLine(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

export function getPetLine(scene: PetSpeechScene, extraLines: string[] = []): string {
  const lines = scene === "idle" && extraLines.length > 0 ? extraLines : PET_CORPUS[scene];
  return pickLine(lines);
}

function cleanPetLine(text: string): string {
  return text
    .trim()
    .replace(/^["“”'「『]+|["“”'」』]+$/g, "")
    .split(/\r?\n/)[0]
    .trim()
    .slice(0, 48);
}

function isPetAiAction(value: unknown): value is PetAiAction {
  return (
    value === "idle" ||
    value === "happy" ||
    value === "surprise" ||
    value === "wake" ||
    value === "annoyed" ||
    value === "curious" ||
    value === "protective" ||
    value === "mocking"
  );
}

function isPetMood(value: unknown): value is PetMood {
  return (
    value === "neutral" ||
    value === "pleased" ||
    value === "annoyed" ||
    value === "curious" ||
    value === "sleepy" ||
    value === "protective" ||
    value === "mocking"
  );
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

function parsePetAiReply(text: string, fallbackLine: string): PetAiReply {
  const json = extractJsonObject(text);
  if (!json) {
    return { line: cleanPetLine(text) || fallbackLine, action: "idle", mood: "neutral" };
  }

  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const line = typeof parsed.line === "string" ? cleanPetLine(parsed.line) : "";
    const action = isPetAiAction(parsed.action) ? parsed.action : "idle";
    const mood = isPetMood(parsed.mood) ? parsed.mood : "neutral";
    return { line: line || fallbackLine, action, mood };
  } catch {
    return { line: cleanPetLine(text) || fallbackLine, action: "idle", mood: "neutral" };
  }
}

export async function getPetImprovisedLine(
  scene: PetSpeechScene,
  localLine: string,
  memorySummary?: string,
  preferenceSummary?: string,
  userText?: string,
): Promise<PetAiReply> {
  const text = await askOnce(buildPetPrompt(scene, localLine, memorySummary, preferenceSummary, userText));
  return parsePetAiReply(text, localLine);
}
