/**
 * The sponsored swap pipeline, mirroring demo/sponsored_swap.py:
 * quote -> build (nonce, deadline) -> SLH-DSA sign in the worker -> sponsor co-sign
 * (verified byte-for-byte before use) -> eth_sendFrameTransaction -> admission ->
 * inclusion -> frame 0 verified -> settled deltas from receipt logs.
 */
import { encodeFunctionData, recoverAddress } from "viem";
import { erc20Abi } from "../../shared/abis.js";
import { SIGNATURE_BYTES, SIGNATURE_SCHEME, SPONSOR_SIGNATURE_BYTES } from "../../shared/constants.js";
import { encodeRaw, fromEthrexRpcTransaction, fromWire, signingHash, toWire, txHash, type FrameTx } from "../../shared/frameTx.js";
import { loadPoolState, quoteExactIn } from "../../shared/quote.js";
import { rpcBatch, rpcCall, RpcError } from "../../shared/rpc.js";
import { buildSwapTx, parseSwapTx } from "../../shared/swap.js";
import type { Address, Hex, PublicConfig, SponsorResponse, SwapDirection } from "../../shared/types.js";
import type { Signer } from "../crypto/types.js";
import type { WalletRecord } from "../state/types.js";
import { formatToken, tokenIn, tokenOut } from "./amounts.js";
import { api, ApiError } from "./api.js";
import { explorerTxUrl } from "./explorer.js";
import {
  describeMempoolError,
  describeRejection,
  frameViews,
  parseAdmission,
  quantity,
  receiptFee,
  receiptSucceeded,
  sameAddress,
  tokenDeltas,
  type AdmissionSummary,
  type RawReceipt,
} from "./receipts.js";
import type { FrameView, SwapInput, SwapProgress, SwapResult, SwapStage } from "./types.js";

export const DEADLINE_SECONDS = 1800n;
export const INCLUSION_TIMEOUT_MS = 180_000;
/** How long to look a submission up by hash when the mempool's answer to it was lost. */
export const RECONCILE_TIMEOUT_MS = 60_000;

/**
 * JSON-RPC codes that prove the transaction was not taken: the sidecar's validation refusals
 * (-32602, -32600, -32500, -32502, -32504, -32507, -32521) and the gateway's refusals before
 * forwarding (-32601, -32700, -32005). Anything else, such as a timeout, a dropped connection or
 * the gateway's -32002 after forwarding, may have lost the answer to an accepted submission.
 */
const REFUSAL_CODES = new Set([-32602, -32600, -32500, -32502, -32504, -32507, -32521, -32601, -32700, -32005]);

/** SwapResult plus the facts the proof receipt shows. */
export interface SwapReport extends SwapResult {
  nonce: bigint;
  /** Wall-clock ms the worker spent signing (live swaps only). */
  signMs: number | null;
  /** Quoted output before slippage (live swaps only). */
  quotedOut: bigint | null;
}

export class SwapError extends Error {
  constructor(
    public readonly stage: SwapStage,
    message: string,
    public readonly txHash?: Hex,
    public readonly result?: SwapReport,
    /** The transaction may still be included (its outcome is unknown), so a new swap must not be invited. */
    public readonly unresolved = false,
  ) {
    super(message);
    this.name = "SwapError";
  }
}

type SwapConfig = PublicConfig;

const usdcSymbol = (config: Pick<PublicConfig, "faucet">) => config.faucet.symbol || "dUSDC";
export const tokenSymbol = (config: Pick<PublicConfig, "faucet">, token: "usdc" | "weth") =>
  token === "usdc" ? usdcSymbol(config) : "WETH";

/** Labels for the five frames, in order (the design's frame list). */
export function swapFrameLabels(config: Pick<PublicConfig, "faucet">, direction: SwapDirection, amountIn: bigint | null): string[] {
  const from = tokenIn(direction);
  const amount = amountIn && amountIn > 0n ? `${formatToken(amountIn, from)} ` : "";
  return [
    "Check your SLH-DSA signature",
    "Sponsor approves paying gas",
    `Approve ${amount}${tokenSymbol(config, from)} for Permit2`,
    "Permit2 allowance for the router",
    `Swap to ${tokenSymbol(config, tokenOut(direction))} on the guarded pool`,
  ];
}

export const PLAN_MODES = ["VERIFY", "VERIFY", "SENDER", "SENDER", "SENDER"] as const;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(id), reject(signal.reason)), { once: true });
  });

