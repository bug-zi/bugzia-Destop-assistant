import type { PetAiAction, PetMood } from "./petDialogue";

/**
 * Agent-notify channel. The Rust receiver (`agent_notify.rs`) listens on a
 * localhost HTTP endpoint for lifecycle events POSTed by Claude Code / Codex
 * hooks, classifies each into a normalized payload, and emits it on this global
 * event so the pet overlay can react. Mirrors the `PET_INPUT_PREVIEW` pattern.
 */
export const PET_AGENT_NOTIFY = "pet:agent-notify";

/** Which agent the event came from (the `?source=` query param). */
export type PetAgentNotifySource = "claude" | "codex";

/**
 * Normalized event kind. Frontend mirror of what `agent_notify.rs` emits:
 * - done    — a turn finished cleanly (Claude Stop with no pending tasks) or
 *             a Codex turn-boundary candidate after frontend quiet-window confirm.
 * - needs   — the agent wants the user (Claude Notification permission/idle/
 *             elicitation; Codex PermissionRequest).
 * - error   — the agent errored (Claude StopFailure).
 * - paused  — Claude Stop with pending background tasks. Codex paused payloads
 *             are treated as silent compatibility heartbeats by the pet.
 */
export type PetAgentNotifyKind = "done" | "needs" | "error" | "paused";

/**
 * Normalized payload emitted on `pet:agent-notify`. MUST match the JSON shape
 * built by `build()` in agent_notify.rs exactly. `summary` is only present when
 * the user enabled content snippets (privacy-gated on the Rust side).
 */
export interface PetAgentNotify {
  source: PetAgentNotifySource;
  kind: PetAgentNotifyKind;
  title: string;
  summary?: string;
  tool?: string;
  sessionId?: string;
  cwd?: string;
  /** epoch millis — set by the Rust receiver. */
  receivedAt: number;
}

/** Kind -> pet pose + mood. Done pleases, needs startles, error annoys, paused
 *  gently prods. Every action here is one `applyAiAction` handles (no idle). */
export const AGENT_NOTIFY_REACTION: Record<
  PetAgentNotifyKind,
  { action: PetAiAction; mood: PetMood }
> = {
  done: { action: "happy", mood: "pleased" },
  needs: { action: "surprise", mood: "curious" },
  error: { action: "annoyed", mood: "annoyed" },
  paused: { action: "curious", mood: "curious" },
};

/** Persona lines (vampire-queen voice), keyed by source x kind. The picked line
 *  is the bubble; the handler appends the optional tool / summary after it. */
const AGENT_NOTIFY_LINES: Record<PetAgentNotifySource, Record<PetAgentNotifyKind, string[]>> = {
  claude: {
    done: [
      "Claude 说做完了。本女王只是转告。",
      "哼，Claude 收工了。",
      "Claude 那边结束了，去验收吧。",
    ],
    needs: [
      "Claude 在等你发话，人类。",
      "Claude 卡住了，说要你拿主意。",
      "喂，Claude 问你呢，别让它干等。",
    ],
    error: [
      "Claude 出错了，真是没用。",
      "Claude 报错了，去看看吧。",
    ],
    paused: [
      "Claude 停下来了，好像还有事没做完。",
      "Claude 暂停了，你不去看看？",
    ],
  },
  codex: {
    done: [
      "Codex 那边停下来了，去验收吧。",
      "Codex 回合结束，本女王替你传话。",
      "Codex 安静下来了，该你去看一眼。",
    ],
    needs: [
      "Codex 要你批准，动作快点。",
      "Codex 在等许可，人类。",
      "Codex 问你呢，别让它干等。",
    ],
    error: [
      "Codex 出错了，真不省心。",
      "Codex 报错了，去瞧瞧。",
    ],
    paused: [
      "Codex 停下来了，去看看情况。",
      "Codex 到一个回合了，做完没有自己确认。",
      "Codex 暂停了，是在等你还是在收尾？",
    ],
  },
};

/** Pick a random persona line for a (source, kind) event. */
export function pickAgentNotifyLine(source: PetAgentNotifySource, kind: PetAgentNotifyKind): string {
  const lines = AGENT_NOTIFY_LINES[source]?.[kind];
  if (!lines || lines.length === 0) return "有代理在叫你。";
  return lines[Math.floor(Math.random() * lines.length)];
}
