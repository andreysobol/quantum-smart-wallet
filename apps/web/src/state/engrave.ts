import { useSyncExternalStore } from "react";
import { formatEther, isAddressEqual } from "viem";
import { accountSalt } from "../../shared/account.js";
import { RpcError } from "../../shared/rpc.js";
import type { Address, CreateAccountRequest, CreateAccountResponse, Hex, PublicConfig } from "../../shared/types.js";
import { ApiError } from "../chain/api.js";
import { SignerError, type KeyMeta, type Signer } from "../crypto/types.js";
import type { AccountLookup } from "./factory.js";
import type { WalletRecord } from "./types.js";

/**
 * The engraving flow behind the Engrave screen. Create: generate the key in the signer worker,
 * derive the CREATE2 account, have the operator create it (POST /api/account), confirm on-chain.
 * Restore: start from an imported key and find its account (offering creation if it is missing).
 * Runs outside React so re-renders, StrictMode and navigation never start a second key generation.
 */
export type EngraveMode = "create" | "restore";
export type EngraveStep = "connect" | "seed" | "root" | "derive" | "create" | "confirm" | "done";
export type EngravePhase = "running" | "error" | "offer" | "unavailable" | "done";

export interface EngraveState {
  mode: EngraveMode;
  phase: EngravePhase;
  step: EngraveStep;
  status: string;
  publicKey: Hex | null;
  account: Address | null;
  /** Account creation transaction, when this flow created the account. */
  txHash: Hex | null;
  /** Wei locked by the factory, as ETH text (from the config). */
  stakeEth: string | null;
  error: string | null;
  record: WalletRecord | null;
}

export interface EngraveDeps {
  loadConfig(): Promise<PublicConfig>;
  signer: Signer;
  createAccount(body: CreateAccountRequest): Promise<CreateAccountResponse>;
  lookupAccount(rpcUrl: string, factory: Address, publicKey: Hex, salt: Hex, expected?: Address): Promise<AccountLookup>;
  onDone(record: WalletRecord): void;
  /** Minimum time each visible step stays on screen so the engraving reads (0 for reduced motion and tests). */
  paceMs: number;
  /** Delay between on-chain confirmation polls. */
  pollMs?: number;
}

const STATUS: Record<EngraveStep, string> = {
  connect: "Connecting to devnet",
  seed: "Drawing a 256-bit seed",
  root: "Computing PK.root",
  derive: "Deriving your account",
  create: "Engraving your account on devnet",
  confirm: "Confirming on-chain",
  done: "",
};