const zeros = (bytes: number): Hex => `0x${"00".repeat(bytes)}`;
const hexBytes = (hex: string) => (hex.length - 2) / 2;

export function withSignature(tx: FrameTx, index: number, signature: Hex): FrameTx {
  return { ...tx, signatures: tx.signatures.map((entry, i) => (i === index ? { ...entry, signature } : entry)) };
}

/** Readable message for an /api/sponsor failure; `what` names the transaction ("swap", "registration"). */
export function describeSponsorError(error: unknown, what = "swap"): string {
  if (!(error instanceof ApiError)) return "The sponsor request failed unexpectedly. Try again.";
  switch (error.code) {
    case "policy_rejected":
      return `The sponsor declined this ${what}: ${error.message}`;
    case "invalid_signature":
      return `The sponsor could not verify your SLH-DSA signature: ${error.message}`;
    case "rate_limited":
      return "Too many sponsorship requests from this device or account. Wait a minute and try again.";
    case "not_configured":
    case "operator_unavailable":
      return "The sponsor is unavailable on this server right now.";
    case "not_quantum_account":
      return "This account is not registered with the QuantumAccountFactory, so it cannot be sponsored.";
    case "timeout":
      return "The sponsor did not answer in time. Try again.";
    case "network":
      return error.message;
    default:
      return `The sponsor request failed: ${error.message}`;
  }
}

/**
 * Accept the sponsor's co-signed transaction only if it is byte-identical to the one we
 * signed except signatures[1].signature, its hashes recompute to the claimed values, and
 * that signature recovers to the expected sponsor. Returns the decoded transaction.
 */
export async function verifySponsorResponse(ours: FrameTx, response: SponsorResponse, expectedSponsor: Address): Promise<FrameTx> {
  const reject = (why: string): never => {
    throw new SwapError("sponsor", `The sponsor's response was refused (${why}). Nothing was submitted.`);
  };
  if (!sameAddress(response.sponsor, expectedSponsor)) reject("it names an unexpected sponsor");
  let theirs: FrameTx | null = null;
  try {
    theirs = fromWire(response.tx);
  } catch {
    reject("the transaction could not be decoded");
  }
  if (!theirs) return reject("the transaction could not be decoded");
  const entry = theirs.signatures[1];
  const placeholder = ours.signatures[1]?.signature ?? zeros(SPONSOR_SIGNATURE_BYTES);
  if (
    !entry ||
    Number(entry.scheme) !== SIGNATURE_SCHEME.SECP256K1 ||
    !sameAddress(entry.signer, expectedSponsor) ||
    entry.msg !== "0x" ||
    hexBytes(entry.signature) !== SPONSOR_SIGNATURE_BYTES
  ) {
    reject("the sponsor signature entry is malformed");
  }
  if (theirs.signatures.length !== ours.signatures.length) reject("the signature list changed");
  if (encodeRaw(withSignature(theirs, 1, placeholder)).toLowerCase() !== encodeRaw(ours).toLowerCase()) {
    reject("the transaction differs from the one you signed");
  }
  const digest = signingHash(ours).toLowerCase();
  if (signingHash(theirs).toLowerCase() !== digest || response.signingHash.toLowerCase() !== digest) {
    reject("the signing hash does not match");
  }
  if (txHash(theirs).toLowerCase() !== response.txHash.toLowerCase()) reject("the transaction hash does not match");
  const sig = entry!.signature.toLowerCase();
  const parity = Number.parseInt(sig.slice(2, 4), 16);
  if (parity !== 0 && parity !== 1) reject("the sponsor signature parity is invalid");
  let recovered: string | null = null;
  try {
    recovered = await recoverAddress({
      hash: digest as Hex,
      signature: { r: `0x${sig.slice(4, 68)}`, s: `0x${sig.slice(68, 132)}`, yParity: parity },
    });
  } catch {
    recovered = null;
  }
  if (!sameAddress(recovered, expectedSponsor)) reject("the sponsor signature does not recover to the sponsor");
  return theirs;
}

