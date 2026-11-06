/**
 * Exact-in quotes for the guarded dUSDC/WETH Uniswap v4 pool, reproducing v4-core
 * Pool.swap / SwapMath.computeSwapStep / SqrtPriceMath / TickMath (commit 59d3ecf5)
 * with bigint arithmetic, so amounts match the chain to the wei.
 *
 * Assumption (verified on the shared devnet): the pool's only liquidity is one
 * full-range position, so liquidity is constant between the usable tick bounds and
 * the only initialized ticks are those bounds. Like Pool.swap we still step at
 * every tick-bitmap word boundary (rounding differs per step), but no tick is ever
 * crossed: a swap that would reach a bound is rejected as too large for the pool.
 */
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { stateViewAbi } from "./abis.js";
import { rpcBatch, RpcError, type RpcOptions } from "./rpc.js";
import type { PublicConfig, SwapDirection } from "./types.js";

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_SWAP_FEE = 1_000_000n;

export class QuoteError extends Error {
  override name = "QuoteError";
}

export interface PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  /** LP fee in pips (millionths) from slot0. */
  lpFee: number;
  /** Packed protocol fee from slot0: low 12 bits zeroForOne, high 12 bits oneForZero. */
  protocolFee: number;
  tickSpacing: number;
  /** True when dUSDC is currency0 (it is on the shared devnet). */
  usdcIsCurrency0: boolean;
  blockNumber: number;
}

export interface Quote {
  amountOut: bigint;
  /** Price movement caused by the trade, excluding the LP fee, in basis points. */
  priceImpactBps: number;
  /** Total swap fee in basis points (3000 pips = 30 bps). */
  feeBps: number;
  /** Spot price before the trade, dUSDC per WETH (display only). */
  spotUsdcPerWeth: number;
  sqrtPriceAfterX96: bigint;
}

// ---------------------------------------------------------------------------
// FullMath / SqrtPriceMath / TickMath
// ---------------------------------------------------------------------------

const mulDiv = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d;
const mulDivUp = (a: bigint, b: bigint, d: bigint): bigint => {
  const p = a * b;
  return p / d + (p % d > 0n ? 1n : 0n);
};
const divUp = (a: bigint, b: bigint): bigint => a / b + (a % b > 0n ? 1n : 0n);

export function getAmount0Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (a > b) [a, b] = [b, a];
  const numerator1 = liquidity << 96n;
  const numerator2 = b - a;
  return roundUp ? divUp(mulDivUp(numerator1, numerator2, b), a) : mulDiv(numerator1, numerator2, b) / a;
}

export function getAmount1Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const diff = a > b ? a - b : b - a;
  return roundUp ? mulDivUp(liquidity, diff, Q96) : mulDiv(liquidity, diff, Q96);
}

function nextSqrtPriceFromInput(sqrtP: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (zeroForOne) {
    // getNextSqrtPriceFromAmount0RoundingUp(add = true), including its overflow fallback
    if (amountIn === 0n) return sqrtP;
    const numerator1 = liquidity << 96n;
    const product = amountIn * sqrtP;
    if (product <= MAX_UINT256 && numerator1 + product <= MAX_UINT256) return mulDivUp(numerator1, sqrtP, numerator1 + product);
    return divUp(numerator1, numerator1 / sqrtP + amountIn);
  }
  // getNextSqrtPriceFromAmount1RoundingDown(add = true)
  const next = sqrtP + (amountIn << 96n) / liquidity;
  if (next > MAX_UINT160) throw new QuoteError("Price overflow");
  return next;
}

const TICK_FACTORS: readonly bigint[] = [
  0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n, 0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

/** TickMath.getSqrtPriceAtTick: Q64.96 sqrt(1.0001^tick), rounded up. */
export function getSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || Math.abs(tick) > MAX_TICK) throw new QuoteError(`Invalid tick ${tick}`);
  const absTick = Math.abs(tick);
  let price = absTick & 1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  TICK_FACTORS.forEach((factor, i) => {
    if (absTick & (2 << i)) price = (price * factor) >> 128n;
  });
  if (tick > 0) price = MAX_UINT256 / price;
  return (price + (1n << 32n) - 1n) >> 32n;
}

// ---------------------------------------------------------------------------
// SwapMath.computeSwapStep (exact input) and the Pool.swap loop
// ---------------------------------------------------------------------------

