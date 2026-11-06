// Wallet record custody: storage when the browser blocks it, and one wallet record per device that is never
// replaced silently (by a stale tab, two tabs creating at once, or a stale tab's update of its old wallet).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountSalt } from "../shared/account.js";
import type { Address, Hex, PublicConfig } from "../shared/types.js";
import type { Signer } from "../src/crypto/types.js";
import { EngraveJob, type EngraveDeps } from "../src/state/engrave.js";
import { commitWalletRecord, loadWalletRecord, saveWalletRecord, walletToReplace, type CommitResult } from "../src/state/storage.js";
import type { WalletRecord } from "../src/state/types.js";

const CHAIN_ID = 81411338;
const FACTORY = "0x573b8fC3b0d72b3B859eACBA67fA3224Ecb55181" as const;
const TX = `0x${"cd".repeat(32)}` as Hex;
const PK_A = `0x${"0a".repeat(32)}` as Hex;
const PK_B = `0x${"0b".repeat(32)}` as Hex;
/** The fake factory's CREATE2 address for a salt (distinct per salt). */
const addressFor = (salt: Hex) => `0x${salt.slice(-40)}` as Address;

// Only the fields the engraving flow reads.
const config = {
  chainId: CHAIN_ID,
  rpcUrl: "rpc",
  contracts: { accountFactory: FACTORY },
  accountInitialStake: "12000000000000000",
  operatorReady: true,
} as unknown as PublicConfig;

