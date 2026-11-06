/**
 * Devnet ENSv2 registration: names, calldata codecs and the 6-frame sponsored registration.
 *
 * ENSv2 registries mint names as ERC-1155 tokens and call onERC1155Received on contract owners, which
 * QuantumAccount does not implement. Each account therefore registers to its own ENSVault (token owner),
 * which only the account can act through (controller), and points the name at the account:
 *
 *   0 VERIFY  account  validateFrame()                                  SLH-DSA, execution approval
 *   1 VERIFY  sponsor                                                   gas payment approval
 *   2 SENDER  ENSVaultFactory.createVault(account)              atomic  idempotent: opens the vault once
 *   3 SENDER  dUSDC.approve(registrar, price)                   atomic  exactly the quoted price
 *   4 SENDER  registrar.register(label, vault, resolver, dur)   atomic  pulls the price, mints to the vault
 *   5 SENDER  vault.execute(resolver, setAddress(name, 60, account))    forward resolution to the account
 *
 * Frames 2-5 are one atomic batch: the approval never outlives a failed registration. Decoders are strict:
 * bounded size, decode, re-encode canonically, require byte equality.
 */
import { bytesToHex, concat, decodeFunctionData, encodeFunctionData, isAddress, namehash, stringToBytes } from "viem";
import { normalize } from "viem/ens";
import { FEES, FRAME_LIMITS, FRAME_MODE, SIGNATURE_BYTES, SIGNATURE_SCHEME, SPONSOR_SIGNATURE_BYTES, VALIDATE_FRAME_SELECTOR } from "./constants.js";
import { ensRegistrarAbi, ensVaultAbi, ensVaultFactoryAbi, permissionedResolverAbi } from "./ensAbis.js";
import { APPROVE_SCOPE, ATOMIC_BATCH_FLAG, type Fees, type Frame, type FrameLimits, type FrameTx } from "./frameTx.js";
import { decodeErc20Approve, encodeErc20Approve } from "./swap.js";
import type { Address, EnsDeployment, Hex, PublicConfig } from "./types.js";

export const YEAR_SECONDS = 31_536_000n;
/** SLIP-44 coin type of ETH: addr(node) records. */
export const ETH_COIN_TYPE = 60n;
/** NameCoder: a DNS label is at most 255 bytes. */
export const MAX_LABEL_BYTES = 255;

/**
 * Per-frame gas limits of the registration (execution / state gas). Measured on the shared devnet for a
 * first registration (tx 0x813b0326…, 11-character label): createVault 117,295 / 3,369,060, approve
 * 17,325 / 0, register 134,516 / 489,600, setAddress 52,245 / 293,760. Each extra 32 bytes of label adds a
 * 97,920 state-gas slot to register and setAddress, so those are sized for a 255-byte label.
 */
export const ENS_FRAME_LIMITS = {
  createVault: { execution: 250_000n, state: 4_500_000n },
  approve: { execution: 60_000n, state: 120_000n },
  register: { execution: 400_000n, state: 1_500_000n },
  setAddress: { execution: 200_000n, state: 1_200_000n },
} as const satisfies Record<string, FrameLimits>;

export class EnsCodecError extends Error {
  override name = "EnsCodecError";
}

function fail(message: string): never {
  throw new EnsCodecError(message);
}

const lower = (value: string): Hex => value.toLowerCase() as Hex;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) fail(`${label} must be a valid address`);
  return lower(value);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export type LabelCheck = { ok: true; label: string; name: string } | { ok: false; reason: string };

/**
 * ENSIP-15 normalization of one label under `namespace`. The registered label is the normalized form;
 * the sponsor only accepts labels that are already normalized (checkLabel(label).label === label).
 */
export function checkLabel(input: string, namespace: string): LabelCheck {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "Type a name." };
  if (trimmed.includes(".")) return { ok: false, reason: `One label only, without dots: it goes before .${namespace}.` };
  let label: string;
  try {
    label = normalize(trimmed);
  } catch (error) {
    const why = error instanceof Error ? error.message.split("\n")[0] : "";
    return { ok: false, reason: `Not a valid ENS name${why ? ` (${why.replace(/^Invalid label /, "").replace(/\.$/, "")})` : ""}.` };
  }
  if (!label || label.includes(".")) return { ok: false, reason: `One label only, without dots: it goes before .${namespace}.` };
  if (stringToBytes(label).length > MAX_LABEL_BYTES) return { ok: false, reason: `At most ${MAX_LABEL_BYTES} bytes.` };
  return { ok: true, label, name: `${label}.${namespace}` };
}

export function isNormalizedLabel(label: string, namespace: string): boolean {
  const checked = checkLabel(label, namespace);
  return checked.ok && checked.label === label;
}

