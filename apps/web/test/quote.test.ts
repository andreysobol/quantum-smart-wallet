/**
 * v4 exact-in math: vectors from v4-core's own tests (slhsol/lib/v4-core/test), the
 * mined demo swap (PoolManager Initialize at block 27 -> Swap at block 408), and the
 * Pool.swap word-boundary stepping. Live StateView read only with QSW_LIVE_READ=1.
 */
import { describe, expect, it } from "vitest";
import {
  computeSwapStepExactIn,
  getSqrtPriceAtTick,
  loadPoolState,
  MAX_SQRT_PRICE,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MIN_TICK,
  quoteExactIn,
  simulateExactIn,
  spotUsdcPerWeth,
  swapFeePips,
  type PoolState,
} from "../shared/quote.js";
import type { PublicConfig } from "../shared/types.js";

const SQRT_PRICE_1_1 = 79228162514264337593543950336n;
const SQRT_PRICE_101_100 = 79623317895830914510639640423n;
const SQRT_PRICE_1000_100 = 250541448375047931186413801569n;
const SQRT_PRICE_1_4 = 39614081257132168796771975168n;
const ETHER = 10n ** 18n;

/** Pool right after Initialize (block 27): the state the demo swap started from. */
const initial: PoolState = {
  sqrtPriceX96: 0x5758ae05bbf89b1e32f83635685cn,
  tick: 0x30e77,
  liquidity: 447213595499957n,
  lpFee: 3000,
  protocolFee: 0,
  tickSpacing: 60,
  usdcIsCurrency0: true,
  blockNumber: 27,
};
/** PoolManager Swap event of the demo swap (block 408): post-swap price and tick. */
const afterDemo: PoolState = { ...initial, sqrtPriceX96: 0x575790adb6f3054692e00ac1431fn, tick: 0x30e76, blockNumber: 408 };

describe("SwapMath.computeSwapStep (v4-core test vectors)", () => {
  it("exact in, one for zero, capped at the price target", () => {
    expect(computeSwapStepExactIn(SQRT_PRICE_1_1, SQRT_PRICE_101_100, 2n * ETHER, ETHER, 600)).toEqual({
      sqrtPriceNextX96: SQRT_PRICE_101_100,
      amountIn: 9975124224178055n,
      amountOut: 9925619580021728n,
      feeAmount: 5988667735148n,
    });
  });

  it("exact in, one for zero, fully spent before the target", () => {
    const step = computeSwapStepExactIn(SQRT_PRICE_1_1, SQRT_PRICE_1000_100, 2n * ETHER, ETHER, 600);
    expect(step).toMatchObject({ amountIn: 999400000000000000n, amountOut: 666399946655997866n, feeAmount: 600000000000000n });
    expect(step.sqrtPriceNextX96 < SQRT_PRICE_1000_100).toBe(true);
  });

  it("target price of 1 uses a partial input amount", () => {
    expect(computeSwapStepExactIn(2n, 1n, 1n, 3915081100057732413702495386755767n, 1)).toEqual({
      sqrtPriceNextX96: 1n,
      amountIn: SQRT_PRICE_1_4,
      amountOut: 0n,
      feeAmount: 39614120871253040049813n,
    });
  });

  it("does not take the entire input amount as fee", () => {
    expect(computeSwapStepExactIn(2413n, 79887613182836312n, 1985041575832132834610021537970n, 10n, 1872)).toEqual({
      sqrtPriceNextX96: 2413n,
      amountIn: 9n,
      amountOut: 0n,
      feeAmount: 1n,
    });
  });
});

describe("TickMath.getSqrtPriceAtTick", () => {
  it("matches the library bounds and tick 0", () => {
    expect(getSqrtPriceAtTick(MIN_TICK)).toBe(MIN_SQRT_PRICE);
    expect(getSqrtPriceAtTick(MAX_TICK)).toBe(MAX_SQRT_PRICE);
    expect(getSqrtPriceAtTick(0)).toBe(SQRT_PRICE_1_1);
    expect(() => getSqrtPriceAtTick(MAX_TICK + 1)).toThrow();
  });

  it("agrees with sqrt(1.0001^tick) * 2^96 to 1e-12 for every bit of the tick", () => {
    for (let bit = 0; bit < 20; bit++) {
      for (const tick of [1 << bit, -(1 << bit), (1 << bit) + 7, -((1 << bit) + 13)]) {
        if (Math.abs(tick) > MAX_TICK) continue;
        const expected = Math.exp((tick / 2) * Math.log1p(1e-4)); // log1p: the literal 1.0001 is inexact
        const actual = Number(getSqrtPriceAtTick(tick)) / 2 ** 96;
        expect(Math.abs(actual / expected - 1), `tick ${tick}`).toBeLessThan(1e-12);
      }
    }
  });
});

