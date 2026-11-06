/**
 * The guarded Uniswap v4 swap calldata and the 5-frame sponsored swap of
 * demo/sponsored_swap.py, generalised to both pool directions.
 *
 * - ERC20 approve(address,uint256)                     0x095ea7b3
 * - Permit2 approve(address,address,uint160,uint48)    0x87517c45
 * - UniversalRouter execute(bytes,bytes[],uint256)     0x3593564c
 *     commands 0x10 (V4_SWAP); input = abi.encode(bytes actions, bytes[] params)
 *     actions 0x06 SWAP_EXACT_IN_SINGLE, 0x0c SETTLE_ALL, 0x0f TAKE_ALL
 *     params[0] = ExactInputSingleParams of the pinned v4-periphery (a7af5b34, with minHopPriceX36)
 *     params[1] = (currencyIn, amountIn), params[2] = (currencyOut, minOut)
 * - QuantumAccount validateFrame()                     0x634b01e8
 *
 * Decoders are strict: decode, re-encode canonically, require byte equality.
 */
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, isAddress, parseAbi } from "viem";
import {
  FEES,
  FRAME_LIMITS,
  FRAME_MODE,
  SIGNATURE_BYTES,
  SIGNATURE_SCHEME,
  SPONSOR_SIGNATURE_BYTES,
  UNIVERSAL_ROUTER_V4_SWAP,
  V4_ACTIONS_EXACT_IN_SINGLE,
  VALIDATE_FRAME_SELECTOR,
} from "./constants.js";
import { APPROVE_SCOPE, ATOMIC_BATCH_FLAG, type Fees, type Frame, type FrameLimits, type FrameTx } from "./frameTx.js";
import type { Address, Hex, PoolKey, PublicConfig, SwapDirection } from "./types.js";

export class SwapCodecError extends Error {
  override name = "SwapCodecError";
}

function fail(message: string): never {
  throw new SwapCodecError(message);
}

const lower = (value: string): Hex => value.toLowerCase() as Hex;
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) fail(`${label} must be a valid address`);
  return lower(value);
}

function uint(value: bigint, bits: number, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << BigInt(bits)) fail(`${label} must be a uint${bits}`);
  return value;
}

function canonical(data: Hex, reencoded: Hex, label: string): void {
  if (lower(data) !== lower(reencoded)) fail(`${label}: non-canonical ABI encoding`);
}

/** Calldata sizes of the template: the approvals take only static arguments and the swap carries no hook data. */
const TEMPLATE_BYTES = { erc20Approve: 68, permit2Approve: 132, guardedSwap: 1124 } as const;

/**
 * Checked before decoding: the generic ABI decoder follows offsets taken from the data, and
 * overlapping dynamic elements make it materialise far more bytes than it was given.
 */
function templateSize(data: Hex, bytes: number, label: string): void {
  if (data.length !== 2 + 2 * bytes) fail(`${label}: non-canonical ABI encoding (expected ${bytes} bytes, got ${(data.length - 2) / 2})`);
}

// ---------------------------------------------------------------------------
// Calldata codecs
// ---------------------------------------------------------------------------

const ERC20_APPROVE_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const PERMIT2_APPROVE_ABI = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const EXECUTE_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;
const EXACT_INPUT_SINGLE_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "poolKey", type: "tuple", components: POOL_KEY_COMPONENTS },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "minHopPriceX36", type: "uint256" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;
const CURRENCY_AND_AMOUNT = [{ type: "address" }, { type: "uint256" }] as const;
const ACTIONS_AND_PARAMS = [{ type: "bytes" }, { type: "bytes[]" }] as const;

export interface Erc20Approve {
  spender: Address;
  amount: bigint;
}

export function encodeErc20Approve({ spender, amount }: Erc20Approve): Hex {
  return encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [address(spender, "spender"), uint(amount, 256, "amount")] });
}

export function decodeErc20Approve(data: Hex): Erc20Approve {
  templateSize(data, TEMPLATE_BYTES.erc20Approve, "ERC20 approve");
  const { args } = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data });
  const out = { spender: lower(args[0]), amount: args[1] };
  canonical(data, encodeErc20Approve(out), "ERC20 approve");
  return out;
}

export interface Permit2Approve {
  token: Address;
  spender: Address;
  amount: bigint;
  expiration: bigint;
}

