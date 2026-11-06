/**
 * Devnet ENSv2 registration codec: names, strict calldata decoders and the 6-frame template.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { ATOMIC_BATCH_FLAG, type FrameTx } from "../shared/frameTx.js";
import {
  buildRegisterTx,
  checkLabel,
  decodeCreateVault,
  decodeRegister,
  decodeVaultSetAddress,
  dnsEncode,
  durationFor,
  encodeRegister,
  encodeVaultSetAddress,
  ENS_FRAME_LIMITS,
  EnsCodecError,
  isNormalizedLabel,
  parseRegisterTx,
  priceFor,
  registerFrameLabels,
  YEAR_SECONDS,
  type EnsTxConfig,
} from "../shared/ens.js";
import { encodeErc20Approve } from "../shared/swap.js";
import type { Address, EnsDeployment } from "../shared/types.js";

const manifest = JSON.parse(readFileSync(new URL("../../../slhsol/deployments/shared-devnet.json", import.meta.url), "utf8"));

export const ENS: EnsDeployment = {
  label: manifest.ens.label,
  namespace: manifest.ens.namespace,
  rootRegistry: manifest.ens.rootRegistry,
  ethRegistry: manifest.ens.ethRegistry,
  qswRegistry: manifest.ens.qswRegistry,
  universalResolver: manifest.ens.universalResolver,
  registrar: manifest.ens.registrar,
  vaultFactory: manifest.ens.vaultFactory,
  resolverImplementation: manifest.ens.resolverImplementation,
  verifiableFactory: manifest.ens.verifiableFactory,
  paymentToken: manifest.ens.paymentToken,
  pricePerYear: String(manifest.ens.pricePerYear),
  minDuration: manifest.ens.minDuration,
  maxYears: 5,
  deploymentBlock: manifest.ens.deploymentBlock,
};

const ACCOUNT = "0x95cae22851d7cf34db32d64851e22db63d5ae710" as Address;
const SPONSOR = "0xb7ca4c821205f6721bacbd48052bebf6a1f252c1" as Address;
const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const RESOLVER = "0x2222222222222222222222222222222222222222" as Address;
const config: EnsTxConfig = { chainId: manifest.chainId, sponsor: SPONSOR, ens: ENS };

const build = (overrides: Partial<Parameters<typeof buildRegisterTx>[0]> = {}) =>
  buildRegisterTx({ config, account: ACCOUNT, nonce: 7n, label: "alice", years: 2, price: 10_000_000n, vault: VAULT, resolver: RESOLVER, ...overrides });

const withFrame = (tx: FrameTx, index: number, patch: Partial<FrameTx["frames"][number]>): FrameTx => ({
  ...tx,
  frames: tx.frames.map((frame, i) => (i === index ? { ...frame, ...patch } : frame)),
});

describe("names", () => {
  it("normalizes one label with ENSIP-15", () => {
    expect(checkLabel("  Alice ", "qsw.eth")).toEqual({ ok: true, label: "alice", name: "alice.qsw.eth" });
    expect(checkLabel("🙂", "qsw.eth")).toMatchObject({ ok: true, name: "🙂.qsw.eth" });
    expect(isNormalizedLabel("alice", "qsw.eth")).toBe(true);
    expect(isNormalizedLabel("Alice", "qsw.eth")).toBe(false);
  });

  it("refuses empty, dotted and invalid labels", () => {
    expect(checkLabel("   ", "qsw.eth")).toMatchObject({ ok: false, reason: "Type a name." });
    expect(checkLabel("alice.bob", "qsw.eth")).toMatchObject({ ok: false });
    expect(checkLabel("ab_cd", "qsw.eth")).toMatchObject({ ok: false });
    expect(checkLabel("a".repeat(256), "qsw.eth")).toMatchObject({ ok: false, reason: "At most 255 bytes." });
  });

  it("DNS-encodes names like NameCoder", () => {
    expect(dnsEncode("alice.qsw.eth")).toBe("0x05616c69636503717377036574680" + "0");
    expect(() => dnsEncode("a..eth")).toThrow(EnsCodecError);
  });

  it("prices whole years only", () => {
    expect(durationFor(3)).toBe(3n * YEAR_SECONDS);
    expect(priceFor(ENS, 3)).toBe(15_000_000n);
    expect(() => durationFor(0)).toThrow(EnsCodecError);
    expect(() => durationFor(1.5)).toThrow(EnsCodecError);
  });
});

describe("calldata", () => {
  it("round-trips register and refuses non-canonical or oversized data", () => {
    const data = encodeRegister({ label: "alice", owner: VAULT, resolver: RESOLVER, duration: YEAR_SECONDS });
    expect(decodeRegister(data)).toEqual({ label: "alice", owner: VAULT, resolver: RESOLVER, duration: YEAR_SECONDS });
    expect(() => decodeRegister(`${data}00` as Hex)).toThrow(/non-canonical/);
    expect(() => decodeRegister(`${data}${"00".repeat(600)}` as Hex)).toThrow(/too large/);
  });

  it("round-trips the vault's setAddress call", () => {
    const value = { resolver: RESOLVER, name: dnsEncode("alice.qsw.eth"), coinType: 60n, value: ACCOUNT };
    expect(decodeVaultSetAddress(encodeVaultSetAddress(value))).toEqual(value);
  });

  it("refuses createVault data that is not exactly one address", () => {
    const tx = build();
    expect(decodeCreateVault(tx.frames[2]!.data)).toBe(ACCOUNT);
    expect(() => decodeCreateVault(`${tx.frames[2]!.data}00` as Hex)).toThrow(EnsCodecError);
  });
});

describe("registration template", () => {
  it("builds six frames: two VERIFY, then one atomic SENDER batch", () => {
    const tx = build();
    expect(tx.frames.map((f) => [f.mode, f.flags])).toEqual([
      [1, 2],
      [1, 1],
      [2, ATOMIC_BATCH_FLAG],
      [2, ATOMIC_BATCH_FLAG],
      [2, ATOMIC_BATCH_FLAG],
      [2, 0],
    ]);
    expect(tx.frames.map((f) => getAddress(f.target))).toEqual(
      [ACCOUNT, SPONSOR, ENS.vaultFactory, ENS.paymentToken, ENS.registrar, VAULT].map((a) => getAddress(a)),
    );
    expect(tx.frames[3]!.data).toBe(encodeErc20Approve({ spender: ENS.registrar, amount: 10_000_000n }));
    expect(tx.frames[4]!.limits).toEqual(ENS_FRAME_LIMITS.register);
    expect(registerFrameLabels("alice.qsw.eth", "10 dUSDC")[4]).toBe("Register alice.qsw.eth to your vault");
  });

  it("parses back to the intent", () => {
    expect(parseRegisterTx(build(), config)).toEqual({
      account: ACCOUNT,
      nonce: 7n,
      sponsor: SPONSOR,
      label: "alice",
      name: "alice.qsw.eth",
      years: 2,
      duration: 2n * YEAR_SECONDS,
      price: 10_000_000n,
      vault: VAULT,
      resolver: RESOLVER,
    });
  });

  it("refuses to build unnormalized labels, too many years or a zero price", () => {
    expect(() => build({ label: "Alice" })).toThrow(/normalized/);
    expect(() => build({ years: 6 })).toThrow(/at most 5 years/);
    expect(() => build({ price: 0n })).toThrow(/positive/);
  });

  const tampered: [string, (tx: FrameTx) => FrameTx, RegExp][] = [
    ["another account's vault opened", (tx) => withFrame(tx, 2, { data: build({ account: SPONSOR, sponsor: ACCOUNT }).frames[2]!.data }), /own vault/],
    ["approval to another spender", (tx) => withFrame(tx, 3, { data: encodeErc20Approve({ spender: SPONSOR, amount: 10_000_000n }) }), /approve the registrar/],
    ["unnormalized label", (tx) => withFrame(tx, 4, { data: encodeRegister({ label: "Alice", owner: VAULT, resolver: RESOLVER, duration: 2n * YEAR_SECONDS }) }), /normalized/],
    ["partial year", (tx) => withFrame(tx, 4, { data: encodeRegister({ label: "alice", owner: VAULT, resolver: RESOLVER, duration: YEAR_SECONDS + 1n }) }), /whole years/],
    ["six years", (tx) => withFrame(tx, 4, { data: encodeRegister({ label: "alice", owner: VAULT, resolver: RESOLVER, duration: 6n * YEAR_SECONDS }) }), /1 to 5 years/],
    ["record pointed elsewhere", (tx) => withFrame(tx, 5, { data: encodeVaultSetAddress({ resolver: RESOLVER, name: dnsEncode("alice.qsw.eth"), coinType: 60n, value: SPONSOR }) }), /at the sender/],
    ["record for another name", (tx) => withFrame(tx, 5, { data: encodeVaultSetAddress({ resolver: RESOLVER, name: dnsEncode("bob.qsw.eth"), coinType: 60n, value: ACCOUNT }) }), /registered name/],
    ["record on another resolver", (tx) => withFrame(tx, 5, { data: encodeVaultSetAddress({ resolver: VAULT, name: dnsEncode("alice.qsw.eth"), coinType: 60n, value: ACCOUNT }) }), /resolver the name is registered with/],
    ["batch broken before the registration", (tx) => withFrame(tx, 3, { flags: 0 }), /flags 4/],
    ["value attached", (tx) => withFrame(tx, 4, { value: 1n }), /zero value/],
    ["extra frame", (tx) => ({ ...tx, frames: [...tx.frames, tx.frames[5]!] }), /exactly 6 frames/],
  ];
  it.each(tampered)("rejects %s", (_name, mutate, message) => {
    expect(() => parseRegisterTx(mutate(build()), config)).toThrow(message);
  });
});
