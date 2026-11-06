/**
 * Devnet ENSv2 in the browser: quotes, the account's names and the sponsored registration.
 *
 * Every name the wallet shows is re-checked on chain: the namespace registry must list the account's
 * ENSVault as the token owner (unexpired), and the universal resolver must resolve the name to the
 * account. The vault holds the name; the account controls the vault.
 */
import { decodeEventLog, decodeFunctionResult, encodeEventTopics, encodeFunctionData, keccak256, stringToBytes } from "viem";
import { demoUsdcAbi } from "../../shared/abis.js";
import { buildRegisterTx, checkLabel, dnsEncode, durationFor, nameNode, registerFrameLabels } from "../../shared/ens.js";
import { ensRegistrarAbi, ensRegistryAbi, ensVaultFactoryAbi, universalResolverAbi } from "../../shared/ensAbis.js";
import { signingHash, toWire, txHash } from "../../shared/frameTx.js";
import { rpcBatch, rpcCall, type BatchItem, type BatchResult } from "../../shared/rpc.js";
import { SIGNATURE_BYTES } from "../../shared/constants.js";
import { formatUnits } from "../../shared/format.js";
import type { Address, EnsDeployment, Hex, PublicConfig, SponsorResponse } from "../../shared/types.js";
import type { Signer } from "../crypto/types.js";
import type { WalletRecord } from "../state/types.js";
import { api } from "./api.js";
import { explorerTxUrl } from "./explorer.js";
import { describeRejection, frameViews, quantity, receiptFee, receiptSucceeded, sameAddress, tokenDeltas, type RawLog } from "./receipts.js";
import {
  describeSponsorError,
  describeUnexpected,
  submitFrameTransaction,
  SwapError,
  verifySponsorResponse,
  waitForAdmission,
  waitForReceipt,
  withSignature,
} from "./swap.js";
import type { FrameView, SwapProgress, SwapStage } from "./types.js";

export type EnsConfig = PublicConfig & { ens: EnsDeployment };

export const hasEns = (config: PublicConfig | null): config is EnsConfig => !!config?.ens;

const STATUS_REGISTERED = 2;
const call = (to: Address, data: Hex): BatchItem => ({ method: "eth_call", params: [{ to, data }, "latest"] });
const labelId = (label: string) => BigInt(keccak256(stringToBytes(label)));
const okHex = (item: BatchResult | undefined): Hex | null => (item?.ok ? (item.result as Hex) : null);

export function formatDusdc(raw: bigint): string {
  return `${formatUnits(raw, 6, 2)} dUSDC`;
}

// ---------------------------------------------------------------------------- reads

export interface NameQuote {
  label: string;
  name: string;
  years: number;
  available: boolean;
  /** registrar.getPrice(duration), raw dUSDC. */
  price: bigint;
  /** The account's dUSDC balance. */
  balance: bigint;
}

/** Availability and the registrar's quoted price, read in one batch. */
export async function quoteName(config: EnsConfig, account: Address, label: string, years: number, signal?: AbortSignal): Promise<NameQuote> {
  const { ens } = config;
  const [available, price, balance] = await rpcBatch(
    config.rpcUrl,
    [
      call(ens.registrar, encodeFunctionData({ abi: ensRegistrarAbi, functionName: "isAvailable", args: [label] })),
      call(ens.registrar, encodeFunctionData({ abi: ensRegistrarAbi, functionName: "getPrice", args: [durationFor(years)] })),
      call(ens.paymentToken, encodeFunctionData({ abi: demoUsdcAbi, functionName: "balanceOf", args: [account] })),
    ],
    { signal },
  );
  const [a, p, b] = [okHex(available), okHex(price), okHex(balance)];
  if (!a || !p || !b) throw new Error("Could not read the registrar from the devnet RPC.");
  return {
    label,
    name: `${label}.${ens.namespace}`,
    years,
    available: decodeFunctionResult({ abi: ensRegistrarAbi, functionName: "isAvailable", data: a }),
    price: decodeFunctionResult({ abi: ensRegistrarAbi, functionName: "getPrice", data: p }),
    balance: decodeFunctionResult({ abi: demoUsdcAbi, functionName: "balanceOf", data: b }),
  };
}

export interface VaultInfo {
  /** ENSVault of the account: the token owner of its names. */
  vault: Address;
  /** The vault's PermissionedResolver proxy. */
  resolver: Address;
  deployed: boolean;
}

