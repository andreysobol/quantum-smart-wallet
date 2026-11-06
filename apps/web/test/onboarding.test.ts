// Onboarding logic: the engrave job (with fakes), wallet storage, the passphrase hint, and live read-only factory calls.
import { describe, expect, it } from "vitest";
import { accountSalt } from "../shared/account.js";
import { ApiError } from "../src/chain/api.js";
import type { PublicConfig } from "../shared/types.js";
import type { Signer } from "../src/crypto/types.js";
import { EngraveJob, type EngraveDeps } from "../src/state/engrave.js";
import { lookupAccount } from "../src/state/factory.js";
import { loadWalletRecord, parseWalletRecord, saveWalletRecord, WALLET_STORAGE_KEY } from "../src/state/storage.js";
import { passphraseHint } from "../src/screens/Backup.js";

const PK = ("0x" + "ab".repeat(32)) as `0x${string}`;
const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const FACTORY = "0x573b8fC3b0d72b3B859eACBA67fA3224Ecb55181" as const;
const TX = ("0x" + "cd".repeat(32)) as `0x${string}`;

const config = (over: Partial<PublicConfig> = {}): PublicConfig =>
  ({
    chainId: 81411338,
    rpcUrl: "https://altmempool.bailo.london/rpc",
    contracts: { accountFactory: FACTORY },
    accountInitialStake: "12000000000000000",
    operatorReady: true,
    ...over,
  }) as PublicConfig;

function fakeSigner() {
  const calls = { generate: 0, setMeta: [] as unknown[] };
  const signer = {
    ready: async () => {},
    generate: async () => {
      calls.generate++;
      return { publicKey: PK, ms: 5 };
    },
    setMeta: async (_pk: string, meta: unknown) => {
      calls.setMeta.push(meta);
    },
  } as unknown as Signer;
  return { signer, calls };
}

function deps(over: Partial<EngraveDeps> & { lookups?: Array<{ predicted: `0x${string}`; registered: boolean } | Error> } = {}) {
  const { signer, calls } = fakeSigner();
  const lookups = [...(over.lookups ?? [{ predicted: ACCOUNT, registered: false }, { predicted: ACCOUNT, registered: true }])];
  const done: unknown[] = [];
  const created: unknown[] = [];
  const base: EngraveDeps = {
    loadConfig: async () => config(),
    signer,
    createAccount: async (body) => {
      created.push(body);
      return { account: ACCOUNT, salt: accountSalt(PK), publicKey: PK, created: true, txHash: TX, blockNumber: 1, stakeWei: "12000000000000000" };
    },
    lookupAccount: async () => {
      const next = lookups.length > 1 ? lookups.shift() : lookups[0];
      if (next instanceof Error) throw next;
      return next!;
    },
    onDone: (record) => done.push(record),
    paceMs: 0,
    pollMs: 1,
  };
  return { deps: { ...base, ...over }, calls, done, created };
}

