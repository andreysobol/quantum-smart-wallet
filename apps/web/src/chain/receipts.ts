/**
 * Pure parsers for the shared devnet's JSON-RPC shapes: EL receipts of type-6 frame
 * transactions (`payer`, `frameReceipts`), ERC-20 Transfer deltas, and the sidecar's
 * admission records (`skandha_explorer_getTransaction`). No I/O here.
 */
import type { Address, Hex } from "../../shared/types.js";
import type { FrameView } from "./types.js";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** ethrex emits Transfer logs from this pseudo-address for native ETH moves (EIP-7708 style). */
export const NATIVE_TRANSFER_PSEUDO_ADDRESS = "0xfffffffffffffffffffffffffffffffffffffffe";

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
}

export interface RawFrameReceipt {
  status: string;
  gasUsed: string;
  stateGasUsed?: string;
  logs: RawLog[];
}

/** eth_getTransactionReceipt on /rpc (frame transactions add payer + frameReceipts). */
export interface RawReceipt {
  transactionHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  status: string;
  type: string;
  from: string;
  to: string | null;
  gasUsed: string;
  effectiveGasPrice: string;
  payer?: string | null;
  frameReceipts?: RawFrameReceipt[];
  logs: RawLog[];
}

/** One frame of a mined type-6 transaction as returned by eth_getTransactionByHash. */
export interface RawTxFrame {
  mode: string | number;
  flags: string | number;
  to?: string | null;
  target?: string | null;
  data: string;
}

export const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** 32-byte topic form of an address. */
export const addressTopic = (address: string): string => "0x" + address.toLowerCase().slice(2).padStart(64, "0");

const toBig = (value: string | number | null | undefined): bigint => {
  if (value === null || value === undefined || value === "" || value === "0x") return 0n;
  return BigInt(value);
};

export const quantity = (value: string | number | null | undefined): number => Number(toBig(value));

/**
 * Net ERC-20 movements for `account` from Transfer logs, filtered by token contract
 * (native-ETH pseudo-transfers share topic0 and are ignored). Negative = paid out.
 */
export function tokenDeltas(logs: readonly RawLog[], account: string, tokens: { usdc: string; weth: string }): {
  usdc: bigint;
  weth: bigint;
} {
  const me = addressTopic(account);
  const delta = { usdc: 0n, weth: 0n };
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const key = sameAddress(log.address, tokens.usdc) ? "usdc" : sameAddress(log.address, tokens.weth) ? "weth" : null;
    if (!key) continue;
    const amount = toBig(log.data);
    if (log.topics[1]?.toLowerCase() === me) delta[key] -= amount;
    if (log.topics[2]?.toLowerCase() === me) delta[key] += amount;
  }
  return delta;
}

const MODE_NAMES = ["DEFAULT", "VERIFY", "SENDER"] as const;
export const modeName = (mode: string | number): FrameView["mode"] => MODE_NAMES[Number(mode)] ?? "DEFAULT";

/** Frame views from the transaction's frames plus (when mined) its frame receipts. */
export function frameViews(
  frames: readonly { mode: string | number; flags: string | number; target: string | null }[],
  labels: readonly string[],
  receipt: Pick<RawReceipt, "frameReceipts"> | null,
): FrameView[] {
  return frames.map((frame, index) => {
    const fr = receipt?.frameReceipts?.[index];
    return {
      index,
      mode: modeName(frame.mode),
      flags: Number(frame.flags),
      target: (frame.target ?? "0x") as Address,
      label: labels[index] ?? `Frame ${index}`,
      status: fr ? (quantity(fr.status) === 1 ? "success" : "failed") : null,
      gasUsed: fr ? toBig(fr.gasUsed) : null,
    };
  });
}

export function receiptSucceeded(receipt: RawReceipt): boolean {
  return quantity(receipt.status) === 1 && (receipt.frameReceipts ?? []).every((f) => quantity(f.status) === 1);
}

export const receiptFee = (receipt: RawReceipt): bigint => toBig(receipt.gasUsed) * toBig(receipt.effectiveGasPrice);

// ---------------------------------------------------------------------------- admission

export interface RuleCheck {
  rule: string;
  verdict: "pass" | "fail" | "skipped";
  frameIndex?: number;
  entity?: string;
  detail?: string;
}

