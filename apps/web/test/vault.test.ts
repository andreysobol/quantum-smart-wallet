import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { Hex } from "../shared/types.js";
import { bytesToHex } from "../src/crypto/backupCrypto.js";
import { SignerError } from "../src/crypto/types.js";
import { deleteRecord, getRecord, openSecret, putRecord, sealSecret, type KeyRecord } from "../src/crypto/vault.js";

function keyPair() {
  const secretKey = crypto.getRandomValues(new Uint8Array(64));
  return { secretKey, publicKey: bytesToHex(secretKey.subarray(32)) };
}

const contains = (haystack: Uint8Array, needle: Uint8Array) =>
  haystack.length >= needle.length &&
  Array.from({ length: haystack.length - needle.length + 1 }).some((_, start) =>
    needle.every((byte, i) => haystack[start + i] === byte),
  );

async function record(pair = keyPair()): Promise<KeyRecord> {
  return { publicKey: pair.publicKey, ...(await sealSecret(pair.secretKey, pair.publicKey)), meta: null, createdAt: Date.now() };
}

describe("vault sealing", () => {
  it("seals with a fresh non-extractable AES-GCM-256 device key and opens again", async () => {
    const pair = keyPair();
    const sealed = await record(pair);
    expect(sealed.deviceKey.extractable).toBe(false);
    expect(sealed.deviceKey.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await expect(crypto.subtle.exportKey("raw", sealed.deviceKey)).rejects.toThrow();
    expect(sealed.wrapped.iv).toHaveLength(12);
    expect(sealed.wrapped.ciphertext).toHaveLength(80);
    expect(contains(sealed.wrapped.ciphertext, pair.secretKey.subarray(0, 32))).toBe(false);
    expect(await openSecret(sealed)).toEqual(pair.secretKey);

    const again = await record(pair);
    expect(again.deviceKey).not.toBe(sealed.deviceKey);
    expect(again.wrapped.iv).not.toEqual(sealed.wrapped.iv);
  });

  it("binds the ciphertext to the public key (AAD) and detects tampering", async () => {
    const sealed = await record();
    const swapped = { ...sealed, publicKey: keyPair().publicKey };
    await expect(openSecret(swapped)).rejects.toBeInstanceOf(SignerError);
    const ciphertext = sealed.wrapped.ciphertext.slice();
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    await expect(openSecret({ ...sealed, wrapped: { ...sealed.wrapped, ciphertext } })).rejects.toMatchObject({
      code: "storage_unavailable",
    });
  });
});

describe("vault storage (IndexedDB)", () => {
  it("stores, reads, updates and deletes records keyed by lowercase public key", async () => {
    const pair = keyPair();
    const sealed = await record(pair);
    await putRecord({ ...sealed, publicKey: pair.publicKey.toUpperCase().replace("0X", "0x") as Hex });

    const stored = await getRecord(pair.publicKey);
    expect(stored?.publicKey).toBe(pair.publicKey);
    // The CryptoKey survives structured cloning into IndexedDB and still decrypts.
    expect(stored && (await openSecret(stored))).toEqual(pair.secretKey);

    const meta = { chainId: 81411338, account: "0x00000000000000000000000000000000000000aa", factory: "0x00000000000000000000000000000000000000f1", salt: `0x${"22".repeat(32)}` } as const;
    await putRecord({ ...sealed, meta });
    expect((await getRecord(pair.publicKey))?.meta).toEqual(meta);

    await deleteRecord(pair.publicKey);
    expect(await getRecord(pair.publicKey)).toBeUndefined();
  });

  it("returns undefined for unknown keys", async () => {
    expect(await getRecord(keyPair().publicKey)).toBeUndefined();
  });
});
