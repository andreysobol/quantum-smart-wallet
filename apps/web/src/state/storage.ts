import { isPublicKey } from "../../shared/account.js";
import type { Hex } from "../../shared/types.js";
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

// `storage` defaults to localStorage inside the try: merely reading window.localStorage throws a
// SecurityError when the browser blocks site data, and a default parameter would throw before the try.

export function loadWalletRecord(storage?: Pick<Storage, "getItem">): WalletRecord | null {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(WALLET_STORAGE_KEY);
    return raw ? parseWalletRecord(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveWalletRecord(record: WalletRecord | null, storage?: Pick<Storage, "setItem" | "removeItem">): void {
  try {
    const target = storage ?? globalThis.localStorage;
    if (record) target?.setItem(WALLET_STORAGE_KEY, JSON.stringify(record));
    else target?.removeItem(WALLET_STORAGE_KEY);
  } catch {
    // Storage full, disabled or blocked: the wallet still works for this session.
  }
}

const sameKey = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

/**
 * The stored wallet that saving a wallet for `publicKey` would replace (null for a new key that is not
 * known yet), or null when nothing would be lost. The app keeps one wallet record per device, so
 * replacing a different one needs the user's explicit consent.
 */
export function walletToReplace(stored: WalletRecord | null, publicKey: Hex | null): WalletRecord | null {
  return stored && !(publicKey && sameKey(stored.publicKey, publicKey)) ? stored : null;
}

export type CommitResult = { saved: true } | { saved: false; current: WalletRecord };

/**
 * Compare-and-set save: re-read storage and refuse (returning the stored wallet) when it holds a different
 * key than `next`, unless that key is `replaces`, the wallet the user agreed to replace. Another tab may
 * have saved a wallet since this one last looked; overwriting it would leave that wallet's key unreachable.
 */
export function commitWalletRecord(
  next: WalletRecord,
  replaces: Hex | null,
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): CommitResult {
  const current = walletToReplace(loadWalletRecord(storage), next.publicKey);
  if (current && !(replaces && sameKey(current.publicKey, replaces))) return { saved: false, current };
  saveWalletRecord(next, storage);
  return { saved: true };
}
