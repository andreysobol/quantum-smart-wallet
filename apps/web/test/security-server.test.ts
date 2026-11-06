/**
 * Server hardening against hostile requests, through the real routes with a fake manifest and a
 * fake chain (no network; nothing is broadcast):
 * - swap calldata is size-checked before any ABI decoding, and sponsor bodies are small;
 * - writes are same-origin JSON only (no cross-site "simple" POSTs);
 * - per-account limits only count requests that could act for the account;
 * - the devnet genesis is pinned, and the operator caps the stake and gas price it signs;
 * - the dev/preview server takes the client IP from the socket, not from request headers.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, parseTransaction, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { accountAbi, demoUsdcAbi, factoryAbi, verifierAbi } from "../shared/abis.js";
import { MAX_NONCE_SEQ, toWire, type FrameTx } from "../shared/frameTx.js";
import { buildSwapTx, decodeErc20Approve, decodeGuardedSwap, decodePermit2Approve } from "../shared/swap.js";
import type { PublicConfig } from "../shared/types.js";
import { ServerContext } from "../server/context.js";
import { toRequest } from "../server/dev.js";
import { readEnv } from "../server/env.js";
import { BODY_LIMIT, clientIp } from "../server/http.js";
import type { Rpc } from "../server/manifest.js";
import { accountRoute, configRoute, faucetRoute, sponsorRoute } from "../server/routes.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const manifest: any = JSON.parse(readFileSync(new URL("../../../slhsol/deployments/shared-devnet.json", import.meta.url), "utf8"));
const APP = "https://wallet.example";
const OPERATOR_KEY = generatePrivateKey();
const OPERATOR = privateKeyToAccount(OPERATOR_KEY);
const PUBLIC_KEY = `0x${"cd".repeat(32)}` as Hex;
const PQ_SIGNATURE = `0x${"5a".repeat(7856)}` as Hex;
const NOW = 1_800_000_000n;
const GWEI = 10n ** 9n;
const ETHER = 10n ** 18n;
const OTHER_GENESIS = `0x${"11".repeat(32)}` as Hex;
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
/** The fake factory's CREATE2 prediction: one account per public key. */
const accountOf = (publicKey: Hex) => getAddress(`0x${keccak256(publicKey).slice(-40)}`);
const ACCOUNT = accountOf(PUBLIC_KEY);
/** Any nonzero 32 bytes passes as an SLH-DSA public key. */
const freshKey = (): Hex => generatePrivateKey();