export async function loadVault(config: EnsConfig, account: Address, signal?: AbortSignal): Promise<VaultInfo> {
  const { ens } = config;
  const [vault, resolver] = await rpcBatch(
    config.rpcUrl,
    [
      call(ens.vaultFactory, encodeFunctionData({ abi: ensVaultFactoryAbi, functionName: "vaultAddress", args: [account] })),
      call(ens.vaultFactory, encodeFunctionData({ abi: ensVaultFactoryAbi, functionName: "resolverAddress", args: [account] })),
    ],
    { signal },
  );
  const [v, r] = [okHex(vault), okHex(resolver)];
  if (!v || !r) throw new Error("Could not read the vault factory from the devnet RPC.");
  const vaultAddress = decodeFunctionResult({ abi: ensVaultFactoryAbi, functionName: "vaultAddress", data: v });
  const code = await rpcCall<Hex>(config.rpcUrl, "eth_getCode", [vaultAddress, "latest"], { signal });
  return {
    vault: vaultAddress,
    resolver: decodeFunctionResult({ abi: ensVaultFactoryAbi, functionName: "resolverAddress", data: r }),
    deployed: !!code && code !== "0x",
  };
}

export interface NameStatus {
  label: string;
  name: string;
  /** The registry's current token owner (the vault for the wallet's own names). */
  owner: Address | null;
  expiry: number;
  tokenId: bigint;
  registered: boolean;
  /** addr(node) through the universal resolver, or null when it does not resolve. */
  resolvesTo: Address | null;
  /** Held by the account's vault, unexpired, and resolving to the account. */
  verified: boolean;
}

/** Registry state and forward resolution of `labels`, verified against the account and its vault. */
export async function checkNames(config: EnsConfig, account: Address, vault: Address, labels: string[], signal?: AbortSignal): Promise<NameStatus[]> {
  if (!labels.length) return [];
  const { ens } = config;
  const items: BatchItem[] = labels.flatMap((label) => {
    const name = `${label}.${ens.namespace}`;
    return [
      call(ens.qswRegistry, encodeFunctionData({ abi: ensRegistryAbi, functionName: "getState", args: [labelId(label)] })),
      call(
        ens.universalResolver,
        encodeFunctionData({
          abi: universalResolverAbi,
          functionName: "resolve",
          args: [dnsEncode(name), encodeFunctionData({ abi: ADDR_ABI, functionName: "addr", args: [nameNode(name)] })],
        }),
      ),
    ];
  });
  const results: BatchResult[] = [];
  for (let i = 0; i < items.length; i += 20) results.push(...(await rpcBatch(config.rpcUrl, items.slice(i, i + 20), { signal })));
  const now = Math.floor(Date.now() / 1000);
  return labels.map((label, i) => {
    const stateHex = okHex(results[2 * i]);
    if (!stateHex) throw new Error(`Could not read ${label}.${ens.namespace} from the registry.`);
    const state = decodeFunctionResult({ abi: ensRegistryAbi, functionName: "getState", data: stateHex });
    let resolvesTo: Address | null = null;
    const resolved = okHex(results[2 * i + 1]);
    if (resolved) {
      try {
        const [result] = decodeFunctionResult({ abi: universalResolverAbi, functionName: "resolve", data: resolved });
        // A single-output function decodes to the value itself, not a one-element array.
        const address = decodeFunctionResult({ abi: ADDR_ABI, functionName: "addr", data: result });
        resolvesTo = /^0x0{40}$/i.test(address) ? null : address;
      } catch {
        resolvesTo = null;
      }
    }
    const expiry = Number(state.expiry);
    const registered = state.status === STATUS_REGISTERED && expiry > now;
    const owner = registered && !/^0x0{40}$/i.test(state.latestOwner) ? state.latestOwner : null;
    return {
      label,
      name: `${label}.${ens.namespace}`,
      owner,
      expiry,
      tokenId: state.tokenId,
      registered,
      resolvesTo,
      verified: registered && sameAddress(owner, vault) && sameAddress(resolvesTo, account),
    };
  });
}