async function fetchAdmission(config: SwapConfig, hash: Hex, signal?: AbortSignal): Promise<AdmissionSummary | null> {
  try {
    const detail = await rpcCall(config.mempoolUrl, "skandha_explorer_getTransaction", [hash], { signal, timeoutMs: 15_000 });
    return parseAdmission(detail);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

export async function waitForAdmission(
  config: SwapConfig,
  hash: Hex,
  until: (a: AdmissionSummary) => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AdmissionSummary | null> {
  const end = Date.now() + timeoutMs;
  let last: AdmissionSummary | null = null;
  for (;;) {
    last = (await fetchAdmission(config, hash, signal)) ?? last;
    if ((last && until(last)) || Date.now() >= end) return last;
    await sleep(1_000, signal);
  }
}

/**
 * What the sidecar (admission record, mempool entry) and the chain (receipt) know about a
 * transaction right now. `seen`: the mempool took it or a block holds it. A failed lookup
 * counts as not knowing.
 */
async function lookUpTransaction(
  config: SwapConfig,
  hash: Hex,
  signal?: AbortSignal,
): Promise<{ seen: boolean; admission: AdmissionSummary | null }> {
  const quiet = <T>(request: Promise<T>): Promise<T | null> =>
    request.catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return null;
    });
  const options = { signal, timeoutMs: 15_000 };
  const [admission, entry, receipt] = await Promise.all([
    fetchAdmission(config, hash, signal),
    quiet(rpcCall<{ status?: unknown } | null>(config.mempoolUrl, "skandha_frameTransactionStatus", [hash], options)),
    quiet(rpcCall<RawReceipt | null>(config.rpcUrl, "eth_getTransactionReceipt", [hash], options)),
  ]);
  if (receipt) return { seen: true, admission };
  if (admission?.outcome === "rejected") return { seen: false, admission };
  return { seen: !!admission || typeof entry?.status === "string", admission };
}

const DEAD_STATUSES = new Set(["Cancelled", "Reverted"]);

export async function waitForReceipt(config: SwapConfig, hash: Hex, signal?: AbortSignal): Promise<RawReceipt> {
  const end = Date.now() + INCLUSION_TIMEOUT_MS;
  for (let poll = 0; Date.now() < end; poll++) {
    try {
      const receipt = await rpcCall<RawReceipt | null>(config.rpcUrl, "eth_getTransactionReceipt", [hash], { signal });
      if (receipt) return receipt;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    if (poll % 3 === 2) {
      try {
        const status = await rpcCall<{ status?: string; reason?: string }>(
          config.mempoolUrl,
          "skandha_frameTransactionStatus",
          [hash],
          { signal },
        );
        if (status?.status && DEAD_STATUSES.has(status.status)) {
          throw new SwapError(
            "inclusion",
            `The mempool ${status.status === "Cancelled" ? "dropped" : "could not include"} the transaction${status.reason ? `: ${status.reason}` : "."}`,
            hash,
          );
        }
      } catch (error) {
        if (error instanceof SwapError || signal?.aborted) throw error;
      }
    }
    await sleep(2_000, signal);
  }
  throw new SwapError(
    "inclusion",
    "The transaction was not included within 3 minutes. It may still land: check it on the explorer before retrying.",
    hash,
    undefined,
    true,
  );
}

/** Why an included swap reverted, from its frame statuses. */
export function revertMessage(frames: readonly FrameView[]): string {
  const failed = frames.find((f) => f.status === "failed");
  if (!failed) return "The transaction was included but reverted.";
  if (failed.index === 4)
    return "The swap frame reverted, most likely because the price moved past your minimum or the deadline passed. The approvals were rolled back with it; the sponsor still paid the gas.";
  if (failed.index === 2 || failed.index === 3) return `Frame ${failed.index} (${failed.label}) reverted, so the swap did not run.`;
  return `Frame ${failed.index} (${failed.label}) failed.`;
}

function report(
  config: SwapConfig,
  account: Address,
  tx: FrameTx,
  receipt: RawReceipt,
  labels: string[],
  intent: { direction: SwapDirection; minOut: bigint },
  admission: AdmissionSummary | null,
  extra: { signMs: number | null; quotedOut: bigint | null; signingHash: Hex },
): SwapReport {
  const frames = frameViews(
    tx.frames.map((f) => ({ mode: f.mode, flags: f.flags, target: f.target })),
    labels,
    receipt,
  );
  const deltas = tokenDeltas(receipt.logs, account, { usdc: config.contracts.demoUSDC, weth: config.contracts.weth9 });
  const from = tokenIn(intent.direction);
  const to = tokenOut(intent.direction);
  const hash = receipt.transactionHash;
  return {
    txHash: hash,
    signingHash: extra.signingHash,
    blockNumber: quantity(receipt.blockNumber),
    blockHash: receipt.blockHash,
    status: receiptSucceeded(receipt) ? "success" : "reverted",
    sponsor: (config.sponsor ?? receipt.payer ?? "0x") as Address,
    payer: (receipt.payer ?? "0x") as Address,
    feeWei: receiptFee(receipt),
    gasUsed: BigInt(receipt.gasUsed),
    pqValidationGas: frames[0]?.gasUsed ?? null,
    frames,
    direction: intent.direction,
    amountIn: deltas[from] < 0n ? -deltas[from] : 0n,
    amountOut: deltas[to] > 0n ? deltas[to] : 0n,
    minOut: intent.minOut,
    admission: admission
      ? { outcome: admission.outcome, checksPassed: admission.checksPassed, checksTotal: admission.checksTotal }
      : null,
    explorerTxUrl: explorerTxUrl(config, hash, { frame: true }),
    nonce: tx.nonceSeq,
    signMs: extra.signMs,
    quotedOut: extra.quotedOut,
  };
}

/**
 * Run one sponsored swap end to end. Never submits unless the sponsor's transaction
 * matches ours exactly (see verifySponsorResponse). Throws SwapError with a readable
 * message and the failing stage; an included-but-reverted swap returns status "reverted".
 */
export async function runSwap(
  config: SwapConfig,
  wallet: Pick<WalletRecord, "account" | "publicKey">,
  signer: Pick<Signer, "sign">,
  input: SwapInput,
  onProgress: (progress: SwapProgress) => void,
  signal?: AbortSignal,
): Promise<SwapReport> {
  let stage: SwapStage = "quote";
  let hash: Hex | undefined;
  const emit = (state: SwapProgress["state"], message: string, extra: Partial<SwapProgress> = {}) =>
    onProgress({ stage, state, message, ...(hash ? { txHash: hash } : {}), ...extra });
  const fail = (message: string): never => {
    throw new SwapError(stage, message, hash);
  };
  const account = wallet.account;
  const { direction, amountIn } = input;
  const from = tokenIn(direction);
  const to = tokenOut(direction);
  try {
    emit("active", "Reading the pool price");
    const sponsor = config.sponsor;
    if (!config.operatorReady || !sponsor) return fail("Sponsored swaps are unavailable: this server has no sponsor configured.");
    if (amountIn <= 0n) fail("Enter an amount to swap.");
    const cap = BigInt(from === "usdc" ? config.limits.maxAmountInUsdc : config.limits.maxAmountInWeth);
    if (amountIn > cap) fail(`The sponsor accepts at most ${formatToken(cap, from)} ${tokenSymbol(config, from)} per swap.`);
    if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10_000) {
      fail("Slippage must be between 0% and 100%.");
    }
    const pool = await loadPoolState(config.rpcUrl, config);
    const quote = quoteExactIn(pool, direction, amountIn);
    const minOut = (quote.amountOut * BigInt(10_000 - input.slippageBps)) / 10_000n;
    if (minOut <= 0n) fail("This amount is too small to swap: the minimum output rounds to zero.");
    emit("done", `Quoted ${formatToken(quote.amountOut, to)} ${tokenSymbol(config, to)}`);

    stage = "build";
    emit("active", "Reading the account nonce and the chain time");
    const [nonceR, blockR, balanceR] = await rpcBatch(
      config.rpcUrl,
      [
        { method: "eth_getTransactionCount", params: [account, "latest"] },
        { method: "eth_getBlockByNumber", params: ["latest", false] },
        {
          method: "eth_call",
          params: [
            {
              to: from === "usdc" ? config.contracts.demoUSDC : config.contracts.weth9,
              data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [account] } as never),
            },
            "latest",
          ],
        },
      ],
      { signal },
    );
    if (!nonceR?.ok || !blockR?.ok || !balanceR?.ok) fail("Could not read the account state from the devnet RPC. Try again.");
    const timestamp = (blockR!.ok ? (blockR!.result as { timestamp?: string } | null)?.timestamp : undefined) ?? null;
    if (!timestamp) fail("Could not read the latest block. Try again.");
    const balance = BigInt(balanceR!.ok ? (balanceR!.result as string) : "0x0");
    if (balance < amountIn) {
      fail(`Not enough ${tokenSymbol(config, from)}: the account holds ${formatToken(balance, from)}.`);
    }
    const nonce = BigInt(nonceR!.ok ? (nonceR!.result as string) : "0x0");
    const deadline = BigInt(timestamp!) + DEADLINE_SECONDS;
    const unsigned = buildSwapTx({ config, account, nonce, direction, amountIn, minOut, deadline });
    const digest = signingHash(unsigned);
    const labels = swapFrameLabels(config, direction, amountIn);
    emit("done", `${unsigned.frames.length} frames · 1 signature`, { signingHash: digest, detail: { nonce: Number(nonce) } });

    stage = "sign";
    emit("active", "Signing with SLH-DSA-SHA2-128s in your browser", { signingHash: digest });
    const signed_ = await signer.sign(wallet.publicKey, digest);
    if (hexBytes(signed_.signature) !== SIGNATURE_BYTES) fail("The signer returned a malformed signature.");
    const signed = withSignature(unsigned, 0, signed_.signature);
    if (signingHash(signed).toLowerCase() !== digest.toLowerCase()) fail("Signing changed the transaction. Nothing was sent.");
    emit("done", `SLH-DSA-SHA2-128s · 7,856 bytes · ${Math.round(signed_.ms).toLocaleString("en-US")} ms`, {
      signingHash: digest,
      detail: { signMs: Math.round(signed_.ms) },
    });

    stage = "sponsor";
    emit("active", "Asking the sponsor to co-sign the gas payment");
    let response: SponsorResponse | null = null;
    try {
      response = await api.sponsor({ tx: toWire(signed) });
    } catch (error) {
      fail(describeSponsorError(error));
    }
    const final = await verifySponsorResponse(signed, response!, sponsor);
    hash = txHash(final);
    emit("done", `Co-signed by sponsor ${sponsor.slice(0, 6)}…${sponsor.slice(-4)}`);

    stage = "submit";
    emit("active", "Sending to the alternative mempool");
    await submitFrameTransaction(config, final, hash, () => emit("active", "No answer from the mempool: looking the transaction up by its hash"), signal);
    emit("done", "Accepted by the mempool");

    stage = "admission";
    emit("active", "Reading the mempool's admission checks");
    let admission = await waitForAdmission(config, hash, () => true, 8_000, signal);
    if (admission?.outcome === "rejected") fail(describeRejection(admission));
    if (admission?.outcome === "dropped" || admission?.outcome === "replaced") {
      fail(`The mempool ${admission.outcome} the transaction${admission.reason ? `: ${admission.reason}` : "."}`);
    }
    emit("done", admission ? `${admission.checksPassed} of ${admission.checksTotal} admission checks passed` : "Admitted", {
      detail: admission ? { checksPassed: admission.checksPassed, checksTotal: admission.checksTotal } : {},
    });

    stage = "inclusion";
    emit("active", "Waiting for a block");
    const receipt = await waitForReceipt(config, hash, signal);
    emit("done", `Included in block ${quantity(receipt.blockNumber).toLocaleString("en-US")}`, {
      detail: { blockNumber: quantity(receipt.blockNumber) },
    });

    stage = "verified";
    const views = frameViews(final.frames.map((f) => ({ mode: f.mode, flags: f.flags, target: f.target })), labels, receipt);
    if (views[0]?.status !== "success") {
      fail("The account's VERIFY frame failed: the SLH-DSA signature was not accepted on-chain.");
    }
    const pqGas = views[0]?.gasUsed ?? 0n;
    emit("done", `Signature verified on-chain · ${pqGas.toLocaleString("en-US")} gas`, {
      detail: { pqValidationGas: Number(pqGas) },
    });

    stage = "settled";
    emit("active", "Reading the settled amounts");
    admission =
      (await waitForAdmission(config, hash, (a) => a.outcome === "included", 8_000, signal).catch(() => admission)) ?? admission;
    const result = report(config, account, final, receipt, labels, { direction, minOut }, admission, {
      signMs: Math.round(signed_.ms),
      quotedOut: quote.amountOut,
      signingHash: digest,
    });
    if (result.status === "reverted") emit("error", revertMessage(result.frames));
    else emit("done", `Received ${formatToken(result.amountOut, to)} ${tokenSymbol(config, to)}`);
    return result;
  } catch (error) {
    const swapError =
      error instanceof SwapError
        ? error
        : signal?.aborted
          ? new SwapError(stage, "The swap was cancelled.", hash)
          : new SwapError(stage, describeUnexpected(error), hash);
    onProgress({ stage: swapError.stage, state: "error", message: swapError.message, ...(hash ? { txHash: hash } : {}) });
    throw swapError;
  }
}