export function encodePermit2Approve({ token, spender, amount, expiration }: Permit2Approve): Hex {
  return encodeFunctionData({
    abi: PERMIT2_APPROVE_ABI,
    functionName: "approve",
    args: [address(token, "token"), address(spender, "spender"), uint(amount, 160, "amount"), Number(uint(expiration, 48, "expiration"))],
  });
}

export function decodePermit2Approve(data: Hex): Permit2Approve {
  templateSize(data, TEMPLATE_BYTES.permit2Approve, "Permit2 approve");
  const { args } = decodeFunctionData({ abi: PERMIT2_APPROVE_ABI, data });
  const out = { token: lower(args[0]), spender: lower(args[1]), amount: args[2], expiration: BigInt(args[3]) };
  canonical(data, encodePermit2Approve(out), "Permit2 approve");
  return out;
}

function checkedPoolKey(key: PoolKey): PoolKey {
  if (!Number.isInteger(key.fee) || key.fee < 0 || key.fee >= 1 << 24) fail("poolKey.fee must be a uint24");
  if (!Number.isInteger(key.tickSpacing) || key.tickSpacing < -(1 << 23) || key.tickSpacing >= 1 << 23) fail("poolKey.tickSpacing must be an int24");
  return {
    currency0: address(key.currency0, "poolKey.currency0"),
    currency1: address(key.currency1, "poolKey.currency1"),
    fee: key.fee,
    tickSpacing: key.tickSpacing,
    hooks: address(key.hooks, "poolKey.hooks"),
  };
}

export interface GuardedSwap {
  poolKey: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
  /** Per-hop price floor of the pinned periphery; the wallet signs 0. */
  minHopPriceX36?: bigint;
  /** The guard ignores hook data; the wallet signs 0x. */
  hookData?: Hex;
}

export interface DecodedGuardedSwap extends Required<GuardedSwap> {
  tokenIn: Address;
  tokenOut: Address;
}

export function swapTokens(key: PoolKey, zeroForOne: boolean): { tokenIn: Address; tokenOut: Address } {
  return zeroForOne
    ? { tokenIn: lower(key.currency0), tokenOut: lower(key.currency1) }
    : { tokenIn: lower(key.currency1), tokenOut: lower(key.currency0) };
}

/** UniversalRouter execute(0x10, [abi.encode(0x060c0f, [swap, settle, take])], deadline). */
export function encodeGuardedSwap(swap: GuardedSwap): Hex {
  const key = checkedPoolKey(swap.poolKey);
  const { tokenIn, tokenOut } = swapTokens(key, swap.zeroForOne);
  const params = [
    encodeAbiParameters(EXACT_INPUT_SINGLE_PARAMS, [
      {
        poolKey: key,
        zeroForOne: swap.zeroForOne,
        amountIn: uint(swap.amountIn, 128, "amountIn"),
        amountOutMinimum: uint(swap.amountOutMinimum, 128, "amountOutMinimum"),
        minHopPriceX36: uint(swap.minHopPriceX36 ?? 0n, 256, "minHopPriceX36"),
        hookData: swap.hookData ?? "0x",
      },
    ]),
    encodeAbiParameters(CURRENCY_AND_AMOUNT, [tokenIn, swap.amountIn]),
    encodeAbiParameters(CURRENCY_AND_AMOUNT, [tokenOut, swap.amountOutMinimum]),
  ];
  const input = encodeAbiParameters(ACTIONS_AND_PARAMS, [V4_ACTIONS_EXACT_IN_SINGLE, params]);
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: "execute",
    args: [UNIVERSAL_ROUTER_V4_SWAP, [input], uint(swap.deadline, 256, "deadline")],
  });
}

/**
 * Decode and require the exact guarded-swap template: one V4_SWAP command, actions
 * SWAP_EXACT_IN_SINGLE/SETTLE_ALL/TAKE_ALL, settle = (input currency, amountIn),
 * take = (output currency, amountOutMinimum). The router pays/takes for its
 * msgSender() (the account): there is no recipient field to redirect. Only the
 * wallet's encoding without hook data (exactly 1,124 bytes) is accepted.
 */
