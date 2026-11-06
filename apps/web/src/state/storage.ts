import { isPublicKey } from "../../shared/account.js";
import type { WalletRecord } from "./types.js";

export const WALLET_STORAGE_KEY = "qsw.wallet.v1";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Strict shape check: anything unexpected in storage is ignored rather than trusted. */
export function parseWalletRecord(value: unknown): WalletRecord | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const ok =
    r.version === 1 &&
    Number.isSafeInteger(r.chainId) &&
    typeof r.account === "string" && ADDRESS.test(r.account) &&
    isPublicKey(r.publicKey) &&
    typeof r.salt === "string" && HASH.test(r.salt) &&
    typeof r.factory === "string" && ADDRESS.test(r.factory) &&
    typeof r.createdAt === "number" &&
    (r.createTxHash === null || (typeof r.createTxHash === "string" && HASH.test(r.createTxHash))) &&
    typeof r.backedUp === "boolean";
  if (!ok) return null;
  return {
    version: 1,
    chainId: r.chainId as number,
    account: r.account as WalletRecord["account"],
    publicKey: (r.publicKey as string).toLowerCase() as WalletRecord["publicKey"],
    salt: r.salt as WalletRecord["salt"],
    factory: r.factory as WalletRecord["factory"],
    createdAt: r.createdAt as number,
    createTxHash: r.createTxHash as WalletRecord["createTxHash"],
    backedUp: r.backedUp as boolean,
  };
}

export function loadWalletRecord(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): WalletRecord | null {
  try {
    const raw = storage?.getItem(WALLET_STORAGE_KEY);
    return raw ? parseWalletRecord(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveWalletRecord(
  record: WalletRecord | null,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = globalThis.localStorage,
): void {
  try {
    if (record) storage?.setItem(WALLET_STORAGE_KEY, JSON.stringify(record));
    else storage?.removeItem(WALLET_STORAGE_KEY);
  } catch {
    // Storage full or disabled (private mode): the wallet still works for this session.
  }
}
