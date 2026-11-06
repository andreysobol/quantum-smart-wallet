import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { encodeFunctionResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erc20Abi, stateViewAbi } from "../shared/abis.js";
import { cosignAsSponsor, fromWire, signingHash, toWire, txHash } from "../shared/frameTx.js";
import type { Hex, SponsorResponse } from "../shared/types.js";
import { getSession, showLive, showReplay, startSwap } from "../src/chain/session.js";
import { RECONCILE_TIMEOUT_MS, runSwap, SwapError, type SwapReport } from "../src/chain/swap.js";
import type { SwapProgress } from "../src/chain/types.js";
import type { Signer } from "../src/crypto/types.js";
import { Proof } from "../src/screens/Proof.js";
import type { WalletRecord } from "../src/state/types.js";
import { CONFIG, DEMO, fixture } from "./chain.fixtures.js";

// The Proof screen reads the wallet context; the session tests below render it with this value.
const walletContext = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../src/state/wallet.js", () => ({ useWallet: () => walletContext.value }));

const sponsorAccount = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const config = { ...CONFIG, sponsor: sponsorAccount.address };
const swapReceipt = fixture<Record<string, unknown>>("receipt-swap.json");
const admissionDetail = fixture<{ admission: Record<string, unknown> }>("admission-swap.json");
const SQRT_PRICE_BEFORE_DEMO = 1771595571142957102961017161607260n;
const PUBLIC_KEY = "0xa557fbaf399f187f8e3a0835037fb7eff5fe1b86194bd8c9e181772254b8edaf" as Hex;
const wallet = { account: DEMO, publicKey: PUBLIC_KEY };
const signer = { sign: async () => ({ signature: `0x${"ab".repeat(7856)}` as Hex, ms: 1234 }) };
const input = { direction: "USDC_TO_WETH" as const, amountIn: 1_000_000n, slippageBps: 50 };
const STAGES = ["quote", "build", "sign", "sponsor", "submit", "admission", "inclusion", "verified", "settled"];

const REJECTED = {
  outcome: "rejected",
  errorCode: -32500,
  checks: [
    { rule: "gas-limit", verdict: "pass" },
    { rule: "simulation", verdict: "fail", detail: "validation prefix frame reverted" },
  ],
  frameStatuses: ["reverted", "not-run"],
};

/** How the gateway answers eth_sendFrameTransaction. */
type Answer =
  | "hash" // the normal answer
  | "lost" // the gateway's 20 s upstream timeout after forwarding: -32002 "Upstream RPC is unavailable"
  | "dropped" // the browser loses the connection after the request went out
  | "html" // a proxy error page instead of JSON-RPC
  | "known" // -32602 "Frame transaction already known": it is in the mempool
  | "refused"; // a sidecar validation error: a definite refusal

interface Scenario {
  answer: Answer;
  /** ms after the submit when the sidecar holds the admission record and mempool entry (omit: never). */
  recordAfterMs?: number;
  outcome?: "accepted" | "rejected";
  /** ms after the submit when a block includes the transaction (omit: never). */
  includedAfterMs?: number;
}

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** The devnet RPC, the sidecar behind the gateway and the app's /api/sponsor, faked in one fetch. */
function fakeNetwork(scenario: Scenario) {
  const calls: string[] = [];
  let hash: Hex | null = null;
  let submittedAt = Number.POSITIVE_INFINITY;
  const reached = (afterMs: number | undefined) => afterMs !== undefined && Date.now() - submittedAt >= afterMs;
  const notFound = () => new RpcFailure(-32600, "Frame transaction not found");

  const rpc = (method: string, params: unknown[]): unknown => {
    const call = params[0] as { to?: string; data?: string } | undefined;
    const included = reached(scenario.includedAfterMs);
    switch (method) {
      case "eth_blockNumber":
        return "0x198";
      case "eth_getTransactionCount":
        return "0x6";
      case "eth_getBlockByNumber":
        return { number: "0x197", timestamp: "0x6aed4b33" };
      case "eth_call":
        if (call?.to?.toLowerCase() === config.contracts.stateView.toLowerCase()) {
          return call.data?.startsWith("0xc815641c")
            ? encodeFunctionResult({ abi: stateViewAbi, functionName: "getSlot0", result: [SQRT_PRICE_BEFORE_DEMO, 200311, 0, 3000] } as never)
            : encodeFunctionResult({ abi: stateViewAbi, functionName: "getLiquidity", result: 447213595499957n } as never);
        }
        return encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: 5_000_000n } as never);
      case "skandha_explorer_getTransaction":
        if (!reached(scenario.recordAfterMs)) throw notFound();
        return {
          ...admissionDetail,
          hash,
          admission:
            scenario.outcome === "rejected" ? REJECTED : { ...admissionDetail.admission, outcome: included ? "included" : "accepted" },
        };
      case "skandha_frameTransactionStatus":
        if (included) return { status: "OnChain", transaction: hash };
        if (!reached(scenario.recordAfterMs) || scenario.outcome === "rejected") throw notFound();
        return { status: "Pending" };
      case "eth_getTransactionReceipt":
        return included ? { ...swapReceipt, transactionHash: hash, payer: sponsorAccount.address.toLowerCase() } : null;
      default:
        throw new RpcFailure(-32601, `unexpected RPC ${method}`);
    }
  };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (resource: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "null"));
      if (String(resource).endsWith("/api/sponsor")) {
        calls.push("api.sponsor");
        const cosigned = await cosignAsSponsor(fromWire(body.tx), sponsorAccount);
        const reply: SponsorResponse = {
          sponsor: sponsorAccount.address,
          signingHash: signingHash(cosigned),
          txHash: txHash(cosigned),
          tx: toWire(cosigned),
        };
        return json(reply);
      }
      if (!Array.isArray(body) && body.method === "eth_sendFrameTransaction") {
        calls.push(body.method);
        hash = txHash(fromWire(body.params[0]));
        submittedAt = Date.now();
        switch (scenario.answer) {
          case "hash":
            return json({ jsonrpc: "2.0", id: body.id, result: hash });
          case "lost":
            return json({ jsonrpc: "2.0", id: body.id, error: { code: -32002, message: "Upstream RPC is unavailable" } }, 502);
          case "dropped":
            throw new TypeError("fetch failed");
          case "html":
            return new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 });
          case "known":
            return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Frame transaction already known" } });
          case "refused":
            return json({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32500, message: "validation prefix frame reverted (validation gas limits: frame 0: 2400000 gas, frame 1: 30000 gas)" },
            });
        }
      }
      const one = (req: { id: number; method: string; params?: unknown[] }) => {
        calls.push(req.method);
        try {
          return { jsonrpc: "2.0", id: req.id, result: rpc(req.method, req.params ?? []) };
        } catch (error) {
          const code = error instanceof RpcFailure ? error.code : -32000;
          return { jsonrpc: "2.0", id: req.id, error: { code, message: (error as Error).message } };
        }
      };
      return json(Array.isArray(body) ? body.map(one) : one(body));
    }),
  );
  return { calls, hash: () => hash };
}