export interface SwapStep {
  sqrtPriceNextX96: bigint;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
}

/** computeSwapStep for exact input; `amountRemaining` is the positive input still to swap. */
export function computeSwapStepExactIn(current: bigint, target: bigint, liquidity: bigint, amountRemaining: bigint, feePips: number): SwapStep {
  const fee = BigInt(feePips);
  const zeroForOne = current >= target;
  const lessFee = mulDiv(amountRemaining, MAX_SWAP_FEE - fee, MAX_SWAP_FEE);
  let amountIn = zeroForOne ? getAmount0Delta(target, current, liquidity, true) : getAmount1Delta(current, target, liquidity, true);
  let next: bigint;
  let feeAmount: bigint;
  if (lessFee >= amountIn) {
    next = target;
    feeAmount = fee === MAX_SWAP_FEE ? amountIn : mulDivUp(amountIn, fee, MAX_SWAP_FEE - fee);
  } else {
    amountIn = lessFee;
    next = nextSqrtPriceFromInput(current, liquidity, lessFee, zeroForOne);
    feeAmount = amountRemaining - amountIn;
  }
  const amountOut = zeroForOne ? getAmount1Delta(next, current, liquidity, false) : getAmount0Delta(current, next, liquidity, false);
  return { sqrtPriceNextX96: next, amountIn, amountOut, feeAmount };
}

/** ProtocolFeeLibrary.calculateSwapFee for the swap direction. */
export function swapFeePips(pool: Pick<PoolState, "lpFee" | "protocolFee">, zeroForOne: boolean): number {
  const protocol = zeroForOne ? pool.protocolFee & 0xfff : pool.protocolFee >> 12;
  if (protocol === 0) return pool.lpFee;
  return protocol + pool.lpFee - Math.floor((protocol * pool.lpFee) / 1_000_000);
}

/** Next tick the swap steps to: the word boundary (TickBitmap) or a full-range bound. */
function nextTick(tick: number, spacing: number, zeroForOne: boolean): { next: number; isBound: boolean } {
  const lowerBound = Math.trunc(MIN_TICK / spacing) * spacing;
  const upperBound = Math.trunc(MAX_TICK / spacing) * spacing;
  const compressed = Math.floor(tick / spacing);
  if (zeroForOne) {
    const wordStart = (compressed - (compressed & 0xff)) * spacing;
    return lowerBound >= wordStart && lowerBound <= compressed * spacing ? { next: lowerBound, isBound: true } : { next: wordStart, isBound: false };
  }
  const c = compressed + 1;
  const wordEnd = (c + (255 - (c & 0xff))) * spacing;
  return upperBound >= c * spacing && upperBound <= wordEnd ? { next: upperBound, isBound: true } : { next: wordEnd, isBound: false };
}

export interface SwapSimulation {
  amountIn: bigint;
  amountOut: bigint;
  sqrtPriceAfterX96: bigint;
  steps: number;
}

