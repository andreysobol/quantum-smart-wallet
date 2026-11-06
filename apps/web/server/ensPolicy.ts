import { decodeFunctionResult, encodeFunctionData } from "viem";
import { demoUsdcAbi, factoryAbi } from "../shared/abis.js";
import { buildRegisterTx, EnsCodecError, parseRegisterTx, type ParsedRegistration } from "../shared/ens.js";
import { ensRegistrarAbi, ensVaultFactoryAbi } from "../shared/ensAbis.js";
import { encodeRaw, type FrameTx } from "../shared/frameTx.js";
import type { Address, EnsDeployment, Hex } from "../shared/types.js";
import { ApiFailure } from "./http.js";
import type { Deployment, Rpc } from "./manifest.js";
import { checkEnvelope, checkSponsorFunds, okResult, rejectPolicy as reject, verifyAccountSignature } from "./policy.js";

export interface EnsPolicyContext {
  deployment: Pick<Deployment, "chainId" | "contracts"> & { ens: EnsDeployment };
  sponsor: Address;
  /** Wei the sponsor must keep on top of the worst-case fee of this transaction. */
  reserve: bigint;
  rpc: Rpc;
}

/**
 * Static checks of the registration template (no network): the shared envelope, the six frames with
 * exact targets and calldata, and the canonical template rebuilt from the parsed intent, byte for byte
 * (gas limits included). Returns the intent; chain values are checked by checkEnsSponsorPolicy.
 */
export function checkEnsTemplate(tx: FrameTx, ctx: Omit<EnsPolicyContext, "rpc" | "reserve">): ParsedRegistration {
  const { deployment, sponsor } = ctx;
  checkEnvelope(tx, deployment, sponsor, 6);
  let parsed: ParsedRegistration;
  try {
    parsed = parseRegisterTx(tx, deployment);
  } catch (error) {
    if (error instanceof EnsCodecError) return reject(`Registration frames rejected: ${error.message}.`);
    return reject("Registration frames could not be decoded.");
  }
  const rebuilt = buildRegisterTx({
    config: { chainId: deployment.chainId, sponsor, ens: deployment.ens },
    account: tx.sender,
    nonce: tx.nonceSeq,
    label: parsed.label,
    years: parsed.years,
    price: parsed.price,
    vault: parsed.vault,
    resolver: parsed.resolver,
  });
  if (encodeRaw({ ...rebuilt, signatures: tx.signatures }) !== encodeRaw(tx)) reject("Frames 2-5 must match the canonical registration template byte for byte.");
  return parsed;
}

/**
 * The complete registration policy: the static template, then live checks — a factory-created account
 * at its current nonce, the account's own vault and resolver, an available name, the registrar's quoted
 * price as the exact payment, enough dUSDC to pay it, sponsor funds — and the account's SLH-DSA signature
 * verified on-chain.
 */
export async function checkEnsSponsorPolicy(tx: FrameTx, ctx: EnsPolicyContext): Promise<ParsedRegistration> {
  const parsed = checkEnsTemplate(tx, ctx);
  const { contracts, ens } = ctx.deployment;
  const call = (to: Address, data: Hex) => ({ method: "eth_call", params: [{ to, data }, "latest"] });
  const [nonce, registered, balance, vault, resolver, available, price, dusdc] = await ctx.rpc.batch([
    { method: "eth_getTransactionCount", params: [tx.sender, "latest"] },
    call(contracts.accountFactory, encodeFunctionData({ abi: factoryAbi, functionName: "isAccount", args: [tx.sender] })),
    { method: "eth_getBalance", params: [ctx.sponsor, "latest"] },
    call(ens.vaultFactory, encodeFunctionData({ abi: ensVaultFactoryAbi, functionName: "vaultAddress", args: [tx.sender] })),
    call(ens.vaultFactory, encodeFunctionData({ abi: ensVaultFactoryAbi, functionName: "resolverAddress", args: [tx.sender] })),
    call(ens.registrar, encodeFunctionData({ abi: ensRegistrarAbi, functionName: "isAvailable", args: [parsed.label] })),
    call(ens.registrar, encodeFunctionData({ abi: ensRegistrarAbi, functionName: "getPrice", args: [parsed.duration] })),
    call(ens.paymentToken, encodeFunctionData({ abi: demoUsdcAbi, functionName: "balanceOf", args: [tx.sender] })),
  ]);
  const decode = <T>(item: Parameters<typeof okResult>[0], what: string, abi: unknown, functionName: string): T =>
    decodeFunctionResult({ abi, functionName, data: okResult(item, what) as Hex } as never) as T;

  if (!decode<boolean>(registered, "the account registry", factoryAbi, "isAccount")) {
    throw new ApiFailure(403, "not_quantum_account", "The sender is not a QuantumAccount created by the wallet factory.");
  }
  const accountNonce = BigInt(okResult(nonce, "the account nonce") as Hex);
  if (tx.nonceSeq !== accountNonce) reject(`nonceSeq ${tx.nonceSeq} does not match the account nonce ${accountNonce}; rebuild the registration.`);
  const ownVault = decode<Address>(vault, "the account's vault address", ensVaultFactoryAbi, "vaultAddress");
  const ownResolver = decode<Address>(resolver, "the account's resolver address", ensVaultFactoryAbi, "resolverAddress");
  if (ownVault.toLowerCase() !== parsed.vault) reject(`The name must be registered to the sender's own vault ${ownVault}.`);
  if (ownResolver.toLowerCase() !== parsed.resolver) reject(`The name must use the sender's own resolver ${ownResolver}.`);
  if (!decode<boolean>(available, "the name's availability", ensRegistrarAbi, "isAvailable")) {
    reject(`${parsed.name} is already registered.`);
  }
  const quoted = decode<bigint>(price, "the registrar price", ensRegistrarAbi, "getPrice");
  if (parsed.price !== quoted) reject(`The payment must be the registrar's quoted price of ${quoted} raw dUSDC for ${parsed.years} year${parsed.years === 1 ? "" : "s"}.`);
  const funds = decode<bigint>(dusdc, "the account's dUSDC balance", demoUsdcAbi, "balanceOf");
  if (funds < parsed.price) reject(`The account holds ${funds} raw dUSDC, less than the ${parsed.price} the name costs.`);
  checkSponsorFunds(tx, BigInt(okResult(balance, "the sponsor balance") as Hex), ctx.reserve);
  await verifyAccountSignature(tx, contracts, ctx.rpc);
  return parsed;
}
