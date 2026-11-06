import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_RESPONSE_BYTES, RpcFault, isRecord, validateExplorerParams } from "./policy";

export type ChainRpc = (method: string, params: unknown[]) => Promise<unknown>;
type JsonRecord = Record<string, unknown>;
type Header = { number: number; hash: string; parentHash: string; timestamp: number };
export type ExplorerTransaction = {
  hash: string; blockNumber: number; transactionIndex: number; timestamp: number;
  from: string | null; to: string | null; contractAddress: string | null; payer: string | null;
  type: string; status: string | null; gasUsed: string | null; value: string;
};
type StoredRow = ExplorerTransaction & { cursor: number };
type IndexedTransaction = { row: ExplorerTransaction; transaction: JsonRecord; receipt: JsonRecord; participants: Set<string> };

const MAX_BLOCKS_PER_POLL = 32;
const MAX_TRANSACTIONS_PER_POLL = 500;
const MAX_TRANSACTIONS_PER_BLOCK = 5_000;
const MAX_REORG_DEPTH = 64;
const MAX_RPC_BYTES = 16 * 1024 * 1024;
const PARTICIPANT_VERSION = 1;
const MAX_MIGRATION_ROWS = 32;
const MAX_MIGRATION_BYTES = 8 * 1024 * 1024;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ACCOUNT_CREATED = "0x934abbffb6906db60a85b076f1e41da9667dfa53c7724f4fe2333298d7b1db8c";
const HEX_HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function address(value: unknown): string | null {
  return typeof value === "string" && HEX_ADDRESS.test(value) ? value.toLowerCase() : null;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !HEX_HASH.test(value)) throw new Error("Invalid chain hash");
  return value.toLowerCase();
}
function quantity(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return "0x" + value.toString(16);
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return "0x" + BigInt(value).toString(16);
  return null;
}
function integer(value: unknown): number {
  const encoded = quantity(value);
  const number = encoded === null ? NaN : Number(BigInt(encoded));
  if (!Number.isSafeInteger(number)) throw new Error("Invalid chain number");
  return number;
}
function header(value: unknown): Header {
  if (!isRecord(value)) throw new Error("Block is unavailable");
  return {
    number: integer(value.number), hash: hash(value.hash),
    parentHash: hash(value.parentHash), timestamp: integer(value.timestamp),
  };
}
function topicAddress(value: unknown): string | null {
  return typeof value === "string" && /^0x0{24}[0-9a-fA-F]{40}$/.test(value) ?
    address("0x" + value.slice(-40)) : null;
}
function logs(receipt: JsonRecord): unknown[] {
  const result: unknown[] = Array.isArray(receipt.logs) ? [...receipt.logs] : [];
  if (Array.isArray(receipt.frameReceipts)) {
    for (const frame of receipt.frameReceipts) {
      if (isRecord(frame) && Array.isArray(frame.logs)) result.push(...frame.logs);
    }
  }
  return result;
}
function prepareTransaction(transaction: JsonRecord, receipt: JsonRecord, block: Header, index: number): IndexedTransaction {
  const txHash = hash(transaction.hash);
  if (hash(receipt.transactionHash) !== txHash || hash(receipt.blockHash) !== block.hash ||
      integer(receipt.blockNumber) !== block.number || integer(receipt.transactionIndex) !== index) {
    throw new Error("Receipt does not match the indexed block");
  }
  const frames = Array.isArray(transaction.frames) ? transaction.frames.filter(isRecord) : [];
  const frameValue = frames.reduce((sum, frame) => sum + BigInt(quantity(frame.value) ?? "0x0"), 0n);
  const status = typeof receipt.status === "boolean" ? (receipt.status ? "0x1" : "0x0") : quantity(receipt.status);
  const row: ExplorerTransaction = {
    hash: txHash, blockNumber: block.number, transactionIndex: index, timestamp: block.timestamp,
    from: address(transaction.from) ?? address(transaction.sender) ?? address(receipt.from),
    to: address(transaction.to), contractAddress: address(receipt.contractAddress),
    payer: address(receipt.payer), type: quantity(transaction.type) ?? quantity(receipt.type) ?? "0x0",
    status, gasUsed: quantity(receipt.gasUsed),
    value: quantity(transaction.value) ?? "0x" + frameValue.toString(16),
  };
  const participants = new Set<string>();
  const add = (candidate: unknown) => { const normalized = address(candidate); if (normalized) participants.add(normalized); };
  for (const candidate of [row.from, row.to, row.contractAddress, row.payer]) add(candidate);
  for (const frame of frames) {
    // Mined ethrex RPC uses to; the sidecar submission DTO uses target.
    const destination = Object.hasOwn(frame, "to") ? frame.to : frame.target;
    add(destination ?? transaction.sender ?? row.from);
  }
  for (const value of logs(receipt)) {
    if (!isRecord(value)) continue;
    add(value.address);
    const topics = Array.isArray(value.topics) ? value.topics : [];
    if (typeof topics[0] !== "string") continue;
    if (topics[0].toLowerCase() === TRANSFER) {
      add(topicAddress(topics[1])); add(topicAddress(topics[2]));
    } else if (topics[0].toLowerCase() === ACCOUNT_CREATED) {
      add(topicAddress(topics[1]));
    }
  }
  return { row, transaction, receipt, participants };
}