/** DNS wire format (NameCoder.encode): length-prefixed labels, then a zero byte. */
export function dnsEncode(name: string): Hex {
  const parts = name.split(".").map((label) => {
    const bytes = stringToBytes(label);
    if (bytes.length < 1 || bytes.length > MAX_LABEL_BYTES) fail(`invalid label in ${name}`);
    return concat([new Uint8Array([bytes.length]), bytes]);
  });
  return bytesToHex(concat([...parts, new Uint8Array([0])]));
}

export const nameNode = (name: string): Hex => namehash(name);

/** Whole years only: the price is pricePerYear × years and the sponsor rejects anything else. */
export function durationFor(years: number): bigint {
  if (!Number.isInteger(years) || years < 1) fail("years must be a positive integer");
  return BigInt(years) * YEAR_SECONDS;
}

export function priceFor(ens: Pick<EnsDeployment, "pricePerYear">, years: number): bigint {
  return BigInt(ens.pricePerYear) * BigInt(years);
}

// ---------------------------------------------------------------------------
// Calldata codecs
// ---------------------------------------------------------------------------

/** register(string,address,address,uint64): 4 + 128 head + 32 length + up to 256 padded label bytes. */
const MAX_REGISTER_BYTES = 4 + 128 + 32 + 256;
/** execute(address,bytes(setAddress(bytes,uint256,bytes))) with a DNS name of at most ~300 bytes. */
const MAX_EXECUTE_BYTES = 4 + 64 + 32 + 4 + 96 + 32 + 320 + 32 + 32;

function bounded(data: Hex, max: number, label: string): void {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data) || (data.length - 2) / 2 > max) fail(`${label}: calldata too large`);
}

function canonical(data: Hex, reencoded: Hex, label: string): void {
  if (lower(data) !== lower(reencoded)) fail(`${label}: non-canonical ABI encoding`);
}

export function encodeCreateVault(account: Address): Hex {
  return encodeFunctionData({ abi: ensVaultFactoryAbi, functionName: "createVault", args: [address(account, "account")] });
}

export function decodeCreateVault(data: Hex): Address {
  if ((data.length - 2) / 2 !== 36) fail("createVault: non-canonical ABI encoding");
  const { functionName, args } = decodeFunctionData({ abi: ensVaultFactoryAbi, data });
  if (functionName !== "createVault") fail("expected createVault(address)");
  const account = lower(args[0] as Address);
  canonical(data, encodeCreateVault(account), "createVault");
  return account;
}

export interface Registration {
  label: string;
  owner: Address;
  resolver: Address;
  duration: bigint;
}

export function encodeRegister({ label, owner, resolver, duration }: Registration): Hex {
  if (duration < 0n || duration >= 1n << 64n) fail("duration must be a uint64");
  return encodeFunctionData({
    abi: ensRegistrarAbi,
    functionName: "register",
    args: [label, address(owner, "owner"), address(resolver, "resolver"), duration],
  });
}

export function decodeRegister(data: Hex): Registration {
  bounded(data, MAX_REGISTER_BYTES, "register");
  const { functionName, args } = decodeFunctionData({ abi: ensRegistrarAbi, data });
  if (functionName !== "register") fail("expected register(string,address,address,uint64)");
  const [label, owner, resolver, duration] = args as readonly [string, Address, Address, bigint];
  const out = { label, owner: lower(owner), resolver: lower(resolver), duration };
  canonical(data, encodeRegister(out), "register");
  return out;
}

export interface VaultSetAddress {
  resolver: Address;
  /** DNS-encoded name. */
  name: Hex;
  coinType: bigint;
  /** The address record, 20 bytes. */
  value: Hex;
}

export function encodeVaultSetAddress({ resolver, name, coinType, value }: VaultSetAddress): Hex {
  const inner = encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setAddress", args: [name, coinType, value] });
  return encodeFunctionData({ abi: ensVaultAbi, functionName: "execute", args: [address(resolver, "resolver"), inner] });
}

export function decodeVaultSetAddress(data: Hex): VaultSetAddress {
  bounded(data, MAX_EXECUTE_BYTES, "vault execute");
  const outer = decodeFunctionData({ abi: ensVaultAbi, data });
  if (outer.functionName !== "execute") fail("expected execute(address,bytes)");
  const [resolver, innerData] = outer.args as readonly [Address, Hex];
  const inner = decodeFunctionData({ abi: permissionedResolverAbi, data: innerData });
  if (inner.functionName !== "setAddress") fail("the vault call must be setAddress(bytes,uint256,bytes)");
  const [name, coinType, value] = inner.args as readonly [Hex, bigint, Hex];
  const out = { resolver: lower(resolver), name: lower(name), coinType, value: lower(value) };
  canonical(data, encodeVaultSetAddress(out), "vault execute");
  return out;
}

