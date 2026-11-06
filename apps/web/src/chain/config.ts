import { rpcBatch } from "../../shared/rpc.js";
import type { PublicConfig } from "../../shared/types.js";
import { api } from "./api.js";

let cached: Promise<PublicConfig> | null = null;

/**
 * Load the public configuration from the server, then confirm against the public
 * RPC that we are talking to the expected chain (chain ID AND genesis hash).
 */
export function loadConfig(): Promise<PublicConfig> {
  cached ??= (async () => {
    const config = await api.config();
    const [chain, genesis] = await rpcBatch(config.rpcUrl, [
      { method: "eth_chainId" },
      { method: "eth_getBlockByNumber", params: ["0x0", false] },
    ]);
    if (!chain?.ok || Number(chain.result) !== config.chainId) {
      throw new Error(`The RPC endpoint is not chain ${config.chainId}.`);
    }
    const hash = genesis?.ok ? (genesis.result as { hash?: string } | null)?.hash : undefined;
    if (!hash || hash.toLowerCase() !== config.genesisHash.toLowerCase()) {
      throw new Error("The RPC endpoint's genesis does not match the deployment manifest.");
    }
    return config;
  })().catch((error) => {
    cached = null;
    throw error;
  });
  return cached;
}
