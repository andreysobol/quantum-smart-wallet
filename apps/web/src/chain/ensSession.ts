/**
 * The live name registration, kept outside React so it survives screen changes (like the swap session).
 */
import { useSyncExternalStore } from "react";
import type { Hex } from "../../shared/types.js";
import type { Signer } from "../crypto/types.js";
import type { WalletRecord } from "../state/types.js";
import { registrationLabels, runRegistration, type EnsConfig, type RegistrationInput, type RegistrationReport } from "./ens.js";
import { SwapError } from "./swap.js";
import type { StageState, SwapProgress, SwapStage } from "./types.js";

export interface LiveRegistration {
  id: number;
  account: string;
  input: RegistrationInput;
  name: string;
  labels: string[];
  stage: SwapStage;
  state: StageState;
  message: string;
  /** When the transaction reached the mempool (drives the hypertree while waiting). */
  submittedAt: number | null;
  history: SwapProgress[];
  txHash: Hex | null;
  result: RegistrationReport | null;
  error: string | null;
  /** Failed without a known outcome: the transaction may still be included. */
  unresolved: boolean;
  running: boolean;
}

let live: LiveRegistration | null = null;
let sequence = 0;
const listeners = new Set<() => void>();

function publish(next: LiveRegistration | null) {
  live = next;
  for (const listener of listeners) listener();
}

function patch(id: number, update: Partial<LiveRegistration>) {
  if (live?.id === id) publish({ ...live, ...update });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => live;

export function useRegistration(): LiveRegistration | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Forget a finished registration (to start another). */
export function clearRegistration() {
  if (!live?.running) publish(null);
}

/** Start a sponsored registration in the background. `onVerified` runs once the name verified on chain. */
export function startRegistration(
  config: EnsConfig,
  wallet: WalletRecord,
  signer: Signer,
  input: RegistrationInput,
  quotedPrice: bigint,
  onVerified?: (report: RegistrationReport) => void,
): LiveRegistration {
  if (live?.running) throw new Error("A registration is already in progress.");
  const id = ++sequence;
  const name = `${input.label}.${config.ens.namespace}`;
  publish({
    id,
    account: wallet.account,
    input,
    name,
    labels: registrationLabels(config, input.label, quotedPrice),
    stage: "quote",
    state: "active",
    message: `Checking ${name}`,
    submittedAt: null,
    history: [],
    txHash: null,
    result: null,
    error: null,
    unresolved: false,
    running: true,
  });
  runRegistration(config, wallet, signer, input, (progress) => {
    if (live?.id !== id) return;
    patch(id, {
      stage: progress.stage,
      state: progress.state,
      message: progress.message,
      history: [...live.history, progress],
      txHash: progress.txHash ?? live.txHash,
      submittedAt: live.submittedAt ?? (progress.stage === "submit" && progress.state === "done" ? Date.now() : null),
    });
  })
    .then((result) => {
      const failed = result.status !== "success" || !result.check?.verified;
      patch(id, { result, running: false, txHash: result.txHash, error: failed ? (live?.message ?? "The registration did not complete.") : null });
      if (!failed) onVerified?.(result);
    })
    .catch((error: unknown) => {
      const wrapped = error instanceof SwapError ? error : null;
      patch(id, {
        running: false,
        error: error instanceof Error ? error.message : "The registration failed.",
        unresolved: wrapped?.unresolved ?? false,
        ...(wrapped?.txHash ? { txHash: wrapped.txHash } : {}),
      });
    });
  return live!;
}
