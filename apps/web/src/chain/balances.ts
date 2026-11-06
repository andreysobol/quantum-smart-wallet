import { decodeFunctionResult, encodeFunctionData, type Abi } from "viem";
import { erc20Abi, stakingRegistryAbi, stateViewAbi } from "../../shared/abis.js";
import { rpcBatch, type BatchResult, type RpcOptions } from "../../shared/rpc.js";
import type { Address, Hex, PublicConfig } from "../../shared/types.js";
import { spotUsdcPerWeth } from "./amounts.js";
import { sameAddress } from "./receipts.js";
import type { Balances } from "./types.js";

type BalanceConfig = Pick<PublicConfig, "rpcUrl" | "contracts" | "poolKey" | "poolId">;

const call = (to: Address, abi: Abi, functionName: string, args: readonly unknown[]) => ({
  method: "eth_call",
  params: [{ to, data: encodeFunctionData({ abi, functionName, args } as never) }, "latest"],
});

function decoded(result: BatchResult | undefined, abi: Abi, functionName: string): unknown {
  if (!result?.ok) return null;
  try {
    return decodeFunctionResult({ abi, functionName, data: result.result as Hex } as never);
  } catch {
    return null;
  }
}

const first = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);

/** Spendable ETH, dUSDC, WETH, the locked registry stake and the pool spot price, in one batch. */
export async function loadBalances(config: BalanceConfig, account: Address, options: RpcOptions = {}): Promise<Balances> {
  const { demoUSDC, weth9, stakingRegistry, stateView } = config.contracts;
  const results = await rpcBatch(
    config.rpcUrl,
    [
      { method: "eth_blockNumber" },
      { method: "eth_getBalance", params: [account, "latest"] },
      call(demoUSDC, erc20Abi as Abi, "balanceOf", [account]),
      call(weth9, erc20Abi as Abi, "balanceOf", [account]),
      call(stakingRegistry, stakingRegistryAbi as Abi, "getDepositInfo", [account]),
      call(stateView, stateViewAbi as Abi, "getSlot0", [config.poolId]),
    ],
    options,
  );
  const [blockR, ethR, usdcR, wethR, stakeR, slotR] = results;
  const usdc = decoded(usdcR, erc20Abi as Abi, "balanceOf");
  const weth = decoded(wethR, erc20Abi as Abi, "balanceOf");
  if (!blockR?.ok || !ethR?.ok || typeof usdc !== "bigint" || typeof weth !== "bigint") {
    throw new Error("Could not read balances from the devnet RPC. Check your connection and try again.");
  }
  const stake = first(decoded(stakeR, stakingRegistryAbi as Abi, "getDepositInfo"));
  const sqrtPriceX96 = first(decoded(slotR, stateViewAbi as Abi, "getSlot0"));
  return {
    block: Number(BigInt(blockR.result as string)),
    eth: BigInt(ethR.result as string),
    usdc,
    weth,
    stake: typeof stake === "bigint" ? stake : null,
    usdcPerWeth:
      typeof sqrtPriceX96 === "bigint"
        ? spotUsdcPerWeth(sqrtPriceX96, sameAddress(config.poolKey.currency0, demoUSDC))
        : Number.NaN,
  };
}
