/**
 * Pure view model for the Proof screen: maps real swap stages (live) or a replay clock
 * onto the design's five phases, frame rows and SLH-DSA hypertree animation.
 */
import type { FrameView, SwapStage } from "./types.js";

export const PHASES = [
  { name: "Compose", title: "Composing" },
  { name: "Sign", title: "Signing" },
  { name: "Verify", title: "Verifying" },
  { name: "Execute", title: "Executing" },
  { name: "Settle", title: "Settled" },
] as const;

/** Phase index (0..4) a swap stage belongs to. */
export function phaseOfStage(stage: SwapStage): number {
  switch (stage) {
    case "quote":
    case "build":
      return 0;
    case "sign":
    case "sponsor":
      return 1;
    case "submit":
    case "admission":
    case "inclusion":
      return 2;
    case "verified":
      return 3;
    case "settled":
      return 4;
  }
}

export type FrameRunState = "hidden" | "shown" | "running" | "finished";

export interface FrameRow {
  cls: string;
  status: string;
}

export function frameRow(frame: Pick<FrameView, "mode" | "status">, state: FrameRunState): FrameRow {
  const appeared = state !== "hidden";
  const run = state === "running";
  const fin = state === "finished";
  let status = "";
  if (fin) status = frame.status === "failed" ? "Reverted" : frame.mode === "VERIFY" ? "Approved" : "Done";
  else if (run) status = "Running";
  return { cls: (appeared ? "in" : "") + (run ? " run" : "") + (fin ? " fin" : ""), status };
}

/** Frame states while a live swap is at `stage` (frames 0-1 are the validation prefix). */
export function liveFrameStates(stage: SwapStage, frameCount: number, settled: boolean): FrameRunState[] {
  const phase = phaseOfStage(stage);
  return Array.from({ length: frameCount }, (_, i): FrameRunState => {
    if (settled) return "finished";
    if (stage === "quote" || stage === "build") return stage === "build" ? "shown" : "hidden";
    if (phase === 1) return "shown";
    if (phase === 2) return i < 2 ? "running" : "shown";
    return i < 2 ? "finished" : "running";
  });
}

// ---------------------------------------------------------------------------- hypertree

/** Virtual milliseconds of the design's verify animation: 14 FORS spokes, FORS root, 7 layers, root. */
const SPOKE0 = 250;
const SPOKE = 75;
const FORS_AT = SPOKE0 + 14 * SPOKE + 200;
const LAYER = 430;
export const TREE_SPAN = FORS_AT + 7 * LAYER + 450;

export interface TreeGeometryLike {
  spokes: string[];
  fors: string;
  layers: string[];
  climb: string[];
}

/** Split the hypertree into dim / lit / hot / climb paths for progress f in [0, 1]. */
export function treePaths(g: TreeGeometryLike, f: number): { dim: string; lit: string; hot: string; climb: string } {
  const v = Math.max(0, Math.min(1, f)) * TREE_SPAN;
  let dim = "";
  let lit = "";
  let hot = "";
  let climb = "";
  g.spokes.forEach((d, i) => {
    const at = SPOKE0 + SPOKE * (i + 1);
    if (v >= at) lit += d;
    else if (v > 0 && v >= at - SPOKE) hot += d;
    else dim += d;
  });
  if (v >= FORS_AT) lit += g.fors;
  else dim += g.fors;
  g.layers.forEach((d, j) => {
    const start = FORS_AT + LAYER * j;
    if (v >= start + LAYER) lit += d;
    else if (v >= start) hot += d;
    else dim += d;
  });
  g.climb.forEach((d, j) => {
    if ((j < 7 && v >= FORS_AT + LAYER * (j + 1)) || (j === 7 && v >= TREE_SPAN)) climb += d;
  });
  return { dim, lit, hot, climb };
}

/** Tree progress while waiting for inclusion: eases towards 0.92, completes only once verified. */
export const waitingTreeProgress = (elapsedMs: number): number => 0.92 * (1 - Math.exp(-elapsedMs / 5000));

// ---------------------------------------------------------------------------- replay clock

export interface ReplayTimeline {
  phaseEnds: number[];
  fAppear: number[];
  fRun: number[];
  fDone: number[];
  verifyStart: number;
  rootAt: number;
  stampAt: number;
  total: number;
}

/** Fixed-pace replay of a recorded swap, shaped like the design's buildProof(). */
export function replayTimeline(frameCount: number): ReplayTimeline {
  const fAppear: number[] = [];
  const fRun: number[] = [];
  const fDone: number[] = [];
  let t = 200;
  for (let i = 0; i < frameCount; i++) fAppear.push((t += 320));
  const composeEnd = t + 500;
  const signEnd = composeEnd + 2200;
  const verifyStart = signEnd;
  fRun[0] = verifyStart + 100;
  const rootAt = verifyStart + TREE_SPAN;
  fDone[0] = rootAt + 350;
  fRun[1] = fDone[0];
  fDone[1] = fRun[1] + 300;
  const verifyEnd = fDone[1] + 200;
  t = verifyEnd;
  for (let i = 2; i < frameCount; i++) {
    fRun[i] = t + 100;
    t += 700;
    fDone[i] = t;
  }
  const executeEnd = t + 200;
  const stampAt = executeEnd + 300;
  const total = executeEnd + 1100;
  return { phaseEnds: [composeEnd, signEnd, verifyEnd, executeEnd, total + 1], fAppear, fRun, fDone, verifyStart, rootAt, stampAt, total };
}

export interface ReplayFrame {
  phase: number;
  frames: FrameRunState[];
  tree: number;
  done: boolean;
  stamped: boolean;
  signing: boolean;
}

export function replayAt(tl: ReplayTimeline, t: number): ReplayFrame {
  let phase = 4;
  for (let i = 0; i < 5; i++) {
    if (t < (tl.phaseEnds[i] ?? 0)) {
      phase = i;
      break;
    }
  }
  const frames = tl.fAppear.map((appear, i): FrameRunState => {
    if (t >= (tl.fDone[i] ?? Infinity)) return "finished";
    if (t >= (tl.fRun[i] ?? Infinity)) return "running";
    return t >= appear ? "shown" : "hidden";
  });
  return {
    phase,
    frames,
    tree: Math.max(0, Math.min(1, (t - tl.verifyStart) / TREE_SPAN)),
    done: t >= tl.total,
    stamped: t >= tl.stampAt,
    signing: t >= (tl.phaseEnds[0] ?? 0) && t < tl.verifyStart,
  };
}
