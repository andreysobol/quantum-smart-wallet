import type { Address, Hex, SwapDirection } from "../../shared/types.js";

export interface Balances {
  block: number;
  /** Spendable ETH on the account (expected 0: gas is sponsored). */
  eth: bigint;
  usdc: bigint;
  weth: bigint;
  /** ETH locked as alternative-mempool stake, or null if unknown. */
  stake: bigint | null;
  /** Spot price from the pool, dUSDC per WETH (float, display only). */
  usdcPerWeth: number;
}

export type LedgerKind = "create" | "faucet" | "swap" | "other";

export interface LedgerEntry {
  hash: Hex;
  kind: LedgerKind;
  title: string;
  meta: string;
  blockNumber: number;
  timestamp: number;
  status: "success" | "reverted";
  payer: Address | null;
  /** Actual token deltas for the account, raw units, when known. */
  deltas?: { usdc: bigint; weth: bigint };
}

export interface SwapInput {
  direction: SwapDirection;
  amountIn: bigint;
  /** Slippage tolerance in basis points used to derive minOut from the quote. */
  slippageBps: number;
}

export type SwapStage =
  | "quote"
  | "build"
  | "sign"
  | "sponsor"
  | "submit"
  | "admission"
  | "inclusion"
  | "verified"
  | "settled";

export type StageState = "pending" | "active" | "done" | "error";

export interface FrameView {
  index: number;
  mode: "VERIFY" | "SENDER" | "DEFAULT";
  flags: number;
  target: Address;
  label: string;
  /** Null until the receipt is known. */
  status: "success" | "failed" | null;
  gasUsed: bigint | null;
}

export interface SwapProgress {
  stage: SwapStage;
  state: StageState;
  message: string;
  txHash?: Hex;
  signingHash?: Hex;
  detail?: Record<string, string | number | boolean | null>;
}

export interface SwapResult {
  txHash: Hex;
  signingHash: Hex;
  blockNumber: number;
  blockHash: Hex;
  status: "success" | "reverted";
  sponsor: Address;
  payer: Address;
  feeWei: bigint;
  gasUsed: bigint;
  /** Gas used by frame 0 (account VERIFY: on-chain SLH-DSA verification). */
  pqValidationGas: bigint | null;
  frames: FrameView[];
  direction: SwapDirection;
  /** Actual token movements for the account, raw units, from receipt logs. */
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  admission: { outcome: string; checksPassed: number; checksTotal: number } | null;
  explorerTxUrl: string;
}
