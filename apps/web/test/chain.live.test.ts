import { describe, expect, it } from "vitest";
import { loadActivity } from "../src/chain/activity.js";
import { loadBalances } from "../src/chain/balances.js";
import { loadSwapReport } from "../src/chain/swap.js";
import { CONFIG, DEMO } from "./chain.fixtures.js";

// Read-only smoke against the shared devnet; run with QSW_LIVE_READ=1.
const DEMO_SWAP = "0x5372c2b13aa087361c62475f8b28f843012a9fb2ae4e4692878d80efcb28fa1e";

describe.skipIf(!process.env.QSW_LIVE_READ)("live devnet reads", () => {
  it("loads balances, stake and the pool price for the demo account", async () => {
    const b = await loadBalances(CONFIG, DEMO);
    expect(b.eth).toBe(0n);
    expect(b.stake).toBe(12_000_000_000_000_000n);
    expect(b.usdcPerWeth).toBeGreaterThan(100);
    expect(b.block).toBeGreaterThan(408);
  });

  it("loads and classifies the demo account's activity", async () => {
    const ledger = await loadActivity(CONFIG, DEMO);
    expect(ledger.map((l) => l.kind)).toEqual(expect.arrayContaining(["swap", "faucet", "create"]));
    expect(ledger.find((l) => l.kind === "swap")?.deltas).toEqual({ usdc: -1_000_000n, weth: 498_475_151_013_721n });
  });

  it("rebuilds the demo swap's proof from chain data", async () => {
    const r = await loadSwapReport(CONFIG, DEMO, DEMO_SWAP);
    expect(r).toMatchObject({
      status: "success",
      direction: "USDC_TO_WETH",
      amountIn: 1_000_000n,
      amountOut: 498_475_151_013_721n,
      minOut: 450_000_000_000_000n,
      pqValidationGas: 1_120_597n,
      nonce: 6n,
      signingHash: "0x0b81f2c7cb1950141b67d8e4d37188d321586a7d4d0ea2401413e7c77fc40343",
    });
  });
});
