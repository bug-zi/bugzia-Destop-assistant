# Desktop Pet State Machine Plan

## Goal

Upgrade the 2D desktop pet from scattered event-to-action reactions into a small role state machine. Keep the current 2D sprite pipeline and character direction, but make actions, bubbles, and AI/Codex states feel coordinated.

## Principles

- Keep the pet 2D. Do not introduce 3D, VRM, or Three.js for this phase.
- Treat events as inputs to a role state, not direct animation commands.
- Keep sprite actions configurable so future action-frame additions are cheap.
- Preserve existing user-facing behavior unless a change is needed for the state machine.
- Verify after every stage.

## Stage 1: Extract Action Configuration

Status: completed.

Move sprite action metadata out of `PetWindow.tsx` into a dedicated pet action module.

Deliverables:
- `src/features/petAgent/petActions.ts`
- `PetAction` type
- `ActionSpec` type
- `ACTIONS` map
- helper for resolving AI action to sprite action

Verification:
- `pnpm build`

Result: passed.

## Stage 2: Add Role State Machine

Status: completed.

Create a small role state machine inspired by vibe-break's event-to-state mapping.

Runtime states:
- `idle`
- `listening`
- `thinking`
- `working`
- `waiting`
- `done`
- `error`
- `chatting`
- `dragged`
- `sleepy`

Deliverables:
- `src/features/petAgent/petStateMachine.ts`
- event priority and minimum visible duration
- mapping from runtime state to action/mood/notice priority
- reducer-style transition helpers

Verification:
- `pnpm build`

Result: passed.

## Stage 3: Wire PetWindow Through The State Machine

Status: completed.

Route current pet events through the state machine while keeping existing sprite sheets.

Inputs to wire:
- click / double click
- search input preview
- chat submit / chat reply / chat failure
- drag start / drag end
- sleep / wake
- social notification
- agent notification

Verification:
- `pnpm build`

Result: passed.

## Stage 4: Stabilize Agent And AI Process States

Status: completed.

Make Codex/Claude and AI chat behavior more like a process:
- `thinking` while chat AI is pending
- `waiting` for permission requests
- `done` after confirmed completion
- `error` on failures
- prevent low-priority idle/search bubbles from interrupting active agent/chat states

Verification:
- `pnpm build`
- `cargo test agent_notify --lib`

Result: passed.

## Stage 5: Final Review

Status: completed.

Review the final diff for:
- no unrelated scope expansion
- no mojibake in Chinese text
- no leftover debugging logs added by this phase
- stage checklist completed

Verification:
- `pnpm build`
- `cargo test agent_notify --lib`

Result: passed.
