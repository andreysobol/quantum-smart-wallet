/**
 * Golden tests against the real mined sponsored swap (block 408, tx 0x5372…fa1e) in
 * demo/evidence/shared-devnet. Expected values come from the evidence files and the
 * gateway's ethrex fixture, never from the code under test.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { getAddress, hexToBytes, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  cosignAsSponsor,
  decodeRaw,
  decodeSecp256k1FrameSignature,
  encodeRaw,
  encodeRawBytes,
  fromEthrexRpcTransaction,
  fromWire,
  rsvToFrameSignature,
  signingHash,
  sponsorSignatureBytes,
  toWire,
  totalFrameGasLimit,
  txHash,
  verifySignatureEntry,
  type FrameTx,
} from "../shared/frameTx.js";
import { SIGNATURE_CONTEXT } from "../shared/constants.js";

const REPO = new URL("../../../", import.meta.url);
const evidenceUrl = (name: string) => new URL(`demo/evidence/shared-devnet/${name}`, REPO);
const evidenceText = (name: string) => readFileSync(evidenceUrl(name), "utf8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const evidence = (name: string): any => JSON.parse(evidenceText(name));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const repoJson = (path: string): any => JSON.parse(readFileSync(new URL(path, REPO), "utf8"));

const transactionText = evidenceText("transaction.json");
const wire = JSON.parse(transactionText);
const rawHex = evidenceText("raw-transaction.hex").trim() as Hex;
const report = evidence("report.json");
const receipt = evidence("receipt.json");
const admission = evidence("admission-and-inclusion.json");
const checksums = evidence("checksums.json") as Record<string, string>;
const ethrexFixture = repoJson("infra/gateway/fixtures/mined-frame-transaction.json");
const lower = (value: string) => value.toLowerCase();
const tx: FrameTx = fromWire(wire);

describe("evidence integrity", () => {
  it("every evidence file still matches checksums.json (sha256)", () => {
    expect(Object.keys(checksums).length).toBe(9);
    for (const [name, digest] of Object.entries(checksums)) {
      expect(createHash("sha256").update(readFileSync(evidenceUrl(name))).digest("hex"), name).toBe(digest);
    }
  });
});

describe("frame codec vs the mined transaction", () => {
  it("fromWire(transaction.json) -> encodeRaw equals raw-transaction.hex byte for byte", () => {
    expect(encodeRaw(tx)).toBe(lower(rawHex));
    expect(Buffer.compare(Buffer.from(encodeRawBytes(tx)), Buffer.from(hexToBytes(rawHex)))).toBe(0);
  });

  it("signingHash equals report.json signingHash", () => {
    expect(signingHash(tx)).toBe(lower(report.signingHash));
  });

  it("txHash equals the reported, receipted and mempool-admitted hash", () => {
    const hash = txHash(tx);
    expect(hash).toBe(lower(report.transactionHash));
    expect(hash).toBe(lower(receipt.transactionHash));
    expect(hash).toBe(lower(admission.hash));
    expect(hash).toBe(keccak256(hexToBytes(rawHex)));
  });

  it("decodeRaw(raw-transaction.hex) is the same transaction and re-encodes identically", () => {
    const decoded = decodeRaw(rawHex);
    expect(decoded).toEqual(tx);
    expect(encodeRaw(decoded)).toBe(lower(rawHex));
  });

  it("decodeRaw rejects a wrong type byte and trailing garbage", () => {
    expect(() => decodeRaw(`0x05${rawHex.slice(4)}`)).toThrow(/type byte/);
    expect(() => decodeRaw(`${rawHex}00`)).toThrow();
  });

  it("toWire reproduces transaction.json byte for byte (key order, hex formatting)", () => {
    expect(JSON.stringify(toWire(tx), null, 2) + "\n").toBe(transactionText);
  });

  it("the ethrex eth_getTransactionByHash JSON maps to the same transaction and hashes", () => {
    const mined = fromEthrexRpcTransaction(ethrexFixture.result);
    expect(mined).toEqual(tx);
    expect(txHash(mined)).toBe(lower(ethrexFixture.result.hash));
  });

  it("layout matches the evidence (chain, nonce, frames, signatures, fees)", () => {
    expect(tx.chainId).toBe(81411338n);
    expect(tx.nonceKeys).toEqual([0n]);
    expect(tx.nonceSeq).toBe(BigInt(admission.entry.nonce));
    expect(tx.sender).toBe(lower(report.account));
    expect(tx.frames.map((f) => [f.mode, f.flags])).toEqual([[1, 2], [1, 1], [2, 4], [2, 4], [2, 0]]);
    expect(totalFrameGasLimit(tx)).toBe(3_990_000n);
    expect(tx.fees).toEqual({ maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n, maxFeePerBlobGas: 0n });
    expect(tx.signatures.map((s) => [s.scheme, s.signer, s.msg, (s.signature.length - 2) / 2])).toEqual([
      [0, "0x", "0x", 7856],
      [1, lower(report.sponsor), "0x", 65],
    ]);
  });

  it("fromWire is strict: unknown fields, odd hex, non-minimal quantities, bad checksums, recent roots", () => {
    expect(() => fromWire({ ...wire, extra: 1 })).toThrow(/not an allowed field/);
    expect(() => fromWire({ ...wire, nonceSeq: "0x06" })).toThrow(/minimal/);
    expect(() => fromWire({ ...wire, frames: [{ ...wire.frames[0], data: "0x634b01e" }, ...wire.frames.slice(1)] })).toThrow(/even-length/);
    const badChecksum = "0x19B17f47284db0b254c62eb9ad6ce95538e3bc30";
    expect(() => fromWire({ ...wire, sender: badChecksum })).toThrow(/checksum/);
    expect(() => fromWire({ ...wire, recentRootReferences: [{}] })).toThrow(/must be empty/);
    expect(() => fromWire({ ...wire, nonceKeys: [] })).toThrow(/nonceKeys/);
  });
});

describe("sponsor SECP256K1 signature (entry 1)", () => {
  it("is parity || r || s, low-s, and recovers to the sponsor over the signing hash", async () => {
    const parts = decodeSecp256k1FrameSignature(tx.signatures[1]!.signature);
    expect(sponsorSignatureBytes(parts.yParity, parts.r, parts.s)).toBe(tx.signatures[1]!.signature);
    const check = await verifySignatureEntry(tx, 1);
    expect(check.ok, check.reason).toBe(true);
    expect(getAddress(check.recovered!)).toBe(getAddress(report.sponsor));
    expect(check.digest).toBe(lower(report.signingHash));
  });

  it("fails for a flipped bit, a tampered parity or a changed signed field", async () => {
    const sig = tx.signatures[1]!.signature;
    const withSig = (s: Hex): FrameTx => ({ ...tx, signatures: [tx.signatures[0]!, { ...tx.signatures[1]!, signature: s }] });
    const flipped = (sig.slice(0, 40) + (sig[40] === "0" ? "1" : "0") + sig.slice(41)) as Hex;
    expect((await verifySignatureEntry(withSig(flipped), 1)).ok).toBe(false);
    expect((await verifySignatureEntry(withSig(`0x00${sig.slice(4)}` as Hex), 1)).ok).toBe(false);
    expect((await verifySignatureEntry({ ...tx, fees: { ...tx.fees, maxFeePerGas: tx.fees.maxFeePerGas + 1n } }, 1)).ok).toBe(false);
  });

  it("cosignAsSponsor fills the placeholder without changing the signing hash", async () => {
    const key = `0x${"11".repeat(32)}` as Hex;
    const sponsor = privateKeyToAccount(key);
    const unsigned: FrameTx = {
      ...tx,
      frames: tx.frames.map((f, i) => (i === 1 ? { ...f, target: lower(sponsor.address) as Hex } : f)),
      signatures: [tx.signatures[0]!, { scheme: 1, signer: lower(sponsor.address) as Hex, msg: "0x", signature: `0x${"00".repeat(65)}` }],
    };
    const signed = await cosignAsSponsor(unsigned, sponsor);
    expect(signingHash(signed)).toBe(signingHash(unsigned));
    expect((await verifySignatureEntry(signed, 1)).ok).toBe(true);
    expect(signed.signatures[0]).toEqual(unsigned.signatures[0]);
    expect(rsvToFrameSignature(await sponsor.sign({ hash: signingHash(unsigned) }))).toBe(signed.signatures[1]!.signature);
    await expect(cosignAsSponsor(tx, sponsor)).rejects.toThrow(/not the sponsor/);
  });
});

describe("signing-hash elision (devnet profile)", () => {
  const replaceSig = (i: number, signature: Hex): FrameTx => ({ ...tx, signatures: tx.signatures.map((s, j) => (j === i ? { ...s, signature } : s)) });

  it("ignores the bytes of empty-msg signatures (placeholders, PQ and sponsor signatures are interchangeable)", () => {
    const base = signingHash(tx);
    expect(signingHash(replaceSig(0, `0x${"00".repeat(7856)}`))).toBe(base);
    expect(signingHash(replaceSig(1, `0x${"00".repeat(65)}`))).toBe(base);
    expect(txHash(replaceSig(1, `0x${"00".repeat(65)}`))).not.toBe(txHash(tx));
  });

  it("commits to scheme, signer and msg of every entry (the sponsor address is bound by the PQ signature)", () => {
    const other: FrameTx = { ...tx, signatures: [tx.signatures[0]!, { ...tx.signatures[1]!, signer: "0x000000000000000000000000000000000000dead" }] };
    expect(signingHash(other)).not.toBe(signingHash(tx));
  });
});

describe("PQ signature (entry 0) with the slhts WASM build", () => {
  const slhtsDir = new URL("slhts/", REPO);
  it("verifies over the signing hash with the wallet context, and fails for a changed digest", async () => {
    let image: Buffer;
    try {
      image = readFileSync(new URL("pkg/rslh_bg.wasm", slhtsDir));
    } catch {
      console.warn("slhts is not built (npm run build:wasm); skipping the WASM check");
      return;
    }
    const slhts = (await import(/* @vite-ignore */ new URL("dist/index.js", slhtsDir).href)) as {
      init(url: URL): Promise<void>;
      verify(alg: "sha2", pk: Uint8Array, msg: Uint8Array, sig: Uint8Array, ctx?: Uint8Array): boolean;
    };
    const server = createServer((_req, res) => res.writeHead(200, { "Content-Type": "application/wasm", Connection: "close" }).end(image));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      await slhts.init(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/rslh_bg.wasm`));
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
    const context = new TextEncoder().encode(SIGNATURE_CONTEXT);
    const publicKey = hexToBytes(report.publicKey);
    const digest = hexToBytes(signingHash(tx));
    const signature = hexToBytes(tx.signatures[0]!.signature);
    expect(slhts.verify("sha2", publicKey, digest, signature, context)).toBe(true);
    const tampered = digest.slice();
    tampered[31] = (tampered[31] as number) ^ 1;
    expect(slhts.verify("sha2", publicKey, tampered, signature, context)).toBe(false);
    expect(slhts.verify("sha2", publicKey, digest, signature)).toBe(false);
  });
});