describe("the mined demo swap (1 dUSDC -> WETH, block 408)", () => {
  it("reproduces the exact WETH output and post-swap price", () => {
    const sim = simulateExactIn(initial, true, 1_000_000n);
    expect(sim.amountOut).toBe(498475151013721n); // report.outputWETH and the Swap event amount1
    expect(sim.sqrtPriceAfterX96).toBe(afterDemo.sqrtPriceX96);
    expect(sim.steps).toBe(1);
    const quote = quoteExactIn(initial, "USDC_TO_WETH", 1_000_000n);
    expect(quote.amountOut).toBe(498475151013721n);
    expect(quote.feeBps).toBe(30);
    expect(quote.priceImpactBps).toBeLessThan(1);
    expect(spotUsdcPerWeth(initial)).toBeCloseTo(2000, 6);
  });
});

describe("Pool.swap stepping and both directions", () => {
  it("steps at the tick-bitmap word boundary exactly like Pool.swap", () => {
    // Tick 200310 is compressed 3338 (word 13, bit 10): the word starts at tick 199680.
    const amountIn = 1_000_000_000n; // 1,000 dUSDC moves the price past the boundary
    const sim = simulateExactIn(afterDemo, true, amountIn);
    expect(sim.steps).toBe(2);
    const boundary = getSqrtPriceAtTick(199680);
    const first = computeSwapStepExactIn(afterDemo.sqrtPriceX96, boundary, afterDemo.liquidity, amountIn, 3000);
    expect(first.sqrtPriceNextX96).toBe(boundary);
    const second = computeSwapStepExactIn(boundary, getSqrtPriceAtTick(199680 - 256 * 60), afterDemo.liquidity, amountIn - first.amountIn - first.feeAmount, 3000);
    expect(sim.amountOut).toBe(first.amountOut + second.amountOut);
    expect(sim.sqrtPriceAfterX96).toBe(second.sqrtPriceNextX96);
  });

  it("quotes WETH -> dUSDC near spot for small trades and loses about two fees on a round trip", () => {
    const wethIn = 10n ** 15n; // 0.001 WETH
    const quote = quoteExactIn(afterDemo, "WETH_TO_USDC", wethIn);
    const spot = spotUsdcPerWeth(afterDemo);
    const expected = (Number(wethIn) / 1e18) * spot * 0.997 * 1e6;
    expect(Math.abs(Number(quote.amountOut) / expected - 1)).toBeLessThan(0.001);
    const back = quoteExactIn(afterDemo, "USDC_TO_WETH", quote.amountOut);
    const loss = 1 - Number(back.amountOut) / Number(wethIn);
    expect(loss).toBeGreaterThan(0.0059);
    expect(loss).toBeLessThan(0.0065);
  });

  it("reports price impact growing with size and rejects impossible amounts", () => {
    const small = quoteExactIn(afterDemo, "USDC_TO_WETH", 1_000_000n);
    const large = quoteExactIn(afterDemo, "USDC_TO_WETH", 1_000_000_000n);
    expect(large.priceImpactBps).toBeGreaterThan(small.priceImpactBps);
    expect(large.priceImpactBps).toBeGreaterThan(400);
    expect(() => quoteExactIn(afterDemo, "USDC_TO_WETH", 0n)).toThrow(/positive/);
    expect(() => quoteExactIn({ ...afterDemo, liquidity: 0n }, "USDC_TO_WETH", 1n)).toThrow(/liquidity/);
  });

  it("combines the protocol fee like ProtocolFeeLibrary.calculateSwapFee", () => {
    expect(swapFeePips({ lpFee: 3000, protocolFee: 0 }, true)).toBe(3000);
    expect(swapFeePips({ lpFee: 3000, protocolFee: 1000 | (500 << 12) }, true)).toBe(1000 + 3000 - 3);
    expect(swapFeePips({ lpFee: 3000, protocolFee: 1000 | (500 << 12) }, false)).toBe(500 + 3000 - 1);
  });
});

describe.skipIf(process.env.QSW_LIVE_READ !== "1")("live StateView read (QSW_LIVE_READ=1)", () => {
  it("loads the pool and quotes 1 dUSDC", async () => {
    const manifest = (await (await fetch("https://altmempool.bailo.london/deployment.json")).json()) as Record<string, unknown>;
    const config = {
      contracts: { stateView: manifest.stateView, demoUSDC: manifest.demoUSDC } as PublicConfig["contracts"],
      poolKey: manifest.poolKey as PublicConfig["poolKey"],
      poolId: manifest.poolId as PublicConfig["poolId"],
    };
    const pool = await loadPoolState(manifest.rpcUrl as string, config);
    expect(pool.liquidity > 0n).toBe(true);
    expect(pool.lpFee).toBe(3000);
    expect(pool.usdcIsCurrency0).toBe(true);
    expect(quoteExactIn(pool, "USDC_TO_WETH", 1_000_000n).amountOut > 0n).toBe(true);
  });
});
