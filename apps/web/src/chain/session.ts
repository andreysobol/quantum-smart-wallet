/**
 * The live swap session, kept outside React so a running swap survives screen changes.
 * Exchange starts it, Proof renders it (or a replay of a past swap by hash).
 */
import { useSyncExternalStore } from "react";
import type { Hex, PublicConfig } from "../../shared/types.js";
import type { Signer } from "../crypto/types.js";
import type { WalletRecord } from "../state/types.js";
import { runSwap, SwapError, swapFrameLabels, type SwapReport } from "./swap.js";
import type { StageState, SwapInput, SwapProgress, SwapStage } from "./types.js";

export interface LiveSwap {
  id: number;
  input: SwapInput;
  labels: string[];
  startedAt: number;
  stage: SwapStage;
  state: StageState;
  message: string;
  /** When the transaction reached the mempool (drives the hypertree while waiting). */
  submittedAt: number | null;
  history: SwapProgress[];
  txHash: Hex | null;
  result: SwapReport | null;
  error: string | null;
  /** Failed without a known outcome: the transaction may still be included. */
  unresolved: boolean;
  running: boolean;
}

/** What the Proof screen shows: the live swap, a past swap by hash, or the live name registration. */
export type ProofSource = { kind: "live"; id: number } | { kind: "replay"; hash: Hex } | { kind: "ens"; id: number };

export interface SessionState {
  live: LiveSwap | null;
  view: ProofSource | null;
}

let state: SessionState = { live: null, view: null };
let sequence = 0;
const listeners = new Set<() => void>();

function publish(next: SessionState) {
  state = next;
  for (const listener of listeners) listener();
}

function patchLive(id: number, patch: Partial<LiveSwap>) {
  if (state.live?.id !== id) return;
  publish({ ...state, live: { ...state.live, ...patch } });
}

export const getSession = (): SessionState => state;

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSession(): SessionState {
  return useSyncExternalStore(subscribeSession, getSession, getSession);
}

/** Start a sponsored swap in the background and point the Proof screen at it. */
export function startSwap(config: PublicConfig, wallet: WalletRecord, signer: Signer, input: SwapInput): LiveSwap {
  if (state.live?.running) throw new Error("A swap is already in progress.");
  const id = ++sequence;
  const live: LiveSwap = {
    id,
    input,
    labels: swapFrameLabels(config, input.direction, input.amountIn),
    startedAt: Date.now(),
    stage: "quote",
    state: "active",
    message: "Reading the pool price",
    submittedAt: null,
    history: [],
    txHash: null,
    result: null,
    error: null,
    unresolved: false,
    running: true,
  };
  publish({ live, view: { kind: "live", id } });
  runSwap(config, wallet, signer, input, (progress) => {
    const current = state.live;
    if (current?.id !== id) return;
    patchLive(id, {
      stage: progress.stage,
      state: progress.state,
      message: progress.message,
      history: [...current.history, progress],
      txHash: progress.txHash ?? current.txHash,
      submittedAt: current.submittedAt ?? (progress.stage === "submit" && progress.state === "done" ? Date.now() : null),
    });
  })
    .then((result) => patchLive(id, { result, running: false, txHash: result.txHash }))
    .catch((error: unknown) => {
      const swapError = error instanceof SwapError ? error : null;
      patchLive(id, {
        running: false,
        error: error instanceof Error ? error.message : "The swap failed.",
        unresolved: swapError?.unresolved ?? false,
        result: swapError?.result ?? null,
        ...(swapError?.txHash ? { txHash: swapError.txHash } : {}),
      });
    });
  return live;
}

/** Show a past swap on the Proof screen (loaded from chain by hash). */
export function showReplay(hash: Hex) {
  publish({ ...state, view: { kind: "replay", hash } });
}

/** Show the live (or last) name registration on the Proof screen. */
export function showRegistration(id: number) {
  publish({ ...state, view: { kind: "ens", id } });
}

/** Point the Proof screen back at the live (or last) swap. */
export function showLive() {
  if (state.live) publish({ ...state, view: { kind: "live", id: state.live.id } });
}