const ADDR_ABI = [
  { type: "function", name: "addr", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
] as const;

const NAME_REGISTERED = encodeEventTopics({ abi: ensRegistrarAbi, eventName: "NameRegistered" })[0] as Hex;
const ownerTopic = (address: Address) => `0x${address.toLowerCase().slice(2).padStart(64, "0")}` as Hex;

export interface OwnedNames extends VaultInfo {
  names: NameStatus[];
}

/**
 * The names the registrar minted to the account's vault (NameRegistered with owner = vault), each
 * re-verified on chain. Names the vault no longer holds are kept with `verified: false`.
 */
export async function loadNames(config: EnsConfig, account: Address, signal?: AbortSignal): Promise<OwnedNames> {
  const vault = await loadVault(config, account, signal);
  if (!vault.deployed) return { ...vault, names: [] };
  const logs = await rpcCall<RawLog[]>(
    config.rpcUrl,
    "eth_getLogs",
    [{ address: config.ens.registrar, fromBlock: `0x${config.ens.deploymentBlock.toString(16)}`, toBlock: "latest", topics: [NAME_REGISTERED, null, ownerTopic(vault.vault)] }],
    { signal },
  );
  const labels = [...new Set(logs.flatMap((log) => {
    try {
      const { args } = decodeEventLog({ abi: ensRegistrarAbi, eventName: "NameRegistered", data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
      return [args.label];
    } catch {
      return [];
    }
  }))];
  const names = await checkNames(config, account, vault.vault, labels, signal);
  names.sort((a, b) => Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name));
  return { ...vault, names };
}

// ---------------------------------------------------------------------------- registration

export interface RegistrationInput {
  label: string;
  years: number;
}

export interface RegistrationReport {
  txHash: Hex;
  signingHash: Hex;
  blockNumber: number;
  status: "success" | "reverted";
  sponsor: Address;
  payer: Address;
  feeWei: bigint;
  pqValidationGas: bigint | null;
  frames: FrameView[];
  name: string;
  years: number;
  /** dUSDC that left the account in this transaction, from its Transfer logs. */
  paid: bigint;
  quotedPrice: bigint;
  vault: Address;
  resolver: Address;
  /** Registry ownership and forward resolution, checked after inclusion. */
  check: NameStatus | null;
  admission: { outcome: string; checksPassed: number; checksTotal: number } | null;
  explorerTxUrl: string;
  nonce: bigint;
  signMs: number;
}

export const registrationLabels = (config: EnsConfig, label: string, price: bigint | null) =>
  registerFrameLabels(`${label}.${config.ens.namespace}`, price === null ? "dUSDC" : formatDusdc(price));

/**
 * Register one name end to end: quote, build the 6-frame template, sign with SLH-DSA in the worker,
 * get it co-signed by the sponsor (kind "ens-register"), submit it to the alternative mempool, wait for
 * inclusion, then verify on chain that the vault holds the name and it resolves to the account.
 * Never submits unless the sponsor's transaction matches ours exactly.
 */
export async function runRegistration(
  config: EnsConfig,
  wallet: Pick<WalletRecord, "account" | "publicKey">,
  signer: Pick<Signer, "sign">,
  input: RegistrationInput,
  onProgress: (progress: SwapProgress) => void,
  signal?: AbortSignal,
): Promise<RegistrationReport> {
  let stage: SwapStage = "quote";
  let hash: Hex | undefined;
  const emit = (state: SwapProgress["state"], message: string, extra: Partial<SwapProgress> = {}) =>
    onProgress({ stage, state, message, ...(hash ? { txHash: hash } : {}), ...extra });
  const fail = (message: string): never => {
    throw new SwapError(stage, message, hash);
  };
  const account = wallet.account;
  const { ens } = config;
  try {
    const sponsor = config.sponsor;
    if (!config.operatorReady || !sponsor) return fail("Registrations are unavailable: this server has no sponsor configured.");
    const checked = checkLabel(input.label, ens.namespace);
    if (!checked.ok) return fail(checked.reason);
    if (checked.label !== input.label) fail(`Register the normalized form ${checked.name}.`);
    if (!Number.isInteger(input.years) || input.years < 1 || input.years > ens.maxYears) fail(`Choose 1 to ${ens.maxYears} years.`);
    emit("active", `Checking ${checked.name}`);
    const [quote, vault] = await Promise.all([
      quoteName(config, account, checked.label, input.years, signal),
      loadVault(config, account, signal),
    ]);
    if (!quote.available) fail(`${checked.name} is already registered.`);
    if (quote.balance < quote.price) fail(`${formatDusdc(quote.price)} needed; the account holds ${formatDusdc(quote.balance)}.`);
    emit("done", `${checked.name} is available · ${formatDusdc(quote.price)}`, { detail: { price: quote.price.toString() } });

    stage = "build";
    emit("active", "Reading the account nonce");
    const nonce = BigInt(await rpcCall<Hex>(config.rpcUrl, "eth_getTransactionCount", [account, "latest"], { signal }));
    const unsigned = buildRegisterTx({
      config,
      account,
      nonce,
      label: checked.label,
      years: input.years,
      price: quote.price,
      vault: vault.vault,
      resolver: vault.resolver,
    });
    const digest = signingHash(unsigned);
    const labels = registrationLabels(config, checked.label, quote.price);
    emit("done", `${unsigned.frames.length} frames · 1 signature`, { signingHash: digest, detail: { nonce: Number(nonce) } });

    stage = "sign";
    emit("active", "Signing with SLH-DSA-SHA2-128s in your browser", { signingHash: digest });
    const signed_ = await signer.sign(wallet.publicKey, digest);
    if ((signed_.signature.length - 2) / 2 !== SIGNATURE_BYTES) fail("The signer returned a malformed signature.");
    const signed = withSignature(unsigned, 0, signed_.signature);
    if (signingHash(signed).toLowerCase() !== digest.toLowerCase()) fail("Signing changed the transaction. Nothing was sent.");
    emit("done", `SLH-DSA-SHA2-128s · 7,856 bytes · ${Math.round(signed_.ms).toLocaleString("en-US")} ms`, { signingHash: digest });

    stage = "sponsor";
    emit("active", "Asking the sponsor to co-sign the gas payment");
    let response: SponsorResponse | null = null;
    try {
      response = await api.sponsor({ tx: toWire(signed), kind: "ens-register" });
    } catch (error) {
      fail(describeSponsorError(error, "registration"));
    }
    const final = await verifySponsorResponse(signed, response!, sponsor);
    hash = txHash(final);
    emit("done", `Co-signed by sponsor ${sponsor.slice(0, 6)}…${sponsor.slice(-4)}`);

    stage = "submit";
    emit("active", "Sending to the alternative mempool");
    await submitFrameTransaction(config, final, hash, () => emit("active", "No answer from the mempool: looking the transaction up by its hash"), signal, "registration");
    emit("done", "Accepted by the mempool");

    stage = "admission";
    emit("active", "Reading the mempool's admission checks");
    let admission = await waitForAdmission(config, hash, () => true, 8_000, signal);
    if (admission?.outcome === "rejected") fail(describeRejection(admission));
    if (admission?.outcome === "dropped" || admission?.outcome === "replaced") {
      fail(`The mempool ${admission.outcome} the transaction${admission.reason ? `: ${admission.reason}` : "."}`);
    }
    emit("done", admission ? `${admission.checksPassed} of ${admission.checksTotal} admission checks passed` : "Admitted");

    stage = "inclusion";
    emit("active", "Waiting for a block");
    const receipt = await waitForReceipt(config, hash, signal);
    emit("done", `Included in block ${quantity(receipt.blockNumber).toLocaleString("en-US")}`);

    stage = "verified";
    const frames = frameViews(final.frames.map((f) => ({ mode: f.mode, flags: f.flags, target: f.target })), labels, receipt);
    if (frames[0]?.status !== "success") fail("The account's VERIFY frame failed: the SLH-DSA signature was not accepted on-chain.");
    const pqGas = frames[0]?.gasUsed ?? 0n;
    emit("done", `Signature verified on-chain · ${pqGas.toLocaleString("en-US")} gas`);

    stage = "settled";
    emit("active", `Checking that your vault holds ${checked.name} and it resolves to your account`);
    const succeeded = receiptSucceeded(receipt);
    const check = succeeded ? (await checkNames(config, account, vault.vault, [checked.label], signal))[0] ?? null : null;
    admission =
      (await waitForAdmission(config, hash, (a) => a.outcome === "included", 8_000, signal).catch(() => admission)) ?? admission;
    const deltas = tokenDeltas(receipt.logs, account, { usdc: config.contracts.demoUSDC, weth: config.contracts.weth9 });
    const report: RegistrationReport = {
      txHash: receipt.transactionHash,
      signingHash: digest,
      blockNumber: quantity(receipt.blockNumber),
      status: succeeded ? "success" : "reverted",
      sponsor,
      payer: (receipt.payer ?? "0x") as Address,
      feeWei: receiptFee(receipt),
      pqValidationGas: pqGas,
      frames,
      name: checked.name,
      years: input.years,
      paid: deltas.usdc < 0n ? -deltas.usdc : 0n,
      quotedPrice: quote.price,
      vault: vault.vault,
      resolver: vault.resolver,
      check,
      admission: admission ? { outcome: admission.outcome, checksPassed: admission.checksPassed, checksTotal: admission.checksTotal } : null,
      explorerTxUrl: explorerTxUrl(config, receipt.transactionHash, { frame: true }),
      nonce,
      signMs: Math.round(signed_.ms),
    };
    if (!succeeded) {
      const failed = frames.find((f) => f.status === "failed");
      emit("error", failed ? `Frame ${failed.index} (${failed.label}) reverted; the whole batch rolled back and no dUSDC was spent.` : "The transaction reverted.");
    } else if (!check?.verified) {
      emit("error", `Included, but ${checked.name} did not verify: ${check?.owner ? "the vault does not hold it or it does not resolve to your account" : "the registry does not show it yet"}.`);
    } else {
      emit("done", `${checked.name} is held by your vault and resolves to your account`);
    }
    return report;
  } catch (error) {
    const wrapped =
      error instanceof SwapError
        ? error
        : signal?.aborted
          ? new SwapError(stage, "The registration was cancelled.", hash)
          : new SwapError(stage, describeUnexpected(error), hash);
    onProgress({ stage: wrapped.stage, state: "error", message: wrapped.message, ...(hash ? { txHash: hash } : {}) });
    throw wrapped;
  }
}
