import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, isAddress, keccak256 } from "viem";
import { factoryAbi } from "../shared/abis.js";
import { CHAIN_ID, NATIVE_PROFILE } from "../shared/constants.js";
import { rpcBatch, rpcCall, type BatchItem, type BatchResult } from "../shared/rpc.js";
import type { Address, DeploymentContracts, Hex, PoolKey } from "../shared/types.js";
import { ApiFailure } from "./http.js";

/** JSON-RPC access, injectable so policy and routes are testable without a network. */
export interface Rpc {
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  batch(calls: BatchItem[]): Promise<BatchResult[]>;
}

export function httpRpc(url: string): Rpc {
  return {
    call: <T>(method: string, params: unknown[] = []) => rpcCall<T>(url, method, params),
    batch: (calls: BatchItem[]) => rpcBatch(url, calls),
  };
}

export interface Deployment {
  chainId: number;
  genesisHash: Hex;
  nativeProfile: string;
  rpcUrl: string;
  mempoolUrl: string;
  explorerUrl: string;
  contracts: DeploymentContracts;
  poolKey: PoolKey;
  poolId: Hex;
  /** INITIAL_STAKE read from the factory on-chain. */
  accountInitialStake: bigint;
}

const bad = (message: string): never => {
  throw new ApiFailure(502, "upstream_error", `Deployment manifest is invalid: ${message}`);
};

function addr(m: Record<string, unknown>, key: string): Address {
  const value = m[key];
  if (typeof value !== "string" || !isAddress(value, { strict: false })) bad(`${key} is not an address`);
  return getAddress(value as string);
}

function str(m: Record<string, unknown>, key: string): string {
  const value = m[key];
  if (typeof value !== "string" || !value) bad(`${key} is missing`);
  return value as string;
}

function httpsUrl(value: string, key: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
  } catch {
    bad(`${key} is not a URL`);
  }
  return value;
}

export function computePoolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** Validate the published manifest (shape, chain, pool key/id consistency). Static checks only. */
export function parseManifest(json: unknown, overrides: { rpcUrl?: string | null; mempoolUrl?: string | null } = {}): Omit<Deployment, "accountInitialStake"> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return bad("not an object");
  const m = json as Record<string, unknown>;
  if (m.chainId !== CHAIN_ID) bad(`chainId must be ${CHAIN_ID}`);
  if (m.status !== undefined && m.status !== "ready") bad(`status is ${String(m.status)}`);
  const genesisHash = str(m, "genesisHash");
  if (!/^0x[0-9a-fA-F]{64}$/.test(genesisHash)) bad("genesisHash is not 32 bytes");
  const nativeProfile = str(m, "nativeProfile");
  if (!nativeProfile.includes(NATIVE_PROFILE)) bad(`nativeProfile must be ${NATIVE_PROFILE}`);
  const contracts: DeploymentContracts = {
    accountFactory: addr(m, "accountFactory"),
    demoUSDC: addr(m, "demoUSDC"),
    weth9: addr(m, "weth9"),
    permit2: addr(m, "permit2"),
    universalRouter: addr(m, "universalRouter"),
    poolManager: addr(m, "poolManager"),
    stateView: addr(m, "stateView"),
    quantumGuardHook: addr(m, "quantumGuardHook"),
    verifier: addr(m, "verifier"),
    stakingRegistry: addr(m, "stakingRegistry"),
  };
  const k = m.poolKey;
  if (typeof k !== "object" || k === null) return bad("poolKey is missing");
  const pk = k as Record<string, unknown>;
  if (typeof pk.fee !== "number" || !Number.isInteger(pk.fee) || typeof pk.tickSpacing !== "number" || !Number.isInteger(pk.tickSpacing) || pk.tickSpacing <= 0) {
    bad("poolKey fee/tickSpacing are invalid");
  }
  const poolKey: PoolKey = {
    currency0: addr(pk, "currency0"),
    currency1: addr(pk, "currency1"),
    fee: pk.fee as number,
    tickSpacing: pk.tickSpacing as number,
    hooks: addr(pk, "hooks"),
  };
  const pair = [poolKey.currency0, poolKey.currency1].map((a) => a.toLowerCase()).sort().join();
  if (pair !== [contracts.demoUSDC, contracts.weth9].map((a) => a.toLowerCase()).sort().join()) bad("pool is not dUSDC/WETH");
  if (poolKey.hooks !== contracts.quantumGuardHook) bad("pool hook is not the QuantumGuardHook");
  const poolId = str(m, "poolId").toLowerCase() as Hex;
  if (computePoolId(poolKey) !== poolId) bad("poolId does not match poolKey");
  return {
    chainId: CHAIN_ID,
    genesisHash: genesisHash.toLowerCase() as Hex,
    nativeProfile,
    rpcUrl: httpsUrl(overrides.rpcUrl ?? str(m, "rpcUrl"), "rpcUrl"),
    mempoolUrl: httpsUrl(overrides.mempoolUrl ?? str(m, "mempoolUrl"), "mempoolUrl"),
    explorerUrl: httpsUrl(str(m, "explorerUrl"), "explorerUrl"),
    contracts,
    poolKey,
    poolId,
  };
}

export interface ChainVerifier {
  rpc: Rpc;
  mempool: Rpc;
}

/**
 * Verify the RPC really is the manifest's chain (chain id, genesis, pinned ethrex
 * profile), the mempool is on the same chain, and read INITIAL_STAKE.
 */
export async function verifyChain(base: Omit<Deployment, "accountInitialStake">, { rpc, mempool }: ChainVerifier): Promise<Deployment> {
  const [chainId, genesis, version, stake] = await rpc.batch([
    { method: "eth_chainId" },
    { method: "eth_getBlockByNumber", params: ["0x0", false] },
    { method: "web3_clientVersion" },
    { method: "eth_call", params: [{ to: base.contracts.accountFactory, data: encodeFunctionData({ abi: factoryAbi, functionName: "INITIAL_STAKE" }) }, "latest"] },
  ]);
  const wrong = (message: string): never => {
    throw new ApiFailure(502, "upstream_error", message);
  };
  if (!chainId?.ok || Number(chainId.result) !== base.chainId) wrong(`The RPC endpoint is not chain ${base.chainId}.`);
  const hash = genesis?.ok ? (genesis.result as { hash?: string } | null)?.hash : undefined;
  if (!hash || hash.toLowerCase() !== base.genesisHash) wrong("The RPC endpoint's genesis does not match the deployment manifest.");
  if (!version?.ok || typeof version.result !== "string" || !version.result.includes(NATIVE_PROFILE)) {
    wrong(`The RPC endpoint is not the pinned ethrex ${NATIVE_PROFILE} profile.`);
  }
  if (!stake?.ok) return wrong("Could not read the factory's INITIAL_STAKE.");
  const initialStake = decodeFunctionResult({ abi: factoryAbi, functionName: "INITIAL_STAKE", data: stake.result as Hex });
  const mempoolChain = await mempool.call<string>("eth_chainId");
  if (Number(mempoolChain) !== base.chainId) wrong(`The mempool endpoint is not chain ${base.chainId}.`);
  return { ...base, accountInitialStake: initialStake };
}
