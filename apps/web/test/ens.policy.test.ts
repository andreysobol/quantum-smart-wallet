/**
 * Sponsorship of Devnet ENSv2 registrations: the explicit template, its live checks and the route.
 * The swap policy is covered by policy.test.ts and must not change.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accountAbi, demoUsdcAbi, factoryAbi, verifierAbi } from "../shared/abis.js";
import { buildRegisterTx, encodeRegister, priceFor, YEAR_SECONDS, type EnsTxConfig } from "../shared/ens.js";
import { ensRegistrarAbi, ensVaultFactoryAbi } from "../shared/ensAbis.js";
import { toWire, type FrameTx } from "../shared/frameTx.js";
import { RpcError } from "../shared/rpc.js";
import type { Address } from "../shared/types.js";
import { ServerContext } from "../server/context.js";
import { parseEnsSection } from "../server/ens.js";
import { checkEnsSponsorPolicy, type EnsPolicyContext } from "../server/ensPolicy.js";
import { readEnv } from "../server/env.js";
import type { Rpc } from "../server/manifest.js";
import { sponsorRoute } from "../server/routes.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const manifest: any = JSON.parse(readFileSync(new URL("../../../slhsol/deployments/shared-devnet.json", import.meta.url), "utf8"));
const ens = parseEnsSection(manifest.ens);
const ACCOUNT = "0x19b17f47284db0b254c62eb9ad6ce95538e3bc30" as Address;
const SPONSOR = "0xb7ca4c821205f6721bacbd48052bebf6a1f252c1" as Address;
const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const RESOLVER = "0x2222222222222222222222222222222222222222" as Address;
const PUBLIC_KEY = `0x${"cd".repeat(32)}` as Hex;
const PQ_SIGNATURE = `0x${"5a".repeat(7856)}` as Hex;
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const contracts = { accountFactory: manifest.accountFactory, demoUSDC: manifest.demoUSDC, verifier: manifest.verifier } as never;

interface Chain {
  registered: boolean;
  nonce: bigint;
  available: boolean;
  pricePerYear: bigint;
  dusdc: bigint;
  vault: Address;
  resolver: Address;
}

function fakeRpc(chain: Chain): Rpc {
  const call = async (method: string, params: unknown[] = []): Promise<unknown> => {
    if (method === "eth_getTransactionCount") return `0x${chain.nonce.toString(16)}`;
    if (method === "eth_getBalance") return `0x${(10n ** 21n).toString(16)}`;
    if (method !== "eth_call") throw new Error(`unexpected RPC ${method}`);
    const { to, data } = params[0] as { to: string; data: Hex };
    if (same(to, manifest.accountFactory)) return encodeFunctionResult({ abi: factoryAbi, functionName: "isAccount", result: chain.registered });
    if (same(to, ens.vaultFactory)) {
      const { functionName } = decodeFunctionData({ abi: ensVaultFactoryAbi, data });
      return encodeFunctionResult({ abi: ensVaultFactoryAbi, functionName, result: functionName === "vaultAddress" ? chain.vault : chain.resolver } as never);
    }
    if (same(to, ens.registrar)) {
      const { functionName, args } = decodeFunctionData({ abi: ensRegistrarAbi, data });
      if (functionName === "isAvailable") return encodeFunctionResult({ abi: ensRegistrarAbi, functionName, result: chain.available });
      if (functionName === "getPrice") {
        return encodeFunctionResult({ abi: ensRegistrarAbi, functionName, result: (chain.pricePerYear * (args[0] as bigint)) / 31_536_000n });
      }
    }
    if (same(to, ens.paymentToken)) return encodeFunctionResult({ abi: demoUsdcAbi, functionName: "balanceOf", result: chain.dusdc });
    if (same(to, ACCOUNT)) return encodeFunctionResult({ abi: accountAbi, functionName: "publicKey", result: PUBLIC_KEY });
    if (same(to, manifest.verifier)) {
      const { args } = decodeFunctionData({ abi: verifierAbi, data });
      return encodeFunctionResult({ abi: verifierAbi, functionName: "verify", result: args[0] === PUBLIC_KEY && args[3] === PQ_SIGNATURE });
    }
    throw new Error(`unexpected eth_call to ${to}`);
  };
  return {
    call: call as Rpc["call"],
    batch: async (calls) => Promise.all(calls.map(async (c) => ({ ok: true as const, result: await call(c.method, c.params) }))),
  };
}

const honest = (): Chain => ({ registered: true, nonce: 7n, available: true, pricePerYear: 5_000_000n, dusdc: 50_000_000n, vault: VAULT, resolver: RESOLVER });
const txConfig: EnsTxConfig = { chainId: manifest.chainId, sponsor: SPONSOR, ens };

function signedTx(overrides: Partial<Parameters<typeof buildRegisterTx>[0]> = {}): FrameTx {
  const tx = buildRegisterTx({ config: txConfig, account: ACCOUNT, nonce: 7n, label: "alice", years: 2, price: priceFor(ens, 2), vault: VAULT, resolver: RESOLVER, ...overrides });
  return { ...tx, signatures: tx.signatures.map((s, i) => (i === 0 ? { ...s, signature: PQ_SIGNATURE } : s)) };
}

const ctxFor = (chain: Chain): EnsPolicyContext => ({ deployment: { chainId: manifest.chainId, contracts, ens }, sponsor: SPONSOR, reserve: 0n, rpc: fakeRpc(chain) });

describe("ens registration policy", () => {
  it("accepts the account's own registration at the quoted price", async () => {
    await expect(checkEnsSponsorPolicy(signedTx(), ctxFor(honest()))).resolves.toMatchObject({
      name: "alice.qsw.eth",
      years: 2,
      price: 10_000_000n,
      vault: VAULT,
      resolver: RESOLVER,
    });
  });

  const cases: [string, Partial<Chain>, Partial<Parameters<typeof buildRegisterTx>[0]>, { status?: number; message: RegExp }][] = [
    ["a taken name", { available: false }, {}, { message: /alice\.qsw\.eth is already registered/ }],
    ["a payment below the quote", {}, { price: 9_999_999n }, { message: /quoted price of 10000000/ }],
    ["a payment above the quote", {}, { price: 10_000_001n }, { message: /quoted price/ }],
    ["an account without the dUSDC", { dusdc: 9_000_000n }, {}, { message: /less than the 10000000/ }],
    ["another account's vault", {}, { vault: "0x3333333333333333333333333333333333333333" }, { message: /sender's own vault/ }],
    ["another resolver", {}, { resolver: "0x3333333333333333333333333333333333333333" }, { message: /sender's own resolver/ }],
    ["an address that is not a factory account", { registered: false }, {}, { status: 403, message: /not a QuantumAccount/ }],
    ["a stale nonce", { nonce: 8n }, {}, { message: /does not match the account nonce 8/ }],
  ];
  it.each(cases)("rejects %s", async (_what, chainPatch, txPatch, expected) => {
    const error = await checkEnsSponsorPolicy(signedTx(txPatch), ctxFor({ ...honest(), ...chainPatch })).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: expected.status ?? 422, message: expect.stringMatching(expected.message) });
  });

  it("rejects a signature that does not verify", async () => {
    const tx = signedTx();
    const forged = { ...tx, signatures: tx.signatures.map((s, i) => (i === 0 ? { ...s, signature: `0x${"5b".repeat(7856)}` as Hex } : s)) };
    await expect(checkEnsSponsorPolicy(forged, ctxFor(honest()))).rejects.toMatchObject({ status: 422, code: "invalid_signature" });
  });

  it("rejects changed gas limits, fees and unnormalized labels before any network read", async () => {
    const tx = signedTx();
    const raised = { ...tx, frames: tx.frames.map((f, i) => (i === 2 ? { ...f, limits: { ...f.limits, state: f.limits.state + 1n } } : f)) };
    await expect(checkEnsSponsorPolicy(raised, ctxFor(honest()))).rejects.toThrow(/byte for byte/);
    await expect(checkEnsSponsorPolicy({ ...tx, fees: { ...tx.fees, maxFeePerGas: 3_000_000_000n } }, ctxFor(honest()))).rejects.toThrow(/Fees must be exactly/);
    const unnormalized = encodeRegister({ label: "Alice", owner: VAULT, resolver: RESOLVER, duration: 2n * YEAR_SECONDS });
    const tampered = { ...tx, frames: tx.frames.map((f, i) => (i === 4 ? { ...f, data: unnormalized } : f)) };
    await expect(checkEnsSponsorPolicy(tampered, ctxFor(honest()))).rejects.toThrow(/Registration frames rejected: the label must be a normalized/);
  });
});

describe("POST /api/sponsor kinds", () => {
  const operatorKey = `0x${"11".repeat(32)}` as Hex;
  const chainRpc: Rpc = {
    call: (async (method: string) => {
      if (method === "eth_chainId") return "0x4da3d0a";
      throw new Error(`unexpected RPC ${method}`);
    }) as Rpc["call"],
    batch: async (calls) =>
      calls.map((c) => {
        if (c.method === "eth_chainId") return { ok: true as const, result: "0x4da3d0a" };
        if (c.method === "eth_getBlockByNumber") return { ok: true as const, result: { hash: manifest.genesisHash } };
        if (c.method === "web3_clientVersion") return { ok: true as const, result: "ethrex/eip8141-tracer-9aa3645d" };
        const to = (c.params?.[0] as { to?: string } | undefined)?.to ?? "";
        if (c.method === "eth_call" && same(to, manifest.accountFactory)) {
          return { ok: true as const, result: encodeFunctionResult({ abi: factoryAbi, functionName: "INITIAL_STAKE", result: 12n * 10n ** 15n }) };
        }
        return { ok: false as const, error: new RpcError(-32000, "unavailable", c.method) };
      }),
  };
  const ctx = new ServerContext({
    env: readEnv({ QSW_OPERATOR_PRIVATE_KEY: operatorKey }),
    fetchManifest: async () => manifest,
    rpcFor: () => chainRpc,
  });
  const post = (body: unknown) =>
    new Request("http://localhost/api/sponsor", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-real-ip": "203.0.113.7" },
      body: JSON.stringify(body),
    });
  const tx = toWire(signedTx({ sponsor: privateKeyToAccount(operatorKey).address }));

  it("refuses unknown kinds", async () => {
    const response = await sponsorRoute(post({ tx, kind: "mint" }), ctx);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: 'kind must be "swap" or "ens-register".' } });
  });

  it("answers 503 for registrations when the namespace did not verify", async () => {
    const response = await sponsorRoute(post({ tx, kind: "ens-register" }), ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "not_configured", message: /Devnet ENSv2/ } });
  });
});
