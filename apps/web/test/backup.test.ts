import { describe, expect, it } from "vitest";
import { SIGNATURE_CONTEXT } from "../shared/constants.js";
import type { Hex } from "../shared/types.js";
import {
  BACKUP_FORMAT,
  MAX_BACKUP_FILE_BYTES,
  MAX_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS,
  backupAad,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  decryptBackup,
  encryptBackup,
  parseBackup,
  parseBackupJson,
} from "../src/crypto/backupCrypto.js";
import { backupFileName, readBackupFile } from "../src/crypto/signer.js";
import { SignerError, type BackupFile, type KeyMeta } from "../src/crypto/types.js";

const PASS = "correct horse battery staple";
const FAST = MIN_PBKDF2_ITERATIONS;
const META: KeyMeta = {
  chainId: 81411338,
  account: "0x8F3a1c2B4d5E6f708192a3B4c5D6e7F809a1B2c3",
  factory: "0x00000000000000000000000000000000000000f1",
  salt: `0x${"11".repeat(32)}`,
};

/** Structurally valid FIPS 205 key pair: the secret key ends with the 32-byte public key. */
function keyPair() {
  const secretKey = crypto.getRandomValues(new Uint8Array(64));
  return { secretKey, publicKey: bytesToHex(secretKey.subarray(32)) };
}

async function backupFor(pair = keyPair(), passphrase = PASS, iterations = FAST) {
  return { pair, file: await encryptBackup({ ...pair, passphrase, meta: META, iterations }) };
}

async function failure(action: Promise<unknown> | (() => unknown)): Promise<SignerError> {
  try {
    await (typeof action === "function" ? action() : action);
  } catch (error) {
    expect(error).toBeInstanceOf(SignerError);
    return error as SignerError;
  }
  throw new Error("expected a SignerError");
}

/** Replace one base64 field by its decoded bytes with one bit flipped. */
function flipBit(base64: string, index = 0): string {
  const bytes = base64ToBytes(base64);
  bytes[index] = (bytes[index] ?? 0) ^ 1;
  return bytesToBase64(bytes);
}

describe("base64", () => {
  it("round-trips every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("rejects non-canonical or invalid input", () => {
    for (const text of ["QQ", "QUJD\n", "@@@@", "QR==", "QUJD QUJD"]) expect(() => base64ToBytes(text)).toThrow();
  });
});