/**
 * Send a co-signed frame transaction to the alternative mempool. Only a JSON-RPC refusal proves the
 * mempool did not take it; otherwise the answer may be all that was lost, so the transaction is looked
 * up by its hash before failing, and while it may still land the error is marked unresolved rather than
 * reported as a rejection that would invite a second attempt. Throws SwapError at the "submit" stage.
 */
export async function submitFrameTransaction(
  config: SwapConfig,
  final: FrameTx,
  hash: Hex,
  onUnanswered: () => void,
  signal?: AbortSignal,
  what = "swap",
): Promise<void> {
  const fail = (message: string): never => {
    throw new SwapError("submit", message, hash);
  };
  try {
    const returned = await rpcCall<string>(config.mempoolUrl, "eth_sendFrameTransaction", [toWire(final)], {
      signal,
      timeoutMs: 60_000,
    });
    if (typeof returned !== "string" || returned.toLowerCase() !== hash.toLowerCase()) {
      fail("The mempool answered with a different transaction hash than the one you signed.");
    }
  } catch (error) {
    if (error instanceof SwapError || signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof RpcError && /already known/i.test(message)) return;
    const refused = error instanceof RpcError && error.method !== "fetch" && REFUSAL_CODES.has(error.code);
    if (!refused) onUnanswered();
    const end = Date.now() + (refused ? 0 : RECONCILE_TIMEOUT_MS);
    for (;;) {
      const found = await lookUpTransaction(config, hash, signal);
      if (found.seen) return;
      if (found.admission?.outcome === "rejected") fail(describeRejection(found.admission));
      if (refused) fail(describeMempoolError(message));
      if (Date.now() >= end) {
        throw new SwapError(
          "submit",
          `The mempool's answer was lost (${message}), so this ${what}'s status is unknown. It may still be included: check the transaction on the explorer before trying again.`,
          hash,
          undefined,
          true,
        );
      }
      await sleep(2_000, signal);
    }
  }
}

