import { describe, expect, it } from "vitest";
import { classifyRow, toLedgerEntry, type ExplorerRow } from "../src/chain/activity.js";
import { formatAmount, parseAmountInput, rawToInput, sanitizeAmountInput, spotUsdcPerWeth } from "../src/chain/amounts.js";
import { explorerAddressUrl, explorerTxUrl } from "../src/chain/explorer.js";
import {
  frameRow,
  liveFrameStates,
  phaseOfStage,
  replayAt,
  replayTimeline,
  TREE_SPAN,
  treePaths,
  waitingTreeProgress,
} from "../src/chain/proof.js";
import {
  describeMempoolError,
  describeRejection,
  frameViews,
  parseAdmission,
  receiptFee,
  receiptSucceeded,
  tokenDeltas,
  type RawReceipt,
} from "../src/chain/receipts.js";

import { CONFIG, DEMO, fixture, SPONSOR } from "./chain.fixtures.js";

const list = fixture<{ transactions: ExplorerRow[] }>("explorer-list-demo.json");
const swapReceipt = fixture<RawReceipt>("receipt-swap.json");
const mintReceipt = fixture<RawReceipt>("receipt-mint.json");
const createReceipt = fixture<RawReceipt>("receipt-create.json");
const admissionDetail = fixture<unknown>("admission-swap.json");

const row = (hash: string) => {
  const found = list.transactions.find((r) => r.hash === hash);
  if (!found) throw new Error("fixture row missing");
  return found;
};

describe("activity classification (live explorer index rows)", () => {
  it("classifies the demo account's swap, faucet mint and creation", () => {
    expect(list.transactions.map((r) => classifyRow(r, CONFIG, DEMO))).toEqual(["swap", "faucet", "create"]);
  });

  it("builds ledger entries with actual amounts from receipts", () => {
    const swap = toLedgerEntry(row(swapReceipt.transactionHash), CONFIG, DEMO, swapReceipt);
    expect(swap).toMatchObject({ kind: "swap", status: "success", blockNumber: 408, payer: SPONSOR.toLowerCase() });
    expect(swap.title).toBe("Swapped 1.00 dUSDC → 0.0004985 WETH");
    expect(swap.meta).toBe("5 frames · sponsored · block 408");
    expect(swap.deltas).toEqual({ usdc: -1_000_000n, weth: 498_475_151_013_721n });

    const mint = toLedgerEntry(row(mintReceipt.transactionHash), CONFIG, DEMO, mintReceipt);
    expect(mint).toMatchObject({ kind: "faucet", title: "Received 1.00 dUSDC", meta: "Faucet · block 405" });

    const created = toLedgerEntry(row(createReceipt.transactionHash), CONFIG, DEMO, null);
    expect(created).toMatchObject({ kind: "create", title: "Account created", meta: "Stake 0.012 ETH locked · block 404" });
  });

  it("ignores native-ETH pseudo-transfers when computing token deltas", () => {
    // The creation receipt only moves ETH (0xff..fe pseudo-address logs): no token deltas.
    expect(tokenDeltas(createReceipt.logs, DEMO, { usdc: CONFIG.contracts.demoUSDC, weth: CONFIG.contracts.weth9 })).toEqual({
      usdc: 0n,
      weth: 0n,
    });
  });
});

describe("frame receipts", () => {
  it("reads frame statuses, PQ validation gas, fee and payer from the EL receipt", () => {
    const frames = frameViews(
      [
        { mode: 1, flags: 2, target: DEMO },
        { mode: 1, flags: 1, target: SPONSOR },
        { mode: 2, flags: 4, target: CONFIG.contracts.demoUSDC },
        { mode: 2, flags: 4, target: CONFIG.contracts.permit2 },
        { mode: 2, flags: 0, target: CONFIG.contracts.universalRouter },
      ],
      ["a", "b", "c", "d", "e"],
      swapReceipt,
    );
    expect(frames.map((f) => [f.mode, f.status])).toEqual([
      ["VERIFY", "success"],
      ["VERIFY", "success"],
      ["SENDER", "success"],
      ["SENDER", "success"],
      ["SENDER", "success"],
    ]);
    expect(frames[0]?.gasUsed).toBe(1_120_597n);
    expect(receiptSucceeded(swapReceipt)).toBe(true);
    expect(receiptFee(swapReceipt)).toBe(1_727_304_012_091_128n);
    expect(swapReceipt.payer?.toLowerCase()).toBe(SPONSOR.toLowerCase());
  });

  it("treats any failed frame as a revert", () => {
    const broken = structuredClone(swapReceipt);
    broken.frameReceipts![4]!.status = "0x0";
    expect(receiptSucceeded(broken)).toBe(false);
    expect(frameViews([{ mode: 2, flags: 0, target: DEMO }], ["x"], { frameReceipts: [broken.frameReceipts![4]!] })[0]?.status).toBe(
      "failed",
    );
  });
});

