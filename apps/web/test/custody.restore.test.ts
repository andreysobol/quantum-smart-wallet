// Restore when a backup's meta (outside the encryption's AAD, so editable) disagrees with the factory: the key's
// canonical account comes first, and the recorded salt is only a fallback the factory must confirm.
import { describe, expect, it } from "vitest";
import { accountSalt } from "../shared/account.js";
import type { Address, Hex, PublicConfig } from "../shared/types.js";
import type { KeyMeta, Signer } from "../src/crypto/types.js";
import { EngraveJob, type EngraveDeps } from "../src/state/engrave.js";
import type { WalletRecord } from "../src/state/types.js";

const CHAIN_ID = 81411338;
const FACTORY = "0x573b8fC3b0d72b3B859eACBA67fA3224Ecb55181" as const;
const PK = `0x${"ab".repeat(32)}` as Hex;
const TX = `0x${"cd".repeat(32)}` as Hex;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const CANONICAL = accountSalt(PK);
const EDITED = `0x${"ee".repeat(32)}` as Hex;
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

/** A factory whose getAddress is addressFor(salt) and whose isAccount reads `registered`. */
function fakeChain(registered: Address[]) {
  const accounts = new Set(registered.map((a) => a.toLowerCase()));
  const salts: Hex[] = [];
  const created: unknown[] = [];
  const setMeta: KeyMeta[] = [];
  const done: WalletRecord[] = [];
  const deps: EngraveDeps = {
    loadConfig: async () => config,
    signer: {
      ready: async () => {},
      setMeta: async (_pk: Hex, meta: KeyMeta) => void setMeta.push(meta),
    } as unknown as Signer,
    lookupAccount: async (_rpc, _factory, _pk, salt, expected) => {
      salts.push(salt);
      const predicted = addressFor(salt);
      return { predicted, registered: accounts.has((expected ?? predicted).toLowerCase()) };
    },
    // The server always creates the key's canonical account.
    createAccount: async ({ publicKey }) => {
      const salt = accountSalt(publicKey);
      created.push(publicKey);
      accounts.add(addressFor(salt).toLowerCase());
      return { account: addressFor(salt), salt, publicKey, created: true, txHash: TX, blockNumber: 1, stakeWei: "1" };
    },
    onDone: (r) => void done.push(r),
    paceMs: 0,
    pollMs: 1,
  };
  return { deps, salts, created, setMeta, done };
}

const restore = async (chain: ReturnType<typeof fakeChain>, meta: KeyMeta | null) => {
  const job = new EngraveJob(chain.deps, "restore", { publicKey: PK, meta });
  await job.start();
  return job;
};
const meta = (over: Partial<KeyMeta>): KeyMeta => ({ chainId: CHAIN_ID, factory: FACTORY, account: addressFor(CANONICAL), salt: CANONICAL, ...over });

describe("restore with backup meta that disagrees with the factory", () => {
  it("a recorded account the factory does not derive falls back to the key's canonical account", async () => {
    const chain = fakeChain([addressFor(CANONICAL)]);
    const job = await restore(chain, meta({ account: OTHER }));
    expect(job.getSnapshot()).toMatchObject({ phase: "done", account: addressFor(CANONICAL) });
    expect(chain.done[0]).toMatchObject({ account: addressFor(CANONICAL), salt: CANONICAL, backedUp: true });
    // The key store's meta is rewritten with the confirmed account, so later backups carry it.
    expect(chain.setMeta).toEqual([meta({})]);
  });

  it("an edited salt pointing at a pre-created sibling account does not hide the funded canonical account", async () => {
    const chain = fakeChain([addressFor(CANONICAL), addressFor(EDITED)]);
    const job = await restore(chain, meta({ account: addressFor(EDITED), salt: EDITED }));
    expect(job.getSnapshot()).toMatchObject({ phase: "done", account: addressFor(CANONICAL) });
    expect(chain.salts[0]).toBe(CANONICAL);
    expect(chain.done[0]).toMatchObject({ salt: CANONICAL });
  });

  it("an edited salt with no account behind it offers to create the canonical account, and creation succeeds", async () => {
    const chain = fakeChain([]);
    const job = await restore(chain, meta({ account: addressFor(EDITED), salt: EDITED }));
    expect(job.getSnapshot()).toMatchObject({ phase: "offer", account: addressFor(CANONICAL) });
    await job.acceptCreate();
    expect(job.getSnapshot()).toMatchObject({ phase: "done", account: addressFor(CANONICAL), txHash: TX });
    expect(chain.created).toEqual([PK]);
    expect(chain.done[0]).toMatchObject({ salt: CANONICAL, account: addressFor(CANONICAL) });
  });

  it("a reset devnet (recorded account no longer derived, nothing registered) leads to the creation offer, not an error", async () => {
    const chain = fakeChain([]);
    const job = await restore(chain, meta({ account: OTHER }));
    expect(job.getSnapshot()).toMatchObject({ phase: "offer", account: addressFor(CANONICAL) });
  });

  it("a non-canonical recorded salt is used when the factory confirms its registered account", async () => {
    const chain = fakeChain([addressFor(EDITED)]);
    const job = await restore(chain, meta({ account: addressFor(EDITED), salt: EDITED }));
    expect(job.getSnapshot()).toMatchObject({ phase: "done", account: addressFor(EDITED) });
    expect(chain.salts.slice(0, 2)).toEqual([CANONICAL, EDITED]);
    expect(chain.done[0]).toMatchObject({ salt: EDITED, account: addressFor(EDITED) });
  });

  it("a recorded salt whose account differs from the recorded one is ignored", async () => {
    const chain = fakeChain([addressFor(EDITED)]);
    const job = await restore(chain, meta({ account: OTHER, salt: EDITED }));
    expect(job.getSnapshot()).toMatchObject({ phase: "offer", account: addressFor(CANONICAL) });
  });

  it("meta for another chain or factory is not consulted", async () => {
    const chain = fakeChain([addressFor(CANONICAL), addressFor(EDITED)]);
    const job = await restore(chain, meta({ chainId: 1, account: addressFor(EDITED), salt: EDITED }));
    expect(job.getSnapshot()).toMatchObject({ phase: "done", account: addressFor(CANONICAL) });
    expect(chain.salts.every((salt) => salt === CANONICAL)).toBe(true);
  });
});
