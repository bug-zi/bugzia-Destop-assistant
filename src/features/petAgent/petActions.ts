import type { PetAiAction } from "./petDialogue";
import annoyedSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/annoyed.png";
import approvalWaitSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/approval_wait.png";
import blinkSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/blink.png";
import curiousSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/curious.png";
import doubleSurpriseSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/double_surprise.png";
import doneProudSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/done_proud.png";
import dragSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/drag.png";
import dropSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/drop.png";
import errorDisdainSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/error_disdain.png";
import happySheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/happy.png";
import idleSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/idle.png";
import mockingSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/mocking.png";
import protectiveSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/protective.png";
import sleepStartSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/sleep_start.png";
import sleepSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/sleep.png";
import surpriseSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/surprise.png";
import tapHappySheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/tap_happy.png";
import thinkingLoopSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/thinking_loop.png";
import wakeSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/wake.png";
import waveSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/wave.png";
import workingWatchSheetSrc from "../../../assets/pet/vampire-sprite-v1/runtime/working_watch.png";

export type PetAction =
  | "idle"
  | "blink"
  | "happy"
  | "tap_happy"
  | "drag"
  | "drop"
  | "surprise"
  | "double_surprise"
  | "annoyed"
  | "curious"
  | "protective"
  | "mocking"
  | "thinking_loop"
  | "working_watch"
  | "approval_wait"
  | "done_proud"
  | "error_disdain"
  | "sleep_start"
  | "sleep"
  | "wake"
  | "wave";

export interface ActionSpec {
  src: string;
  frames: number;
  fps: number;
  loop: boolean;
  next?: PetAction;
}

export const ACTIONS: Record<PetAction, ActionSpec> = {
  idle: { src: idleSheetSrc, frames: 6, fps: 8, loop: true },
  blink: { src: blinkSheetSrc, frames: 4, fps: 12, loop: false, next: "idle" },
  happy: { src: happySheetSrc, frames: 6, fps: 12, loop: false, next: "idle" },
  tap_happy: { src: tapHappySheetSrc, frames: 6, fps: 12, loop: false, next: "idle" },
  drag: { src: dragSheetSrc, frames: 4, fps: 10, loop: true },
  drop: { src: dropSheetSrc, frames: 5, fps: 12, loop: false, next: "idle" },
  surprise: { src: surpriseSheetSrc, frames: 6, fps: 14, loop: false, next: "idle" },
  double_surprise: { src: doubleSurpriseSheetSrc, frames: 6, fps: 14, loop: false, next: "idle" },
  annoyed: { src: annoyedSheetSrc, frames: 6, fps: 14, loop: false, next: "idle" },
  curious: { src: curiousSheetSrc, frames: 6, fps: 10, loop: false, next: "idle" },
  protective: { src: protectiveSheetSrc, frames: 6, fps: 12, loop: false, next: "idle" },
  mocking: { src: mockingSheetSrc, frames: 6, fps: 12, loop: false, next: "idle" },
  thinking_loop: { src: thinkingLoopSheetSrc, frames: 6, fps: 8, loop: true },
  working_watch: { src: workingWatchSheetSrc, frames: 6, fps: 10, loop: true },
  approval_wait: { src: approvalWaitSheetSrc, frames: 6, fps: 10, loop: true },
  done_proud: { src: doneProudSheetSrc, frames: 6, fps: 12, loop: false, next: "idle" },
  error_disdain: { src: errorDisdainSheetSrc, frames: 6, fps: 12, loop: false, next: "idle" },
  sleep_start: { src: sleepStartSheetSrc, frames: 5, fps: 8, loop: false, next: "sleep" },
  sleep: { src: sleepSheetSrc, frames: 4, fps: 6, loop: true },
  wake: { src: wakeSheetSrc, frames: 5, fps: 12, loop: false, next: "idle" },
  wave: { src: waveSheetSrc, frames: 5, fps: 12, loop: false, next: "idle" },
};

export function actionForAiAction(aiAction: PetAiAction): PetAction | null {
  switch (aiAction) {
    case "happy":
      return "tap_happy";
    case "surprise":
      return "double_surprise";
    case "wake":
      return "wake";
    case "annoyed":
      return "annoyed";
    case "curious":
      return "curious";
    case "protective":
      return "protective";
    case "mocking":
      return "mocking";
    case "idle":
    default:
      return null;
  }
}