// ---------------------------------------------------------------------------
// The 6-frame sponsored registration
// ---------------------------------------------------------------------------

export type EnsTxConfig = Pick<PublicConfig, "chainId" | "sponsor"> & { ens: EnsDeployment };

export interface BuildRegisterParams {
  config: EnsTxConfig;
  account: Address;
  nonce: bigint;
  label: string;
  years: number;
  /** The quoted payment: registrar.getPrice(duration). */
  price: bigint;
  /** ENSVaultFactory.vaultAddress(account) and resolverAddress(account). */
  vault: Address;
  resolver: Address;
  sponsor?: Address;
}

const zeros = (length: number): Hex => `0x${"00".repeat(length)}`;

export function buildRegisterTx(p: BuildRegisterParams): FrameTx {
  const { ens } = p.config;
  const sponsorValue = p.sponsor ?? p.config.sponsor;
  if (!sponsorValue) fail("this server has no sponsor configured");
  const account = address(p.account, "account");
  const sponsor = address(sponsorValue, "sponsor");
  if (sponsor === account) fail("sponsor must differ from the account");
  if (!isNormalizedLabel(p.label, ens.namespace)) fail("the label must be a normalized single label");
  if (p.years > ens.maxYears) fail(`at most ${ens.maxYears} years`);
  if (p.price <= 0n) fail("the price must be positive");
  const vault = address(p.vault, "vault");
  const resolver = address(p.resolver, "resolver");
  const duration = durationFor(p.years);
  const frame = (mode: number, flags: number, target: Address, limits: FrameLimits, data: Hex): Frame => ({
    mode,
    flags,
    target,
    limits: { execution: limits.execution, state: limits.state },
    value: 0n,
    data,
  });
  return {
    chainId: BigInt(p.config.chainId),
    nonceKeys: [0n],
    nonceSeq: p.nonce,
    sender: account,
    frames: [
      frame(FRAME_MODE.VERIFY, APPROVE_SCOPE.EXECUTION, account, FRAME_LIMITS.accountVerify, VALIDATE_FRAME_SELECTOR),
      frame(FRAME_MODE.VERIFY, APPROVE_SCOPE.PAYMENT, sponsor, FRAME_LIMITS.sponsorVerify, "0x"),
      frame(FRAME_MODE.SENDER, ATOMIC_BATCH_FLAG, lower(ens.vaultFactory), ENS_FRAME_LIMITS.createVault, encodeCreateVault(account)),
      frame(FRAME_MODE.SENDER, ATOMIC_BATCH_FLAG, lower(ens.paymentToken), ENS_FRAME_LIMITS.approve, encodeErc20Approve({ spender: ens.registrar, amount: p.price })),
      frame(FRAME_MODE.SENDER, ATOMIC_BATCH_FLAG, lower(ens.registrar), ENS_FRAME_LIMITS.register, encodeRegister({ label: p.label, owner: vault, resolver, duration })),
      frame(
        FRAME_MODE.SENDER,
        0,
        vault,
        ENS_FRAME_LIMITS.setAddress,
        encodeVaultSetAddress({ resolver, name: dnsEncode(`${p.label}.${ens.namespace}`), coinType: ETH_COIN_TYPE, value: account }),
      ),
    ],
    signatures: [
      { scheme: SIGNATURE_SCHEME.ARBITRARY, signer: "0x", msg: "0x", signature: zeros(SIGNATURE_BYTES) },
      { scheme: SIGNATURE_SCHEME.SECP256K1, signer: sponsor, msg: "0x", signature: zeros(SPONSOR_SIGNATURE_BYTES) },
    ],
    fees: { ...FEES } satisfies Fees,
    blobVersionedHashes: [],
    recentRootReferences: [],
  };
}

export interface ParsedRegistration {
  account: Address;
  nonce: bigint;
  sponsor: Address;
  label: string;
  name: string;
  years: number;
  duration: bigint;
  price: bigint;
  vault: Address;
  resolver: Address;
}

/**
 * Structural parse of a (signed or unsigned) registration against the template and the namespace:
 * modes, flags, targets, zero value, decodable calldata that agrees across frames, a normalized label,
 * whole years within maxYears, and the two signature entries. Does NOT check gas limits, fees, chain
 * state (vault/resolver addresses, availability, price) or signatures: the server rebuilds the exact
 * template with chain values and compares bytes.
 */
