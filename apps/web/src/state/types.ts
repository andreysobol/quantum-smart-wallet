import type { Address, Hex } from "../../shared/types.js";

/**
 * The single wallet on this device (public data only; persisted in localStorage
 * under "qsw.wallet.v1"). The encrypted secret key lives in IndexedDB via the signer.
 */
export interface WalletRecord {
  version: 1;
  chainId: number;
  account: Address;
  publicKey: Hex;
  salt: Hex;
  factory: Address;
  createdAt: number;
  createTxHash: Hex | null;
  /** True only after a backup file was exported AND verified by re-import. */
  backedUp: boolean;
}

/** Top-level screens, mirroring the design's screen names. */
export type Screen =
  | "genesis"
  | "engrave"
  | "restore"
  | "backup"
  | "portfolio"
  | "exchange"
  | "names"
  | "proof";
