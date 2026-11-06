import { decodeFunctionResult, encodeFunctionData, stringToHex } from "viem";
import { accountAbi, factoryAbi, verifierAbi } from "../shared/abis.js";
import {
  FEES,
  FRAME_LIMITS,
  FRAME_MODE,
  SIGNATURE_BYTES,
  SIGNATURE_CONTEXT,
  SIGNATURE_SCHEME,
  SPONSOR_SIGNATURE_BYTES,
  VALIDATE_FRAME_SELECTOR,
} from "../shared/constants.js";
import { encodeRaw, signingHash, totalFrameGasLimit, type Frame, type FrameLimits, type FrameTx } from "../shared/frameTx.js";
import { buildSwapTx, parseSwapTx, SwapCodecError, type ParsedSwap } from "../shared/swap.js";
import type { Address, Hex } from "../shared/types.js";
import { ApiFailure } from "./http.js";
import type { Deployment, Rpc } from "./manifest.js";

export const MAX_DEADLINE_SECONDS = 3600;
/** Gas for the eth_call that runs the on-chain SLH-DSA verifier (~1.1M used). */
const VERIFY_CALL_GAS = "0x989680";

export interface PolicyContext {
  deployment: Pick<Deployment, "chainId" | "contracts" | "poolKey">;
  sponsor: Address;
  maxSwapUsdc: bigint;
  maxSwapWeth: bigint;
  /** Wei the sponsor must keep on top of the worst-case fee of this transaction. */
  reserve: bigint;
  rpc: Rpc;
}