const CONFIRM_ATTEMPTS = 8;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class EngraveJob {
  private state: EngraveState;
  private readonly listeners = new Set<() => void>();
  private run = 0;
  private allowCreate: boolean;
  private readonly meta: KeyMeta | null;

  constructor(
    private readonly deps: EngraveDeps,
    mode: EngraveMode,
    restored?: { publicKey: Hex; meta: KeyMeta | null },
  ) {
    this.allowCreate = mode === "create";
    this.meta = restored?.meta ?? null;
    this.state = {
      mode,
      phase: "running",
      step: "connect",
      status: STATUS.connect,
      publicKey: restored?.publicKey ?? null,
      account: null,
      txHash: null,
      stakeEth: null,
      error: null,
      record: null,
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = (): EngraveState => this.state;

  /** Start, or resume after an error (a generated key is kept: retries never make a second one). */
  start(): Promise<void> {
    return this.execute(++this.run);
  }
  /** Resume after an error, or once the server's operator has been configured. */
  retry(): Promise<void> {
    return this.state.phase === "error" || this.state.phase === "unavailable" ? this.start() : Promise.resolve();
  }
  /** Restore mode: the user accepted creating an account for the restored key. */
  acceptCreate(): Promise<void> {
    if (this.state.phase !== "offer") return Promise.resolve();
    this.allowCreate = true;
    return this.start();
  }
  cancel(): void {
    this.run++;
  }

  private set(patch: Partial<EngraveState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private step(step: EngraveStep, status = STATUS[step]): void {
    this.set({ step, status });
  }

  private async execute(run: number): Promise<void> {
    const live = () => run === this.run;
    const { signer, paceMs } = this.deps;
    const pace = () => sleep(paceMs);
    try {
      this.set({ phase: "running", error: null });
      this.step("connect");
      const config = await this.deps.loadConfig();
      if (!live()) return;
      const stakeEth = formatEther(BigInt(config.accountInitialStake));
      this.set({ stakeEth });

      let publicKey = this.state.publicKey;
      if (!publicKey) {
        this.step("seed");
        await signer.ready();
        const generated = signer.generate();
        await pace();
        if (!live()) return;
        this.step("root");
        publicKey = (await generated).publicKey;
        if (!live()) return;
        this.set({ publicKey });
        await pace();
      }

      this.step("derive");
      const factory = config.contracts.accountFactory;
      const fromBackup =
        this.meta && this.meta.chainId === config.chainId && isAddressEqual(this.meta.factory, factory) ? this.meta : null;
      const salt = fromBackup?.salt ?? accountSalt(publicKey);
      const found = await this.deps.lookupAccount(config.rpcUrl, factory, publicKey, salt);
      if (!live()) return;
      if (fromBackup && !isAddressEqual(found.predicted, fromBackup.account)) {
        throw new Error("The factory derives a different account for this key than the backup records. Nothing was changed.");
      }
      const account = found.predicted;
      this.set({ account });
      await pace();
      if (!live()) return;

      let txHash = this.state.txHash;
      if (!found.registered) {
        if (!this.allowCreate) return this.set({ phase: "offer" });
        // Ask the server even when the cached config says no operator: it answers not_configured
        // (shown with a retry), and a retry succeeds once the operator key has been set.
        this.step("create", `${STATUS.create} · the operator stakes ${stakeEth} ETH`);
        const created = await this.deps.createAccount({ publicKey });
        if (!live()) return;
        if (!isAddressEqual(created.account, account) || created.salt.toLowerCase() !== salt.toLowerCase()) {
          throw new Error("The server reported a different account than the factory derives for your key. Nothing was saved.");
        }
        txHash = created.txHash ?? txHash;
        this.set({ txHash });
      }

      this.step("confirm");
      for (let attempt = 1; ; attempt++) {
        const check = await this.deps.lookupAccount(config.rpcUrl, factory, publicKey, salt, account);
        if (!live()) return;
        if (!isAddressEqual(check.predicted, account)) {
          throw new Error("factory.getAddress returned a different account on re-check. Nothing was saved.");
        }
        if (check.registered) break;
        if (attempt >= CONFIRM_ATTEMPTS) {
          throw new Error("The account is not registered on-chain yet. Wait a few seconds, then try again.");
        }
        await sleep(this.deps.pollMs ?? 1500);
        if (!live()) return;
      }

      await signer.setMeta(publicKey, { chainId: config.chainId, account, factory, salt });
      if (!live()) return;
      const record: WalletRecord = {
        version: 1,
        chainId: config.chainId,
        account,
        publicKey,
        salt,
        factory,
        createdAt: Date.now(),
        createTxHash: txHash,
        // A restore starts from a backup file that just decrypted, so the backup is known to work.
        backedUp: this.state.mode === "restore",
      };
      this.set({ phase: "done", step: "done", status: "", record });
      this.deps.onDone(record);
    } catch (error) {
      if (!live()) return;
      if (error instanceof ApiError && error.code === "not_configured") return this.set({ phase: "unavailable" });
      this.set({ phase: "error", error: describeError(error) });
    }
  }
}

/** A readable sentence for any failure in the onboarding flows. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError || error instanceof SignerError) return error.message;
  if (error instanceof RpcError) return `The devnet RPC failed: ${error.message}. Check your connection and try again.`;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}

// The current job, shared by the screen that starts it (Genesis/Restore) and the Engrave screen.
let current: EngraveJob | null = null;
const pointerListeners = new Set<() => void>();
const notify = () => pointerListeners.forEach((listener) => listener());

export function startEngrave(deps: EngraveDeps, mode: EngraveMode, restored?: { publicKey: Hex; meta: KeyMeta | null }): EngraveJob {
  current?.cancel();
  current = new EngraveJob(deps, mode, restored);
  notify();
  void current.start();
  return current;
}

export function clearEngrave(): void {
  current?.cancel();
  current = null;
  notify();
}

const subscribePointer = (listener: () => void) => {
  pointerListeners.add(listener);
  return () => pointerListeners.delete(listener);
};
const noSubscribe = () => () => {};
const noState = () => null;

/** The current engrave job and its state (both null when no flow was started). */
export function useEngrave(): { job: EngraveJob | null; state: EngraveState | null } {
  const job = useSyncExternalStore(subscribePointer, () => current);
  const state = useSyncExternalStore(job ? job.subscribe : noSubscribe, job ? job.getSnapshot : noState);
  return { job, state };
}
