import { DEFAULT_DEPLOYMENT_URL } from "../shared/constants.js";
import type { Hex } from "../shared/types.js";

/**
 * Server configuration from process.env. Private keys are never logged or
 * returned; only the problems list (variable names, no values) is reported.
 */
export interface ServerEnv {
  operatorKey: Hex | null;
  /** Defaults to the operator key. */
  sponsorKey: Hex | null;
  /** Overrides the manifest's public RPC/mempool URLs (they are published in /api/config). */
  rpcUrl: string | null;
  mempoolUrl: string | null;
  deploymentUrl: string;
  faucetAmount: bigint;
  faucetMaxBalance: bigint;
  maxSwapUsdc: bigint;
  maxSwapWeth: bigint;
  /** Wei kept in reserve on operator/sponsor balances. */
  minOperatorBalance: bigint;
  problems: string[];
}

const KEY = /^(?:0x)?([0-9a-fA-F]{64})$/;

function key(source: Record<string, string | undefined>, name: string, problems: string[]): Hex | null {
  const raw = source[name]?.trim();
  if (!raw) return null;
  const match = KEY.exec(raw);
  if (!match) {
    problems.push(`${name} is not a 32-byte hex private key`);
    return null;
  }
  return `0x${(match[1] as string).toLowerCase()}`;
}

function amount(source: Record<string, string | undefined>, name: string, fallback: bigint, problems: string[]): bigint {
  const raw = source[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    problems.push(`${name} must be a positive integer in raw units; using the default`);
    return fallback;
  }
  return BigInt(raw);
}

function url(source: Record<string, string | undefined>, name: string, problems: string[]): string | null {
  const raw = source[name]?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
    return raw;
  } catch {
    problems.push(`${name} is not an http(s) URL; ignoring it`);
    return null;
  }
}

export function readEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const problems: string[] = [];
  const operatorKey = key(source, "QSW_OPERATOR_PRIVATE_KEY", problems);
  const sponsorKey = key(source, "QSW_SPONSOR_PRIVATE_KEY", problems) ?? operatorKey;
  return {
    operatorKey,
    sponsorKey,
    rpcUrl: url(source, "QSW_RPC_URL", problems),
    mempoolUrl: url(source, "QSW_MEMPOOL_URL", problems),
    deploymentUrl: url(source, "QSW_DEPLOYMENT_URL", problems) ?? DEFAULT_DEPLOYMENT_URL,
    faucetAmount: amount(source, "QSW_FAUCET_AMOUNT", 1_000_000000n, problems),
    faucetMaxBalance: amount(source, "QSW_FAUCET_MAX_BALANCE", 5_000_000000n, problems),
    maxSwapUsdc: amount(source, "QSW_MAX_SWAP_USDC", 1_000_000000n, problems),
    maxSwapWeth: amount(source, "QSW_MAX_SWAP_WETH", 500_000_000_000_000_000n, problems),
    minOperatorBalance: amount(source, "QSW_MIN_OPERATOR_BALANCE", 50_000_000_000_000_000n, problems),
    problems,
  };
}
