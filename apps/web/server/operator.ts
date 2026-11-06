import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { RpcError } from "../shared/rpc.js";
import type { Address, Hex } from "../shared/types.js";
import { ApiFailure } from "./http.js";
import type { Rpc } from "./manifest.js";

const MIN_GAS_PRICE = 1_000_000_000n;
/** EIP-7825 per-transaction gas cap pinned on the devnet. */
const MAX_TX_GAS = 16_777_216n;
const RETRYABLE = /nonce too low|already known|underpriced|replacement transaction|nonce.*(used|lower)/i;

export interface TxReceipt {
  transactionHash: Hex;
  blockNumber: Hex;
  status: Hex;
  gasUsed: Hex;
}

export interface SentTx {
  hash: Hex;
  blockNumber: number;
}

export interface OperatorOptions {
  receiptTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The server's EOA for account creation and faucet mints: legacy EIP-155
 * transactions exactly like demo/sponsored_swap.py send() (estimate * 1.2,
 * at least +50k; gas price >= 1 gwei; pending nonce), serialised per instance.
 */
export class Operator {
  readonly address: Address;
  private readonly account: PrivateKeyAccount;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    privateKey: Hex,
    private readonly rpc: Rpc,
    private readonly chainId: number,
    private readonly options: OperatorOptions = {},
  ) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }

  async balance(): Promise<bigint> {
    return BigInt(await this.rpc.call<Hex>("eth_getBalance", [this.address, "latest"]));
  }

  send(tx: { to: Address; data: Hex; value?: bigint }): Promise<SentTx> {
    const run = this.queue.then(() => this.sendNow(tx));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sendNow({ to, data, value = 0n }: { to: Address; data: Hex; value?: bigint }): Promise<SentTx> {
    const request = { from: this.address, to, data, value: `0x${value.toString(16)}` };
    const estimate = BigInt(await this.rpc.call<Hex>("eth_estimateGas", [request]));
    const gas = estimate * 12n / 10n > estimate + 50_000n ? estimate * 12n / 10n : estimate + 50_000n;
    if (gas > MAX_TX_GAS) throw new ApiFailure(502, "upstream_error", "The transaction exceeds the devnet's per-transaction gas cap.");
    const quoted = BigInt(await this.rpc.call<Hex>("eth_gasPrice"));
    let gasPrice = quoted > MIN_GAS_PRICE ? quoted : MIN_GAS_PRICE;
    let hash: Hex | null = null;
    for (let attempt = 0; attempt < 3 && !hash; attempt++) {
      const nonce = Number(BigInt(await this.rpc.call<Hex>("eth_getTransactionCount", [this.address, "pending"])));
      const raw = await this.account.signTransaction({ type: "legacy", chainId: this.chainId, nonce, gas, gasPrice, to, data, value });
      try {
        hash = await this.rpc.call<Hex>("eth_sendRawTransaction", [raw]);
      } catch (error) {
        if (!(error instanceof RpcError) || !RETRYABLE.test(error.message) || attempt === 2) throw error;
        gasPrice = (gasPrice * 11n) / 10n + 1n;
      }
    }
    if (!hash) throw new ApiFailure(502, "upstream_error", "The operator transaction could not be submitted.");
    const receipt = await this.waitForReceipt(hash);
    if (receipt.status !== "0x1") throw new ApiFailure(502, "upstream_error", `The operator transaction ${hash} reverted.`);
    return { hash, blockNumber: Number(BigInt(receipt.blockNumber)) };
  }

  private async waitForReceipt(hash: Hex): Promise<TxReceipt> {
    const { receiptTimeoutMs = 45_000, pollMs = 1_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = this.options;
    const deadline = Date.now() + receiptTimeoutMs;
    for (;;) {
      const receipt = await this.rpc.call<TxReceipt | null>("eth_getTransactionReceipt", [hash]);
      if (receipt) return receipt;
      if (Date.now() >= deadline) {
        throw new ApiFailure(504, "timeout", `Transaction ${hash} was sent but not mined within ${receiptTimeoutMs / 1000} s. Check the explorer before retrying.`);
      }
      await sleep(pollMs);
    }
  }
}