const reject = (message: string): never => {
  throw new ApiFailure(422, "policy_rejected", message);
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const byteLength = (hex: Hex) => (hex.length - 2) / 2;
const sameLimits = (a: FrameLimits, b: FrameLimits) => a.execution === b.execution && a.state === b.state;

function checkFrame(frame: Frame, index: number, expected: { mode: number; flags: number; target: string; limits: FrameLimits; data: Hex; what: string }) {
  if (frame.mode !== expected.mode || frame.flags !== expected.flags) reject(`Frame ${index} must be ${expected.what} (mode ${expected.mode}, flags ${expected.flags}).`);
  if (!same(frame.target, expected.target)) reject(`Frame ${index} must target ${expected.target}.`);
  if (!sameLimits(frame.limits, expected.limits)) reject(`Frame ${index} gas limits must be ${expected.limits.execution}/${expected.limits.state}.`);
  if (frame.value !== 0n) reject(`Frame ${index} must not carry value.`);
  if (frame.data.toLowerCase() !== expected.data) reject(`Frame ${index} calldata must be ${expected.data === "0x" ? "empty" : expected.data}.`);
}

/** Static template checks (no network). Returns the parsed swap intent. */
export function checkTemplate(tx: FrameTx, ctx: Omit<PolicyContext, "rpc" | "reserve">): ParsedSwap {
  const { deployment, sponsor } = ctx;
  if (tx.chainId !== BigInt(deployment.chainId)) reject(`chainId must be ${deployment.chainId}.`);
  if (tx.nonceKeys.length !== 1 || tx.nonceKeys[0] !== 0n) reject("nonceKeys must be [0] (the account's linear nonce).");
  if (tx.blobVersionedHashes.length > 0 || tx.recentRootReferences.length > 0) reject("Blob hashes and recent root references must be empty.");
  const fees = tx.fees;
  if (fees.maxPriorityFeePerGas !== FEES.maxPriorityFeePerGas || fees.maxFeePerGas !== FEES.maxFeePerGas || fees.maxFeePerBlobGas !== FEES.maxFeePerBlobGas) {
    reject(`Fees must be exactly ${FEES.maxPriorityFeePerGas} / ${FEES.maxFeePerGas} / ${FEES.maxFeePerBlobGas} wei per gas.`);
  }
  if (tx.frames.length !== 5) reject(`Expected exactly 5 frames, got ${tx.frames.length}.`);
  const [verify, pay] = tx.frames as [Frame, Frame];
  checkFrame(verify, 0, { mode: FRAME_MODE.VERIFY, flags: 2, target: tx.sender, limits: FRAME_LIMITS.accountVerify, data: VALIDATE_FRAME_SELECTOR, what: "the account VERIFY frame" });
  checkFrame(pay, 1, { mode: FRAME_MODE.VERIFY, flags: 1, target: sponsor, limits: FRAME_LIMITS.sponsorVerify, data: "0x", what: "the sponsor VERIFY frame" });
  if (tx.signatures.length !== 2) reject(`Expected exactly 2 signature entries, got ${tx.signatures.length}.`);
  const [pq, sp] = tx.signatures as [FrameTx["signatures"][number], FrameTx["signatures"][number]];
  if (pq.scheme !== SIGNATURE_SCHEME.ARBITRARY || pq.signer !== "0x" || pq.msg !== "0x" || byteLength(pq.signature) !== SIGNATURE_BYTES) {
    reject(`Signature 0 must be the ${SIGNATURE_BYTES}-byte SLH-DSA signature (ARBITRARY scheme, empty signer and msg).`);
  }
  if (sp.scheme !== SIGNATURE_SCHEME.SECP256K1 || !same(sp.signer, sponsor) || sp.msg !== "0x" || byteLength(sp.signature) !== SPONSOR_SIGNATURE_BYTES) {
    reject(`Signature 1 must be a ${SPONSOR_SIGNATURE_BYTES}-byte SECP256K1 placeholder for sponsor ${sponsor} with empty msg.`);
  }
  let parsed: ParsedSwap;
  try {
    parsed = parseSwapTx(tx, deployment);
  } catch (error) {
    if (error instanceof SwapCodecError) return reject(`Swap frames rejected: ${error.message}.`);
    return reject("Swap frames could not be decoded.");
  }
  if (parsed.minOut <= 0n) reject("The minimum output must be greater than zero.");
  const max = parsed.direction === "USDC_TO_WETH" ? ctx.maxSwapUsdc : ctx.maxSwapWeth;
  if (parsed.amountIn <= 0n || parsed.amountIn > max) reject(`The input amount must be between 1 and ${max} raw units.`);
  const rebuilt = buildSwapTx({
    config: { chainId: deployment.chainId, contracts: deployment.contracts, poolKey: deployment.poolKey, sponsor },
    account: tx.sender,
    nonce: tx.nonceSeq,
    direction: parsed.direction,
    amountIn: parsed.amountIn,
    minOut: parsed.minOut,
    deadline: parsed.deadline,
  });
  if (encodeRaw({ ...rebuilt, signatures: tx.signatures }) !== encodeRaw(tx)) reject("Frames 2-4 must match the canonical swap template byte for byte.");
  return parsed;
}

type Ok = { ok: true; result: unknown };

function okResult(item: { ok: boolean; result?: unknown; error?: Error } | undefined, what: string): unknown {
  if (!item || !item.ok) throw new ApiFailure(502, "upstream_error", `The devnet RPC failed to return ${what}.`);
  return (item as Ok).result;
}

/**
 * The complete sponsorship policy: the static template plus live checks (factory
 * registration, account nonce, deadline window, sponsor funds) and the account's
 * SLH-DSA signature verified on-chain with the deployment's verifier.
 */
export async function checkSponsorPolicy(tx: FrameTx, ctx: PolicyContext): Promise<ParsedSwap> {
  const parsed = checkTemplate(tx, ctx);
  const { contracts } = ctx.deployment;
  const [nonce, block, registered, balance] = await ctx.rpc.batch([
    { method: "eth_getTransactionCount", params: [tx.sender, "latest"] },
    { method: "eth_getBlockByNumber", params: ["latest", false] },
    { method: "eth_call", params: [{ to: contracts.accountFactory, data: encodeFunctionData({ abi: factoryAbi, functionName: "isAccount", args: [tx.sender] }) }, "latest"] },
    { method: "eth_getBalance", params: [ctx.sponsor, "latest"] },
  ]);
  const isAccount = decodeFunctionResult({ abi: factoryAbi, functionName: "isAccount", data: okResult(registered, "the account registry") as Hex });
  if (!isAccount) throw new ApiFailure(403, "not_quantum_account", "The sender is not a QuantumAccount created by the wallet factory.");
  const accountNonce = BigInt(okResult(nonce, "the account nonce") as Hex);
  if (tx.nonceSeq !== accountNonce) reject(`nonceSeq ${tx.nonceSeq} does not match the account nonce ${accountNonce}; rebuild the swap.`);
  const timestamp = BigInt((okResult(block, "the latest block") as { timestamp: Hex }).timestamp);
  if (parsed.deadline <= timestamp || parsed.deadline > timestamp + BigInt(MAX_DEADLINE_SECONDS)) {
    reject(`The deadline must be after the latest block time (${timestamp}) and at most ${MAX_DEADLINE_SECONDS} s ahead.`);
  }
  const worstCaseFee = totalFrameGasLimit(tx) * tx.fees.maxFeePerGas;
  if (BigInt(okResult(balance, "the sponsor balance") as Hex) < worstCaseFee + ctx.reserve) {
    throw new ApiFailure(503, "operator_unavailable", "The sponsor is low on gas funds. Please try again later.");
  }

  const publicKey = decodeFunctionResult({
    abi: accountAbi,
    functionName: "publicKey",
    data: await ctx.rpc.call<Hex>("eth_call", [{ to: tx.sender, data: encodeFunctionData({ abi: accountAbi, functionName: "publicKey" }) }, "latest"]),
  });
  const verifyData = encodeFunctionData({
    abi: verifierAbi,
    functionName: "verify",
    args: [publicKey, signingHash(tx), stringToHex(SIGNATURE_CONTEXT), (tx.signatures[0] as FrameTx["signatures"][number]).signature],
  });
  const valid = decodeFunctionResult({
    abi: verifierAbi,
    functionName: "verify",
    data: await ctx.rpc.call<Hex>("eth_call", [{ to: contracts.verifier, data: verifyData, gas: VERIFY_CALL_GAS }, "latest"]),
  });
  if (!valid) throw new ApiFailure(422, "invalid_signature", "The SLH-DSA signature does not verify for this account's public key and transaction.");
  return parsed;
}