describe("encryptBackup / decryptBackup", () => {
  it("round-trips with the default 600k-iteration PBKDF2 and the documented layout", async () => {
    const pair = keyPair();
    const file = await encryptBackup({ ...pair, passphrase: PASS, meta: META });
    expect(file).toMatchObject({
      format: BACKUP_FORMAT,
      version: 1,
      algorithm: "SLH-DSA-SHA2-128s",
      context: SIGNATURE_CONTEXT,
      publicKey: pair.publicKey,
      meta: META,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS },
      cipher: { name: "AES-GCM" },
    });
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    expect(base64ToBytes(file.kdf.salt)).toHaveLength(16);
    expect(base64ToBytes(file.cipher.iv)).toHaveLength(12);
    expect(base64ToBytes(file.cipher.ciphertext)).toHaveLength(64 + 16);
    expect(Date.parse(file.createdAt)).not.toBeNaN();

    const restored = parseBackupJson(JSON.stringify(file));
    expect(restored).toEqual(file);
    expect(await decryptBackup(restored, PASS)).toEqual(pair.secretKey);
  });

  it("never writes the secret key in clear and uses a fresh salt and IV per export", async () => {
    const { pair, file } = await backupFor();
    const again = await encryptBackup({ ...pair, passphrase: PASS, meta: META, iterations: FAST });
    const json = JSON.stringify(file);
    const secretHalf = pair.secretKey.subarray(0, 32);
    expect(json).not.toContain(bytesToHex(secretHalf).slice(2));
    expect(json).not.toContain(bytesToBase64(pair.secretKey).slice(0, 40));
    expect(again.kdf.salt).not.toBe(file.kdf.salt);
    expect(again.cipher.iv).not.toBe(file.cipher.iv);
    expect(again.cipher.ciphertext).not.toBe(file.cipher.ciphertext);
  });

  it("rejects a wrong passphrase", async () => {
    const { file } = await backupFor();
    const error = await failure(decryptBackup(file, `${PASS}!`));
    expect(error.code).toBe("bad_passphrase");
    expect((await failure(decryptBackup(file, ""))).code).toBe("bad_passphrase");
  });

  it("normalizes passphrases to NFC", async () => {
    const { pair, file } = await backupFor(keyPair(), "café au lait 1234");
    expect(await decryptBackup(file, "café au lait 1234")).toEqual(pair.secretKey);
  });

  it("rejects tampered ciphertext, IV, salt and authenticated header (AAD)", async () => {
    const { file } = await backupFor();
    const other = keyPair();
    const tampered: BackupFile[] = [
      { ...file, cipher: { ...file.cipher, ciphertext: flipBit(file.cipher.ciphertext, 5) } },
      { ...file, cipher: { ...file.cipher, ciphertext: flipBit(file.cipher.ciphertext, 79) } },
      { ...file, cipher: { ...file.cipher, iv: flipBit(file.cipher.iv) } },
      { ...file, kdf: { ...file.kdf, salt: flipBit(file.kdf.salt) } },
      { ...file, kdf: { ...file.kdf, iterations: FAST + 1 } },
      { ...file, publicKey: other.publicKey },
    ];
    for (const candidate of tampered) {
      expect((await failure(decryptBackup(candidate, PASS))).code).toBe("bad_passphrase");
    }
    // Header fields outside the accepted values are refused before any decryption.
    for (const candidate of [
      { ...file, context: "QuantumSmartWallet/SLH-DSA-SHA2-128s/v2" },
      { ...file, version: 2 },
      { ...file, algorithm: "SLH-DSA-SHAKE-128s" },
      { ...file, format: "other-wallet-backup" },
    ]) {
      expect((await failure(decryptBackup(candidate as unknown as BackupFile, PASS))).code).toBe("bad_backup");
    }
  });

  it("binds the AAD to exactly format, version, algorithm, context and public key", async () => {
    const { file } = await backupFor();
    const aad = JSON.parse(new TextDecoder().decode(backupAad(file)));
    expect(aad).toEqual({
      format: file.format,
      version: file.version,
      algorithm: file.algorithm,
      context: file.context,
      publicKey: file.publicKey,
    });
  });

  it("refuses a backup whose decrypted key does not match its public key", async () => {
    // Craft a file the wallet would never write: A's secret under B's authenticated header.
    const a = keyPair();
    const b = keyPair();
    const { file } = await backupFor(b);
    const salt = base64ToBytes(file.kdf.salt);
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASS), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: file.kdf.iterations },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const iv = base64ToBytes(file.cipher.iv);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: backupAad(file) }, key, a.secretKey));
    const forged = { ...file, cipher: { ...file.cipher, ciphertext: bytesToBase64(ciphertext) } };
    expect((await failure(decryptBackup(forged, PASS))).code).toBe("key_mismatch");
  });

  it("enforces passphrase, key and iteration bounds when encrypting", async () => {
    const pair = keyPair();
    expect((await failure(encryptBackup({ ...pair, passphrase: "short12", meta: null }))).code).toBe("bad_passphrase");
    for (const iterations of [MIN_PBKDF2_ITERATIONS - 1, MAX_PBKDF2_ITERATIONS + 1, 100_000.5]) {
      expect((await failure(encryptBackup({ ...pair, passphrase: PASS, meta: null, iterations }))).code).toBe("internal");
    }
    const mismatched = { secretKey: pair.secretKey, publicKey: keyPair().publicKey };
    expect((await failure(encryptBackup({ ...mismatched, passphrase: PASS, meta: null }))).code).toBe("self_check_failed");
  });
});

