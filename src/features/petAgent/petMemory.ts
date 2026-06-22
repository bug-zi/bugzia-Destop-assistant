import type { PetSpeechScene } from "./petCorpus";

export interface PetMemoryEvent {
  scene: PetSpeechScene;
  line: string;
  at: number;
}

export interface PetMemory {
  events: PetMemoryEvent[];
  interactionCount: number;
}

const MAX_EVENTS = 6;

export function createPetMemory(): PetMemory {
  return {
    events: [],
    interactionCount: 0,
  };
}

export function rememberPetEvent(
  memory: PetMemory,
  scene: PetSpeechScene,
  line: string,
): PetMemory {
  const isInteraction = scene !== "idle" && scene !== "startup";
  return {
    events: [{ scene, line, at: Date.now() }, ...memory.events].slice(0, MAX_EVENTS),
    interactionCount: memory.interactionCount + (isInteraction ? 1 : 0),
  };
}

export function summarizePetMemory(memory: PetMemory): string {
  if (memory.events.length === 0) return "暂无最近互动。";
  const recent = memory.events
    .slice(0, 3)
    .map((event) => `${event.scene}:${event.line}`)
    .join("；");
  return `互动次数:${memory.interactionCount}；最近:${recent}`;
}