interface Fake {
  genesisHash: string;
  stake: bigint;
  gasPrice: bigint;
  registered: Set<string>;
  usdcBalance: bigint;
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
        return params[0] === "0x0" ? { hash: fake.genesisHash } : { timestamp: `0x${NOW.toString(16)}` };
      case "eth_getBalance":
        return `0x${(100n * ETHER).toString(16)}`;
      case "eth_getTransactionCount":
        return "0x7";
      case "eth_estimateGas":
        return "0x30d40";
      case "eth_gasPrice":
        return `0x${fake.gasPrice.toString(16)}`;
      case "eth_sendRawTransaction": {
        // Captured, never broadcast: the fake chain applies the effect.
        const raw = params[0] as Hex;
        fake.sent.push(raw);
        const tx = parseTransaction(raw as `0x02${string}`);
        if (same(tx.to, manifest.accountFactory)) {
          const { args } = decodeFunctionData({ abi: factoryAbi, data: tx.data as Hex });
          fake.registered.add(accountOf(args?.[0] as Hex).toLowerCase());
        }
        if (same(tx.to, manifest.demoUSDC)) fake.usdcBalance += 1_000_000_000n;
        return keccak256(raw);
      }
      case "eth_getTransactionReceipt":
        return { transactionHash: params[0], blockNumber: "0x99", status: "0x1", gasUsed: "0x1" };
      case "eth_call": {
        const { to, data } = params[0] as { to: string; data: Hex };
        if (same(to, manifest.accountFactory)) {
          const { functionName, args } = decodeFunctionData({ abi: factoryAbi, data });
          if (functionName === "INITIAL_STAKE") return encodeFunctionResult({ abi: factoryAbi, functionName, result: fake.stake });
          if (functionName === "getAddress") return encodeFunctionResult({ abi: factoryAbi, functionName, result: accountOf(args?.[0] as Hex) });
          if (functionName === "isAccount") return encodeFunctionResult({ abi: factoryAbi, functionName, result: fake.registered.has(String(args?.[0]).toLowerCase()) });
        }
        if (same(to, manifest.demoUSDC)) {
          const { functionName } = decodeFunctionData({ abi: demoUsdcAbi, data });
          if (functionName === "balanceOf") return encodeFunctionResult({ abi: demoUsdcAbi, functionName, result: fake.usdcBalance });
          if (functionName === "MINTER") return encodeFunctionResult({ abi: demoUsdcAbi, functionName, result: OPERATOR.address });
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

function setup(vars: Record<string, string> = {}, chain: Partial<Fake> = {}, manifestPatch: Record<string, unknown> = {}) {
  const fake: Fake = {
    genesisHash: manifest.genesisHash,
    stake: 12_000_000_000_000_000n,
    gasPrice: GWEI,
    registered: new Set(),
    usdcBalance: 0n,
    sent: [],
    methods: [],
    ...chain,
  };
  const ctx = new ServerContext({
    env: readEnv({ QSW_OPERATOR_PRIVATE_KEY: OPERATOR_KEY, ...vars }),
    fetchManifest: async () => ({ ...manifest, ...manifestPatch }),
    rpcFor: () => fakeChain(fake),
    operatorOptions: { pollMs: 1, receiptTimeoutMs: 1000 },
  });
  return { ctx, fake };
}

/** What the app's own page sends: a same-origin fetch with a JSON body. */
const SAME_ORIGIN = { "Content-Type": "application/json", Origin: APP, "Sec-Fetch-Site": "same-origin" };

const post = (path: string, body: unknown, headers: Record<string, string> = SAME_ORIGIN, ip = "203.0.113.9") =>
  new Request(`${APP}${path}`, {
    method: "POST",
    headers: { ...headers, "x-real-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const get = (path: string) => new Request(`${APP}${path}`);

async function errorOf(response: Response) {
  return { status: response.status, ...((await response.json()) as { error: { code: string; message: string } }).error };
}

const configOf = async (ctx: ServerContext) => (await (await configRoute(get("/api/config"), ctx)).json()) as PublicConfig;

function signedSwap(config: PublicConfig, amountIn = 1_000_000n): FrameTx {
  const unsigned = buildSwapTx({ config, account: ACCOUNT, nonce: 7n, direction: "USDC_TO_WETH", amountIn, minOut: 1n, deadline: NOW + 1800n });
  return { ...unsigned, signatures: [{ ...unsigned.signatures[0]!, signature: PQ_SIGNATURE }, unsigned.signatures[1]!] };
}

const withFrame = (tx: FrameTx, i: number, patch: Partial<FrameTx["frames"][number]>): FrameTx => ({
  ...tx,
  frames: tx.frames.map((f, j) => (j === i ? { ...f, ...patch } : f)),
});

/**
 * execute(0x10, inputs, 0) whose `inputs` elements overlap: each length word claims every byte to
 * the end of the calldata, so a generic decoder materialises O(size^2) bytes.
 */
function overlappingExecute(size: number): Hex {
  const word = (n: number) => n.toString(16).padStart(64, "0");
  const words = Array<string>(size / 32).fill(word(0));
  const count = Math.floor((size - 192) / 128);
  const firstLength = 192 + 32 * count;
  words[0] = word(0x60); // commands offset
  words[1] = word(0xa0); // inputs offset
  words[3] = word(1); // commands length
  words[4] = "10".padEnd(64, "0"); // V4_SWAP
  words[5] = word(count); // inputs length
  for (let i = 0; i < count; i++) {
    const at = firstLength + 64 * i;
    words[6 + i] = word(at - 192); // element offset (relative to the array data)
    words[at / 32] = word(size - at - 32); // element length: to the end
  }
  return `0x3593564c${words.join("")}`;
}

describe("sponsor requests cannot make the server do unbounded work", () => {
  it("the swap template's calldata sizes are fixed (both directions, any amounts)", async () => {
    const config = await configOf(setup().ctx);
    for (const direction of ["USDC_TO_WETH", "WETH_TO_USDC"] as const) {
      for (const amount of [1n, (1n << 128n) - 1n]) {
        const tx = buildSwapTx({ config, account: ACCOUNT, nonce: 0n, direction, amountIn: amount, minOut: amount, deadline: (1n << 48n) - 1n });
        expect(tx.frames.slice(2).map((f) => (f.data.length - 2) / 2)).toEqual([68, 132, 1124]);
      }
    }
  });

  it("decoders check the exact size before handing calldata to the ABI decoder", () => {
    expect(() => decodeGuardedSwap(overlappingExecute(16_384))).toThrow(/expected 1124 bytes, got 16388/);
    expect(() => decodeErc20Approve(`0x095ea7b3${"00".repeat(96)}`)).toThrow(/expected 68 bytes, got 100/);
    expect(() => decodePermit2Approve(`0x87517c45${"00".repeat(160)}`)).toThrow(/expected 132 bytes, got 164/);
  });

  it("a hostile frame 4 inside the body limit is refused before decoding and before any chain read", async () => {
    const { ctx, fake } = setup({}, { registered: new Set([ACCOUNT.toLowerCase()]) });
    const wire = toWire(signedSwap(await configOf(ctx)));
    wire.frames[4]!.data = overlappingExecute(6_144);
    const body = JSON.stringify({ tx: wire });
    expect(body.length).toBeLessThan(BODY_LIMIT.sponsor);
    fake.methods.length = 0;
    expect(await errorOf(await sponsorRoute(post("/api/sponsor", body), ctx))).toMatchObject({
      status: 422,
      code: "policy_rejected",
      message: "Swap frames rejected: guarded swap: non-canonical ABI encoding (expected 1124 bytes, got 6148).",
    });
    expect(fake.methods).toEqual([]);
  });

  it("caps sponsor bodies near the size of the largest real signed swap", async () => {
    const { ctx } = setup({}, { registered: new Set([ACCOUNT.toLowerCase()]) });
    const config = await configOf(ctx);
    for (const direction of ["USDC_TO_WETH", "WETH_TO_USDC"] as const) {
      const max = (1n << 128n) - 1n;
      const unsigned = buildSwapTx({ config, account: ACCOUNT, nonce: MAX_NONCE_SEQ, direction, amountIn: max, minOut: max, deadline: (1n << 48n) - 1n });
      const largest = JSON.stringify({ tx: toWire({ ...unsigned, signatures: [{ ...unsigned.signatures[0]!, signature: PQ_SIGNATURE }, unsigned.signatures[1]!] }) });
      expect(largest.length * 1.25).toBeLessThan(BODY_LIMIT.sponsor);
    }
    expect(BODY_LIMIT.sponsor).toBeLessThanOrEqual(32 * 1024);
    const padded = JSON.stringify({ tx: toWire(signedSwap(config)), pad: "x".repeat(20_000) });
    expect(await errorOf(await sponsorRoute(post("/api/sponsor", padded), ctx))).toMatchObject({ status: 413, code: "bad_request" });
  });
});

describe("writes are same-origin JSON only", () => {
  const crossSite: Record<string, Record<string, string>> = {
    "a text/plain simple request from another site": { "Content-Type": "text/plain;charset=UTF-8", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    "a text/plain request without Origin or Sec-Fetch-Site": { "Content-Type": "text/plain;charset=UTF-8" },
    "a form post": { "Content-Type": "application/x-www-form-urlencoded" },
    "JSON marked cross-site": { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    "JSON marked same-site (a sibling subdomain)": { "Content-Type": "application/json", "Sec-Fetch-Site": "same-site" },
    "JSON from a foreign Origin": { "Content-Type": "application/json", Origin: "https://evil.example" },
    "JSON from an opaque Origin": { "Content-Type": "application/json", Origin: "null" },
    "JSON from a look-alike Origin": { "Content-Type": "application/json", Origin: "https://wallet.example.evil.example" },
  };
  const routes = { "/api/account": accountRoute, "/api/faucet": faucetRoute, "/api/sponsor": sponsorRoute };

  it("refuses cross-site writes before any work, without using the visitor's rate limit", async () => {
    const { ctx, fake } = setup({}, { registered: new Set([ACCOUNT.toLowerCase()]) });
    const config = await configOf(ctx);
    const bodies = { "/api/account": { publicKey: freshKey() }, "/api/faucet": { account: ACCOUNT }, "/api/sponsor": { tx: toWire(signedSwap(config)) } };
    fake.methods.length = 0;
    for (const [path, route] of Object.entries(routes)) {
      for (const [name, headers] of Object.entries(crossSite)) {
        const error = await errorOf(await route(post(path, bodies[path as keyof typeof bodies], headers), ctx));
        expect([403, 415], `${path}: ${name}`).toContain(error.status);
        expect(error.code, `${path}: ${name}`).toBe("bad_request");
      }
    }
    expect(fake.methods).toEqual([]);
    // The same IP still has its whole account-creation allowance (6 per hour).
    for (let i = 0; i < 6; i++) expect((await accountRoute(post("/api/account", { publicKey: freshKey() }), ctx)).status).toBe(200);
  });

  it("accepts same-origin JSON and non-browser clients (no Origin, no Sec-Fetch-Site)", async () => {
    const { ctx } = setup();
    const allowed: Record<string, string>[] = [
      SAME_ORIGIN,
      { "Content-Type": "application/json; charset=utf-8", Origin: APP },
      { "Content-Type": "application/json", "Sec-Fetch-Site": "none" },
      { "Content-Type": "application/json" },
    ];
    for (const headers of allowed) {
      const response = await accountRoute(post("/api/account", { publicKey: freshKey() }, headers), ctx);
      expect(response.status, JSON.stringify(headers)).toBe(200);
    }
    // A platform may hand the function an internal URL; the public host is then in Host or X-Forwarded-Host.
    for (const header of ["Host", "X-Forwarded-Host"]) {
      const behindProxy = new Request("http://10.0.0.5:3000/api/account", {
        method: "POST",
        headers: { ...SAME_ORIGIN, [header]: "wallet.example", "x-real-ip": "203.0.113.20" },
        body: JSON.stringify({ publicKey: freshKey() }),
      });
      expect((await accountRoute(behindProxy, ctx)).status, header).toBe(200);
    }
  });
});

describe("per-account limits only count requests that could act for the account", () => {
  it("junk sponsor requests naming someone else's account do not lock that account out", async () => {
    const { ctx } = setup({}, { registered: new Set([ACCOUNT.toLowerCase()]) });
    const valid = signedSwap(await configOf(ctx));
    const badLimits = withFrame(valid, 0, { limits: { execution: 1n, state: 0n } });
    const badSignature: FrameTx = { ...valid, signatures: [{ ...valid.signatures[0]!, signature: `0x${"a5".repeat(7856)}` }, valid.signatures[1]!] };
    for (let i = 0; i < 10; i++) {
      expect((await sponsorRoute(post("/api/sponsor", { tx: toWire(badLimits) }, SAME_ORIGIN, "198.51.100.66"), ctx)).status).toBe(422);
      expect((await sponsorRoute(post("/api/sponsor", { tx: toWire(badSignature) }, SAME_ORIGIN, "198.51.100.66"), ctx)).status).toBe(422);
    }
    const response = await sponsorRoute(post("/api/sponsor", { tx: toWire(valid) }, SAME_ORIGIN, "203.0.113.5"), ctx);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  });

  it("limits co-signs per account, but replays of a co-signed swap are free", async () => {
    const { ctx } = setup({}, { registered: new Set([ACCOUNT.toLowerCase()]) });
    const config = await configOf(ctx);
    // Once submitted, a signed swap is public: anyone can resubmit it, here 20 times at once.
    const published = toWire(signedSwap(config));
    const replays = await Promise.all(Array.from({ length: 20 }, (_, i) => sponsorRoute(post("/api/sponsor", { tx: published }, SAME_ORIGIN, `198.51.100.${i}`), ctx)));
    expect(replays.map((r) => r.status)).toEqual(Array(20).fill(200));
    // The owner's allowance is intact: 14 more swaps make 15, then the limit applies.
    for (let i = 1; i < 15; i++) expect((await sponsorRoute(post("/api/sponsor", { tx: toWire(signedSwap(config, 1_000_000n + BigInt(i))) }), ctx)).status).toBe(200);
    expect(await errorOf(await sponsorRoute(post("/api/sponsor", { tx: toWire(signedSwap(config, 2_000_000n)) }), ctx))).toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("faucet requests only count against an account when they mint", async () => {
    const { ctx, fake } = setup();
    for (let i = 0; i < 5; i++) {
      expect(await errorOf(await faucetRoute(post("/api/faucet", { account: ACCOUNT }), ctx))).toMatchObject({ status: 403, code: "not_quantum_account" });
    }
    fake.registered.add(ACCOUNT.toLowerCase());
    fake.usdcBalance = 5_000_000_000n;
    for (let i = 0; i < 2; i++) {
      expect(await errorOf(await faucetRoute(post("/api/faucet", { account: ACCOUNT }), ctx))).toMatchObject({ status: 422, code: "policy_rejected" });
    }
    fake.usdcBalance = 0n;
    for (let i = 0; i < 3; i++) expect((await faucetRoute(post("/api/faucet", { account: ACCOUNT }), ctx)).status).toBe(200);
    expect(await errorOf(await faucetRoute(post("/api/faucet", { account: ACCOUNT }), ctx))).toMatchObject({ status: 429, code: "rate_limited" });
    expect(fake.sent).toHaveLength(3);
  });
});

describe("the devnet is pinned, and the operator caps what it signs", () => {
  it("refuses a manifest and an RPC that agree on another genesis, and an RPC that disagrees with the pin", async () => {
    const { ctx } = setup({}, { genesisHash: OTHER_GENESIS }, { genesisHash: OTHER_GENESIS });
    expect(await errorOf(await configRoute(get("/api/config"), ctx))).toMatchObject({
      status: 502,
      code: "upstream_error",
      message: "Deployment manifest is invalid: genesisHash is not the pinned devnet genesis",
    });
    const rpcOnly = setup({}, { genesisHash: OTHER_GENESIS });
    expect(await errorOf(await configRoute(get("/api/config"), rpcOnly.ctx))).toMatchObject({ status: 502, message: expect.stringMatching(/RPC endpoint's genesis/) });
  });

  it("QSW_GENESIS_HASH replaces the pin explicitly", async () => {
    const moved = setup({ QSW_GENESIS_HASH: OTHER_GENESIS }, { genesisHash: OTHER_GENESIS }, { genesisHash: OTHER_GENESIS });
    const response = await configRoute(get("/api/config"), moved.ctx);
    expect(response.status).toBe(200);
    expect(((await response.json()) as PublicConfig).genesisHash).toBe(OTHER_GENESIS);
    expect((await configRoute(get("/api/config"), setup({ QSW_GENESIS_HASH: OTHER_GENESIS }).ctx)).status).toBe(502);
    const invalid = readEnv({ QSW_GENESIS_HASH: "0x1234" });
    expect(invalid.genesisHash).toBeNull();
    expect(invalid.problems.join(" ")).toMatch(/QSW_GENESIS_HASH/);
  });

  it("pays no stake above QSW_MAX_ACCOUNT_STAKE (default 0.012 ETH)", async () => {
    const { ctx, fake } = setup({}, { stake: ETHER });
    expect(await errorOf(await accountRoute(post("/api/account", { publicKey: freshKey() }), ctx))).toMatchObject({
      status: 503,
      code: "operator_unavailable",
      message: expect.stringMatching(/stake/),
    });
    expect(fake.sent).toHaveLength(0);
    const raised = setup({ QSW_MAX_ACCOUNT_STAKE: ETHER.toString() }, { stake: ETHER });
    expect((await accountRoute(post("/api/account", { publicKey: freshKey() }), raised.ctx)).status).toBe(200);
    expect(parseTransaction(raised.fake.sent[0]! as `0x02${string}`).value).toBe(ETHER);
  });

  it("signs no gas price above 10 gwei, whatever the RPC quotes", async () => {
    const { ctx, fake } = setup({}, { gasPrice: 50n * GWEI });
    expect(await errorOf(await accountRoute(post("/api/account", { publicKey: freshKey() }), ctx))).toMatchObject({
      status: 503,
      code: "operator_unavailable",
      message: expect.stringMatching(/gas price/),
    });
    expect(fake.methods).not.toContain("eth_sendRawTransaction");
    const atCap = setup({}, { gasPrice: 10n * GWEI });
    expect((await accountRoute(post("/api/account", { publicKey: freshKey() }), atCap.ctx)).status).toBe(200);
    expect(parseTransaction(atCap.fake.sent[0]! as `0x02${string}`).gasPrice).toBe(10n * GWEI);
  });
});

describe("dev/preview API server", () => {
  it("takes the client IP from the socket and drops client-supplied forwarding headers", () => {
    const req = {
      method: "GET",
      url: "/api/config",
      headers: { host: "localhost:4173", "x-real-ip": "10.0.0.1", "x-forwarded-for": "10.0.0.2, 10.0.0.3", "x-vercel-forwarded-for": "10.0.0.4" },
      socket: { remoteAddress: "192.0.2.10" },
    } as unknown as IncomingMessage;
    const request = toRequest(req);
    expect(clientIp(request)).toBe("192.0.2.10");
    expect(request.headers.get("x-forwarded-for")).toBeNull();
    expect(request.headers.get("x-vercel-forwarded-for")).toBeNull();
    expect(new URL(request.url).host).toBe("localhost:4173");
  });
});
