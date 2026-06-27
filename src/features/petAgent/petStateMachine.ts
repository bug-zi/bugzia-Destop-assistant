import type { PetAiAction, PetMood } from "./petDialogue";
import type { PetAction } from "./petActions";

export type PetRuntimeState =
  | "idle"
  | "listening"
  | "thinking"
  | "working"
  | "waiting"
  | "done"
  | "error"
  | "chatting"
  | "dragged"
  | "sleepy";

export type PetRuntimeEvent =
  | "idle"
  | "search_input"
  | "pet_click"
  | "pet_double_click"
  | "chat_open"
  | "chat_submit"
  | "chat_reply"
  | "chat_error"
  | "agent_thinking"
  | "agent_working"
  | "agent_waiting"
  | "agent_done"
  | "agent_error"
  | "social_notify"
  | "drag_start"
  | "drag_end"
  | "sleep_start"
  | "wake";

export type PetNoticePriority = "ambient" | "input" | "system" | "interaction" | "social" | "agent";

export interface PetRuntimeSnapshot {
  state: PetRuntimeState;
  priority: number;
  enteredAt: number;
  holdUntil: number;
}

export interface PetRuntimePresentation {
  action?: PetAction;
  mood: PetMood;
  noticePriority: PetNoticePriority;
}

interface RuntimeRule {
  state: PetRuntimeState;
  priority: number;
  minDurationMs: number;
}

const RULES: Record<PetRuntimeEvent, RuntimeRule> = {
  idle: { state: "idle", priority: 0, minDurationMs: 0 },
  search_input: { state: "listening", priority: 15, minDurationMs: 1_200 },
  pet_click: { state: "chatting", priority: 40, minDurationMs: 1_000 },
  pet_double_click: { state: "chatting", priority: 55, minDurationMs: 1_800 },
  chat_open: { state: "chatting", priority: 60, minDurationMs: 2_000 },
  chat_submit: { state: "thinking", priority: 70, minDurationMs: 2_500 },
  chat_reply: { state: "chatting", priority: 72, minDurationMs: 2_500 },
  chat_error: { state: "error", priority: 80, minDurationMs: 3_000 },
  agent_thinking: { state: "thinking", priority: 45, minDurationMs: 2_500 },
  agent_working: { state: "working", priority: 50, minDurationMs: 2_500 },
  agent_waiting: { state: "waiting", priority: 90, minDurationMs: 4_000 },
  agent_done: { state: "done", priority: 75, minDurationMs: 3_000 },
  agent_error: { state: "error", priority: 95, minDurationMs: 4_000 },
  social_notify: { state: "listening", priority: 65, minDurationMs: 2_500 },
  drag_start: { state: "dragged", priority: 100, minDurationMs: 0 },
  drag_end: { state: "idle", priority: 100, minDurationMs: 0 },
  sleep_start: { state: "sleepy", priority: 10, minDurationMs: 0 },
  wake: { state: "idle", priority: 85, minDurationMs: 1_500 },
};

const PRESENTATION: Record<PetRuntimeState, PetRuntimePresentation> = {
  idle: { mood: "neutral", noticePriority: "ambient" },
  listening: { action: "curious", mood: "curious", noticePriority: "input" },
  thinking: { action: "thinking_loop", mood: "curious", noticePriority: "interaction" },
  working: { action: "working_watch", mood: "protective", noticePriority: "agent" },
  waiting: { action: "approval_wait", mood: "curious", noticePriority: "agent" },
  done: { action: "done_proud", mood: "pleased", noticePriority: "agent" },
  error: { action: "error_disdain", mood: "annoyed", noticePriority: "agent" },
  chatting: { action: "tap_happy", mood: "pleased", noticePriority: "interaction" },
  dragged: { action: "drag", mood: "annoyed", noticePriority: "interaction" },
  sleepy: { action: "sleep_start", mood: "sleepy", noticePriority: "system" },
};

export const INITIAL_PET_RUNTIME: PetRuntimeSnapshot = {
  state: "idle",
  priority: 0,
  enteredAt: 0,
  holdUntil: 0,
};

export function transitionPetRuntime(
  current: PetRuntimeSnapshot,
  event: PetRuntimeEvent,
  now: number,
): PetRuntimeSnapshot {
  const rule = RULES[event];
  if (!rule) return current;

  const isHeld = current.holdUntil > now;
  const canInterrupt = !isHeld || rule.priority >= current.priority || event === "drag_end";
  if (!canInterrupt) return current;

  return {
    state: rule.state,
    priority: rule.priority,
    enteredAt: now,
    holdUntil: now + rule.minDurationMs,
  };
}

export function canShowRuntimeNotice(current: PetRuntimeSnapshot, event: PetRuntimeEvent, now: number): boolean {
  const rule = RULES[event];
  if (!rule) return true;
  if (rule.state === current.state) return true;
  return current.holdUntil <= now || rule.priority >= current.priority;
}

export function presentationForRuntime(state: PetRuntimeState): PetRuntimePresentation {
  return PRESENTATION[state];
}

export function eventForAiAction(action: PetAiAction): PetRuntimeEvent {
  switch (action) {
    case "happy":
      return "chat_reply";
    case "surprise":
      return "agent_waiting";
    case "annoyed":
      return "agent_error";
    case "curious":
      return "agent_thinking";
    case "protective":
      return "agent_working";
    case "mocking":
      return "chat_reply";
    case "wake":
      return "wake";
    case "idle":
    default:
      return "idle";
  }
}
