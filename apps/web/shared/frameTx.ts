/**
 * EIP-8141 frame transaction codec for the pinned ethrex `9aa3645d` profile
 * (shared devnet 81411338). Port of slhsol/script/simulate_native.py (rlp,
 * signature_hash, sign_payer) and demo/sponsored_swap.py (wire), checked
 * byte-for-byte against demo/evidence/shared-devnet (test/frameTx.test.ts).
 *
 * Isomorphic (viem only) and never holds a private key: co-signing takes a signer.
 *
 * Profile notes (do not "upgrade" silently):
 * - tx = 0x06 || rlp([chainId, nonceKeys, nonceSeq, sender, frames, signatures,
 *   fees, blobVersionedHashes, recentRootReferences])
 * - frame = [mode, flags, target, [execution, state], value, data]
 * - signature entry = [scheme, signer, msg, signature]
 * - signing hash = keccak256(0x06 || rlp(tx')) where tx' empties the `signature`
 *   bytes of every entry whose `msg` is empty (newer drafts commit to lengths; this devnet does not).
 */
import { bytesToHex, fromRlp, hexToBytes, isAddress, keccak256, recoverAddress, toRlp } from "viem";
import { FRAME_MODE, SIGNATURE_SCHEME } from "./constants.js";
import type { Address, Hex, WireFrameTx } from "./types.js";

export type { Address, Hex, WireFrameTx };

export const FRAME_TX_TYPE = 0x06;
/** Bits 0-1 of `flags` (APPROVE scope); bit 2 is ATOMIC_BATCH_FLAG. */
export const APPROVE_SCOPE = { NONE: 0, PAYMENT: 1, EXECUTION: 2, EXECUTION_AND_PAYMENT: 3 } as const;
export const ATOMIC_BATCH_FLAG = 0x04;
const MAX_FRAME_FLAGS = APPROVE_SCOPE.EXECUTION_AND_PAYMENT | ATOMIC_BATCH_FLAG;
const P256_SCHEME = 2;