export function describeUnexpected(error: unknown): string {
  if (error instanceof RpcError) return `The devnet RPC failed: ${error.message}`;
  if (error instanceof Error && error.name === "SignerError") return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}

// ---------------------------------------------------------------------------- replay

/** Rebuild the proof of a past swap from chain data (and the sidecar's admission record, if still held). */
export async function loadSwapReport(config: SwapConfig, account: Address, hash: Hex, signal?: AbortSignal): Promise<SwapReport> {
  const [detail, admission] = await Promise.all([
    rpcCall<{ transaction: { type?: string } | null; receipt: RawReceipt | null } | null>(config.rpcUrl, "qsw_explorerTransaction", [hash], {
      signal,
    }),
    fetchAdmission(config, hash, signal),
  ]);
  if (!detail?.transaction) throw new SwapError("inclusion", "This transaction is not on chain (or not indexed yet).", hash);
  if (!detail.receipt) throw new SwapError("inclusion", "This transaction has not been included yet.", hash);
  if (quantity(detail.transaction.type) !== 6) throw new SwapError("inclusion", "This is not a frame transaction.", hash);
  const tx = fromEthrexRpcTransaction(detail.transaction);
  let direction: SwapDirection = "USDC_TO_WETH";
  let minOut = 0n;
  let amountIn: bigint | null = null;
  try {
    const intent = parseSwapTx(tx, config);
    direction = intent.direction;
    minOut = intent.minOut;
    amountIn = intent.amountIn;
  } catch {
    const deltas = tokenDeltas(detail.receipt.logs, account, { usdc: config.contracts.demoUSDC, weth: config.contracts.weth9 });
    direction = deltas.weth < 0n ? "WETH_TO_USDC" : "USDC_TO_WETH";
  }
  const labels = swapFrameLabels(config, direction, amountIn);
  const signing = txHash(tx).toLowerCase() === hash.toLowerCase() ? signingHash(tx) : ("0x" as Hex);
  return report(config, account, tx, detail.receipt, labels, { direction, minOut }, admission, {
    signMs: null,
    quotedOut: null,
    signingHash: signing,
  });
}
