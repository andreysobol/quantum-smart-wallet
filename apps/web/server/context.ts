import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address } from "../shared/types.js";
import { loadEns } from "./ens.js";
import { readEnv, type ServerEnv } from "./env.js";
import { ApiFailure, RateLimiter, RecentKeys } from "./http.js";
import { httpRpc, parseManifest, verifyChain, type Deployment, type Rpc } from "./manifest.js";
import { Operator, type OperatorOptions } from "./operator.js";

const MANIFEST_TTL_MS = 5 * 60_000;

export interface Chain {
  deployment: Deployment;
  rpc: Rpc;
  /** Null without QSW_OPERATOR_PRIVATE_KEY. */
  operator: Operator | null;
  /** Null without a sponsor key (QSW_SPONSOR_PRIVATE_KEY, else the operator key). */
  sponsor: PrivateKeyAccount | null;
}

export interface ContextOptions {
  env?: ServerEnv;
  fetchManifest?: (url: string) => Promise<unknown>;
  rpcFor?: (url: string) => Rpc;
  now?: () => number;
  operatorOptions?: OperatorOptions;
}

async function fetchManifest(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ApiFailure(502, "upstream_error", "The deployment manifest could not be fetched.");
  }
  if (!response.ok) throw new ApiFailure(502, "upstream_error", `The deployment manifest returned HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new ApiFailure(502, "upstream_error", "The deployment manifest is not JSON.");
  }
}

/** Per-instance server state: env, verified deployment (cached 5 min), keys and rate limiters. */
export class ServerContext {
  readonly env: ServerEnv;
  readonly now: () => number;
  readonly limits;
  /** Signing hashes co-signed in the last hour (the longest deadline): a replay is not charged to the account again. */
  readonly cosigned: RecentKeys;
  private readonly fetchManifest: (url: string) => Promise<unknown>;
  private readonly rpcFor: (url: string) => Rpc;
  private readonly operatorOptions: OperatorOptions;
  private cached: { chain: Promise<Chain>; expires: number } | null = null;
  readonly sponsorAddress: Address | null;

  constructor(options: ContextOptions = {}) {
    this.env = options.env ?? readEnv();
    this.now = options.now ?? Date.now;
    this.fetchManifest = options.fetchManifest ?? fetchManifest;
    this.rpcFor = options.rpcFor ?? httpRpc;
    this.operatorOptions = options.operatorOptions ?? {};
    this.sponsorAddress = this.env.sponsorKey ? privateKeyToAccount(this.env.sponsorKey).address : null;
    const hour = 3_600_000;
    this.limits = {
      accountIp: new RateLimiter(6, hour, this.now),
      faucetIp: new RateLimiter(12, hour, this.now),
      faucetAccount: new RateLimiter(3, 10 * 60_000, this.now),
      sponsorIp: new RateLimiter(40, 10 * 60_000, this.now),
      sponsorAccount: new RateLimiter(15, 10 * 60_000, this.now),
    };
    this.cosigned = new RecentKeys(hour, this.now);
    for (const problem of this.env.problems) console.warn(`[api] configuration: ${problem}`);
  }

  chain(): Promise<Chain> {
    const now = this.now();
    if (this.cached && this.cached.expires > now) return this.cached.chain;
    const chain = this.loadChain();
    this.cached = { chain, expires: now + MANIFEST_TTL_MS };
    chain.catch(() => {
      if (this.cached?.chain === chain) this.cached = null;
    });
    return chain;
  }

  private async loadChain(): Promise<Chain> {
    const { rpcUrl, mempoolUrl, genesisHash } = this.env;
    const manifest = await this.fetchManifest(this.env.deploymentUrl);
    const base = parseManifest(manifest, { rpcUrl, mempoolUrl, genesisHash });
    const rpc = this.rpcFor(base.rpcUrl);
    const verified = await verifyChain(base, { rpc, mempool: this.rpcFor(base.mempoolUrl) });
    const { ens, problem } = await loadEns(manifest, verified, rpc);
    if (problem) console.warn(`[api] ${problem}`);
    const deployment = { ...verified, ens };
    return {
      deployment,
      rpc,
      operator: this.env.operatorKey ? new Operator(this.env.operatorKey, rpc, deployment.chainId, this.operatorOptions) : null,
      sponsor: this.env.sponsorKey ? privateKeyToAccount(this.env.sponsorKey) : null,
    };
  }
}

let shared: ServerContext | null = null;

/** The process-wide context built from process.env (one per serverless instance). */
export function defaultContext(): ServerContext {
  shared ??= new ServerContext();
  return shared;
}