/** Pool.swap for an exact input with the router's price limit (MIN+1 / MAX-1). */
export function simulateExactIn(pool: PoolState, zeroForOne: boolean, amountIn: bigint): SwapSimulation {
  if (amountIn <= 0n) throw new QuoteError("Amount must be positive");
  if (pool.liquidity <= 0n) throw new QuoteError("The pool has no liquidity");
  const fee = swapFeePips(pool, zeroForOne);
  const limit = zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
  let remaining = amountIn;
  let sqrtPrice = pool.sqrtPriceX96;
  let tick = pool.tick;
  let amountOut = 0n;
  let steps = 0;
  while (remaining !== 0n && sqrtPrice !== limit) {
    const { next, isBound } = nextTick(Math.min(Math.max(tick, MIN_TICK), MAX_TICK), pool.tickSpacing, zeroForOne);
    const tickNext = Math.min(Math.max(next, MIN_TICK), MAX_TICK);
    const sqrtNext = getSqrtPriceAtTick(tickNext);
    const target = zeroForOne ? (sqrtNext < limit ? limit : sqrtNext) : sqrtNext > limit ? limit : sqrtNext;
    const step = computeSwapStepExactIn(sqrtPrice, target, pool.liquidity, remaining, fee);
    const start = sqrtPrice;
    sqrtPrice = step.sqrtPriceNextX96;
    remaining -= step.amountIn + step.feeAmount;
    amountOut += step.amountOut;
    steps++;
    if (sqrtPrice === sqrtNext) {
      if (isBound) throw new QuoteError("This amount is larger than the pool's liquidity can fill");
      tick = zeroForOne ? tickNext - 1 : tickNext;
    } else if (sqrtPrice !== start && remaining !== 0n) {
      throw new QuoteError("Unexpected partial swap step");
    }
  }
  if (remaining !== 0n) throw new QuoteError("This amount is larger than the pool's liquidity can fill");
  return { amountIn, amountOut, sqrtPriceAfterX96: sqrtPrice, steps };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function zeroForOneOf(pool: Pick<PoolState, "usdcIsCurrency0">, direction: SwapDirection): boolean {
  return (direction === "USDC_TO_WETH") === pool.usdcIsCurrency0;
}

/** Spot price, dUSDC per WETH (6 vs 18 decimals). */
export function spotUsdcPerWeth(pool: Pick<PoolState, "sqrtPriceX96" | "usdcIsCurrency0">): number {
  const ratio = Number(pool.sqrtPriceX96) / 2 ** 96;
  const price1Per0 = ratio * ratio; // token1 raw per token0 raw
  return pool.usdcIsCurrency0 ? 1e12 / price1Per0 : price1Per0 * 1e12;
}

export function quoteExactIn(pool: PoolState, direction: SwapDirection, amountIn: bigint): Quote {
  const zeroForOne = zeroForOneOf(pool, direction);
  const sim = simulateExactIn(pool, zeroForOne, amountIn);
  const fee = swapFeePips(pool, zeroForOne);
  const ratio = Number(pool.sqrtPriceX96) / 2 ** 96;
  const price1Per0 = ratio * ratio;
  const spotOut = Number(amountIn) * (zeroForOne ? price1Per0 : 1 / price1Per0) * (1 - fee / 1e6);
  const impact = spotOut > 0 ? 1 - Number(sim.amountOut) / spotOut : 0;
  return {
    amountOut: sim.amountOut,
    priceImpactBps: Math.max(0, Math.round(impact * 10_000 * 100) / 100),
    feeBps: fee / 100,
    spotUsdcPerWeth: spotUsdcPerWeth(pool),
    sqrtPriceAfterX96: sim.sqrtPriceAfterX96,
  };
}

/** Read slot0 + liquidity through StateView (one batched JSON-RPC request). */
export async function loadPoolState(
  rpcUrl: string,
  config: Pick<PublicConfig, "contracts" | "poolKey" | "poolId">,
  options: RpcOptions = {},
): Promise<PoolState> {
  const to = config.contracts.stateView;
  const [slot0, liquidity, block] = await rpcBatch(
    rpcUrl,
    [
      { method: "eth_call", params: [{ to, data: encodeFunctionData({ abi: stateViewAbi, functionName: "getSlot0", args: [config.poolId] }) }, "latest"] },
      { method: "eth_call", params: [{ to, data: encodeFunctionData({ abi: stateViewAbi, functionName: "getLiquidity", args: [config.poolId] }) }, "latest"] },
      { method: "eth_blockNumber" },
    ],
    options,
  );
  for (const result of [slot0, liquidity, block]) {
    if (!result) throw new RpcError(-32603, "Missing pool state response", "eth_call");
    if (!result.ok) throw result.error;
  }
  const [sqrtPriceX96, tick, protocolFee, lpFee] = decodeFunctionResult({
    abi: stateViewAbi,
    functionName: "getSlot0",
    data: (slot0 as { result: unknown }).result as `0x${string}`,
  });
  const pooled = decodeFunctionResult({
    abi: stateViewAbi,
    functionName: "getLiquidity",
    data: (liquidity as { result: unknown }).result as `0x${string}`,
  });
  if (sqrtPriceX96 === 0n) throw new QuoteError("The pool is not initialized");
  return {
    sqrtPriceX96,
    tick,
    liquidity: pooled,
    lpFee,
    protocolFee,
    tickSpacing: config.poolKey.tickSpacing,
    usdcIsCurrency0: config.poolKey.currency0.toLowerCase() === config.contracts.demoUSDC.toLowerCase(),
    blockNumber: Number((block as { result: unknown }).result),
  };
}
