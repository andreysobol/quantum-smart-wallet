import type { PublicConfig } from "../../shared/types.js";

type ExplorerConfig = Pick<PublicConfig, "explorerUrl" | "mempoolUrl">;

/** Explorer base with exactly one trailing slash (`/explorer` without it serves an empty page). */
export function explorerBase(config: ExplorerConfig): string {
  return config.explorerUrl.replace(/\/+$/, "") + "/";
}

/**
 * Transaction page. `frame: true` opens the mempool admission + native frames view
 * (falls back to the chain view when the sidecar no longer remembers the hash);
 * the default chain view works for every transaction type.
 */
export function explorerTxUrl(config: ExplorerConfig, hash: string, options: { frame?: boolean } = {}): string {
  const tx = hash.toLowerCase();
  if (options.frame) return `${explorerBase(config)}tx/${tx}?node=${encodeURIComponent(config.mempoolUrl)}`;
  return `${explorerBase(config)}chain/tx/${tx}`;
}

export function explorerAddressUrl(config: ExplorerConfig, address: string): string {
  return `${explorerBase(config)}address/${address.toLowerCase()}`;
}
