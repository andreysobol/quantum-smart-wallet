/**
 * Pure helpers for the passphrase-encrypted backup file: encoding, PBKDF2-SHA256 ->
 * AES-GCM-256 encryption, and strict file validation. Uses only globalThis.crypto.subtle,
 * TextEncoder and atob/btoa, so it runs in the signer worker and in Node (vitest).
 */
import { SECRET_KEY_BYTES, SIGNATURE_ALGORITHM, SIGNATURE_CONTEXT } from "../../shared/constants.js";
import type { Hex } from "../../shared/types.js";
import { SignerError, type BackupFile, type KeyMeta } from "./types.js";

export const BACKUP_FORMAT = "quantum-smart-wallet-backup";
export const BACKUP_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
/** Bounds accepted when reading a file: refuse weak KDFs and files that would stall the worker. */
export const MIN_PBKDF2_ITERATIONS = 100_000;
export const MAX_PBKDF2_ITERATIONS = 5_000_000;
export const KDF_SALT_BYTES = 16;
export const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
/** The worker's floor; the UI asks for at least 10 characters. */
export const MIN_PASSPHRASE_CHARS = 8;
export const MAX_BACKUP_FILE_BYTES = 64 * 1024;

type Bytes = Uint8Array<ArrayBuffer>;

const PUBLIC_KEY_HEX = /^0x[0-9a-f]{64}$/;
const BYTES32_HEX = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_HEX = /^0x[0-9a-fA-F]{40}$/;

export const isPublicKeyHex = (value: unknown): value is Hex =>
  typeof value === "string" && PUBLIC_KEY_HEX.test(value.toLowerCase()) && !/^0x0{64}$/.test(value);

export const isBytes32Hex = (value: unknown): value is Hex => typeof value === "string" && BYTES32_HEX.test(value);

export function hexToBytes(hex: string): Bytes {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error("invalid hex");
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
  return bytes;
}

export const bytesToHex = (bytes: Uint8Array): Hex =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Strict, canonical standard base64 (with padding); throws on anything else. */
export function base64ToBytes(text: string): Bytes {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new Error("invalid base64");
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (bytesToBase64(bytes) !== text) throw new Error("non-canonical base64");
  return bytes;
}

export const randomBytes = (length: number): Bytes => crypto.getRandomValues(new Uint8Array(length));

export function assertPassphrase(passphrase: unknown): asserts passphrase is string {
  if (typeof passphrase !== "string" || [...passphrase].length < MIN_PASSPHRASE_CHARS) {
    throw new SignerError("bad_passphrase", `The passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters.`);
  }
}

/** Authenticated header: changing any of these fields makes decryption fail. */
export function backupAad(file: Pick<BackupFile, "format" | "version" | "algorithm" | "context" | "publicKey">): Bytes {
  const { format, version, algorithm, context, publicKey } = file;
  return new TextEncoder().encode(JSON.stringify({ format, version, algorithm, context, publicKey }));
}

async function deriveBackupKey(passphrase: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  // NFC so the same passphrase typed on different platforms derives the same key.
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase.normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** FIPS 205 layout: SK = SK.seed || SK.prf || PK.seed || PK.root, so PK is the last 32 bytes. */
const embeddedPublicKey = (secretKey: Uint8Array) => secretKey.subarray(SECRET_KEY_BYTES - 32);

export interface EncryptBackupInput {
  secretKey: Uint8Array;
  publicKey: Hex;
  passphrase: string;
  meta: KeyMeta | null;
  iterations?: number;
  createdAt?: Date;
}

export async function encryptBackup(input: EncryptBackupInput): Promise<BackupFile> {
  const { secretKey, passphrase, meta, iterations = PBKDF2_ITERATIONS, createdAt = new Date() } = input;
  assertPassphrase(passphrase);
  const publicKey = input.publicKey.toLowerCase() as Hex;
  if (!isPublicKeyHex(publicKey)) throw new SignerError("internal", "Invalid public key.");
  if (secretKey.length !== SECRET_KEY_BYTES || !bytesEqual(embeddedPublicKey(secretKey), hexToBytes(publicKey))) {
    throw new SignerError("self_check_failed", "The key to back up does not match its public key.");
  }
  if (!Number.isSafeInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) {
    throw new SignerError("internal", "Unsupported PBKDF2 iteration count.");
  }
  const header = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    algorithm: SIGNATURE_ALGORITHM,
    context: SIGNATURE_CONTEXT,
    publicKey,
  } as const;
  const salt = randomBytes(KDF_SALT_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const key = await deriveBackupKey(passphrase, salt, iterations);
  const plaintext = Uint8Array.from(secretKey);
  let ciphertext: Bytes;
  try {
    ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: backupAad(header) }, key, plaintext),
    );
  } finally {
    plaintext.fill(0);
  }
  return {
    ...header,
    meta: meta ? normalizeMeta(meta) : null,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: bytesToBase64(salt) },
    cipher: { name: "AES-GCM", iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) },
    createdAt: createdAt.toISOString(),
  };
}