export function decodeGuardedSwap(data: Hex): DecodedGuardedSwap {
  templateSize(data, TEMPLATE_BYTES.guardedSwap, "guarded swap");
  const { args } = decodeFunctionData({ abi: EXECUTE_ABI, data });
  const [commands, inputs, deadline] = args;
  if (lower(commands) !== UNIVERSAL_ROUTER_V4_SWAP) fail(`commands must be ${UNIVERSAL_ROUTER_V4_SWAP} (V4_SWAP)`);
  if (inputs.length !== 1) fail("expected exactly one router input");
  const [actions, params] = decodeAbiParameters(ACTIONS_AND_PARAMS, inputs[0] as Hex);
  if (lower(actions) !== V4_ACTIONS_EXACT_IN_SINGLE) fail(`actions must be ${V4_ACTIONS_EXACT_IN_SINGLE}`);
  if (params.length !== 3) fail("expected exactly three action params");
  const [p] = decodeAbiParameters(EXACT_INPUT_SINGLE_PARAMS, params[0] as Hex);
  const [settleCurrency, settleAmount] = decodeAbiParameters(CURRENCY_AND_AMOUNT, params[1] as Hex);
  const [takeCurrency, takeAmount] = decodeAbiParameters(CURRENCY_AND_AMOUNT, params[2] as Hex);
  const poolKey: PoolKey = {
    currency0: lower(p.poolKey.currency0),
    currency1: lower(p.poolKey.currency1),
    fee: p.poolKey.fee,
    tickSpacing: p.poolKey.tickSpacing,
    hooks: lower(p.poolKey.hooks),
  };
  const { tokenIn, tokenOut } = swapTokens(poolKey, p.zeroForOne);
  if (!sameAddress(settleCurrency, tokenIn) || settleAmount !== p.amountIn) fail("SETTLE_ALL must be (input currency, amountIn)");
  if (!sameAddress(takeCurrency, tokenOut) || takeAmount !== p.amountOutMinimum) fail("TAKE_ALL must be (output currency, amountOutMinimum)");
  const decoded: DecodedGuardedSwap = {
    poolKey,
    zeroForOne: p.zeroForOne,
    amountIn: p.amountIn,
    amountOutMinimum: p.amountOutMinimum,
    deadline,
    minHopPriceX36: p.minHopPriceX36,
    hookData: lower(p.hookData),
    tokenIn,
    tokenOut,
  };
  canonical(data, encodeGuardedSwap(decoded), "guarded swap");
  return decoded;
}

// ---------------------------------------------------------------------------
// The 5-frame sponsored swap transaction
// ---------------------------------------------------------------------------

/** What the swap needs from the public config (PublicConfig satisfies it). */
export type SwapConfig = Pick<PublicConfig, "chainId" | "contracts" | "poolKey" | "sponsor">;

export interface BuildSwapParams {
  config: SwapConfig;
  /** The QuantumAccount: tx.sender and frame-0 target. */
  account: Address;
  /** Linear account nonce (nonceKeys = [0]); eth_getTransactionCount(account, "latest"). */
  nonce: bigint;
  direction: SwapDirection;
  amountIn: bigint;
  minOut: bigint;
  /** Unix seconds: both the Permit2 expiration and the router deadline. */
  deadline: bigint;
  /** Defaults to config.sponsor. */
  sponsor?: Address;
}

const zeros = (length: number): Hex => `0x${"00".repeat(length)}`;

export function tokensFor(config: SwapConfig, direction: SwapDirection): { tokenIn: Address; tokenOut: Address } {
  const usdc = lower(config.contracts.demoUSDC);
  const weth = lower(config.contracts.weth9);
  return direction === "USDC_TO_WETH" ? { tokenIn: usdc, tokenOut: weth } : { tokenIn: weth, tokenOut: usdc };
}

function zeroForOneFor(key: PoolKey, tokenIn: Address): boolean {
  if (sameAddress(tokenIn, key.currency0)) return true;
  if (sameAddress(tokenIn, key.currency1)) return false;
  return fail("input token is not a currency of the pool");
}

/**
 * Build the unsigned swap exactly like sponsored_swap.py, with zero-filled
 * signature placeholders (7,856-byte ARBITRARY entry, 65-byte SECP256K1 sponsor
 * entry). Placeholders do not affect the signing hash (empty msg elides them).
 */