export function createInternalChainRpc(url: string): ChainRpc {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Invalid internal explorer RPC URL");
  }
  let nextId = 0;
  return async (method, params) => {
    const id = ++nextId;
    const response = await fetch(parsed, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || !response.body) throw new Error("Chain RPC is unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RPC_BYTES) { await reader.cancel(); throw new Error("Chain RPC response is too large"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const merged = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder().decode(merged));
    if (!isRecord(value) || value.id !== id || value.error || !Object.hasOwn(value, "result")) {
      throw new Error("Chain RPC returned an invalid response");
    }
    return value.result;
  };
}

export class ChainExplorer {
  private readonly db: Database;
  private readonly rpc: ChainRpc;
  private readonly pollInterval: number;
  private readonly maxBlocks: number;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private closed = false;
  private ready = false;
  private error: string | null = null;
  private latest: number | null = null;
  private migratingParticipants = false;

  constructor(options: { rpc: ChainRpc; path?: string; pollIntervalMs?: number; maxBlocksPerPoll?: number }) {
    const path = options.path ?? ":memory:";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.rpc = options.rpc;
    this.pollInterval = options.pollIntervalMs ?? 2_000;
    this.maxBlocks = options.maxBlocksPerPoll ?? MAX_BLOCKS_PER_POLL;
    if (!Number.isSafeInteger(this.pollInterval) || this.pollInterval < 100 ||
        !Number.isSafeInteger(this.maxBlocks) || this.maxBlocks < 1 || this.maxBlocks > 100) {
      this.db.close(); throw new Error("Invalid explorer polling limits");
    }
    this.db.run("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 1000;");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (
        number INTEGER PRIMARY KEY, hash TEXT NOT NULL, parent_hash TEXT NOT NULL, timestamp INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE,
        block_number INTEGER NOT NULL REFERENCES blocks(number) ON DELETE CASCADE,
        transaction_index INTEGER NOT NULL, timestamp INTEGER NOT NULL,
        from_address TEXT, to_address TEXT, contract_address TEXT, payer TEXT,
        type TEXT NOT NULL, status TEXT, gas_used TEXT, value TEXT NOT NULL,
        transaction_json TEXT NOT NULL, receipt_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participants (
        address TEXT NOT NULL, transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        PRIMARY KEY (address, transaction_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS participants_transaction ON participants(transaction_id);
      CREATE INDEX IF NOT EXISTS transactions_block ON transactions(block_number);
    `);
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > PARTICIPANT_VERSION) {
      this.db.close(true); throw new Error("Explorer index was created by a newer version");
    }
    if (version < PARTICIPANT_VERSION) {
      const count = (this.db.query("SELECT COUNT(*) AS count FROM transactions").get() as { count: number }).count;
      this.migratingParticipants = count > 0;
      if (!this.migratingParticipants) this.db.run("PRAGMA user_version = 1");
    }
  }

  private migrateParticipants() {
    const cursor = Number(this.meta("participantMigrationCursor") ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid participant migration cursor");
    const candidates = this.db.query(`SELECT id, length(CAST(transaction_json AS BLOB)) +
      length(CAST(receipt_json AS BLOB)) AS bytes FROM transactions WHERE id>? ORDER BY id LIMIT ?`)
      .all(cursor, MAX_MIGRATION_ROWS + 1) as Array<{ id: number; bytes: number }>;
    const updates: Array<{ id: number; participants: Set<string> }> = [];
    let bytes = 0;
    for (const candidate of candidates.slice(0, MAX_MIGRATION_ROWS)) {
      if (candidate.bytes > MAX_RPC_BYTES * 2) throw new Error("Cached transaction exceeds migration limit");
      if (updates.length > 0 && bytes + candidate.bytes > MAX_MIGRATION_BYTES) break;
      const stored = this.db.query(`SELECT t.transaction_json,t.receipt_json,t.block_number,t.transaction_index,
        b.hash,b.parent_hash,b.timestamp FROM transactions t JOIN blocks b ON b.number=t.block_number WHERE t.id=?`)
        .get(candidate.id) as {
          transaction_json: string; receipt_json: string; block_number: number; transaction_index: number;
          hash: string; parent_hash: string; timestamp: number;
        };
      const transaction: unknown = JSON.parse(stored.transaction_json);
      const receipt: unknown = JSON.parse(stored.receipt_json);
      if (!isRecord(transaction) || !isRecord(receipt)) throw new Error("Invalid cached transaction");
      const prepared = prepareTransaction(transaction, receipt, {
        number: stored.block_number, hash: stored.hash, parentHash: stored.parent_hash, timestamp: stored.timestamp,
      }, stored.transaction_index);
      updates.push({ id: candidate.id, participants: prepared.participants });
      bytes += candidate.bytes;
    }
    const complete = updates.length === candidates.length;
    this.db.transaction(() => {
      const remove = this.db.query("DELETE FROM participants WHERE transaction_id=?");
      const insert = this.db.query("INSERT OR IGNORE INTO participants(address,transaction_id) VALUES(?,?)");
      for (const update of updates) {
        remove.run(update.id);
        for (const address of update.participants) insert.run(address, update.id);
      }
      if (complete) {
        this.db.query("DELETE FROM metadata WHERE key='participantMigrationCursor'").run();
        this.db.run("PRAGMA user_version = 1");
      } else {
        this.setMeta("participantMigrationCursor", String(updates[updates.length - 1].id));
      }
    })();
    this.migratingParticipants = !complete;
  }

  private meta(key: string): string | null {
    return (this.db.query("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
  }
  private setMeta(key: string, value: string) {
    this.db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(key, value);
  }
  private tip(): { number: number; hash: string } | null {
    return this.db.query("SELECT number,hash FROM blocks ORDER BY number DESC LIMIT 1").get() as { number: number; hash: string } | null;
  }
  private rollback(height: number) {
    this.db.transaction(() => { this.db.query("DELETE FROM blocks WHERE number > ?").run(height); })();
  }

  status() {
    const indexed = this.tip()?.number ?? null;
    return {
      chainId: this.meta("chainId"), genesisHash: this.meta("genesisHash"),
      indexedBlock: indexed, latestBlock: this.latest,
      transactionCount: (this.db.query("SELECT COUNT(*) AS count FROM transactions").get() as { count: number }).count,
      indexing: !this.ready || this.pending !== undefined || this.migratingParticipants || this.error !== null ||
        indexed === null || this.latest === null || indexed < this.latest,
      error: this.error, lastUpdated: this.meta("lastUpdated") === null ? null : Number(this.meta("lastUpdated")),
    };
  }

  handle(method: string, params: unknown[]) {
    validateExplorerParams(method, params);
    if (method === "qsw_explorerStatus") return this.status();
    if (method === "qsw_explorerTransaction") {
      const txHash = (params[0] as string).toLowerCase();
      const size = this.db.query(`SELECT length(CAST(transaction_json AS BLOB)) +
        length(CAST(receipt_json AS BLOB)) AS bytes FROM transactions WHERE hash=?`).get(txHash) as { bytes: number } | null;
      if (!size) return null;
      if (size.bytes > MAX_RESPONSE_BYTES - 1024) {
        throw new RpcFault(-32005, "Transaction detail exceeds the public response limit", null, 413);
      }
      const row = this.db.query(`
        SELECT t.transaction_json,t.receipt_json,b.number,b.hash,b.timestamp
        FROM transactions t JOIN blocks b ON b.number=t.block_number WHERE t.hash=?
      `).get(txHash) as {
        transaction_json: string; receipt_json: string; number: number; hash: string; timestamp: number;
      } | null;
      return row ? {
        transaction: JSON.parse(row.transaction_json), receipt: JSON.parse(row.receipt_json),
        block: { number: row.number, hash: row.hash, timestamp: row.timestamp },
      } : null;
    }
    const query = params[0] as { address?: string; before?: number; limit?: number };
    const limit = query.limit ?? 25;
    const before = query.before ?? Number.MAX_SAFE_INTEGER;
    const fields = `SELECT t.id AS cursor,t.hash,t.block_number AS blockNumber,
      t.transaction_index AS transactionIndex,t.timestamp,t.from_address AS "from",
      t.to_address AS "to",t.contract_address AS contractAddress,t.payer,t.type,
      t.status,t.gas_used AS gasUsed,t.value`;
    const rows = (query.address ?
      this.db.query(fields + ` FROM participants p JOIN transactions t ON t.id=p.transaction_id
        WHERE p.address=? AND p.transaction_id<? ORDER BY p.transaction_id DESC LIMIT ?`)
        .all(query.address.toLowerCase(), before, limit + 1) :
      this.db.query(fields + " FROM transactions t WHERE t.id < ? ORDER BY t.id DESC LIMIT ?")
        .all(before, limit + 1)) as StoredRow[];
    return {
      transactions: rows.slice(0, limit).map(({ cursor: _cursor, ...transaction }) => transaction),
      nextCursor: rows.length > limit ? rows[limit - 1].cursor : null,
    };
  }

  syncOnce(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Explorer is closed"));
    if (this.pending) return this.pending;
    this.pending = this.synchronize().then(() => {
      this.ready = true; this.error = null;
      this.setMeta("lastUpdated", String(Math.floor(Date.now() / 1000)));
    }).catch((error) => {
      this.error = "Chain indexing is unavailable; the next poll will retry.";
      throw error;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async synchronize() {
    if (this.migratingParticipants) { this.migrateParticipants(); return; }
    const initial = await Promise.allSettled([
      this.rpc("eth_chainId", []),
      this.rpc("eth_getBlockByNumber", ["0x0", false]),
      this.rpc("eth_blockNumber", []),
    ]);
    const [chainValue, genesisValue, latestValue] = initial.map((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      return outcome.value;
    });
    const chainId = quantity(chainValue);
    if (!chainId) throw new Error("Invalid chain ID");
    const genesis = header(genesisValue);
    if (genesis.number !== 0) throw new Error("Invalid genesis block");
    this.latest = integer(latestValue);
    if (this.meta("chainId") !== chainId || this.meta("genesisHash") !== genesis.hash) {
      this.db.transaction(() => {
        this.db.run("DELETE FROM blocks; DELETE FROM metadata;");
        this.setMeta("chainId", chainId); this.setMeta("genesisHash", genesis.hash);
      })();
    }
    let tip = this.tip();
    if (tip && tip.number > this.latest) { this.rollback(this.latest); tip = this.tip(); }
    if (tip) {
      let ancestor = tip.number;
      let matched = false;
      for (let depth = 0; depth < MAX_REORG_DEPTH && ancestor >= 0; depth++, ancestor--) {
        const stored = this.db.query("SELECT hash FROM blocks WHERE number=?").get(ancestor) as { hash: string } | null;
        const current = header(await this.rpc("eth_getBlockByNumber", ["0x" + ancestor.toString(16), false]));
        if (stored?.hash === current.hash) { matched = true; break; }
      }
      this.rollback(matched ? ancestor : -1);
      tip = this.tip();
    }
    let processed = 0;
    let transactions = 0;
    for (let number = (tip?.number ?? -1) + 1;
         number <= this.latest && processed < this.maxBlocks && transactions < MAX_TRANSACTIONS_PER_POLL;
         number++) {
      const value = await this.rpc("eth_getBlockByNumber", ["0x" + number.toString(16), true]);
      const block = header(value);
      if (block.number !== number || !isRecord(value) || !Array.isArray(value.transactions) ||
          value.transactions.length > MAX_TRANSACTIONS_PER_BLOCK) throw new Error("Invalid block transaction list");
      const parent = this.tip();
      if (number > 0 && (!parent || block.parentHash !== parent.hash)) throw new Error("Chain changed during indexing");
      const entries = value.transactions;
      if (processed > 0 && transactions + entries.length > MAX_TRANSACTIONS_PER_POLL) break;
      const indexed: IndexedTransaction[] = new Array(entries.length);
      let next = 0;
      let failed = false;
      const outcomes = await Promise.allSettled(Array.from({ length: Math.min(4, entries.length) }, async () => {
        try {
        while (!failed && next < entries.length) {
          const index = next++;
          const entry = entries[index];
          const transaction = isRecord(entry) ? entry :
            await this.rpc("eth_getTransactionByHash", [hash(entry)]);
          if (!isRecord(transaction)) throw new Error("Transaction is unavailable");
          const receipt = await this.rpc("eth_getTransactionReceipt", [hash(transaction.hash)]);
          if (!isRecord(receipt)) throw new Error("Transaction receipt is unavailable");
          indexed[index] = prepareTransaction(transaction, receipt, block, index);
        }
        } catch (error) { failed = true; throw error; }
      }));
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      const confirmed = header(await this.rpc("eth_getBlockByNumber", ["0x" + number.toString(16), false]));
      if (confirmed.hash !== block.hash) throw new Error("Chain changed during indexing");
      this.db.transaction(() => {
        this.db.query("INSERT INTO blocks(number,hash,parent_hash,timestamp) VALUES(?,?,?,?)")
          .run(block.number, block.hash, block.parentHash, block.timestamp);
        const insert = this.db.query(`INSERT INTO transactions (
          hash,block_number,transaction_index,timestamp,from_address,to_address,contract_address,
          payer,type,status,gas_used,value,transaction_json,receipt_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const participant = this.db.query("INSERT OR IGNORE INTO participants(address,transaction_id) VALUES(?,?)");
        for (const item of indexed) {
          const row = item.row;
          const result = insert.run(row.hash,row.blockNumber,row.transactionIndex,row.timestamp,row.from,row.to,
            row.contractAddress,row.payer,row.type,row.status,row.gasUsed,row.value,
            JSON.stringify(item.transaction),JSON.stringify(item.receipt));
          for (const address of item.participants) participant.run(address, result.lastInsertRowid);
        }
      })();
      processed++; transactions += entries.length;
    }
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    const poll = async () => {
      try { await this.syncOnce(); }
      catch (error) { console.warn("Chain explorer poll failed: " + (error instanceof Error ? error.message : "unknown error")); }
      if (this.started && !this.closed) this.timer = setTimeout(poll, this.pollInterval);
    };
    void poll();
  }

  async close() {
    this.started = false; this.closed = true; clearTimeout(this.timer);
    await this.pending?.catch(() => {});
    this.db.close(true);
  }
}