export const MAX_FRAMES = 64;
export const MAX_NONCE_KEYS = 16;
/** EIP-8250: nonceSeq must be < 2**64 - 1. */
export const MAX_NONCE_SEQ = (1n << 64n) - 2n;
export const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const SECP256K1_HALF_N = SECP256K1_N / 2n;
const UINT256_MAX = (1n << 256n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

export interface FrameLimits {
  execution: bigint;
  state: bigint;
}

export interface Frame {
  /** 0 DEFAULT, 1 VERIFY, 2 SENDER. */
  mode: number;
  /** Bits 0-1: approval scope; bit 2: ATOMIC_BATCH_FLAG. */
  flags: number;
  /** Always explicit in this wallet (the null "resolve to sender" form is not used). */
  target: Address;
  limits: FrameLimits;
  value: bigint;
  data: Hex;
}

export interface FrameSignature {
  /** 0 ARBITRARY, 1 SECP256K1. */
  scheme: number;
  /** "0x" (resolves to tx.sender) or a 20-byte address. */
  signer: Hex;
  /** "0x" (sign the canonical signing hash) or an explicit 32-byte digest. */
  msg: Hex;
  signature: Hex;
}

export interface Fees {
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  maxFeePerBlobGas: bigint;
}

export interface RecentRootReference {
  sourceId: Hex;
  slot: bigint;
  root: Hex;
}

export interface FrameTx {
  chainId: bigint;
  nonceKeys: bigint[];
  nonceSeq: bigint;
  sender: Address;
  frames: Frame[];
  signatures: FrameSignature[];
  fees: Fees;
  blobVersionedHashes: Hex[];
  recentRootReferences: RecentRootReference[];
}

export class FrameTxError extends Error {
  override name = "FrameTxError";
}

function fail(message: string): never {
  throw new FrameTxError(message);
}

// ---------------------------------------------------------------------------
// Byte/integer helpers (strict: no odd-length hex, no silent padding)
// ---------------------------------------------------------------------------

const EMPTY = new Uint8Array(0);
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

function toBytes(value: unknown, label: string, lengths?: readonly number[]): Uint8Array {
  if (typeof value !== "string" || !HEX_BYTES.test(value)) fail(`${label} must be 0x-prefixed, even-length hex`);
  const bytes = hexToBytes(value as Hex);
  if (lengths && !lengths.includes(bytes.length)) fail(`${label} must be ${lengths.join(" or ")} bytes, got ${bytes.length}`);
  return bytes;
}

function uintBytes(value: bigint | number, label: string): Uint8Array {
  if (typeof value === "number" && !Number.isSafeInteger(value)) fail(`${label} must be a safe integer`);
  if (typeof value !== "number" && typeof value !== "bigint") fail(`${label} must be a bigint or integer`);
  const n = BigInt(value);
  if (n < 0n || n > UINT256_MAX) fail(`${label} must be a uint256`);
  if (n === 0n) return EMPTY;
  const hex = n.toString(16);
  return hexToBytes(`0x${hex.length % 2 ? "0" : ""}${hex}`);
}

const lower = (hex: string): Hex => hex.toLowerCase() as Hex;
const quantity = (n: bigint): Hex => `0x${n.toString(16)}`;
const hexOf = (bytes: Uint8Array): Hex => bytesToHex(bytes);

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// RLP structure, raw encoding, hashes
// ---------------------------------------------------------------------------

export type RlpItem = Uint8Array | readonly RlpItem[];

/** The nested RLP list (without the type byte). `elide` empties signature bytes of empty-msg entries. */
export function toRlpList(tx: FrameTx, elide = false): RlpItem[] {
  return [
    uintBytes(tx.chainId, "chainId"),
    tx.nonceKeys.map((key, i) => uintBytes(key, `nonceKeys[${i}]`)),
    uintBytes(tx.nonceSeq, "nonceSeq"),
    toBytes(tx.sender, "sender", [20]),
    tx.frames.map((frame, i) => [
      uintBytes(frame.mode, `frames[${i}].mode`),
      uintBytes(frame.flags, `frames[${i}].flags`),
      toBytes(frame.target, `frames[${i}].target`, [20]),
      [
        uintBytes(frame.limits.execution, `frames[${i}].limits.execution`),
        uintBytes(frame.limits.state, `frames[${i}].limits.state`),
      ],
      uintBytes(frame.value, `frames[${i}].value`),
      toBytes(frame.data, `frames[${i}].data`),
    ]),
    tx.signatures.map((entry, i) => {
      const msg = toBytes(entry.msg, `signatures[${i}].msg`, [0, 32]);
      const signature = toBytes(entry.signature, `signatures[${i}].signature`);
      return [
        uintBytes(entry.scheme, `signatures[${i}].scheme`),
        toBytes(entry.signer, `signatures[${i}].signer`, [0, 20]),
        msg,
        // simulate_native.signature_hash: `if not signature[2]: signature[3] = b""`
        elide && msg.length === 0 ? EMPTY : signature,
      ];
    }),
    [
      uintBytes(tx.fees.maxPriorityFeePerGas, "fees.maxPriorityFeePerGas"),
      uintBytes(tx.fees.maxFeePerGas, "fees.maxFeePerGas"),
      uintBytes(tx.fees.maxFeePerBlobGas, "fees.maxFeePerBlobGas"),
    ],
    tx.blobVersionedHashes.map((hash, i) => toBytes(hash, `blobVersionedHashes[${i}]`, [32])),
    tx.recentRootReferences.map((ref, i) => [
      toBytes(ref.sourceId, `recentRootReferences[${i}].sourceId`, [32]),
      uintBytes(ref.slot, `recentRootReferences[${i}].slot`),
      toBytes(ref.root, `recentRootReferences[${i}].root`, [32]),
    ]),
  ];
}

function typed(list: RlpItem[]): Uint8Array {
  const body = toRlp(list, "bytes");
  const out = new Uint8Array(body.length + 1);
  out[0] = FRAME_TX_TYPE;
  out.set(body, 1);
  return out;
}

/** 0x06 || rlp(tx): the signed wire transaction bytes. */
export function encodeRawBytes(tx: FrameTx): Uint8Array {
  return typed(toRlpList(tx));
}

/** 0x06 || rlp(tx) as lowercase hex (identical to raw-transaction.hex). */
export function encodeRaw(tx: FrameTx): Hex {
  return bytesToHex(encodeRawBytes(tx));
}

/** keccak256(0x06 || rlp(tx with empty-msg signature bytes elided)): what the account and the sponsor sign. */
export function signingHash(tx: FrameTx): Hex {
  return keccak256(typed(toRlpList(tx, true)));
}

/** keccak256(0x06 || rlp(tx)): the hash returned by eth_sendFrameTransaction and used for receipts. */
export function txHash(tx: FrameTx): Hex {
  return keccak256(encodeRawBytes(tx));
}

// ---------------------------------------------------------------------------
// Raw decoding (strict and canonical: decode, re-encode, compare bytes)
// ---------------------------------------------------------------------------

type Decoded = Uint8Array | Decoded[];

function asBytes(item: Decoded | undefined, label: string, lengths?: readonly number[]): Uint8Array {
  if (!(item instanceof Uint8Array)) fail(`${label}: expected an RLP byte string`);
  if (lengths && !lengths.includes(item.length)) fail(`${label}: expected ${lengths.join(" or ")} bytes`);
  return item;
}

function asList(item: Decoded | undefined, label: string, arity?: number): Decoded[] {
  if (!Array.isArray(item)) fail(`${label}: expected an RLP list`);
  if (arity !== undefined && item.length !== arity) fail(`${label}: expected ${arity} items, got ${item.length}`);
  return item;
}

function asUint(item: Decoded | undefined, label: string): bigint {
  const bytes = asBytes(item, label);
  if (bytes.length > 32) fail(`${label}: integer wider than 256 bits`);
  if (bytes.length > 0 && bytes[0] === 0) fail(`${label}: non-canonical integer (leading zero)`);
  return bytes.length === 0 ? 0n : BigInt(bytesToHex(bytes));
}

function asSmallInt(item: Decoded | undefined, label: string): number {
  const n = asUint(item, label);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label}: too large`);
  return Number(n);
}

/** Parse 0x06 || rlp(...) back into a FrameTx; rejects any non-canonical encoding. */
export function decodeRaw(raw: Hex | Uint8Array): FrameTx {
  const bytes = typeof raw === "string" ? toBytes(raw, "raw transaction") : raw;
  if (bytes.length < 2 || bytes[0] !== FRAME_TX_TYPE) fail("raw transaction must start with type byte 0x06");
  const top = asList(fromRlp(bytes.subarray(1), "bytes") as Decoded, "transaction", 9);
  const [chainId, nonceKeys, nonceSeq, sender, frames, signatures, fees, blobs, refs] = top;
  const feeList = asList(fees, "fees", 3);
  const tx: FrameTx = {
    chainId: asUint(chainId, "chainId"),
    nonceKeys: asList(nonceKeys, "nonceKeys").map((k, i) => asUint(k, `nonceKeys[${i}]`)),
    nonceSeq: asUint(nonceSeq, "nonceSeq"),
    sender: hexOf(asBytes(sender, "sender", [20])),
    frames: asList(frames, "frames").map((item, i) => {
      const [mode, flags, target, limits, value, data] = asList(item, `frames[${i}]`, 6);
      const [execution, state] = asList(limits, `frames[${i}].limits`, 2);
      return {
        mode: asSmallInt(mode, `frames[${i}].mode`),
        flags: asSmallInt(flags, `frames[${i}].flags`),
        target: hexOf(asBytes(target, `frames[${i}].target`, [20])),
        limits: {
          execution: asUint(execution, `frames[${i}].limits.execution`),
          state: asUint(state, `frames[${i}].limits.state`),
        },
        value: asUint(value, `frames[${i}].value`),
        data: hexOf(asBytes(data, `frames[${i}].data`)),
      };
    }),
    signatures: asList(signatures, "signatures").map((item, i) => {
      const [scheme, signer, msg, signature] = asList(item, `signatures[${i}]`, 4);
      return {
        scheme: asSmallInt(scheme, `signatures[${i}].scheme`),
        signer: hexOf(asBytes(signer, `signatures[${i}].signer`, [0, 20])),
        msg: hexOf(asBytes(msg, `signatures[${i}].msg`, [0, 32])),
        signature: hexOf(asBytes(signature, `signatures[${i}].signature`)),
      };
    }),
    fees: {
      maxPriorityFeePerGas: asUint(feeList[0], "fees.maxPriorityFeePerGas"),
      maxFeePerGas: asUint(feeList[1], "fees.maxFeePerGas"),
      maxFeePerBlobGas: asUint(feeList[2], "fees.maxFeePerBlobGas"),
    },
    blobVersionedHashes: asList(blobs, "blobVersionedHashes").map((h, i) => hexOf(asBytes(h, `blobVersionedHashes[${i}]`, [32]))),
    recentRootReferences: asList(refs, "recentRootReferences").map((item, i) => {
      const [sourceId, slot, root] = asList(item, `recentRootReferences[${i}]`, 3);
      return {
        sourceId: hexOf(asBytes(sourceId, `recentRootReferences[${i}].sourceId`, [32])),
        slot: asUint(slot, `recentRootReferences[${i}].slot`),
        root: hexOf(asBytes(root, `recentRootReferences[${i}].root`, [32])),
      };
    }),
  };
  // viem's decoder accepts non-minimal length prefixes; only canonical bytes may hash to this tx.
  if (!equalBytes(encodeRawBytes(tx), bytes)) fail("non-canonical RLP encoding");
  return tx;
}

// ---------------------------------------------------------------------------
// Wire JSON (eth_sendFrameTransaction parameter)
// ---------------------------------------------------------------------------

/**
 * Exact shape produced by sponsored_swap.py wire(): lowercase hex, numeric
 * mode/flags/scheme. Recent root references are not used by this wallet.
 */
export function toWire(tx: FrameTx): WireFrameTx {
  toRlpList(tx); // never emit something the codec rejects
  if (tx.recentRootReferences.length > 0) fail("recent root references are not supported by this wallet");
  return {
    chainId: quantity(tx.chainId),
    nonceKeys: tx.nonceKeys.map(quantity),
    nonceSeq: quantity(tx.nonceSeq),
    sender: lower(tx.sender),
    frames: tx.frames.map((frame) => ({
      mode: frame.mode,
      flags: frame.flags,
      target: lower(frame.target),
      limits: { execution: quantity(frame.limits.execution), state: quantity(frame.limits.state) },
      value: quantity(frame.value),
      data: lower(frame.data),
    })),
    signatures: tx.signatures.map((entry) => ({
      scheme: entry.scheme,
      signer: lower(entry.signer),
      msg: lower(entry.msg),
      signature: lower(entry.signature),
    })),
    fees: {
      maxPriorityFeePerGas: quantity(tx.fees.maxPriorityFeePerGas),
      maxFeePerGas: quantity(tx.fees.maxFeePerGas),
      maxFeePerBlobGas: quantity(tx.fees.maxFeePerBlobGas),
    },
    blobVersionedHashes: tx.blobVersionedHashes.map(lower),
    recentRootReferences: [],
  };
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string, required: readonly string[], optional: readonly string[] = []): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  const record = value as JsonObject;
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) fail(`${label}.${key} is not an allowed field`);
  }
  for (const key of required) if (!(key in record)) fail(`${label}.${key} is required`);
  return record;
}

function array(value: unknown, label: string, max?: number): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (max !== undefined && value.length > max) fail(`${label} has more than ${max} items`);
  return value;
}

function parseQuantity(value: unknown, label: string, max: bigint = UINT256_MAX): bigint {
  if (typeof value !== "string" || !QUANTITY.test(value)) fail(`${label} must be a minimal 0x hex quantity`);
  const n = BigInt(value);
  if (n > max) fail(`${label} is out of range`);
  return n;
}

function parseSmallInt(value: unknown, label: string, valid: (n: number) => boolean): number {
  let n: number | undefined;
  if (typeof value === "number" && Number.isSafeInteger(value)) n = value;
  else if (typeof value === "string" && QUANTITY.test(value)) {
    const big = BigInt(value);
    if (big <= BigInt(Number.MAX_SAFE_INTEGER)) n = Number(big);
  }
  if (n === undefined || !valid(n)) fail(`${label} is not a valid value`);
  return n;
}

function parseAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail(`${label} must be a 20-byte address`);
  // Mixed case must be a valid EIP-55 checksum (catches typos); output is always lowercase.
  if (!isAddress(value, { strict: true })) fail(`${label} has an invalid EIP-55 checksum`);
  return lower(value);
}

function parseBytes(value: unknown, label: string, lengths?: readonly number[]): Hex {
  return lower(hexOf(toBytes(value, label, lengths)));
}

const FRAME_KEYS = ["mode", "flags", "target", "limits", "value", "data"] as const;
const SIGNATURE_KEYS = ["scheme", "signer", "msg", "signature"] as const;
const FEE_KEYS = ["maxPriorityFeePerGas", "maxFeePerGas", "maxFeePerBlobGas"] as const;
const TX_KEYS = ["chainId", "nonceKeys", "nonceSeq", "sender", "frames", "signatures", "fees", "blobVersionedHashes"] as const;

const isMode = (n: number) => n === FRAME_MODE.DEFAULT || n === FRAME_MODE.VERIFY || n === FRAME_MODE.SENDER;
const isFlags = (n: number) => n >= 0 && n <= MAX_FRAME_FLAGS;
const isScheme = (n: number) => n === SIGNATURE_SCHEME.ARBITRARY || n === SIGNATURE_SCHEME.SECP256K1 || n === P256_SCHEME;

/**
 * Strict parser for the eth_sendFrameTransaction JSON (transaction.json shape):
 * minimal hex quantities, even-length byte hex, 20-byte addresses (mixed case
 * must checksum), known fields only, explicit frame targets, no recent roots.
 * Output hex is lowercase.
 */
export function fromWire(json: unknown): FrameTx {
  const t = object(json, "tx", TX_KEYS, ["recentRootReferences"]);
  const fees = object(t.fees, "fees", FEE_KEYS);
  if (array(t.recentRootReferences ?? [], "recentRootReferences").length > 0) fail("recentRootReferences must be empty");
  const tx: FrameTx = {
    chainId: parseQuantity(t.chainId, "chainId"),
    nonceKeys: array(t.nonceKeys, "nonceKeys", MAX_NONCE_KEYS).map((k, i) => parseQuantity(k, `nonceKeys[${i}]`)),
    nonceSeq: parseQuantity(t.nonceSeq, "nonceSeq"),
    sender: parseAddress(t.sender, "sender"),
    frames: array(t.frames, "frames", MAX_FRAMES).map((value, i) => {
      const f = object(value, `frames[${i}]`, FRAME_KEYS);
      const limits = object(f.limits, `frames[${i}].limits`, ["execution", "state"]);
      return {
        mode: parseSmallInt(f.mode, `frames[${i}].mode`, isMode),
        flags: parseSmallInt(f.flags, `frames[${i}].flags`, isFlags),
        target: parseAddress(f.target, `frames[${i}].target`),
        limits: {
          execution: parseQuantity(limits.execution, `frames[${i}].limits.execution`, UINT64_MAX),
          state: parseQuantity(limits.state, `frames[${i}].limits.state`, UINT64_MAX),
        },
        value: parseQuantity(f.value, `frames[${i}].value`),
        data: parseBytes(f.data, `frames[${i}].data`),
      };
    }),
    signatures: array(t.signatures, "signatures", MAX_FRAMES).map((value, i) => {
      const s = object(value, `signatures[${i}]`, SIGNATURE_KEYS);
      return {
        scheme: parseSmallInt(s.scheme, `signatures[${i}].scheme`, isScheme),
        signer: s.signer === "0x" ? "0x" : parseAddress(s.signer, `signatures[${i}].signer`),
        msg: parseBytes(s.msg, `signatures[${i}].msg`, [0, 32]),
        signature: parseBytes(s.signature, `signatures[${i}].signature`),
      };
    }),
    fees: {
      maxPriorityFeePerGas: parseQuantity(fees.maxPriorityFeePerGas, "fees.maxPriorityFeePerGas"),
      maxFeePerGas: parseQuantity(fees.maxFeePerGas, "fees.maxFeePerGas"),
      maxFeePerBlobGas: parseQuantity(fees.maxFeePerBlobGas, "fees.maxFeePerBlobGas"),
    },
    blobVersionedHashes: array(t.blobVersionedHashes, "blobVersionedHashes", MAX_FRAMES).map((h, i) =>
      parseBytes(h, `blobVersionedHashes[${i}]`, [32]),
    ),
    recentRootReferences: [],
  };
  const violation = nonceViolation(tx);
  if (violation) fail(violation);
  return tx;
}

/** EIP-8250 static nonce validity, as the sidecar enforces before admission. */
export function nonceViolation(tx: Pick<FrameTx, "nonceKeys" | "nonceSeq">): string | null {
  const keys = tx.nonceKeys;
  if (keys.length === 0 || keys.length > MAX_NONCE_KEYS) return `nonceKeys count must be between 1 and ${MAX_NONCE_KEYS}`;
  for (let i = 1; i < keys.length; i++) {
    if ((keys[i - 1] as bigint) >= (keys[i] as bigint)) return "nonceKeys must be strictly increasing";
  }
  if (keys.length > 1 && keys[0] === 0n) return "nonce key 0 is only valid as the sole nonce key";
  if (tx.nonceSeq < 0n || tx.nonceSeq > MAX_NONCE_SEQ) return "nonceSeq must be < 2**64 - 1";
  return null;
}

/**
 * ethrex returns a different JSON shape for mined frame transactions: frames use
 * `to`, `gasLimit`, `stateLimit` and hex mode/flags; signatures use hex `scheme`
 * and `signer: null`; fees are flattened. Use this for eth_getTransactionByHash.
 */
export function fromEthrexRpcTransaction(json: unknown): FrameTx {
  if (typeof json !== "object" || json === null) fail("transaction must be an object");
  const t = json as JsonObject;
  if (t.type !== "0x6") fail("not a type-6 frame transaction");
  return {
    chainId: parseQuantity(t.chainId, "chainId"),
    nonceKeys: array(t.nonceKeys, "nonceKeys", MAX_NONCE_KEYS).map((k, i) => parseQuantity(k, `nonceKeys[${i}]`)),
    nonceSeq: parseQuantity(t.nonceSeq, "nonceSeq"),
    sender: parseAddress(t.sender, "sender"),
    frames: array(t.frames, "frames", MAX_FRAMES).map((value, i) => {
      const f = object(value, `frames[${i}]`, ["mode", "flags", "to", "gasLimit", "stateLimit", "value", "data"]);
      return {
        mode: parseSmallInt(f.mode, `frames[${i}].mode`, isMode),
        flags: parseSmallInt(f.flags, `frames[${i}].flags`, isFlags),
        target: parseAddress(f.to, `frames[${i}].to`),
        limits: {
          execution: parseQuantity(f.gasLimit, `frames[${i}].gasLimit`, UINT64_MAX),
          state: parseQuantity(f.stateLimit, `frames[${i}].stateLimit`, UINT64_MAX),
        },
        value: parseQuantity(f.value, `frames[${i}].value`),
        data: parseBytes(f.data, `frames[${i}].data`),
      };
    }),
    signatures: array(t.signatures, "signatures").map((value, i) => {
      const s = object(value, `signatures[${i}]`, SIGNATURE_KEYS);
      return {
        scheme: parseSmallInt(s.scheme, `signatures[${i}].scheme`, isScheme),
        signer: s.signer === null ? "0x" : parseAddress(s.signer, `signatures[${i}].signer`),
        msg: parseBytes(s.msg, `signatures[${i}].msg`, [0, 32]),
        signature: parseBytes(s.signature, `signatures[${i}].signature`),
      };
    }),
    fees: {
      maxPriorityFeePerGas: parseQuantity(t.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
      maxFeePerGas: parseQuantity(t.maxFeePerGas, "maxFeePerGas"),
      maxFeePerBlobGas: parseQuantity(t.maxFeePerBlobGas, "maxFeePerBlobGas"),
    },
    blobVersionedHashes: array(t.blobVersionedHashes ?? [], "blobVersionedHashes").map((h, i) =>
      parseBytes(h, `blobVersionedHashes[${i}]`, [32]),
    ),
    recentRootReferences: array(t.recentRootReferences ?? [], "recentRootReferences").map((value, i) => {
      const r = object(value, `recentRootReferences[${i}]`, ["sourceId", "slot", "root"]);
      return {
        sourceId: parseBytes(r.sourceId, `recentRootReferences[${i}].sourceId`, [32]),
        slot: parseQuantity(r.slot, `recentRootReferences[${i}].slot`, UINT64_MAX),
        root: parseBytes(r.root, `recentRootReferences[${i}].root`, [32]),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// SECP256K1 signature entries (sponsor): parity || r || s
// ---------------------------------------------------------------------------

export interface Secp256k1Parts {
  yParity: 0 | 1;
  r: bigint;
  s: bigint;
}

const word = (n: bigint): string => n.toString(16).padStart(64, "0");

/** Range rules from the sidecar's validateSignature: v in {0,1}, 0 < r < n, 0 < s <= n/2 (low-s). */
function secp256k1PartsViolation({ yParity, r, s }: Secp256k1Parts): string | null {
  if (yParity !== 0 && yParity !== 1) return "parity must be 0 or 1";
  if (!(r > 0n && r < SECP256K1_N)) return "r out of range";
  if (!(s > 0n && s <= SECP256K1_HALF_N)) return "s must be low-s (0 < s <= n/2)";
  return null;
}

/** Frame SECP256K1 signature bytes: parity (1 byte, 0/1) || r (32) || s (32) = 65 bytes. */
export function encodeSecp256k1FrameSignature(parts: Secp256k1Parts): Hex {
  const violation = secp256k1PartsViolation(parts);
  if (violation) fail(violation);
  return `0x0${parts.yParity}${word(parts.r)}${word(parts.s)}`;
}

/** Sponsor signature bytes parity || r || s from its parts (r/s as bigint or 32-byte hex). */
export function sponsorSignatureBytes(parity: number, r: bigint | Hex, s: bigint | Hex): Hex {
  if (parity !== 0 && parity !== 1) fail("parity must be 0 or 1");
  return encodeSecp256k1FrameSignature({ yParity: parity, r: BigInt(r), s: BigInt(s) });
}

/** Strict inverse of encodeSecp256k1FrameSignature. */
export function decodeSecp256k1FrameSignature(signature: Hex): Secp256k1Parts {
  const bytes = toBytes(signature, "SECP256K1 signature", [65]);
  const hex = bytesToHex(bytes).slice(2);
  const parity = bytes[0] as number;
  if (parity !== 0 && parity !== 1) fail("parity must be 0 or 1");
  const parts: Secp256k1Parts = { yParity: parity, r: BigInt(`0x${hex.slice(2, 66)}`), s: BigInt(`0x${hex.slice(66, 130)}`) };
  const violation = secp256k1PartsViolation(parts);
  if (violation) fail(violation);
  return parts;
}

/** Convert an Ethereum r || s || v signature (v = 27/28 or 0/1) into the frame parity || r || s layout. */
export function rsvToFrameSignature(rsv: Hex): Hex {
  const bytes = toBytes(rsv, "r||s||v signature", [65]);
  let v = bytes[64] as number;
  if (v === 27 || v === 28) v -= 27;
  if (v !== 0 && v !== 1) fail("unsupported signature parity");
  const hex = bytesToHex(bytes).slice(2);
  return encodeSecp256k1FrameSignature({ yParity: v, r: BigInt(`0x${hex.slice(0, 64)}`), s: BigInt(`0x${hex.slice(64, 128)}`) });
}

export interface SignatureCheck {
  ok: boolean;
  reason?: string;
  /** Resolved signer (entry signer, or tx.sender when empty). */
  signer?: Address;
  /** Recovered address for SECP256K1 entries. */
  recovered?: Address;
  /** Digest the entry signs (the signing hash when msg is empty). */
  digest?: Hex;
}

/**
 * Protocol-level validation of one signature entry. ARBITRARY entries pass iff the
 * signer is empty: their real check is the account's VERIFY frame (SLH-DSA in
 * QuantumAccount.validateFrame). P256 is not used by this wallet.
 */
export async function verifySignatureEntry(tx: FrameTx, index: number, digestOverride?: Hex): Promise<SignatureCheck> {
  const entry = tx.signatures[index];
  if (!entry) return { ok: false, reason: `no signature entry ${index}` };
  const msg = lower(entry.msg);
  let digest: Hex;
  if (msg === "0x") digest = digestOverride ?? signingHash(tx);
  else if (!/^0x[0-9a-f]{64}$/.test(msg)) return { ok: false, reason: "msg must be empty or 32 bytes" };
  else if (/^0x0{64}$/.test(msg)) return { ok: false, reason: "explicit zero digest is invalid" };
  else digest = msg;
  let signer: Address;
  if (entry.signer === "0x") signer = lower(tx.sender);
  else if (/^0x[0-9a-fA-F]{40}$/.test(entry.signer)) signer = lower(entry.signer);
  else return { ok: false, reason: "signer must be empty or 20 bytes" };

  if (entry.scheme === SIGNATURE_SCHEME.ARBITRARY) {
    return entry.signer === "0x"
      ? { ok: true, signer, digest }
      : { ok: false, reason: "ARBITRARY entries must have an empty signer", signer, digest };
  }
  if (entry.scheme !== SIGNATURE_SCHEME.SECP256K1) return { ok: false, reason: `scheme ${entry.scheme} not supported here`, signer, digest };
  let parts: Secp256k1Parts;
  try {
    parts = decodeSecp256k1FrameSignature(entry.signature);
  } catch (error) {
    return { ok: false, reason: (error as Error).message, signer, digest };
  }
  let recovered: Address;
  try {
    recovered = lower(
      await recoverAddress({ hash: digest, signature: { r: `0x${word(parts.r)}`, s: `0x${word(parts.s)}`, yParity: parts.yParity } }),
    );
  } catch {
    return { ok: false, reason: "signature does not recover", signer, digest };
  }
  return recovered === signer
    ? { ok: true, signer, recovered, digest }
    : { ok: false, reason: "recovered address does not match signer", signer, recovered, digest };
}

/** Minimal signer interface satisfied by a viem LocalAccount (privateKeyToAccount). */
export interface HashSigner {
  address: Address;
  /** Sign a raw 32-byte hash (no EIP-191 prefix); returns r || s || v (65 bytes). */
  sign(args: { hash: Hex }): Promise<Hex>;
}

/**
 * Server-side co-signing (simulate_native.sign_payer): sign the signing hash with
 * the sponsor key and place parity || r || s into the SECP256K1 entry. Empty-msg
 * signature bytes are elided from the signing hash, so this never invalidates the
 * account's PQ signature (asserted).
 */
export async function cosignAsSponsor(tx: FrameTx, signer: HashSigner, index = 1): Promise<FrameTx> {
  const entry = tx.signatures[index];
  if (!entry) fail(`no signature entry ${index}`);
  if (entry.scheme !== SIGNATURE_SCHEME.SECP256K1) fail(`signature entry ${index} is not SECP256K1`);
  if (entry.msg !== "0x") fail(`signature entry ${index} must sign the canonical hash (empty msg)`);
  if (lower(entry.signer) !== lower(signer.address)) fail(`signature entry ${index} signer is not the sponsor`);
  const digest = signingHash(tx);
  const signature = rsvToFrameSignature(await signer.sign({ hash: digest }));
  const signed: FrameTx = { ...tx, signatures: tx.signatures.map((s, i) => (i === index ? { ...s, signature } : s)) };
  if (signingHash(signed) !== digest) fail("co-signing changed the signing hash");
  const check = await verifySignatureEntry(signed, index, digest);
  if (!check.ok) fail(`sponsor signature self-check failed: ${check.reason}`);
  return signed;
}

/** Sum of execution + state limits over all frames (the sponsor's worst-case gas). */
export function totalFrameGasLimit(tx: FrameTx): bigint {
  return tx.frames.reduce((sum, f) => sum + f.limits.execution + f.limits.state, 0n);
}
