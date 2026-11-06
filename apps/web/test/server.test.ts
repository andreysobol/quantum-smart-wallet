/**
 * API routes end to end against a fake manifest + fake chain (no network, nothing
 * is ever broadcast). Live read-only smoke with QSW_LIVE_READ=1.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  stringToHex,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { accountAbi, demoUsdcAbi, factoryAbi, verifierAbi } from "../shared/abis.js";
import { accountSalt } from "../shared/account.js";
import { SIGNATURE_CONTEXT } from "../shared/constants.js";
import { fromWire, signingHash, toWire, txHash, verifySignatureEntry } from "../shared/frameTx.js";
import { buildSwapTx } from "../shared/swap.js";
import type { PublicConfig } from "../shared/types.js";
import { ServerContext } from "../server/context.js";
import { readEnv } from "../server/env.js";
import type { Rpc } from "../server/manifest.js";
import { accountRoute, configRoute, faucetRoute, sponsorRoute } from "../server/routes.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const manifest: any = JSON.parse(readFileSync(new URL("../../../slhsol/deployments/shared-devnet.json", import.meta.url), "utf8"));
const PUBLIC_KEY = `0x${"cd".repeat(32)}` as Hex;
const ACCOUNT = getAddress("0x19b17f47284db0b254c62eb9ad6ce95538e3bc30");
const PQ_SIGNATURE = `0x${"5a".repeat(7856)}` as Hex;
const STAKE = 12_000_000_000_000_000n;
const NOW = 1_800_000_000n;
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

interface Fake {
  registered: Set<string>;
  usdcBalance: bigint;
  minter: string;
  sent: Hex[];
  methods: string[];
}

function fakeChain(fake: Fake): Rpc {
  const call = async (method: string, params: unknown[] = []): Promise<unknown> => {
    fake.methods.push(method);
    switch (method) {
      case "eth_chainId":
        return "0x4da3d0a";
      case "web3_clientVersion":
        return "ethrex/v23.0.0-eip8141-tracer-9aa3645d795945c6";
      case "eth_getBlockByNumber":
        return params[0] === "0x0" ? { hash: manifest.genesisHash } : { timestamp: `0x${NOW.toString(16)}` };
      case "eth_getBalance":
        return `0x${(10n ** 19n).toString(16)}`;
      case "eth_getTransactionCount":
        return "0x7";
      case "eth_estimateGas":
        return "0x30d40"; // 200,000
      case "eth_gasPrice":
        return "0x3b9aca00";
      case "eth_sendRawTransaction": {
        // Captured, never broadcast: the fake chain applies the effect.
        const raw = params[0] as Hex;
        fake.sent.push(raw);
        const tx = parseTransaction(raw as `0x${string}`);
        if (same(tx.to, manifest.accountFactory)) fake.registered.add(ACCOUNT.toLowerCase());
        if (same(tx.to, manifest.demoUSDC)) fake.usdcBalance += 1_000_000_000n;
        return keccak256(raw);
      }
      case "eth_getTransactionReceipt":
        return { transactionHash: params[0], blockNumber: "0x99", status: "0x1", gasUsed: "0x1" };
      case "eth_call": {
        const { to, data } = params[0] as { to: string; data: Hex };
        if (same(to, manifest.accountFactory)) {
          const { functionName, args } = decodeFunctionData({ abi: factoryAbi, data });
          if (functionName === "INITIAL_STAKE") return encodeFunctionResult({ abi: factoryAbi, functionName, result: STAKE });
          if (functionName === "getAddress") return encodeFunctionResult({ abi: factoryAbi, functionName, result: ACCOUNT });
          if (functionName === "isAccount") return encodeFunctionResult({ abi: factoryAbi, functionName, result: fake.registered.has(String(args?.[0]).toLowerCase()) });
        }
        if (same(to, manifest.demoUSDC)) {
          const { functionName } = decodeFunctionData({ abi: demoUsdcAbi, data });
          if (functionName === "balanceOf") return encodeFunctionResult({ abi: demoUsdcAbi, functionName, result: fake.usdcBalance });
          if (functionName === "MINTER") return encodeFunctionResult({ abi: demoUsdcAbi, functionName, result: fake.minter as Hex });
        }
        if (same(to, ACCOUNT)) return encodeFunctionResult({ abi: accountAbi, functionName: "publicKey", result: PUBLIC_KEY });
        if (same(to, manifest.verifier)) {
          const { args } = decodeFunctionData({ abi: verifierAbi, data });
          return encodeFunctionResult({ abi: verifierAbi, functionName: "verify", result: args[0] === PUBLIC_KEY && args[3] === PQ_SIGNATURE });
        }
        throw new Error(`unexpected eth_call to ${to}`);
      }
      default:
        throw new Error(`unexpected RPC ${method}`);
    }
  };
  return {
    call: call as Rpc["call"],
    batch: async (calls) => Promise.all(calls.map(async (c) => ({ ok: true as const, result: await call(c.method, c.params) }))),
  };
}

function setup(vars: Record<string, string> = {}, manifestPatch: Record<string, unknown> = {}) {
  const fake: Fake = { registered: new Set(), usdcBalance: 0n, minter: "0x0000000000000000000000000000000000000000", sent: [], methods: [] };
  const ctx = new ServerContext({
    env: readEnv(vars),
    fetchManifest: async () => ({ ...manifest, ...manifestPatch }),
    rpcFor: () => fakeChain(fake),
    operatorOptions: { pollMs: 1, receiptTimeoutMs: 1000 },
  });
  return { ctx, fake };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-real-ip": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const get = (path: string) => new Request(`http://localhost${path}`);

async function errorOf(response: Response) {
  return { status: response.status, ...((await response.json()) as { error: { code: string; message: string } }).error };
}

describe("without an operator key", () => {
  it("GET /api/config still works with operatorReady false and no sponsor", async () => {
    const { ctx } = setup();
    const response = await configRoute(get("/api/config"), ctx);
    expect(response.status).toBe(200);
    const config = (await response.json()) as PublicConfig;
    expect(config).toMatchObject({
      chainId: 81411338,
      genesisHash: manifest.genesisHash.toLowerCase(),
      sponsor: null,
      operatorReady: false,
      faucet: { enabled: false, symbol: "dUSDC", decimals: 6 },
      accountInitialStake: STAKE.toString(),
      poolId: manifest.poolId,
      signature: { algorithm: "SLH-DSA-SHA2-128s", context: SIGNATURE_CONTEXT, bytes: 7856 },
      limits: { maxAmountInUsdc: "1000000000", maxAmountInWeth: "500000000000000000", maxDeadlineSeconds: 3600 },
    });
    expect(config.contracts.accountFactory).toBe(manifest.accountFactory);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("write endpoints answer 503 not_configured", async () => {
    const { ctx } = setup();
    for (const route of [accountRoute, faucetRoute, sponsorRoute]) {
      expect(await errorOf(await route(post("/api/x", {}), ctx))).toMatchObject({ status: 503, code: "not_configured" });
    }
  });
});

describe("with an operator key (fake chain)", () => {
  const operatorKey = generatePrivateKey();
  const operator = privateKeyToAccount(operatorKey);

  it("publishes the sponsor address derived from the key, never the key", async () => {
    const { ctx } = setup({ QSW_OPERATOR_PRIVATE_KEY: operatorKey });
    const text = await (await configRoute(get("/api/config"), ctx)).text();
    expect(JSON.parse(text)).toMatchObject({ sponsor: operator.address, operatorReady: true, faucet: { enabled: true } });
    expect(text).not.toContain(operatorKey.slice(2));
  });

  it("validates inputs: JSON, public keys, addresses, transactions and body size", async () => {
    const { ctx } = setup({ QSW_OPERATOR_PRIVATE_KEY: operatorKey });
    expect(await errorOf(await accountRoute(post("/api/account", "{nope"), ctx))).toMatchObject({ status: 400, message: /valid JSON/ });
    expect(await errorOf(await accountRoute(post("/api/account", { publicKey: "0x1234" }), ctx))).toMatchObject({ status: 400, message: /publicKey/ });
    expect(await errorOf(await accountRoute(post("/api/account", [1]), ctx))).toMatchObject({ status: 400, message: /JSON object/ });
    expect(await errorOf(await faucetRoute(post("/api/faucet", { account: "0xnope" }), ctx))).toMatchObject({ status: 400, message: /account/ });
    expect(await errorOf(await sponsorRoute(post("/api/sponsor", { tx: { chainId: "0x1" } }), ctx))).toMatchObject({ status: 400, message: /Invalid transaction/ });
    const big = JSON.stringify({ publicKey: "x".repeat(70_000) });
    expect(await errorOf(await accountRoute(post("/api/account", big), ctx))).toMatchObject({ status: 413 });
  });

  it("rate limits account creation per IP", async () => {
    const { ctx } = setup({ QSW_OPERATOR_PRIVATE_KEY: operatorKey });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await accountRoute(post("/api/account", {}), ctx)).status);
    expect(statuses).toEqual([400, 400, 400, 400, 400, 400, 429]);
  });

  it("creates an account with the stake as a signed legacy tx, then answers idempotently", async () => {
    const { ctx, fake } = setup({ QSW_OPERATOR_PRIVATE_KEY: operatorKey });
    const response = await accountRoute(post("/api/account", { publicKey: PUBLIC_KEY }), ctx);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ account: ACCOUNT, salt: accountSalt(PUBLIC_KEY), created: true, blockNumber: 0x99, stakeWei: STAKE.toString() });
    expect(fake.sent).toHaveLength(1);
    const raw = fake.sent[0]!;
    const tx = parseTransaction(raw as `0x${string}`);
    expect(tx).toMatchObject({ type: "legacy", chainId: 81411338, nonce: 7, gas: 250_000n, gasPrice: 1_000_000_000n, value: STAKE });
    expect(getAddress(tx.to!)).toBe(manifest.accountFactory);
    expect(tx.data).toBe(encodeFunctionData({ abi: factoryAbi, functionName: "createAccount", args: [PUBLIC_KEY, accountSalt(PUBLIC_KEY)] }));
    expect(await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })).toBe(operator.address);
    const again = await (await accountRoute(post("/api/account", { publicKey: PUBLIC_KEY }), ctx)).json();
    expect(again).toMatchObject({ created: false, txHash: null });
    expect(fake.sent).toHaveLength(1);
  });

  it("faucet mints only to registered accounts below the cap, as the minter", async () => {
    const { ctx, fake } = setup({ QSW_OPERATOR_PRIVATE_KEY: operatorKey });
    expect(await errorOf(await faucetRoute(post("/api/faucet", { account: ACCOUNT }), ctx))).toMatchObject({ status: 403, code: "not_quantum_account" });
    fake.registered.add(ACCOUNT.toLowerCase());
    expect(await errorOf(await faucetRoute(post("/api/faucet", { account: ACCOUNT }), ctx))).toMatchObject({ status: 503, code: "operator_unavailable" });
    fake.minter = operator.address;
    const minted = await faucetRoute(post("/api/faucet", { account: ACCOUNT }), ctx);
    expect(await minted.json()).toMatchObject({ account: ACCOUNT, token: manifest.demoUSDC, amount: "1000000000", blockNumber: 0x99 });
    const tx = parseTransaction(fake.sent[0]! as `0x${string}`);
    expect(tx.data).toBe(encodeFunctionData({ abi: demoUsdcAbi, functionName: "mint", args: [ACCOUNT, 1_000_000_000n] }));
    // A fourth request for the same account within 10 minutes is rate limited.
    expect(await errorOf(await faucetRoute(post("/api/faucet", { account: ACCOUNT }), ctx))).toMatchObject({ status: 429, code: "rate_limited" });
    const capped = setup({ QSW_OPERATOR_PRIVATE_KEY: operatorKey });
    Object.assign(capped.fake, { registered: new Set([ACCOUNT.toLowerCase()]), minter: operator.address, usdcBalance: 5_000_000_000n });
    expect(await errorOf(await faucetRoute(post("/api/faucet", { account: ACCOUNT }), capped.ctx))).toMatchObject({
      status: 422,
      code: "policy_rejected",
      message: /already holds 5000 dUSDC/,
    });
    expect(capped.fake.sent).toHaveLength(0);
  });

  it("sponsors a valid swap: co-signs, keeps the PQ signature, and never submits", async () => {
    const { ctx, fake } = setup({ QSW_OPERATOR_PRIVATE_KEY: operatorKey });
    fake.registered.add(ACCOUNT.toLowerCase());
    const config = (await (await configRoute(get("/api/config"), ctx)).json()) as PublicConfig;
    const unsigned = buildSwapTx({ config, account: ACCOUNT, nonce: 7n, direction: "USDC_TO_WETH", amountIn: 1_000_000n, minOut: 1n, deadline: NOW + 1800n });
    const tx = { ...unsigned, signatures: [{ ...unsigned.signatures[0]!, signature: PQ_SIGNATURE }, unsigned.signatures[1]!] };
    const response = await sponsorRoute(post("/api/sponsor", { tx: toWire(tx) }), ctx);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    const signed = fromWire(body.tx);
    expect(body.sponsor).toBe(operator.address);
    expect(body.signingHash).toBe(signingHash(tx));
    expect(body.txHash).toBe(txHash(signed));
    expect(signed.signatures[0]!.signature).toBe(PQ_SIGNATURE);
    expect((await verifySignatureEntry(signed, 1)).recovered).toBe(operator.address.toLowerCase());
    expect(fake.methods).not.toContain("eth_sendRawTransaction");
    const rejected = await errorOf(await sponsorRoute(post("/api/sponsor", { tx: toWire({ ...tx, signatures: [{ ...tx.signatures[0]!, signature: `0x${"00".repeat(7856)}` }, tx.signatures[1]!] }) }), ctx));
    expect(rejected).toMatchObject({ status: 422, code: "invalid_signature" });
  });

  it("refuses a manifest for another chain or an RPC with another genesis", async () => {
    const wrongChain = setup({}, { chainId: 1 });
    expect(await errorOf(await configRoute(get("/api/config"), wrongChain.ctx))).toMatchObject({ status: 502, code: "upstream_error", message: /chainId/ });
    const wrongGenesis = setup({}, { genesisHash: `0x${"11".repeat(32)}` });
    expect(await errorOf(await configRoute(get("/api/config"), wrongGenesis.ctx))).toMatchObject({ status: 502, message: /genesis/ });
    const wrongPool = setup({}, { poolId: `0x${"22".repeat(32)}` });
    expect(await errorOf(await configRoute(get("/api/config"), wrongPool.ctx))).toMatchObject({ status: 502, message: /poolId/ });
  });

  it("reports invalid key variables by name only", () => {
    const env = readEnv({ QSW_OPERATOR_PRIVATE_KEY: "0xnot-a-key", QSW_FAUCET_AMOUNT: "-5" });
    expect(env.operatorKey).toBeNull();
    expect(env.problems.join(" ")).toMatch(/QSW_OPERATOR_PRIVATE_KEY.*QSW_FAUCET_AMOUNT/);
    expect(env.problems.join(" ")).not.toContain("not-a-key");
  });
});

describe.skipIf(process.env.QSW_LIVE_READ !== "1")("live read-only smoke (QSW_LIVE_READ=1)", () => {
  it("serves /api/config from the published manifest and verified RPC", async () => {
    const ctx = new ServerContext({ env: readEnv({}) });
    const response = await configRoute(get("/api/config"), ctx);
    const config = (await response.json()) as PublicConfig;
    expect(response.status, JSON.stringify(config)).toBe(200);
    expect(config).toMatchObject({ chainId: 81411338, operatorReady: false, sponsor: null, accountInitialStake: STAKE.toString() });
  });

  it("the deployed verifier accepts the demo's PQ signature exactly as the policy calls it", async () => {
    const evidence = (name: string) => JSON.parse(readFileSync(new URL(`../../../demo/evidence/shared-devnet/${name}`, import.meta.url), "utf8"));
    const report = evidence("report.json");
    const mined = fromWire(evidence("transaction.json"));
    const data = encodeFunctionData({
      abi: verifierAbi,
      functionName: "verify",
      args: [report.publicKey, signingHash(mined), stringToHex(SIGNATURE_CONTEXT), mined.signatures[0]!.signature],
    });
    const reply = await fetch(manifest.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: manifest.verifier, data, gas: "0x989680" }, "latest"] }),
    }).then((r) => r.json() as Promise<{ result: Hex }>);
    expect(BigInt(reply.result)).toBe(1n);
  });
});