/**
 * Decrypt a backup and return the 64-byte secret key (caller must zeroize it).
 * AES-GCM cannot tell a wrong passphrase from a modified file; both are bad_passphrase.
 */
export async function decryptBackup(backup: BackupFile, passphrase: string): Promise<Bytes> {
  const file = parseBackup(backup);
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new SignerError("bad_passphrase", "Enter the backup passphrase.");
  }
  const key = await deriveBackupKey(passphrase, base64ToBytes(file.kdf.salt), file.kdf.iterations);
  let plaintext: Bytes;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(file.cipher.iv), additionalData: backupAad(file) },
        key,
        base64ToBytes(file.cipher.ciphertext),
      ),
    );
  } catch {
    throw new SignerError("bad_passphrase", "Wrong passphrase, or the backup file has been modified.");
  }
  if (plaintext.length !== SECRET_KEY_BYTES || !bytesEqual(embeddedPublicKey(plaintext), hexToBytes(file.publicKey))) {
    plaintext.fill(0);
    throw new SignerError("key_mismatch", "The key inside this backup does not match its public key.");
  }
  return plaintext;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function normalizeMeta(meta: KeyMeta): KeyMeta {
  return { chainId: meta.chainId, account: meta.account, factory: meta.factory, salt: meta.salt };
}

export function isKeyMeta(value: unknown): value is KeyMeta {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.chainId) &&
    (value.chainId as number) > 0 &&
    typeof value.account === "string" &&
    ADDRESS_HEX.test(value.account) &&
    typeof value.factory === "string" &&
    ADDRESS_HEX.test(value.factory) &&
    isBytes32Hex(value.salt)
  );
}

function decodeField(value: unknown, length: number, what: string): string {
  const invalid = () => new SignerError("bad_backup", `This backup file is damaged (invalid ${what}).`);
  if (typeof value !== "string") throw invalid();
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(value);
  } catch {
    throw invalid();
  }
  if (bytes.length !== length) throw invalid();
  return value;
}

/** Validate an untrusted value as a backup file; returns a normalized copy with only known fields. */
export function parseBackup(value: unknown): BackupFile {
  const fail = (message: string) => new SignerError("bad_backup", message);
  if (!isRecord(value) || value.format !== BACKUP_FORMAT) {
    throw fail("This file is not a Quantum Smart Wallet backup.");
  }
  if (value.version !== BACKUP_VERSION) throw fail("This backup was made by an unsupported wallet version.");
  if (value.algorithm !== SIGNATURE_ALGORITHM || value.context !== SIGNATURE_CONTEXT) {
    throw fail(`This backup is not an ${SIGNATURE_ALGORITHM} key for this wallet.`);
  }
  if (typeof value.publicKey !== "string" || !PUBLIC_KEY_HEX.test(value.publicKey) || !isPublicKeyHex(value.publicKey)) {
    throw fail("This backup file is damaged (invalid public key).");
  }
  const { meta, kdf, cipher } = value;
  if (meta !== null && !isKeyMeta(meta)) throw fail("This backup file is damaged (invalid account details).");
  if (!isRecord(kdf) || kdf.name !== "PBKDF2" || kdf.hash !== "SHA-256") {
    throw fail("This backup uses an unsupported key derivation.");
  }
  const iterations = kdf.iterations;
  if (
    typeof iterations !== "number" ||
    !Number.isSafeInteger(iterations) ||
    iterations < MIN_PBKDF2_ITERATIONS ||
    iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw fail("This backup uses an unsupported key derivation strength.");
  }
  if (!isRecord(cipher) || cipher.name !== "AES-GCM") throw fail("This backup uses an unsupported cipher.");
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw fail("This backup file is damaged (invalid creation date).");
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    algorithm: SIGNATURE_ALGORITHM,
    context: SIGNATURE_CONTEXT,
    publicKey: value.publicKey as Hex,
    meta: meta === null ? null : normalizeMeta(meta),
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: decodeField(kdf.salt, KDF_SALT_BYTES, "salt"),
    },
    cipher: {
      name: "AES-GCM",
      iv: decodeField(cipher.iv, GCM_IV_BYTES, "IV"),
      ciphertext: decodeField(cipher.ciphertext, SECRET_KEY_BYTES + GCM_TAG_BYTES, "ciphertext"),
    },
    createdAt: value.createdAt,
  };
}

/** Parse the text of a backup file (size-limited JSON) into a validated BackupFile. */
export function parseBackupJson(text: string): BackupFile {
  if (new TextEncoder().encode(text).length > MAX_BACKUP_FILE_BYTES) {
    throw new SignerError("bad_backup", "This file is too large to be a wallet backup.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SignerError("bad_backup", "This file is not a Quantum Smart Wallet backup (not valid JSON).");
  }
  return parseBackup(value);
}
