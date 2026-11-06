import { decodeFunctionResult, encodeFunctionData } from "viem";
import { rpcBatch, RpcError } from "../../shared/rpc.js";
import type { Address, Hex } from "../../shared/types.js";

/** The two QuantumAccountFactory views the onboarding flow needs (subset of the deployed ABI). */
const factoryAbi = [
  {
    type: "function",
    name: "getAddress",
    stateMutability: "view",
    inputs: [
      { name: "publicKey", type: "bytes32" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "isAccount",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "registered", type: "bool" }],
  },
] as const;

export interface AccountLookup {
  /** factory.getAddress(publicKey, salt): the CREATE2 address of the key's account. */
  predicted: Address;
  /** factory.isAccount(account) for the address that was asked about. */
  registered: boolean;
}

const ethCall = (to: Address, data: Hex) => ({ method: "eth_call", params: [{ to, data }, "latest"] });

/**
 * Read-only factory check: getAddress(publicKey, salt) and isAccount(expected) in one RPC batch.
 * Without `expected`, isAccount is asked about the predicted address in a second call.
 */
export async function lookupAccount(
  rpcUrl: string,
  factory: Address,
  publicKey: Hex,
  salt: Hex,
  expected?: Address,
): Promise<AccountLookup> {
  const getAddressData = encodeFunctionData({ abi: factoryAbi, functionName: "getAddress", args: [publicKey, salt] });
  const calls = [ethCall(factory, getAddressData)];
  if (expected) {
    calls.push(ethCall(factory, encodeFunctionData({ abi: factoryAbi, functionName: "isAccount", args: [expected] })));
  }
  const [addressResult, registeredResult] = await rpcBatch(rpcUrl, calls);
  if (!addressResult?.ok) throw addressResult?.error ?? new RpcError(-32603, "No response to getAddress", "eth_call");
  const predicted = decodeFunctionResult({
    abi: factoryAbi,
    functionName: "getAddress",
    data: addressResult.result as Hex,
  }) as Address;
  if (expected) {
    if (!registeredResult?.ok) throw registeredResult?.error ?? new RpcError(-32603, "No response to isAccount", "eth_call");
    return { predicted, registered: decodeRegistered(registeredResult.result as Hex) };
  }
  return { predicted, registered: await isRegistered(rpcUrl, factory, predicted) };
}

export async function isRegistered(rpcUrl: string, factory: Address, account: Address): Promise<boolean> {
  const data = encodeFunctionData({ abi: factoryAbi, functionName: "isAccount", args: [account] });
  const [result] = await rpcBatch(rpcUrl, [ethCall(factory, data)]);
  if (!result?.ok) throw result?.error ?? new RpcError(-32603, "No response to isAccount", "eth_call");
  return decodeRegistered(result.result as Hex);
}

function decodeRegistered(data: Hex): boolean {
  return decodeFunctionResult({ abi: factoryAbi, functionName: "isAccount", data }) as boolean;
}
