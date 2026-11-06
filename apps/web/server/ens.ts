import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, type Abi } from "viem";
import { ensRegistrarAbi, ensRegistryAbi, ensVaultFactoryAbi, universalResolverAbi } from "../shared/ensAbis.js";
import type { Address, EnsDeployment, Hex } from "../shared/types.js";
import type { Deployment, Rpc } from "./manifest.js";

/** Longest registration the sponsor accepts, in whole years. */
export const ENS_MAX_YEARS = 5;
const YEAR_SECONDS = 31_536_000;
// RegistryRolesLib.ROLE_REGISTRAR | ROLE_RENEW
const REGISTRAR_ROLES = (1n << 0n) | (1n << 16n);

/**
 * The `ens` section of slhsol/deployments/shared-devnet.json as deployed (ensv2/deployments). Used only
 * while the published manifest predates the namespace; it is verified on-chain exactly like the published one.
 */
export const BUNDLED_ENS_SECTION = {
  label: "Devnet ENSv2",
  namespace: "qsw.eth",
  rootRegistry: "0xFE65cfc45b406F2D95d0de80a1eA89a7C6dE9c1C",
  ethRegistry: "0x7f2DC8E732adb8C55AE9787c8ed4D78Ea7F35639",
  qswRegistry: "0x5Bb30cD38cC07029729A1B614e5c834ce166c9aE",
  universalResolver: "0x6F36B098566f113021BB0eab239f0ba952c4b6CD",
  registrar: "0xc1784536C1dF5FBAAA705F4b51e542F14215E257",
  vaultFactory: "0xA9aBbA3d31F832B3258955FA8aD0DB1B49A96e24",
  resolverImplementation: "0xd77E82fF952C9b9E80771F42C4D0344795C6d187",
  verifiableFactory: "0x6c7C51937c2Af20bf7f59edaf471Bf0D8907930E",
  paymentToken: "0x3636a1d9A30C46264822F1A47975707793770F42",
  pricePerYear: 5000000,
  minDuration: 31536000,
  deploymentBlock: 6662,
} as const;

export class EnsConfigError extends Error {
  override name = "EnsConfigError";
}

const bad = (message: string): never => {
  throw new EnsConfigError(message);
};

function addr(m: Record<string, unknown>, key: string): Address {
  const value = m[key];
  if (typeof value !== "string" || !isAddress(value, { strict: false })) bad(`ens.${key} is not an address`);
  return getAddress(value as string);
}

function integer(m: Record<string, unknown>, key: string, min: number): number {
  const value = m[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) bad(`ens.${key} must be an integer of at least ${min}`);
  return value as number;
}

/** Static validation of a manifest `ens` section. */
export function parseEnsSection(json: unknown): EnsDeployment {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return bad("ens is not an object");
  const m = json as Record<string, unknown>;
  const namespace = m.namespace;
  if (typeof namespace !== "string" || !/^[a-z0-9-]+\.eth$/.test(namespace)) bad("ens.namespace must be <label>.eth");
  const label = typeof m.label === "string" && m.label ? m.label : "Devnet ENSv2";
  const minDuration = integer(m, "minDuration", 1);
  if (minDuration > YEAR_SECONDS) bad("ens.minDuration must allow one-year registrations");
  return {
    label,
    namespace: namespace as string,
    rootRegistry: addr(m, "rootRegistry"),
    ethRegistry: addr(m, "ethRegistry"),
    qswRegistry: addr(m, "qswRegistry"),
    universalResolver: addr(m, "universalResolver"),
    registrar: addr(m, "registrar"),
    vaultFactory: addr(m, "vaultFactory"),
    resolverImplementation: addr(m, "resolverImplementation"),
    verifiableFactory: addr(m, "verifiableFactory"),
    paymentToken: addr(m, "paymentToken"),
    pricePerYear: String(integer(m, "pricePerYear", 1)),
    minDuration,
    maxYears: ENS_MAX_YEARS,
    deploymentBlock: integer(m, "deploymentBlock", 0),
  };
}

type Read = [to: Address, abi: Abi, functionName: string, args: unknown[]];

/**
 * Read the namespace back from the chain: root → .eth → the namespace registry, the universal
 * resolver's root, the registrar's registry, token, price and roles, and the vault factory's
 * account factory, proxy factory and resolver implementation.
 */
