/**
 * Encrypted key storage for the signer worker: IndexedDB "qsw-keys" / store "keys", keyed by
 * lowercase public key hex. Each secret is sealed with its own non-extractable AES-GCM-256
 * device key (stored as a CryptoKey object, never as bytes) using the public key as AAD.
 */
import type { Hex } from "../../shared/types.js";
import { hexToBytes, randomBytes, GCM_IV_BYTES } from "./backupCrypto.js";
import { SignerError, type KeyMeta } from "./types.js";

export const DB_NAME = "qsw-keys";
export const STORE = "keys";

export interface KeyRecord {
  publicKey: Hex;
  wrapped: { iv: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> };
  deviceKey: CryptoKey;
  meta: KeyMeta | null;
  createdAt: number;
}

const unavailable = (detail: string) =>
  new SignerError("storage_unavailable", `Secure key storage is unavailable in this browser (${detail}).`);

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(unavailable("no IndexedDB"));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "publicKey" });
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(unavailable(request.error?.message ?? "open failed"));
    request.onblocked = () => reject(unavailable("database blocked by another tab"));
  }).catch((error: unknown) => {
    opening = null;
    throw error;
  });
  return opening;
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result as T);
    tx.onerror = tx.onabort = () => reject(unavailable(tx.error?.message ?? "transaction failed"));
  });
}

export const getRecord = (publicKey: Hex) =>
  run<KeyRecord | undefined>("readonly", (store) => store.get(publicKey.toLowerCase()));

export const putRecord = (record: KeyRecord) =>
  run<unknown>("readwrite", (store) => store.put({ ...record, publicKey: record.publicKey.toLowerCase() }));

export const deleteRecord = (publicKey: Hex) =>
  run<unknown>("readwrite", (store) => store.delete(publicKey.toLowerCase()));

/** Seal a secret key under a fresh non-extractable device key bound to its public key. */
export async function sealSecret(
  secretKey: Uint8Array,
  publicKey: Hex,
): Promise<Pick<KeyRecord, "deviceKey" | "wrapped">> {
  const deviceKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = randomBytes(GCM_IV_BYTES);
  const plaintext = Uint8Array.from(secretKey);
  try {
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: hexToBytes(publicKey.toLowerCase()) }, deviceKey, plaintext),
    );
    return { deviceKey, wrapped: { iv, ciphertext } };
  } finally {
    plaintext.fill(0);
  }
}

/** Decrypt a stored secret key (caller must zeroize it). */
export async function openSecret(record: KeyRecord): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: record.wrapped.iv, additionalData: hexToBytes(record.publicKey.toLowerCase()) },
        record.deviceKey,
        record.wrapped.ciphertext,
      ),
    );
  } catch {
    throw new SignerError("storage_unavailable", "The key stored on this device could not be decrypted. Restore it from your backup file.");
  }
}