describe("EngraveJob", () => {
  it("creates: generate once, operator creates, confirms, persists meta and record", async () => {
    const t = deps();
    const job = new EngraveJob(t.deps, "create");
    const steps: string[] = [];
    job.subscribe(() => steps.push(job.getSnapshot().step));
    await job.start();
    const s = job.getSnapshot();
    expect(s.phase).toBe("done");
    expect(s.publicKey).toBe(PK);
    expect(s.account).toBe(ACCOUNT);
    expect(s.txHash).toBe(TX);
    expect(s.stakeEth).toBe("0.012");
    expect(t.calls.generate).toBe(1);
    expect(t.created).toEqual([{ publicKey: PK }]);
    expect(t.calls.setMeta).toEqual([{ chainId: 81411338, account: ACCOUNT, factory: FACTORY, salt: accountSalt(PK) }]);
    expect(t.done).toHaveLength(1);
    expect(t.done[0]).toMatchObject({ version: 1, account: ACCOUNT, publicKey: PK, salt: accountSalt(PK), factory: FACTORY, createTxHash: TX, backedUp: false });
    expect([...new Set(steps)]).toEqual(["connect", "seed", "root", "derive", "create", "confirm", "done"]);
  });

  it("without an operator: generates the key once, reports unavailable, and a retry succeeds once configured", async () => {
    let configured = false;
    const t = deps({
      loadConfig: async () => config({ operatorReady: false }),
      lookups: [{ predicted: ACCOUNT, registered: false }, { predicted: ACCOUNT, registered: false }, { predicted: ACCOUNT, registered: false }, { predicted: ACCOUNT, registered: true }],
    });
    const create = t.deps.createAccount;
    t.deps.createAccount = async (body) => {
      if (!configured) throw new ApiError("not_configured", "No operator key", 503);
      return create(body);
    };
    const job = new EngraveJob(t.deps, "create");
    await job.start();
    expect(job.getSnapshot()).toMatchObject({ phase: "unavailable", publicKey: PK, account: ACCOUNT });
    expect(t.calls.generate).toBe(1);
    await job.retry();
    expect(job.getSnapshot().phase).toBe("unavailable");
    configured = true;
    await job.retry();
    expect(job.getSnapshot().phase).toBe("done");
    expect(t.calls.generate).toBe(1);
    expect(t.created).toEqual([{ publicKey: PK }]);
    expect(t.done).toHaveLength(1);
  });

  it("maps a server not_configured error to the unavailable state", async () => {
    const t = deps({ createAccount: async () => { throw new ApiError("not_configured", "No operator key", 503); } });
    const job = new EngraveJob(t.deps, "create");
    await job.start();
    expect(job.getSnapshot().phase).toBe("unavailable");
  });

  it("shows a readable error and retries without generating a second key", async () => {
    let fail = true;
    const t = deps({
      createAccount: async () => {
        if (fail) {
          fail = false;
          throw new ApiError("rate_limited", "Too many account requests. Try again in a minute.", 429);
        }
        return { account: ACCOUNT, salt: accountSalt(PK), publicKey: PK, created: false, txHash: null, blockNumber: null, stakeWei: "0" };
      },
      lookups: [{ predicted: ACCOUNT, registered: false }, { predicted: ACCOUNT, registered: false }, { predicted: ACCOUNT, registered: true }],
    });
    const job = new EngraveJob(t.deps, "create");
    await job.start();
    expect(job.getSnapshot()).toMatchObject({ phase: "error", error: "Too many account requests. Try again in a minute." });
    await job.retry();
    expect(job.getSnapshot().phase).toBe("done");
    expect(t.calls.generate).toBe(1);
    expect(t.done).toHaveLength(1);
  });

  it("refuses when the server reports a different account than the factory derives", async () => {
    const t = deps({
      createAccount: async () => ({ account: OTHER, salt: accountSalt(PK), publicKey: PK, created: true, txHash: TX, blockNumber: 1, stakeWei: "1" }),
    });
    const job = new EngraveJob(t.deps, "create");
    await job.start();
    expect(job.getSnapshot().phase).toBe("error");
    expect(t.done).toHaveLength(0);
  });

  it("errors after polling when the account never registers", async () => {
    const t = deps({ lookups: [{ predicted: ACCOUNT, registered: false }] });
    const job = new EngraveJob(t.deps, "create");
    await job.start();
    expect(job.getSnapshot()).toMatchObject({ phase: "error" });
    expect(job.getSnapshot().error).toMatch(/not registered on-chain yet/);
  });

  it("restore: registered account goes straight to done with backedUp true and no creation", async () => {
    const t = deps({ lookups: [{ predicted: ACCOUNT, registered: true }] });
    const job = new EngraveJob(t.deps, "restore", { publicKey: PK, meta: null });
    await job.start();
    expect(job.getSnapshot().phase).toBe("done");
    expect(t.created).toHaveLength(0);
    expect(t.calls.generate).toBe(0);
    expect(t.done[0]).toMatchObject({ backedUp: true, createTxHash: null });
  });

  it("restore: missing account is offered, then created on acceptance", async () => {
    const t = deps({
      lookups: [{ predicted: ACCOUNT, registered: false }, { predicted: ACCOUNT, registered: false }, { predicted: ACCOUNT, registered: true }],
    });
    const job = new EngraveJob(t.deps, "restore", { publicKey: PK, meta: null });
    await job.start();
    expect(job.getSnapshot().phase).toBe("offer");
    expect(t.created).toHaveLength(0);
    await job.acceptCreate();
    expect(job.getSnapshot().phase).toBe("done");
    expect(t.created).toHaveLength(1);
  });

  it("restore: a backup whose (unauthenticated) recorded account disagrees with the factory opens the key's own account", async () => {
    const t = deps({ lookups: [{ predicted: ACCOUNT, registered: true }] });
    const meta = { chainId: 81411338, account: OTHER, factory: FACTORY, salt: accountSalt(PK) };
    const job = new EngraveJob(t.deps, "restore", { publicKey: PK, meta });
    await job.start();
    expect(job.getSnapshot()).toMatchObject({ phase: "done", account: ACCOUNT });
    expect(t.done[0]).toMatchObject({ account: ACCOUNT, salt: accountSalt(PK) });
  });

  it("a cancelled run never reports", async () => {
    let release!: () => void;
    const t = deps({ loadConfig: () => new Promise((resolve) => (release = () => resolve(config()))) });
    const job = new EngraveJob(t.deps, "create");
    const run = job.start();
    job.cancel();
    release();
    await run;
    expect(job.getSnapshot().step).toBe("connect");
    expect(t.calls.generate).toBe(0);
  });
});