export async function verifyEns(ens: EnsDeployment, deployment: Pick<Deployment, "contracts">, rpc: Rpc): Promise<void> {
  const parentLabel = ens.namespace.split(".")[0] as string;
  const reads: Read[] = [
    [ens.rootRegistry, ensRegistryAbi, "getSubregistry", ["eth"]],
    [ens.ethRegistry, ensRegistryAbi, "getSubregistry", [parentLabel]],
    [ens.qswRegistry, ensRegistryAbi, "getParent", []],
    [ens.universalResolver, universalResolverAbi, "ROOT_REGISTRY", []],
    [ens.registrar, ensRegistrarAbi, "REGISTRY", []],
    [ens.registrar, ensRegistrarAbi, "PAYMENT_TOKEN", []],
    [ens.registrar, ensRegistrarAbi, "PRICE", []],
    [ens.registrar, ensRegistrarAbi, "MIN_DURATION", []],
    [ens.qswRegistry, ensRegistryAbi, "hasRootRoles", [REGISTRAR_ROLES, ens.registrar]],
    [ens.vaultFactory, ensVaultFactoryAbi, "ACCOUNT_FACTORY", []],
    [ens.vaultFactory, ensVaultFactoryAbi, "PROXY_FACTORY", []],
    [ens.vaultFactory, ensVaultFactoryAbi, "RESOLVER_IMPLEMENTATION", []],
  ];
  const results = await rpc.batch(
    reads.map(([to, abi, functionName, args]) => ({
      method: "eth_call",
      params: [{ to, data: encodeFunctionData({ abi, functionName, args } as never) }, "latest"],
    })),
  );
  const values = reads.map(([, abi, functionName], i) => {
    const item = results[i];
    if (!item?.ok) return bad(`could not read ${functionName}`);
    return decodeFunctionResult({ abi, functionName, data: item.result as Hex } as never) as unknown;
  });
  const same = (value: unknown, expected: string) => typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
  const [ethSub, nsSub, parent, root, registry, token, price, minDuration, roles, accounts, proxies, implementation] = values;
  const problems: string[] = [];
  if (!same(ethSub, ens.ethRegistry)) problems.push("root registry does not point eth at the .eth registry");
  if (!same(nsSub, ens.qswRegistry)) problems.push(`.eth registry does not point ${parentLabel} at the namespace registry`);
  const [parentRegistry, label] = (parent ?? []) as [string, string];
  if (!same(parentRegistry, ens.ethRegistry) || label !== parentLabel) problems.push("namespace registry has the wrong parent");
  if (!same(root, ens.rootRegistry)) problems.push("universal resolver uses another root registry");
  if (!same(registry, ens.qswRegistry)) problems.push("registrar serves another registry");
  if (!same(token, ens.paymentToken) || !same(token, deployment.contracts.demoUSDC)) problems.push("registrar is not paid in dUSDC");
  if (price !== BigInt(ens.pricePerYear)) problems.push("registrar price differs from the manifest");
  if (minDuration !== BigInt(ens.minDuration)) problems.push("registrar minimum duration differs from the manifest");
  if (roles !== true) problems.push("registrar lacks REGISTRAR/RENEW on the namespace registry");
  if (!same(accounts, deployment.contracts.accountFactory)) problems.push("vault factory trusts another account factory");
  if (!same(proxies, ens.verifiableFactory)) problems.push("vault factory uses another proxy factory");
  if (!same(implementation, ens.resolverImplementation)) problems.push("vault factory uses another resolver implementation");
  if (problems.length) bad(problems.join("; "));
}

/**
 * The verified namespace, from the published manifest's `ens` section or, while it has none, the bundled
 * one. Any failure disables only the names feature: swaps and the rest of the API keep working.
 */
export async function loadEns(
  manifest: unknown,
  deployment: Pick<Deployment, "contracts">,
  rpc: Rpc,
): Promise<{ ens: EnsDeployment | null; problem: string | null }> {
  const published = typeof manifest === "object" && manifest !== null ? (manifest as Record<string, unknown>).ens : undefined;
  try {
    const ens = parseEnsSection(published ?? BUNDLED_ENS_SECTION);
    await verifyEns(ens, deployment, rpc);
    return { ens, problem: null };
  } catch (error) {
    const why = error instanceof Error ? error.message : "unknown error";
    return { ens: null, problem: `Devnet ENSv2 is disabled: ${why}` };
  }
}