const record = (publicKey: Hex, over: Partial<WalletRecord> = {}): WalletRecord => ({
  version: 1,
  chainId: CHAIN_ID,
  account: addressFor(accountSalt(publicKey)),
  publicKey,
  salt: accountSalt(publicKey),
  factory: FACTORY,
  createdAt: 1,
  createTxHash: null,
  backedUp: false,
  ...over,
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("wallet storage when the browser blocks site data", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  beforeEach(() => {
    // Chrome/Firefox with site data blocked: merely reading window.localStorage throws.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });
  });
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("loadWalletRecord() returns null instead of throwing during the first render", () => {
    expect(loadWalletRecord()).toBeNull();
  });

  it("saveWalletRecord() keeps the session going", () => {
    expect(() => saveWalletRecord(record(PK_A))).not.toThrow();
    expect(() => saveWalletRecord(null)).not.toThrow();
  });

  it("commitWalletRecord() does not throw either", () => {
    expect(commitWalletRecord(record(PK_A), null)).toEqual({ saved: true });
  });
});

describe("one wallet record per device", () => {
  it("walletToReplace: only a stored record for a different key needs the user's consent", () => {
    expect(walletToReplace(null, null)).toBeNull();
    expect(walletToReplace(null, PK_A)).toBeNull();
    expect(walletToReplace(record(PK_A), PK_A)).toBeNull();
    expect(walletToReplace(record(PK_A), `0x${"0A".repeat(32)}` as Hex)).toBeNull();
    expect(walletToReplace(record(PK_A), PK_B)).toEqual(record(PK_A));
    // Create: the new key is not known yet and always differs.
    expect(walletToReplace(record(PK_A), null)).toEqual(record(PK_A));
  });

  it("commitWalletRecord saves into empty storage and updates the same key", () => {
    const storage = memoryStorage();
    expect(commitWalletRecord(record(PK_A), null, storage)).toEqual({ saved: true });
    expect(commitWalletRecord(record(PK_A, { backedUp: true }), null, storage)).toEqual({ saved: true });
    expect(loadWalletRecord(storage)).toEqual(record(PK_A, { backedUp: true }));
  });

  it("commitWalletRecord never overwrites a different wallet except the one the user agreed to replace", () => {
    const storage = memoryStorage();
    saveWalletRecord(record(PK_A), storage);
    expect(commitWalletRecord(record(PK_B), null, storage)).toEqual({ saved: false, current: record(PK_A) });
    expect(commitWalletRecord(record(PK_B), PK_B, storage)).toEqual({ saved: false, current: record(PK_A) });
    expect(loadWalletRecord(storage)).toEqual(record(PK_A));
    expect(commitWalletRecord(record(PK_B), PK_A, storage)).toEqual({ saved: true });
    expect(loadWalletRecord(storage)).toEqual(record(PK_B));
  });
});

/**
 * One browser profile: a shared localStorage, a shared key store and one chain. Tabs follow the provider's
 * protocol: read storage before starting (walletToReplace), save with commitWalletRecord(record, replaces).
 */
function device() {
  const storage = memoryStorage();
  const keys = new Set<Hex>();
  const accounts = new Set<string>();
  let next = 1;
  const signer = {
    ready: async () => {},
    generate: async () => {
      const publicKey = `0x${String(next++).padStart(2, "0").repeat(32)}` as Hex;
      keys.add(publicKey);
      return { publicKey, ms: 1 };
    },
    setMeta: async () => {},
  } as unknown as Signer;
  /** An engraving whose save may replace only `replaces`; start() resolves to the save's outcome. */
  const engrave = (replaces: Hex | null) => {
    let outcome: { record: WalletRecord; result: CommitResult } | null = null;
    const deps: EngraveDeps = {
      loadConfig: async () => config,
      signer,
      lookupAccount: async (_rpc, _factory, publicKey, salt) => ({
        predicted: addressFor(salt),
        registered: accounts.has(addressFor(accountSalt(publicKey))),
      }),
      createAccount: async ({ publicKey }) => {
        const salt = accountSalt(publicKey);
        accounts.add(addressFor(salt));
        return { account: addressFor(salt), salt, publicKey, created: true, txHash: TX, blockNumber: 1, stakeWei: "1" };
      },
      onDone: (r) => (outcome = { record: r, result: commitWalletRecord(r, replaces, storage) }),
      paceMs: 0,
      pollMs: 1,
    };
    const job = new EngraveJob(deps, "create");
    return { start: async () => (await job.start(), outcome!) };
  };
  return { storage, keys, engrave };
}

describe("two tabs of one browser", () => {
  it("a stale tab's Create asks before replacing the wallet another tab saved, and keeps the old key", async () => {
    const d = device();
    expect(walletToReplace(loadWalletRecord(d.storage), null)).toBeNull();
    const a = await d.engrave(null).start();
    expect(a.result).toEqual({ saved: true });

    // Tab 2 was opened before A existed; its Create reads storage again and must ask first.
    const current = walletToReplace(loadWalletRecord(d.storage), null);
    expect(current).toEqual(a.record);
    // Only the explicit "Replace it" engraves B, allowed to replace exactly A.
    const b = await d.engrave(current!.publicKey).start();
    expect(b.result).toEqual({ saved: true });
    expect(loadWalletRecord(d.storage)).toEqual(b.record);
    expect(d.keys.has(a.record.publicKey)).toBe(true);
  });

  it("two tabs creating at once: the later save is refused instead of orphaning the first wallet", async () => {
    const d = device();
    const first = d.engrave(null);
    const second = d.engrave(null);
    const a = await first.start();
    const b = await second.start();
    expect(a.result).toEqual({ saved: true });
    expect(b.result).toEqual({ saved: false, current: a.record });
    expect(loadWalletRecord(d.storage)).toEqual(a.record);
    // "Replace it" on the second tab.
    expect(commitWalletRecord(b.record, a.record.publicKey, d.storage)).toEqual({ saved: true });
    expect(loadWalletRecord(d.storage)).toEqual(b.record);
  });

  it("a stale tab's update of its old wallet (Seal backup) does not write it back over the new one", async () => {
    const d = device();
    const a = await d.engrave(null).start();
    const b = await d.engrave(a.record.publicKey).start();
    expect(b.result).toEqual({ saved: true });
    expect(commitWalletRecord({ ...a.record, backedUp: true }, null, d.storage)).toEqual({ saved: false, current: b.record });
    expect(loadWalletRecord(d.storage)).toEqual(b.record);
  });
});
