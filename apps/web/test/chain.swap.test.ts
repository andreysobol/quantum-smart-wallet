import { readFileSync } from "node:fs";
import { encodeFunctionResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { erc20Abi, stateViewAbi } from "../shared/abis.js";
import { cosignAsSponsor, fromWire, signingHash, toWire, txHash, type FrameTx } from "../shared/frameTx.js";
import type { Address, Hex, SponsorResponse, WireFrameTx } from "../shared/types.js";
import { SwapError, runSwap, verifySponsorResponse } from "../src/chain/swap.js";
import type { SwapProgress } from "../src/chain/types.js";
import { CONFIG, DEMO, fixture } from "./chain.fixtures.js";

const evidence = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../demo/evidence/shared-devnet/${name}`, import.meta.url), "utf8"));
const goldenWire = evidence("transaction.json") as WireFrameTx;
const goldenReport = evidence("report.json") as { sponsor: Address; signingHash: Hex; transactionHash: Hex };
const ZERO65 = `0x${"00".repeat(65)}` as Hex;

const withSig1 = (tx: FrameTx, signature: Hex): FrameTx => ({
  ...tx,
  signatures: tx.signatures.map((s, i) => (i === 1 ? { ...s, signature } : s)),
});

describe("verifySponsorResponse (golden demo transaction)", () => {
  const ours = withSig1(fromWire(goldenWire), ZERO65);
  const response: SponsorResponse = {
    sponsor: goldenReport.sponsor,
    signingHash: goldenReport.signingHash,
    txHash: goldenReport.transactionHash,
    tx: goldenWire,
  };

  it("accepts the real co-signed transaction and keeps its hash", async () => {
    const final = await verifySponsorResponse(ours, response, goldenReport.sponsor);
    expect(txHash(final)).toBe(goldenReport.transactionHash);
  });

  it("refuses a response from another sponsor", async () => {
    await expect(verifySponsorResponse(ours, response, DEMO)).rejects.toThrow(/unexpected sponsor/);
  });

  it("refuses a transaction that differs from what we signed", async () => {
    const changed = structuredClone(goldenWire);
    changed.fees.maxFeePerGas = "0x77359401";
    await expect(verifySponsorResponse(ours, { ...response, tx: changed }, goldenReport.sponsor)).rejects.toThrow(
      /differs from the one you signed/,
    );
    const otherNonce = { ...ours, nonceSeq: ours.nonceSeq + 1n };
    await expect(verifySponsorResponse(otherNonce, response, goldenReport.sponsor)).rejects.toThrow(/differs/);
  });

  it("refuses mismatched claimed hashes", async () => {
    const bad = `0x${"11".repeat(32)}` as Hex;
    await expect(verifySponsorResponse(ours, { ...response, txHash: bad }, goldenReport.sponsor)).rejects.toThrow(/transaction hash/);
    await expect(verifySponsorResponse(ours, { ...response, signingHash: bad }, goldenReport.sponsor)).rejects.toThrow(/signing hash/);
  });

  it("refuses a sponsor signature that does not recover to the sponsor", async () => {
    const forged = structuredClone(goldenWire);
    const sig = forged.signatures[1]!.signature;
    forged.signatures[1]!.signature = `${sig.slice(0, 40)}${sig[40] === "a" ? "b" : "a"}${sig.slice(41)}` as Hex;
    const forgedHash = txHash(fromWire(forged));
    await expect(
      verifySponsorResponse(ours, { ...response, tx: forged, txHash: forgedHash }, goldenReport.sponsor),
    ).rejects.toThrow(/does not recover|malformed/);
  });
});

// ---------------------------------------------------------------------------- runSwap against a fake network

const SPONSOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const sponsorAccount = privateKeyToAccount(SPONSOR_KEY);
const config = { ...CONFIG, sponsor: sponsorAccount.address };
const swapReceipt = fixture<Record<string, unknown>>("receipt-swap.json");
const admission = fixture<Record<string, unknown>>("admission-swap.json");
const SQRT_PRICE_BEFORE_DEMO = 1771595571142957102961017161607260n;

type Tamper = (tx: FrameTx) => FrameTx;

function fakeNetwork(tamper?: Tamper) {
  const calls: string[] = [];
  let submitted: Hex | null = null;
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    calls.push(method);
    const call = params[0] as { to?: string; data?: string } | undefined;
    switch (method) {
      case "eth_blockNumber":
        return "0x198";
      case "eth_getTransactionCount":
        return "0x6";
      case "eth_getBlockByNumber":
        return { number: "0x197", timestamp: "0x6aed4b33" };
      case "eth_call": {
        const selector = call?.data?.slice(0, 10);
        if (call?.to?.toLowerCase() === config.contracts.stateView.toLowerCase()) {
          return selector === "0xc815641c"
            ? encodeFunctionResult({ abi: stateViewAbi, functionName: "getSlot0", result: [SQRT_PRICE_BEFORE_DEMO, 200311, 0, 3000] } as never)
            : encodeFunctionResult({ abi: stateViewAbi, functionName: "getLiquidity", result: 447213595499957n } as never);
        }
        return encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: 5_000_000n } as never);
      }
      case "eth_sendFrameTransaction":
        submitted = txHash(fromWire(params[0]));
        return submitted;
      case "skandha_explorer_getTransaction":
        return { ...admission, hash: submitted };
      case "eth_getTransactionReceipt":
        return { ...swapReceipt, transactionHash: submitted, payer: sponsorAccount.address.toLowerCase() };
      default:
        throw new Error(`unexpected RPC ${method}`);
    }
  };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "null"));
    if (url.endsWith("/api/sponsor")) {
      calls.push("api.sponsor");
      const tx = fromWire(body.tx);
      const cosigned = await cosignAsSponsor(tamper ? tamper(tx) : tx, sponsorAccount);
      const reply: SponsorResponse = {
        sponsor: sponsorAccount.address,
        signingHash: signingHash(cosigned),
        txHash: txHash(cosigned),
        tx: toWire(cosigned),
      };
      return new Response(JSON.stringify(reply), { status: 200 });
    }
    const one = async (req: { id: number; method: string; params: unknown[] }) => {
      try {
        return { jsonrpc: "2.0", id: req.id, result: await rpc(req.method, req.params ?? []) };
      } catch (error) {
        return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: (error as Error).message } };
      }
    };
    const reply = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

const fakeSigner = {
  sign: vi.fn(async () => ({ signature: `0x${"ab".repeat(7856)}` as Hex, ms: 1234 })),
};
const wallet = { account: DEMO, publicKey: "0xa557fbaf399f187f8e3a0835037fb7eff5fe1b86194bd8c9e181772254b8edaf" as Hex };
const input = { direction: "USDC_TO_WETH" as const, amountIn: 1_000_000n, slippageBps: 50 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runSwap", () => {
  it("runs every stage and reports the settled amounts, sponsor and PQ validation gas", async () => {
    const { calls } = fakeNetwork();
    const progress: SwapProgress[] = [];
    const result = await runSwap(config, wallet, fakeSigner, input, (p) => progress.push(p));
    expect(result).toMatchObject({
      status: "success",
      direction: "USDC_TO_WETH",
      amountIn: 1_000_000n,
      amountOut: 498_475_151_013_721n,
      pqValidationGas: 1_120_597n,
      blockNumber: 408,
      payer: sponsorAccount.address.toLowerCase(),
      admission: { outcome: "included", checksPassed: 24, checksTotal: 24 },
      nonce: 6n,
      signMs: 1234,
    });
    // Exact v4 quote of the demo input at the demo's pre-swap price, minus 0.5%.
    expect(result.quotedOut).toBe(498_475_151_013_721n);
    expect(result.minOut).toBe((498_475_151_013_721n * 9950n) / 10_000n);
    expect(result.frames.map((f) => f.status)).toEqual(["success", "success", "success", "success", "success"]);
    expect(result.explorerTxUrl).toContain(`/explorer/tx/${result.txHash}?node=`);
    const done = progress.filter((p) => p.state === "done").map((p) => p.stage);
    expect(done).toEqual(["quote", "build", "sign", "sponsor", "submit", "admission", "inclusion", "verified", "settled"]);
    expect(calls.indexOf("api.sponsor")).toBeLessThan(calls.indexOf("eth_sendFrameTransaction"));
  });

  it("never submits when the sponsor co-signs a different transaction", async () => {
    const { calls } = fakeNetwork((tx) => ({ ...tx, fees: { ...tx.fees, maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas + 1n } }));
    const progress: SwapProgress[] = [];
    const error = await runSwap(config, wallet, fakeSigner, input, (p) => progress.push(p)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SwapError);
    expect((error as SwapError).stage).toBe("sponsor");
    expect((error as SwapError).message).toMatch(/differs from the one you signed\). Nothing was submitted/);
    expect(calls).not.toContain("eth_sendFrameTransaction");
    expect(progress.at(-1)).toMatchObject({ stage: "sponsor", state: "error" });
  });

  it("stops before signing when the balance is too low or the server has no sponsor", async () => {
    fakeNetwork();
    await expect(runSwap(config, wallet, fakeSigner, { ...input, amountIn: 6_000_000n }, () => {})).rejects.toThrow(
      /Not enough dUSDC/,
    );
    await expect(runSwap({ ...config, sponsor: null, operatorReady: false }, wallet, fakeSigner, input, () => {})).rejects.toThrow(
      /no sponsor configured/,
    );
    await expect(runSwap(config, wallet, fakeSigner, { ...input, amountIn: 2_000_000_000n }, () => {})).rejects.toThrow(
      /at most 1,000.00 dUSDC/,
    );
  });
});