export function buildSwapTx(p: BuildSwapParams): FrameTx {
  const sponsorValue = p.sponsor ?? p.config.sponsor;
  if (!sponsorValue) fail("this server has no sponsor configured");
  const key = checkedPoolKey(p.config.poolKey);
  const { tokenIn } = tokensFor(p.config, p.direction);
  const zeroForOne = zeroForOneFor(key, tokenIn);
  const account = address(p.account, "account");
  const sponsor = address(sponsorValue, "sponsor");
  const permit2 = address(p.config.contracts.permit2, "permit2");
  const router = address(p.config.contracts.universalRouter, "universalRouter");
  if (sponsor === account) fail("sponsor must differ from the account");
  const frame = (mode: number, flags: number, target: Address, limits: FrameLimits, data: Hex): Frame => ({
    mode,
    flags,
    target,
    limits: { execution: limits.execution, state: limits.state },
    value: 0n,
    data,
  });
  return {
    chainId: BigInt(p.config.chainId),
    nonceKeys: [0n],
    nonceSeq: uint(p.nonce, 64, "nonce"),
    sender: account,
    frames: [
      frame(FRAME_MODE.VERIFY, APPROVE_SCOPE.EXECUTION, account, FRAME_LIMITS.accountVerify, VALIDATE_FRAME_SELECTOR),
      frame(FRAME_MODE.VERIFY, APPROVE_SCOPE.PAYMENT, sponsor, FRAME_LIMITS.sponsorVerify, "0x"),
      frame(FRAME_MODE.SENDER, ATOMIC_BATCH_FLAG, tokenIn, FRAME_LIMITS.tokenApprove, encodeErc20Approve({ spender: permit2, amount: p.amountIn })),
      frame(
        FRAME_MODE.SENDER,
        ATOMIC_BATCH_FLAG,
        permit2,
        FRAME_LIMITS.permit2Approve,
        encodePermit2Approve({ token: tokenIn, spender: router, amount: p.amountIn, expiration: p.deadline }),
      ),
      frame(
        FRAME_MODE.SENDER,
        0,
        router,
        FRAME_LIMITS.swap,
        encodeGuardedSwap({ poolKey: key, zeroForOne, amountIn: p.amountIn, amountOutMinimum: p.minOut, deadline: p.deadline }),
      ),
    ],
    signatures: [
      { scheme: SIGNATURE_SCHEME.ARBITRARY, signer: "0x", msg: "0x", signature: zeros(SIGNATURE_BYTES) },
      { scheme: SIGNATURE_SCHEME.SECP256K1, signer: sponsor, msg: "0x", signature: zeros(SPONSOR_SIGNATURE_BYTES) },
    ],
    fees: { ...FEES } satisfies Fees,
    blobVersionedHashes: [],
    recentRootReferences: [],
  };
}

export interface ParsedSwap {
  direction: SwapDirection;
  amountIn: bigint;
  minOut: bigint;
  deadline: bigint;
  account: Address;
  nonce: bigint;
  sponsor: Address;
  tokenIn: Address;
  tokenOut: Address;
}

/**
 * Structural parse of a (signed or unsigned) sponsored swap against the template
 * and the config: five frames with the template's modes/flags/targets/zero value,
 * decodable calldata whose amounts, tokens, spender and deadline agree across
 * frames, the manifest pool key, and the two signature entries. Does NOT check
 * gas limits, fees, live chain state or any signature: callers that need the
 * exact template rebuild it with buildSwapTx and compare bytes (server policy).
 */