export interface AdmissionSummary {
  outcome: "rejected" | "accepted" | "included" | "replaced" | "dropped" | string;
  checksPassed: number;
  checksTotal: number;
  failed: RuleCheck[];
  errorCode: number | null;
  frameStatuses: string[];
  includer: string | null;
  /** Last lifecycle event reason (e.g. why a pending entry was dropped). */
  reason: string | null;
}

const RULE_LABELS: Record<string, string> = {
  "gas-limit": "total gas limit",
  "recent-root": "recent-root references",
  prefix: "validation prefix shape",
  structure: "transaction structure",
  signature: "sponsor signature",
  simulation: "traced simulation",
  "trace-alignment": "trace alignment",
  "OP-061": "no value in validation calls",
  execution: "execution",
  "out-of-gas": "validation gas",
  "OP-011": "banned opcodes",
  create: "no contract creation in validation",
  storage: "storage access rules",
  "COD-010": "code access rules",
  "entrypoint-access": "entry point access",
  mempool: "mempool acceptance",
  admission: "admission",
};

export const ruleLabel = (check: Pick<RuleCheck, "rule" | "frameIndex" | "entity">): string => {
  const base = RULE_LABELS[check.rule] ?? check.rule;
  return check.entity ? `${base} (${check.entity}${check.frameIndex !== undefined ? `, frame ${check.frameIndex}` : ""})` : base;
};

/** Parse skandha_explorer_getTransaction's result; null when there is no admission record. */
export function parseAdmission(detail: unknown): AdmissionSummary | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as { admission?: unknown; events?: unknown };
  const a = d.admission as
    | { outcome?: unknown; checks?: unknown; errorCode?: unknown; frameStatuses?: unknown; includer?: unknown }
    | null
    | undefined;
  if (!a || typeof a.outcome !== "string") return null;
  const checks = (Array.isArray(a.checks) ? a.checks : []) as RuleCheck[];
  const events = (Array.isArray(d.events) ? d.events : []) as { reason?: unknown }[];
  const reason = [...events].reverse().find((e) => typeof e.reason === "string")?.reason;
  return {
    outcome: a.outcome,
    checksPassed: checks.filter((c) => c.verdict === "pass").length,
    checksTotal: checks.length,
    failed: checks.filter((c) => c.verdict === "fail"),
    errorCode: typeof a.errorCode === "number" ? a.errorCode : null,
    frameStatuses: Array.isArray(a.frameStatuses) ? a.frameStatuses.map(String) : [],
    includer: typeof a.includer === "string" ? a.includer : null,
    reason: typeof reason === "string" ? reason : null,
  };
}

/** One readable sentence for a rejected admission. */
export function describeRejection(summary: AdmissionSummary): string {
  const first = summary.failed[0];
  if (!first) return summary.reason ?? "The mempool rejected the transaction.";
  return `The mempool rejected the transaction at its ${ruleLabel(first)} check${first.detail ? `: ${first.detail}` : "."}`;
}

/**
 * Readable message for an eth_sendFrameTransaction error (the gateway strips error.data
 * and truncates messages to 512 chars).
 */
export function describeMempoolError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("cannot cover its pending frame transactions") || m.includes("maximum cost"))
    return "The sponsor cannot cover the gas for this swap right now. Try again later.";
  if (m.includes("nonce key") && m.includes("already held"))
    return "Another transaction from this account is still pending. Wait for it to settle, then try again.";
  if (m.includes("nonce")) return "The account nonce changed while signing. Try the swap again.";
  if (m.includes("invalid frame transaction signature")) return "The mempool rejected the sponsor's signature.";
  if (m.includes("validation prefix frame reverted"))
    return "The validation frames reverted in simulation: the signature or sponsor approval was refused.";
  if (m.includes("is banned") || m.includes("is throttled"))
    return "The mempool is temporarily throttling this account or its sponsor. Try again in a few minutes.";
  if (m.includes("gas limit is too high")) return "The transaction's gas limits exceed the mempool's cap.";
  if (m.includes("fee too low")) return "A pending transaction with the same nonce has a higher fee.";
  return `The mempool rejected the transaction: ${message}`;
}
