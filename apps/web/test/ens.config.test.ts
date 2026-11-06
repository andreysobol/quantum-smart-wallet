/**
 * Server-side Devnet ENSv2 configuration: the manifest section, its on-chain verification, the bundled
 * fallback and /api/config.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionResult, type Abi, type Hex } from "viem";
import { ensRegistrarAbi, ensRegistryAbi, ensVaultFactoryAbi, universalResolverAbi } from "../shared/ensAbis.js";
import type { Address, EnsDeployment } from "../shared/types.js";
import { BUNDLED_ENS_SECTION, ENS_MAX_YEARS, loadEns, parseEnsSection, verifyEns } from "../server/ens.js";
import { httpRpc, type Rpc } from "../server/manifest.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const manifest: any = JSON.parse(readFileSync(new URL("../../../slhsol/deployments/shared-devnet.json", import.meta.url), "utf8"));
const contracts = { accountFactory: manifest.accountFactory as Address, demoUSDC: manifest.demoUSDC as Address };
const ens = parseEnsSection(manifest.ens);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Answers the verification reads from a namespace description; `patch` falsifies one answer. */
function fakeEnsChain(n: EnsDeployment, patch: Partial<Record<string, unknown>> = {}): Rpc {
  const answer = (to: string, data: Hex): Hex => {
    const tables: [string, Abi][] = [
      [n.rootRegistry, ensRegistryAbi],
      [n.ethRegistry, ensRegistryAbi],
      [n.qswRegistry, ensRegistryAbi],
      [n.universalResolver, universalResolverAbi],
      [n.registrar, ensRegistrarAbi],
      [n.vaultFactory, ensVaultFactoryAbi],
    ];
    const abi = tables.find(([address]) => same(address, to))?.[1];
    if (!abi) throw new Error(`unexpected eth_call to ${to}`);
    const { functionName, args } = decodeFunctionData({ abi, data });
    const truth: Record<string, unknown> = {
      getSubregistry: same(to, n.rootRegistry) ? n.ethRegistry : n.qswRegistry,
      getParent: [n.ethRegistry, "qsw"],
      ROOT_REGISTRY: n.rootRegistry,
      REGISTRY: n.qswRegistry,
      PAYMENT_TOKEN: n.paymentToken,
      PRICE: BigInt(n.pricePerYear),
      MIN_DURATION: BigInt(n.minDuration),
      hasRootRoles: same(String(args?.[1]), n.registrar),
      ACCOUNT_FACTORY: contracts.accountFactory,
      PROXY_FACTORY: n.verifiableFactory,
      RESOLVER_IMPLEMENTATION: n.resolverImplementation,
      ...patch,
    };
    return encodeFunctionResult({ abi, functionName, result: truth[functionName] } as never);
  };
  const call = async (method: string, params: unknown[] = []) => {
    if (method !== "eth_call") throw new Error(`unexpected RPC ${method}`);
    const { to, data } = params[0] as { to: string; data: Hex };
    return answer(to, data);
  };
  return {
    call: call as Rpc["call"],
    batch: async (calls) =>
      Promise.all(calls.map(async (c) => ({ ok: true as const, result: await call(c.method, c.params) }))),
  };
}

describe("manifest ens section", () => {
  it("bundles exactly the manifest's section", () => {
    expect(BUNDLED_ENS_SECTION).toEqual(manifest.ens && Object.fromEntries(Object.entries(manifest.ens).filter(([k]) => k in BUNDLED_ENS_SECTION)));
    expect(parseEnsSection(BUNDLED_ENS_SECTION)).toEqual(ens);
  });

  it("parses the namespace with the sponsor's year limit", () => {
    expect(ens).toMatchObject({ label: "Devnet ENSv2", namespace: "qsw.eth", pricePerYear: "5000000", minDuration: 31_536_000, maxYears: ENS_MAX_YEARS });
  });

  it.each([
    ["a missing address", { ...manifest.ens, registrar: undefined }, /registrar is not an address/],
    ["a namespace outside .eth", { ...manifest.ens, namespace: "qsw.xyz" }, /<label>\.eth/],
    ["a minimum longer than a year", { ...manifest.ens, minDuration: 40_000_000 }, /one-year/],
    ["a zero price", { ...manifest.ens, pricePerYear: 0 }, /pricePerYear/],
  ])("rejects %s", (_what, section, message) => {
    expect(() => parseEnsSection(section)).toThrow(message);
  });
});

describe("on-chain verification", () => {
  it("accepts the deployed wiring", async () => {
    await expect(verifyEns(ens, { contracts } as never, fakeEnsChain(ens))).resolves.toBeUndefined();
  });

  it.each([
    ["a registrar paid in another token", { PAYMENT_TOKEN: manifest.weth9 }, /not paid in dUSDC/],
    ["a vault factory trusting another account factory", { ACCOUNT_FACTORY: manifest.permit2 }, /another account factory/],
    ["a registrar without roles", { hasRootRoles: false }, /lacks REGISTRAR/],
    ["another price", { PRICE: 1n }, /price differs/],
  ])("rejects %s", async (_what, patch, message) => {
    await expect(verifyEns(ens, { contracts } as never, fakeEnsChain(ens, patch))).rejects.toThrow(message);
  });

  it("prefers the published section, falls back to the bundled one, and disables only ENS on failure", async () => {
    expect((await loadEns(manifest, { contracts } as never, fakeEnsChain(ens))).ens).toEqual(ens);
    const { ens: _published, ...withoutEns } = manifest;
    expect((await loadEns(withoutEns, { contracts } as never, fakeEnsChain(ens))).ens).toEqual(ens);
    const broken = await loadEns(manifest, { contracts } as never, fakeEnsChain(ens, { REGISTRY: manifest.weth9 }));
    expect(broken).toEqual({ ens: null, problem: expect.stringMatching(/^Devnet ENSv2 is disabled: .*another registry/) });
  });
});

describe.skipIf(!process.env.QSW_LIVE_READ)("live devnet namespace", () => {
  it("verifies qsw.eth on the shared devnet", async () => {
    await expect(verifyEns(ens, { contracts } as never, httpRpc(manifest.rpcUrl))).resolves.toBeUndefined();
  }, 60_000);
});