describe("admission parsing", () => {
  it("counts the 24 passed checks of the live demo admission", () => {
    const summary = parseAdmission(admissionDetail);
    expect(summary).toMatchObject({ outcome: "included", checksPassed: 24, checksTotal: 24, failed: [], errorCode: null });
    expect(summary?.frameStatuses).toEqual(["success", "success", "success", "success", "success"]);
  });

  it("explains a rejection by its failing rule (shape from the sidecar's AdmissionRecord type)", () => {
    const summary = parseAdmission({
      admission: {
        outcome: "rejected",
        errorCode: -32500,
        checks: [
          { rule: "gas-limit", verdict: "pass" },
          { rule: "simulation", verdict: "fail", detail: "validation prefix frame reverted" },
        ],
        frameStatuses: ["reverted", "not-run"],
      },
      events: [{ kind: "rejected", reason: "validation prefix frame reverted" }],
    });
    expect(summary).toMatchObject({ outcome: "rejected", checksPassed: 1, checksTotal: 2, errorCode: -32500 });
    expect(describeRejection(summary!)).toBe(
      "The mempool rejected the transaction at its traced simulation check: validation prefix frame reverted",
    );
    expect(parseAdmission(null)).toBeNull();
    expect(parseAdmission({ admission: null })).toBeNull();
  });

  it("maps sidecar error messages to readable text", () => {
    expect(describeMempoolError("Frame transaction nonce key 0x0 is already held by pending transaction 0xab")).toMatch(/still pending/);
    expect(describeMempoolError("0xb7.. cannot cover its pending frame transactions: they would owe 1 wei")).toMatch(/sponsor cannot cover/);
    expect(describeMempoolError("Invalid frame transaction signature")).toMatch(/sponsor's signature/);
    expect(describeMempoolError("weird")).toBe("The mempool rejected the transaction: weird");
  });
});

describe("explorer URLs", () => {
  it("matches the explorer's routes", () => {
    const hash = "0x5372C2B13AA087361C62475F8B28F843012A9FB2AE4E4692878D80EFCB28FA1E";
    expect(explorerTxUrl(CONFIG, hash, { frame: true })).toBe(
      "https://altmempool.bailo.london/explorer/tx/0x5372c2b13aa087361c62475f8b28f843012a9fb2ae4e4692878d80efcb28fa1e?node=https%3A%2F%2Faltmempool.bailo.london%2Fmempool",
    );
    expect(explorerTxUrl({ ...CONFIG, explorerUrl: "https://x.test/explorer" }, hash)).toBe(
      "https://x.test/explorer/chain/tx/0x5372c2b13aa087361c62475f8b28f843012a9fb2ae4e4692878d80efcb28fa1e",
    );
    expect(explorerAddressUrl(CONFIG, "0x19B17F47284DB0B254C62EB9AD6CE95538E3BC30")).toBe(
      "https://altmempool.bailo.london/explorer/address/0x19b17f47284db0b254c62eb9ad6ce95538e3bc30",
    );
  });
});

describe("amounts", () => {
  it("sanitises and parses user input exactly", () => {
    expect(sanitizeAmountInput("1,000.5.0abc")).toBe("1000.50");
    expect(parseAmountInput("1000.5", 6)).toBe(1_000_500_000n);
    expect(parseAmountInput(".5", 18)).toBe(500_000_000_000_000_000n);
    expect(parseAmountInput("1.1234567", 6)).toBeNull();
    expect(parseAmountInput("", 6)).toBeNull();
    expect(rawToInput(498_475_151_013_721n, 18, 4)).toBe("0.0004");
    expect(rawToInput(5_000_000_000n, 6, 2)).toBe("5000");
  });

  it("formats with design decimals and never shows a real balance as zero", () => {
    expect(formatAmount(1_234_560_000n, 6, 2)).toBe("1,234.56");
    expect(formatAmount(498_475_151_013_721n, 18, 4)).toBe("0.0004985");
    expect(formatAmount(-1_000_000n, 6, 2)).toBe("−1.00");
  });

  it("derives the dUSDC/WETH spot price from sqrtPriceX96", () => {
    expect(spotUsdcPerWeth(1771507261505971030119689138291487n, true)).toBeCloseTo(2000.1994, 3);
  });
});

describe("proof view model", () => {
  it("maps swap stages onto the design's five phases", () => {
    expect(
      (["quote", "build", "sign", "sponsor", "submit", "admission", "inclusion", "verified", "settled"] as const).map(phaseOfStage),
    ).toEqual([0, 0, 1, 1, 2, 2, 2, 3, 4]);
    expect(liveFrameStates("inclusion", 5, false)).toEqual(["running", "running", "shown", "shown", "shown"]);
    expect(liveFrameStates("verified", 5, false)).toEqual(["finished", "finished", "running", "running", "running"]);
    expect(liveFrameStates("quote", 2, false)).toEqual(["hidden", "hidden"]);
  });

  it("labels frame rows like the design", () => {
    expect(frameRow({ mode: "VERIFY", status: "success" }, "finished")).toEqual({ cls: "in fin", status: "Approved" });
    expect(frameRow({ mode: "SENDER", status: "failed" }, "finished")).toEqual({ cls: "in fin", status: "Reverted" });
    expect(frameRow({ mode: "SENDER", status: null }, "running")).toEqual({ cls: "in run", status: "Running" });
  });

  it("replays phases in order and ends stamped", () => {
    const tl = replayTimeline(5);
    const start = replayAt(tl, 0);
    expect(start).toMatchObject({ phase: 0, done: false, stamped: false, tree: 0 });
    expect(replayAt(tl, tl.verifyStart + 1).phase).toBe(2);
    const end = replayAt(tl, tl.total);
    expect(end).toMatchObject({ phase: 4, done: true, stamped: true, tree: 1 });
    expect(end.frames.every((f) => f === "finished")).toBe(true);
  });

  it("lights the hypertree progressively and waits below 100% until verified", () => {
    const g = { spokes: ["s0", "s1"], fors: "F", layers: ["L0", "L1"], climb: ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"] };
    expect(treePaths(g, 0)).toEqual({ dim: "s0s1FL0L1", lit: "", hot: "", climb: "" });
    const full = treePaths(g, 1);
    expect(full.lit).toBe("s0s1FL0L1");
    expect(full.climb).toBe("c0c1c2c3c4c5c6c7");
    expect(TREE_SPAN).toBeGreaterThan(0);
    expect(waitingTreeProgress(10 * 60_000)).toBeLessThan(1);
  });
});