describe("wallet storage", () => {
  const record = {
    version: 1 as const,
    chainId: 81411338,
    account: ACCOUNT,
    publicKey: PK,
    salt: accountSalt(PK),
    factory: FACTORY,
    createdAt: 1,
    createTxHash: TX,
    backedUp: false,
  };
  it("round-trips a record", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    saveWalletRecord(record, storage);
    expect(map.has(WALLET_STORAGE_KEY)).toBe(true);
    expect(loadWalletRecord(storage)).toEqual(record);
    saveWalletRecord(null, storage);
    expect(loadWalletRecord(storage)).toBeNull();
  });
  it("rejects malformed records", () => {
    expect(parseWalletRecord({ ...record, version: 2 })).toBeNull();
    expect(parseWalletRecord({ ...record, publicKey: "0x" + "00".repeat(32) })).toBeNull();
    expect(parseWalletRecord({ ...record, account: "0x123" })).toBeNull();
    expect(parseWalletRecord({ ...record, backedUp: "yes" })).toBeNull();
    expect(parseWalletRecord({ ...record, createTxHash: null })).toEqual({ ...record, createTxHash: null });
    expect(loadWalletRecord({ getItem: () => "{not json" })).toBeNull();
  });
});

describe("passphrase hint", () => {
  it("requires 10 characters and flags mismatches", () => {
    expect(passphraseHint("short", "")).toBe("At least 10 characters · 5 / 10");
    expect(passphraseHint("correct horse battery", "correct horse")).toBe("The passphrases do not match");
    expect(passphraseHint("correct horse battery", "correct horse battery")).toMatch(/^Estimated \d+ bits · /);
  });
});

describe.runIf(process.env.QSW_LIVE_READ === "1")("factory reads (live, read-only eth_call)", () => {
  it("getAddress + isAccount decode against the deployed factory", async () => {
    const salt = accountSalt(PK);
    const rpc = "https://altmempool.bailo.london/rpc";
    const first = await lookupAccount(rpc, FACTORY, PK, salt);
    expect(first.predicted).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(first.registered).toBe(false);
    const again = await lookupAccount(rpc, FACTORY, PK, salt, first.predicted);
    expect(again).toEqual(first);
  });
});
