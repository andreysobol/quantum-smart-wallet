import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainExplorer, type ChainRpc } from "./explorer";
import { RpcFault, validateHttpPayload } from "./policy";

const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const Q = (n: number) => "0x" + n.toString(16);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CREATED = "0x934abbffb6906db60a85b076f1e41da9667dfa53c7724f4fe2333298d7b1db8c";
const TOPIC = (address: string) => "0x" + "0".repeat(24) + address.slice(2);
const explorers: ChainExplorer[] = [];
const directories: string[] = [];
type RecordValue = Record<string, any>;

class FakeChain {
  chainId = "0x539";
  blocks = new Map<number, RecordValue>();
  receipts = new Map<string, RecordValue>();
  calls: string[] = [];
  fail = false;
  constructor(genesisHash = H(1)) {
    this.blocks.set(0, { number: "0x0", hash: genesisHash, parentHash: H(0), timestamp: "0x64", transactions: [] });
  }
  block(number: number, blockHash: string, entries: Array<{ tx: RecordValue; receipt?: RecordValue }>) {
    const parent = this.blocks.get(number - 1)!;
    const transactions = entries.map(({ tx, receipt = {} }, index) => {
      const transaction: RecordValue = { type: "0x2", from: A(1), to: A(2), value: "0x0", ...tx,
        blockNumber: Q(number), blockHash, transactionIndex: Q(index) };
      this.receipts.set(transaction.hash, {
        transactionHash: transaction.hash, blockHash, blockNumber: Q(number), transactionIndex: Q(index),
        from: transaction.from, to: transaction.to, contractAddress: null, logs: [],
        status: "0x1", gasUsed: "0x5208", type: transaction.type, ...receipt,
      });
      return transaction;
    });
    this.blocks.set(number, { number: Q(number), hash: blockHash, parentHash: parent.hash, timestamp: Q(100 + number * 6), transactions });
  }
  rpc: ChainRpc = async (method, params) => {
    this.calls.push(method);
    if (this.fail) throw new Error("private upstream details should not be public");
    if (method === "eth_chainId") return this.chainId;
    if (method === "eth_blockNumber") return Q(Math.max(...this.blocks.keys()));
    if (method === "eth_getBlockByNumber") {
      const block = this.blocks.get(Number(BigInt(params[0] as string)));
      if (!block) return null;
      return structuredClone({ ...block, transactions: params[1] ? block.transactions : block.transactions.map((tx: RecordValue) => tx.hash) });
    }
    if (method === "eth_getTransactionReceipt") return structuredClone(this.receipts.get(params[0] as string) ?? null);
    if (method === "eth_getTransactionByHash") {
      for (const block of this.blocks.values()) {
        const tx = block.transactions.find((item: RecordValue) => item.hash === params[0]);
        if (tx) return structuredClone(tx);
      }
      return null;
    }
    throw new Error("Unexpected method " + method);
  };
}
function explorer(chain: FakeChain, options: { path?: string; maxBlocksPerPoll?: number; rpc?: ChainRpc } = {}) {
  const result = new ChainExplorer({ rpc: options.rpc ?? chain.rpc, path: options.path, maxBlocksPerPoll: options.maxBlocksPerPoll });
  explorers.push(result);
  return result;
}
function list(index: ChainExplorer, query = {}) {
  return index.handle("qsw_explorerTransactions", [query]) as { transactions: RecordValue[]; nextCursor: number | null };
}
afterEach(async () => {
  for (const index of explorers.splice(0)) await index.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("chain explorer", () => {
  test("indexes ordinary deployment, actual native sender/payer/targets, and exact original detail", async () => {
    const chain = new FakeChain();
    chain.block(1, H(101), [{ tx: { hash: H(11), to: null }, receipt: { contractAddress: A(20) } }]);
    const native = await Bun.file(new URL("../../demo/evidence/shared-devnet/transaction.json", import.meta.url)).json();
    const receipt = await Bun.file(new URL("../../demo/evidence/shared-devnet/receipt.json", import.meta.url)).json();
    chain.block(2, H(102), [{
      tx: { ...native, hash: receipt.transactionHash, type: "0x6", from: null, to: null },
      receipt: { ...receipt, blockHash: H(102), blockNumber: Q(2), transactionIndex: "0x0" },
    }]);
    const index = explorer(chain);
    await index.syncOnce();
    expect(index.status()).toMatchObject({ chainId: "0x539", indexedBlock: 2, latestBlock: 2, transactionCount: 2, indexing: false, error: null });
    expect(list(index, { address: A(20) }).transactions[0]).toMatchObject({ hash: H(11), to: null, contractAddress: A(20), status: "0x1" });
    const nativeRow = list(index).transactions[0];
    expect(nativeRow).toMatchObject({ hash: receipt.transactionHash, from: native.sender, payer: receipt.payer, type: "0x6", value: "0x0", gasUsed: receipt.gasUsed });
    for (const address of [native.sender, receipt.payer, native.frames[2].target, receipt.logs[2].address]) {
      expect(list(index, { address }).transactions.map((tx) => tx.hash)).toContain(receipt.transactionHash);
    }
    const detail = index.handle("qsw_explorerTransaction", [receipt.transactionHash]) as any;
    expect(detail.transaction.signatures).toEqual(native.signatures);
    expect(detail.receipt.payer).toBe(receipt.payer);
    expect(detail.block).toEqual({ number: 2, hash: H(102), timestamp: 112 });
    expect(index.handle("qsw_explorerTransaction", [H(999)])).toBeNull();
  });

  test("indexes only recognized event address topics including factory AccountCreated", async () => {
    const chain = new FakeChain();
    chain.block(1, H(101), [{
      tx: { hash: H(11) },
      receipt: { logs: [
        { address: A(30), topics: [TRANSFER, TOPIC(A(31)), TOPIC(A(32))], data: "0x" },
        { address: A(40), topics: [CREATED, TOPIC(A(41)), TOPIC(A(99)), TOPIC(A(98))], data: "0x" },
        { address: A(50), topics: [H(123), TOPIC(A(97))], data: "0x" },
      ] },
    }]);
    const index = explorer(chain);
    await index.syncOnce();
    for (const address of [A(30), A(31), A(32), A(40), A(41), A(50)]) expect(list(index, { address }).transactions).toHaveLength(1);
    for (const address of [A(99), A(98), A(97)]) expect(list(index, { address }).transactions).toHaveLength(0);
  });

  test("paginates global and sparse address history with stable opaque cursors", async () => {
    const chain = new FakeChain();
    chain.block(1, H(101), Array.from({ length: 6 }, (_, i) => ({
      tx: { hash: H(11 + i), to: i % 2 === 0 ? A(77) : A(2) },
    })));
    const index = explorer(chain);
    await index.syncOnce();
    const first = list(index, { limit: 2 });
    const second = list(index, { limit: 2, before: first.nextCursor! });
    const third = list(index, { limit: 2, before: second.nextCursor! });
    expect([...first.transactions, ...second.transactions, ...third.transactions].map((tx) => tx.hash))
      .toEqual([H(16), H(15), H(14), H(13), H(12), H(11)]);
    expect(third.nextCursor).toBeNull();
    const addressFirst = list(index, { address: A(77).toUpperCase().replace("0X", "0x"), limit: 2 });
    const addressLast = list(index, { address: A(77), limit: 2, before: addressFirst.nextCursor! });
    expect([...addressFirst.transactions, ...addressLast.transactions].map((tx) => tx.hash)).toEqual([H(15), H(13), H(11)]);
    expect(addressLast.nextCursor).toBeNull();
  });

  test("bounds params and rejects invalid members before a mixed batch can execute", () => {
    for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { before: 0 }, { before: Number.MAX_SAFE_INTEGER + 1 }, { address: "0x0" }, { where: "1=1" }]) {
      expect(() => validateHttpPayload({ jsonrpc: "2.0", id: 1, method: "qsw_explorerTransactions", params: [query] }, "rpc")).toThrow(RpcFault);
    }
    expect(() => validateHttpPayload({ jsonrpc: "2.0", id: 1, method: "qsw_explorerTransaction", params: ["0x0"] }, "rpc")).toThrow(RpcFault);
    expect(() => validateHttpPayload({ jsonrpc: "2.0", id: 1, method: "qsw_explorerStatus", params: [] }, "mempool")).toThrow(RpcFault);
    expect(() => validateHttpPayload({ jsonrpc: "2.0", id: 1, method: "qsw_explorerTransactions", params: [{ limit: 100 }] }, "rpc")).not.toThrow();
  });

  test("reports bounded backfill, explicit errors, and successful recovery", async () => {
    const chain = new FakeChain();
    for (let i = 1; i <= 5; i++) chain.block(i, H(100 + i), []);
    const index = explorer(chain, { maxBlocksPerPoll: 2 });
    await index.syncOnce();
    expect(index.status()).toMatchObject({ indexedBlock: 1, latestBlock: 5, indexing: true, error: null });
    await index.syncOnce(); await index.syncOnce();
    expect(index.status()).toMatchObject({ indexedBlock: 5, indexing: false, error: null });
    expect(index.status().lastUpdated).toBeNumber();
    chain.fail = true;
    await expect(index.syncOnce()).rejects.toThrow();
    expect(index.status()).toMatchObject({ indexedBlock: 5, indexing: true });
    expect(index.status().error).toBeString();
    expect(index.status().error).not.toContain("private");
    chain.fail = false;
    await index.syncOnce();
    expect(index.status()).toMatchObject({ indexing: false, error: null });
  });

  test("persists history and replaces orphaned rows and participants after a reorg on restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qsw-explorer-")); directories.push(directory);
    const path = join(directory, "index.sqlite");
    const chain = new FakeChain();
    chain.block(1, H(101), [{ tx: { hash: H(11), to: A(21) } }]);
    let index = explorer(chain, { path });
    await index.syncOnce();
    await index.close(); explorers.splice(explorers.indexOf(index), 1);
    chain.block(1, H(201), [{ tx: { hash: H(12), to: A(22) } }]);
    index = explorer(chain, { path });
    expect(index.status().indexing).toBe(true);
    await index.syncOnce();
    expect(list(index).transactions.map((tx) => tx.hash)).toEqual([H(12)]);
    expect(list(index, { address: A(21) }).transactions).toHaveLength(0);
    expect(list(index, { address: A(22) }).transactions).toHaveLength(1);
    expect(index.handle("qsw_explorerTransaction", [H(11)])).toBeNull();
  });

  test("resets the persistent index when the chain genesis fingerprint changes", async () => {
    const chain = new FakeChain();
    chain.block(1, H(101), [{ tx: { hash: H(11) } }]);
    const index = explorer(chain);
    await index.syncOnce();
    chain.blocks.clear(); chain.receipts.clear();
    chain.blocks.set(0, { number: "0x0", hash: H(999), parentHash: H(0), timestamp: "0x64", transactions: [] });
    await index.syncOnce();
    expect(index.status()).toMatchObject({ genesisHash: H(999), indexedBlock: 0, latestBlock: 0, transactionCount: 0, indexing: false });
    expect(list(index).transactions).toHaveLength(0);
  });

  test("drains failed receipt workers before retry and never exceeds four active reads", async () => {
    const chain = new FakeChain();
    chain.block(1, H(101), Array.from({ length: 6 }, (_, i) => ({ tx: { hash: H(11 + i) } })));
    let failReceipt = true;
    let active = 0, maximum = 0;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowEntered = new Promise<void>((resolve) => { entered = resolve; });
    const rpc: ChainRpc = async (method, params) => {
      active++; maximum = Math.max(maximum, active);
      try {
        if (method === "eth_getTransactionReceipt" && failReceipt) {
          if (params[0] === H(11)) return null;
          if (params[0] === H(12)) { entered(); await gate; }
        }
        return await chain.rpc(method, params);
      } finally { active--; }
    };
    const index = explorer(chain, { rpc });
    const pending = index.syncOnce();
    const failure = pending.catch((error) => error);
    await slowEntered;
    expect(index.syncOnce()).toBe(pending);
    expect(active).toBeGreaterThan(0);
    release();
    expect(await failure).toBeInstanceOf(Error);
    expect(active).toBe(0);
    expect(index.status().transactionCount).toBe(0);
    failReceipt = false;
    await index.syncOnce();
    expect(index.status().transactionCount).toBe(6);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(chain.calls.every((method) => /^(eth_chainId|eth_blockNumber|eth_getBlockByNumber|eth_getTransactionReceipt|eth_getTransactionByHash)$/.test(method))).toBe(true);
  });


  test("drains failed initial identity reads before releasing the active poll", async () => {
    const chain = new FakeChain();
    let fail = true, active = 0;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const enteredSlowRead = new Promise<void>((resolve) => { entered = resolve; });
    const rpc: ChainRpc = async (method, params) => {
      active++;
      try {
        if (fail && method === "eth_chainId") throw new Error("Transient identity error");
        if (fail && method === "eth_getBlockByNumber") { entered(); await gate; }
        return await chain.rpc(method, params);
      } finally { active--; }
    };
    const index = explorer(chain, { rpc });
    const pending = index.syncOnce();
    const failure = pending.catch((error) => error);
    await enteredSlowRead;
    expect(index.syncOnce()).toBe(pending);
    release();
    expect(await failure).toBeInstanceOf(Error);
    expect(active).toBe(0);
    fail = false;
    await index.syncOnce();
    expect(index.status()).toMatchObject({ indexedBlock: 0, indexing: false, error: null });
  });

  test("refuses oversized stored transaction details before returning them publicly", async () => {
    const chain = new FakeChain();
    chain.block(1, H(101), [{ tx: { hash: H(11), input: "0x" + "ab".repeat(2 * 1024 * 1024) } }]);
    const index = explorer(chain);
    await index.syncOnce();
    expect(list(index).transactions).toHaveLength(1);
    expect(() => index.handle("qsw_explorerTransaction", [H(11)])).toThrow("public response limit");
  });
});