export function parseSwapTx(tx: FrameTx, config: Pick<PublicConfig, "chainId" | "contracts" | "poolKey">): ParsedSwap {
  if (tx.chainId !== BigInt(config.chainId)) fail("chainId does not match the deployment");
  if (tx.nonceKeys.length !== 1 || tx.nonceKeys[0] !== 0n) fail("nonceKeys must be [0]");
  if (tx.blobVersionedHashes.length !== 0 || tx.recentRootReferences.length !== 0) fail("blob hashes and recent roots must be empty");
  if (tx.frames.length !== 5) fail("expected exactly 5 frames");
  const [verify, pay, approve, permit, swap] = tx.frames as [Frame, Frame, Frame, Frame, Frame];
  const account = lower(tx.sender);
  const expectFrame = (f: Frame, i: number, mode: number, flags: number, target: string) => {
    if (f.mode !== mode || f.flags !== flags) fail(`frame ${i} must be mode ${mode} with flags ${flags}`);
    if (!sameAddress(f.target, target)) fail(`frame ${i} has the wrong target`);
    if (f.value !== 0n) fail(`frame ${i} must carry zero value`);
  };
  expectFrame(verify, 0, FRAME_MODE.VERIFY, APPROVE_SCOPE.EXECUTION, account);
  if (lower(verify.data) !== VALIDATE_FRAME_SELECTOR) fail("frame 0 must call validateFrame()");
  const sponsor = lower(pay.target);
  if (sponsor === account) fail("sponsor must differ from the account");
  expectFrame(pay, 1, FRAME_MODE.VERIFY, APPROVE_SCOPE.PAYMENT, sponsor);
  if (pay.data !== "0x") fail("frame 1 data must be empty");

  const router = config.contracts.universalRouter;
  const permit2 = config.contracts.permit2;
  const decoded = decodeGuardedSwap(swap.data);
  const expectedKey = checkedPoolKey(config.poolKey);
  for (const field of ["currency0", "currency1", "hooks"] as const) {
    if (!sameAddress(decoded.poolKey[field], expectedKey[field])) fail(`poolKey.${field} does not match the deployment`);
  }
  if (decoded.poolKey.fee !== expectedKey.fee || decoded.poolKey.tickSpacing !== expectedKey.tickSpacing) {
    fail("poolKey fee/tickSpacing does not match the deployment");
  }
  if (decoded.minHopPriceX36 !== 0n || decoded.hookData !== "0x") fail("minHopPriceX36 must be 0 and hookData empty");
  let direction: SwapDirection;
  if (sameAddress(decoded.tokenIn, config.contracts.demoUSDC) && sameAddress(decoded.tokenOut, config.contracts.weth9)) direction = "USDC_TO_WETH";
  else if (sameAddress(decoded.tokenIn, config.contracts.weth9) && sameAddress(decoded.tokenOut, config.contracts.demoUSDC)) direction = "WETH_TO_USDC";
  else fail("swap must be between dUSDC and WETH");
  expectFrame(approve, 2, FRAME_MODE.SENDER, ATOMIC_BATCH_FLAG, decoded.tokenIn);
  expectFrame(permit, 3, FRAME_MODE.SENDER, ATOMIC_BATCH_FLAG, permit2);
  expectFrame(swap, 4, FRAME_MODE.SENDER, 0, router);
  const erc20 = decodeErc20Approve(approve.data);
  if (!sameAddress(erc20.spender, permit2) || erc20.amount !== decoded.amountIn) fail("frame 2 must approve exactly amountIn to Permit2");
  const p2 = decodePermit2Approve(permit.data);
  if (!sameAddress(p2.token, decoded.tokenIn) || !sameAddress(p2.spender, router)) fail("frame 3 must approve the input token to the router");
  if (p2.amount !== decoded.amountIn || p2.expiration !== decoded.deadline) fail("frame 3 amount/expiration must equal amountIn/deadline");

  if (tx.signatures.length !== 2) fail("expected exactly 2 signature entries");
  const [pq, sp] = tx.signatures as [FrameTx["signatures"][number], FrameTx["signatures"][number]];
  if (pq.scheme !== SIGNATURE_SCHEME.ARBITRARY || pq.signer !== "0x" || pq.msg !== "0x") fail("signature 0 must be ARBITRARY with empty signer and msg");
  if ((pq.signature.length - 2) / 2 !== SIGNATURE_BYTES) fail(`signature 0 must be ${SIGNATURE_BYTES} bytes`);
  if (sp.scheme !== SIGNATURE_SCHEME.SECP256K1 || !sameAddress(sp.signer, sponsor) || sp.msg !== "0x") {
    fail("signature 1 must be SECP256K1 by the frame-1 sponsor with empty msg");
  }
  if ((sp.signature.length - 2) / 2 !== SPONSOR_SIGNATURE_BYTES) fail(`signature 1 must be ${SPONSOR_SIGNATURE_BYTES} bytes`);

  return {
    direction,
    amountIn: decoded.amountIn,
    minOut: decoded.amountOutMinimum,
    deadline: decoded.deadline,
    account,
    nonce: tx.nonceSeq,
    sponsor,
    tokenIn: decoded.tokenIn,
    tokenOut: decoded.tokenOut,
  };
}

const SYMBOL = { USDC: "dUSDC", WETH: "WETH" } as const;

/** Human labels for the five frames, in order. */
export function frameLabels(direction: SwapDirection): [string, string, string, string, string] {
  const tokenIn = direction === "USDC_TO_WETH" ? SYMBOL.USDC : SYMBOL.WETH;
  const tokenOut = direction === "USDC_TO_WETH" ? SYMBOL.WETH : SYMBOL.USDC;
  return [
    "Verify SLH-DSA signature",
    "Sponsor approves gas",
    `Approve ${tokenIn} to Permit2`,
    "Permit2 allows the router",
    `Swap ${tokenIn} for ${tokenOut} (guarded v4 pool)`,
  ];
}