describe("parseBackup", () => {
  it("returns a normalized copy without unknown fields", async () => {
    const { file } = await backupFor();
    const parsed = parseBackup({ ...file, extra: "ignored", meta: { ...META, note: "x" } });
    expect(parsed).toEqual(file);
    expect(parsed).not.toHaveProperty("extra");
    expect(parseBackup({ ...file, meta: null }).meta).toBeNull();
  });

  it("rejects malformed files with bad_backup", async () => {
    const { file } = await backupFor();
    const b64 = (length: number) => bytesToBase64(new Uint8Array(length));
    const cases: unknown[] = [
      null,
      "backup",
      [],
      {},
      { ...file, format: undefined },
      { ...file, publicKey: file.publicKey.toUpperCase().replace("0X", "0x") },
      { ...file, publicKey: `0x${"00".repeat(32)}` },
      { ...file, publicKey: `${file.publicKey}00` },
      { ...file, meta: undefined },
      { ...file, meta: { ...META, account: "0x1234" } },
      { ...file, meta: { ...META, chainId: 0 } },
      { ...file, meta: { ...META, salt: "0x11" } },
      { ...file, kdf: { ...file.kdf, name: "scrypt" } },
      { ...file, kdf: { ...file.kdf, hash: "SHA-1" } },
      { ...file, kdf: { ...file.kdf, iterations: MIN_PBKDF2_ITERATIONS - 1 } },
      { ...file, kdf: { ...file.kdf, iterations: MAX_PBKDF2_ITERATIONS + 1 } },
      { ...file, kdf: { ...file.kdf, iterations: 600000.5 } },
      { ...file, kdf: { ...file.kdf, iterations: "600000" } },
      { ...file, kdf: { ...file.kdf, salt: b64(15) } },
      { ...file, kdf: { ...file.kdf, salt: "not base64!" } },
      { ...file, cipher: { ...file.cipher, name: "AES-CBC" } },
      { ...file, cipher: { ...file.cipher, iv: b64(16) } },
      { ...file, cipher: { ...file.cipher, ciphertext: b64(79) } },
      { ...file, cipher: { ...file.cipher, ciphertext: b64(81) } },
      { ...file, cipher: undefined },
      { ...file, createdAt: "yesterday" },
      { ...file, createdAt: 1730000000000 },
    ];
    for (const value of cases) {
      const error = await failure(() => parseBackup(value));
      expect(error.code, JSON.stringify(value)?.slice(0, 120)).toBe("bad_backup");
    }
  });

  it("rejects invalid JSON and oversized text", async () => {
    expect((await failure(() => parseBackupJson("{not json"))).code).toBe("bad_backup");
    const { file } = await backupFor();
    const padded = JSON.stringify({ ...file, padding: "x".repeat(MAX_BACKUP_FILE_BYTES) });
    expect((await failure(() => parseBackupJson(padded))).code).toBe("bad_backup");
  });
});

describe("readBackupFile / backupFileName", () => {
  it("reads a valid file and enforces the size limit", async () => {
    const { file } = await backupFor();
    const json = JSON.stringify(file, null, 2);
    expect(await readBackupFile(new File([json], "qsw-backup.json"))).toEqual(file);
    expect((await failure(readBackupFile(new File([], "empty.json")))).code).toBe("bad_backup");
    const huge = new File([json, " ".repeat(MAX_BACKUP_FILE_BYTES)], "huge.json");
    expect((await failure(readBackupFile(huge))).message).toMatch(/too large/);
    expect((await failure(readBackupFile(new File(["<html>"], "page.html")))).code).toBe("bad_backup");
  });

  it("names the file after the account, or the public key when there is no account yet", async () => {
    const { file } = await backupFor();
    expect(backupFileName(file)).toBe("qsw-backup-0x8f3a1c2b.json");
    const pk = file.publicKey as Hex;
    expect(backupFileName({ ...file, meta: null })).toBe(`qsw-backup-${pk.slice(0, 10)}.json`);
  });
});