/** Advance the fake clock until `done()` (and let real I/O callbacks run in between). */
async function advanceUntil(done: () => boolean) {
  for (let step = 0; !done() && step < 6_000; step++) {
    await vi.advanceTimersByTimeAsync(500);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function swapOn(scenario: Scenario) {
  const network = fakeNetwork(scenario);
  const progress: SwapProgress[] = [];
  const started = Date.now();
  let settled = false;
  const outcome = runSwap(config, wallet, signer, input, (p) => progress.push(p)).then(
    (result): { result: SwapReport | null; error: unknown } => ({ result, error: null }),
    (error: unknown) => ({ result: null, error }),
  );
  void outcome.finally(() => (settled = true));
  await advanceUntil(() => settled);
  const { result, error } = await outcome;
  const submits = network.calls.filter((c) => c === "eth_sendFrameTransaction").length;
  return { result, error, progress, submits, hash: network.hash(), elapsed: Date.now() - started };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("runSwap when the mempool's answer to eth_sendFrameTransaction is lost", () => {
  it.each([
    ["the gateway's upstream timeout (-32002)", "lost"],
    ["a dropped connection", "dropped"],
    ["a proxy error page", "html"],
  ] as const)("finds the accepted swap by its hash after %s and runs it to the end", async (_, answer) => {
    const { result, error, progress, submits } = await swapOn({ answer, recordAfterMs: 0, outcome: "accepted", includedAfterMs: 9_000 });
    expect(error).toBeNull();
    expect(result).toMatchObject({ status: "success", amountOut: 498_475_151_013_721n, nonce: 6n });
    expect(progress.filter((p) => p.state === "done").map((p) => p.stage)).toEqual(STAGES);
    expect(submits).toBe(1);
  });

  it("waits for a sidecar that is still validating when the gateway gives up", async () => {
    const { result, error, progress } = await swapOn({ answer: "lost", recordAfterMs: 25_000, outcome: "accepted", includedAfterMs: 31_000 });
    expect(error).toBeNull();
    expect(result?.status).toBe("success");
    const lookup = progress.find((p) => p.stage === "submit" && p.state === "active" && /hash/.test(p.message));
    expect(lookup?.message).toMatch(/looking the transaction up by its hash/);
  });

  it("picks up a swap that was already included before the lookup", async () => {
    const { result, error } = await swapOn({ answer: "dropped", recordAfterMs: 0, outcome: "accepted", includedAfterMs: 0 });
    expect(error).toBeNull();
    expect(result).toMatchObject({ status: "success", admission: { outcome: "included" } });
  });

  it.each(["lost", "dropped", "html"] as const)(
    "reports an unknown status, never a rejection, when the %s swap shows up nowhere",
    async (answer) => {
      const { error, hash, elapsed, submits } = await swapOn({ answer });
      expect(error).toBeInstanceOf(SwapError);
      expect(error).toMatchObject({ stage: "submit", txHash: hash, unresolved: true });
      const { message } = error as SwapError;
      expect(message).toMatch(/status is unknown/);
      expect(message).toMatch(/check the transaction on the explorer before trying again/);
      expect(message).not.toMatch(/rejected/i);
      expect(elapsed).toBeGreaterThanOrEqual(RECONCILE_TIMEOUT_MS);
      expect(submits).toBe(1);
    },
  );

  it("reports the mempool's reason when the lookup finds a rejection", async () => {
    const { error } = await swapOn({ answer: "dropped", recordAfterMs: 3_000, outcome: "rejected" });
    expect(error).toMatchObject({
      stage: "submit",
      unresolved: false,
      message: "The mempool rejected the transaction at its traced simulation check: validation prefix frame reverted",
    });
  });
});

describe("runSwap when the mempool refuses the transaction outright", () => {
  it("reports the refusal at once without waiting for a lookup window", async () => {
    const { error, elapsed } = await swapOn({ answer: "refused" });
    expect(error).toMatchObject({
      stage: "submit",
      unresolved: false,
      message: "The validation frames reverted in simulation: the signature or sponsor approval was refused.",
    });
    expect(elapsed).toBeLessThan(5_000);
  });

  it("prefers the admission record's structured reason", async () => {
    const { error } = await swapOn({ answer: "refused", recordAfterMs: 0, outcome: "rejected" });
    expect((error as SwapError).message).toBe(
      "The mempool rejected the transaction at its traced simulation check: validation prefix frame reverted",
    );
  });

  it("still treats 'already known' (-32602) as submitted", async () => {
    const { result, error } = await swapOn({ answer: "known", recordAfterMs: 0, outcome: "accepted", includedAfterMs: 6_000 });
    expect(error).toBeNull();
    expect(result?.status).toBe("success");
  });
});

describe("runSwap inclusion timeout", () => {
  it("marks a swap that is still pending after 3 minutes as unresolved", async () => {
    const { error } = await swapOn({ answer: "hash", recordAfterMs: 0, outcome: "accepted" });
    expect(error).toMatchObject({ stage: "inclusion", unresolved: true });
    expect((error as SwapError).message).toMatch(/not included within 3 minutes. It may still land/);
  });
});

// ---------------------------------------------------------------------------- live session and Proof screen

const record: WalletRecord = {
  version: 1,
  chainId: config.chainId,
  account: DEMO,
  publicKey: PUBLIC_KEY,
  salt: `0x${"00".repeat(32)}`,
  factory: config.contracts.accountFactory,
  createdAt: 0,
  createTxHash: null,
  backedUp: true,
};
const go = vi.fn();
walletContext.value = { wallet: record, config, go, proofTx: null };
const renderProof = () => renderToStaticMarkup(createElement(Proof));
const OLD_SWAP = "0x5372c2b13aa087361c62475f8b28f843012a9fb2ae4e4692878d80efcb28fa1e" as Hex;

async function startLive(scenario: Scenario, liveSigner: Pick<Signer, "sign"> = signer) {
  fakeNetwork(scenario);
  startSwap(config, record, liveSigner as Signer, input);
  await advanceUntil(() => !getSession().live?.running);
  return getSession().live;
}

describe("Proof after a swap whose outcome is unknown", () => {
  it("says the status is unknown and does not offer a way back to retry", async () => {
    const live = await startLive({ answer: "lost" });
    expect(live).toMatchObject({ running: false, unresolved: true, stage: "submit" });
    expect(live?.error).toMatch(/status is unknown/);
    const html = renderProof();
    expect(html).toContain("Status unknown");
    expect(html).toContain(`href="https://altmempool.bailo.london/explorer/tx/${live?.txHash}`);
    expect(html).not.toContain("Back to exchange");
    expect(html).toContain("Back to portfolio");
  });

  it("still offers Back to exchange after a definite failure", async () => {
    const live = await startLive({ answer: "refused" });
    expect(live).toMatchObject({ running: false, unresolved: false });
    const html = renderProof();
    expect(html).toContain("Not completed");
    expect(html).toContain("Back to exchange");
  });
});

describe("Proof while a replay hides the live swap", () => {
  it("offers a way back to the swap in progress", async () => {
    // A signature that never arrives keeps the swap running at the sign step.
    const stuck = { sign: () => new Promise<never>(() => {}) };
    fakeNetwork({ answer: "hash" });
    startSwap(config, record, stuck as unknown as Signer, input);
    await advanceUntil(() => getSession().live?.stage === "sign");
    showReplay(OLD_SWAP);
    expect(renderProof()).toContain("Back to live swap");
    showLive();
    expect(getSession().view).toEqual({ kind: "live", id: getSession().live?.id });
    const html = renderProof();
    expect(html).not.toContain("Back to live swap");
    expect(html).toContain("Signing with SLH-DSA-SHA2-128s in your browser");
  });
});