export function parseRegisterTx(tx: FrameTx, config: Pick<PublicConfig, "chainId"> & { ens: EnsDeployment }): ParsedRegistration {
  const { ens } = config;
  if (tx.chainId !== BigInt(config.chainId)) fail("chainId does not match the deployment");
  if (tx.nonceKeys.length !== 1 || tx.nonceKeys[0] !== 0n) fail("nonceKeys must be [0]");
  if (tx.blobVersionedHashes.length !== 0 || tx.recentRootReferences.length !== 0) fail("blob hashes and recent roots must be empty");
  if (tx.frames.length !== 6) fail("expected exactly 6 frames");
  const [verify, pay, open, approve, register, setAddr] = tx.frames as [Frame, Frame, Frame, Frame, Frame, Frame];
  const account = lower(tx.sender);
  const expectFrame = (f: Frame, i: number, mode: number, flags: number, target: string) => {
    if (f.mode !== mode || f.flags !== flags) fail(`frame ${i} must be mode ${mode} with flags ${flags}`);
    if (!same(f.target, target)) fail(`frame ${i} has the wrong target`);
    if (f.value !== 0n) fail(`frame ${i} must carry zero value`);
  };
  expectFrame(verify, 0, FRAME_MODE.VERIFY, APPROVE_SCOPE.EXECUTION, account);
  if (lower(verify.data) !== VALIDATE_FRAME_SELECTOR) fail("frame 0 must call validateFrame()");
  const sponsor = lower(pay.target);
  if (sponsor === account) fail("sponsor must differ from the account");
  expectFrame(pay, 1, FRAME_MODE.VERIFY, APPROVE_SCOPE.PAYMENT, sponsor);
  if (pay.data !== "0x") fail("frame 1 data must be empty");

  expectFrame(open, 2, FRAME_MODE.SENDER, ATOMIC_BATCH_FLAG, ens.vaultFactory);
  if (decodeCreateVault(open.data) !== account) fail("frame 2 must open the sender's own vault");
  expectFrame(approve, 3, FRAME_MODE.SENDER, ATOMIC_BATCH_FLAG, ens.paymentToken);
  const payment = decodeErc20Approve(approve.data);
  if (!same(payment.spender, ens.registrar)) fail("frame 3 must approve the registrar");
  expectFrame(register, 4, FRAME_MODE.SENDER, ATOMIC_BATCH_FLAG, ens.registrar);
  const reg = decodeRegister(register.data);
  if (!isNormalizedLabel(reg.label, ens.namespace)) fail("the label must be a normalized single label");
  if (reg.duration % YEAR_SECONDS !== 0n) fail("the duration must be whole years");
  const years = Number(reg.duration / YEAR_SECONDS);
  if (years < 1 || years > ens.maxYears) fail(`the duration must be 1 to ${ens.maxYears} years`);
  expectFrame(setAddr, 5, FRAME_MODE.SENDER, 0, reg.owner);
  const record = decodeVaultSetAddress(setAddr.data);
  const name = `${reg.label}.${ens.namespace}`;
  if (record.resolver !== reg.resolver) fail("frame 5 must write to the resolver the name is registered with");
  if (record.name !== lower(dnsEncode(name))) fail("frame 5 must set the record of the registered name");
  if (record.coinType !== ETH_COIN_TYPE || record.value !== account) fail("frame 5 must point the name's ETH address at the sender");

  if (tx.signatures.length !== 2) fail("expected exactly 2 signature entries");
  const [pq, sp] = tx.signatures as [FrameTx["signatures"][number], FrameTx["signatures"][number]];
  if (pq.scheme !== SIGNATURE_SCHEME.ARBITRARY || pq.signer !== "0x" || pq.msg !== "0x") fail("signature 0 must be ARBITRARY with empty signer and msg");
  if ((pq.signature.length - 2) / 2 !== SIGNATURE_BYTES) fail(`signature 0 must be ${SIGNATURE_BYTES} bytes`);
  if (sp.scheme !== SIGNATURE_SCHEME.SECP256K1 || !same(sp.signer, sponsor) || sp.msg !== "0x") {
    fail("signature 1 must be SECP256K1 by the frame-1 sponsor with empty msg");
  }
  if ((sp.signature.length - 2) / 2 !== SPONSOR_SIGNATURE_BYTES) fail(`signature 1 must be ${SPONSOR_SIGNATURE_BYTES} bytes`);

  return {
    account,
    nonce: tx.nonceSeq,
    sponsor,
    label: reg.label,
    name,
    years,
    duration: reg.duration,
    price: payment.amount,
    vault: reg.owner,
    resolver: reg.resolver,
  };
}

/** Human labels for the six frames, in order. */
export function registerFrameLabels(name: string, priceText: string): [string, string, string, string, string, string] {
  return [
    "Verify SLH-DSA signature",
    "Sponsor approves gas",
    "Open your name vault",
    `Approve ${priceText} to the registrar`,
    `Register ${name} to your vault`,
    `Point ${name} at your account`,
  ];
}
