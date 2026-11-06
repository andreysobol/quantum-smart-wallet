import { formatEther } from "viem";
import { rpcBatch, rpcCall, type RpcOptions } from "../../shared/rpc.js";
import type { Address, Hex, PublicConfig } from "../../shared/types.js";
import { formatToken } from "./amounts.js";
import { quantity, receiptSucceeded, sameAddress, tokenDeltas, type RawReceipt } from "./receipts.js";
import type { LedgerEntry, LedgerKind } from "./types.js";

type ActivityConfig = Pick<PublicConfig, "rpcUrl" | "contracts" | "accountInitialStake" | "faucet">;

/** One row of the gateway's persistent chain index (qsw_explorerTransactions). */
export interface ExplorerRow {
  hash: Hex;
  blockNumber: number;
  transactionIndex: number;
  timestamp: number;
  from: string;
  to: string | null;
  contractAddress: string | null;
  payer: string | null;
  type: string;
  status: string;
  gasUsed: string;
  value: string;
}

export function classifyRow(row: ExplorerRow, config: Pick<PublicConfig, "contracts">, account: string): LedgerKind {
  if (quantity(row.type) === 6 && sameAddress(row.from, account)) return "swap";
  if (sameAddress(row.to, config.contracts.accountFactory)) return "create";
  if (sameAddress(row.to, config.contracts.demoUSDC) && !sameAddress(row.from, account)) return "faucet";
  return "other";
}

const block = (n: number) => `block ${n.toLocaleString("en-US")}`;

/** Ledger entry from an index row and (for swaps and faucet drips) its receipt. */
export function toLedgerEntry(
  row: ExplorerRow,
  config: ActivityConfig,
  account: string,
  receipt: RawReceipt | null,
): LedgerEntry {
  const kind = classifyRow(row, config, account);
  const ok = receipt ? receiptSucceeded(receipt) : quantity(row.status) === 1;
  const deltas = receipt
    ? tokenDeltas(receipt.logs, account, { usdc: config.contracts.demoUSDC, weth: config.contracts.weth9 })
    : undefined;
  const usdcSym = config.faucet.symbol || "dUSDC";
  let title = "Transaction";
  let meta = block(row.blockNumber);
  if (kind === "create") {
    title = ok ? "Account created" : "Account creation failed";
    meta = `Stake ${formatEther(BigInt(config.accountInitialStake))} ETH locked · ${block(row.blockNumber)}`;
  } else if (kind === "faucet") {
    title = deltas && deltas.usdc > 0n ? `Received ${formatToken(deltas.usdc, "usdc")} ${usdcSym}` : `Faucet drip to ${usdcSym}`;
    if (!ok) title = "Faucet drip failed";
    meta = `Faucet · ${block(row.blockNumber)}`;
  } else if (kind === "swap") {
    const spentUsdc = deltas && deltas.usdc < 0n;
    if (ok && deltas && (deltas.usdc !== 0n || deltas.weth !== 0n)) {
      title = spentUsdc
        ? `Swapped ${formatToken(-deltas.usdc, "usdc")} ${usdcSym} → ${formatToken(deltas.weth, "weth")} WETH`
        : `Swapped ${formatToken(-deltas.weth, "weth")} WETH → ${formatToken(deltas.usdc, "usdc")} ${usdcSym}`;
    } else {
      title = ok ? "Swap" : "Swap reverted";
    }
    const frames = receipt?.frameReceipts?.length;
    meta = `${frames ? `${frames} frames · ` : ""}sponsored · ${block(row.blockNumber)}`;
  }
  return {
    hash: row.hash,
    kind,
    title,
    meta,
    blockNumber: row.blockNumber,
    timestamp: row.timestamp,
    status: ok ? "success" : "reverted",
    payer: (row.payer as Address | null) ?? null,
    ...(deltas && (kind === "swap" || kind === "faucet") ? { deltas } : {}),
  };
}

/**
 * Account history from the gateway index, newest first. Receipts are fetched in
 * batches only for swaps and faucet drips, to show their actual token amounts.
 */
export async function loadActivity(
  config: ActivityConfig,
  account: Address,
  options: RpcOptions & { limit?: number } = {},
): Promise<LedgerEntry[]> {
  const { limit = 25, ...rpc } = options;
  const page = await rpcCall<{ transactions: ExplorerRow[] }>(
    config.rpcUrl,
    "qsw_explorerTransactions",
    [{ address: account.toLowerCase(), limit }],
    rpc,
  );
  const rows = page?.transactions ?? [];
  const wanted = rows.filter((row) => {
    const kind = classifyRow(row, config, account);
    return kind === "swap" || kind === "faucet";
  });
  const receipts = new Map<string, RawReceipt>();
  for (let i = 0; i < wanted.length; i += 20) {
    const chunk = wanted.slice(i, i + 20);
    const results = await rpcBatch(
      config.rpcUrl,
      chunk.map((row) => ({ method: "eth_getTransactionReceipt", params: [row.hash] })),
      rpc,
    );
    results.forEach((result, index) => {
      const row = chunk[index];
      if (row && result.ok && result.result) receipts.set(row.hash.toLowerCase(), result.result as RawReceipt);
    });
  }
  return rows.map((row) => toLedgerEntry(row, config, account, receipts.get(row.hash.toLowerCase()) ?? null));
}
