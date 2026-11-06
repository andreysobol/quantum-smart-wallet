import type { Address, Hex } from "../../shared/types.js";

/** Public metadata stored alongside an encrypted key and inside backup files. */
export interface KeyMeta {
  chainId: number;
  account: Address;
  factory: Address;
  salt: Hex;
}

/**
 * Passphrase-encrypted backup file (JSON, saved as .qsw-backup.json). The secret
 * key never appears unencrypted outside the signer worker.
 */
export interface BackupFile {
  format: "quantum-smart-wallet-backup";
  version: 1;
  algorithm: "SLH-DSA-SHA2-128s";
  context: string;
  publicKey: Hex;
  meta: KeyMeta | null;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string; ciphertext: string };
  createdAt: string;
}

export interface SignResult {
  /** 0x-prefixed 7,856-byte SLH-DSA-SHA2-128s signature over the raw 32-byte digest. */
  signature: Hex;
  /** Wall-clock milliseconds spent signing inside the worker. */
  ms: number;
}

/**
 * Main-thread facade over the signer Web Worker (src/crypto/signer.ts implements it).
 * Keys are generated, stored (encrypted at rest with a non-extractable device key in
 * IndexedDB), used and backed up entirely inside the worker.
 */
export interface Signer {
  /** Load the WASM module (idempotent). Rejects with a readable message if WebAssembly fails to load. */
  ready(): Promise<void>;
  /** Generate a fresh SLH-DSA-SHA2-128s key pair and persist it encrypted. */
  generate(): Promise<{ publicKey: Hex; ms: number }>;
  /** Attach public metadata (account, salt, ...) once the account exists. */
  setMeta(publicKey: Hex, meta: KeyMeta): Promise<void>;
  hasKey(publicKey: Hex): Promise<boolean>;
  /** Sign a raw 32-byte digest with the account context; self-verifies before returning. */
  sign(publicKey: Hex, digest: Hex): Promise<SignResult>;
  /** Encrypt the stored key under a passphrase and return the backup file contents. */
  exportBackup(publicKey: Hex, passphrase: string): Promise<BackupFile>;
  /** Decrypt a backup and check it holds the key for expectedPublicKey. Does not store anything. */
  verifyBackup(backup: BackupFile, passphrase: string, expectedPublicKey: Hex): Promise<boolean>;
  /** Decrypt a backup, re-derive and check the public key, then store the key encrypted on this device. */
  importBackup(backup: BackupFile, passphrase: string): Promise<{ publicKey: Hex; meta: KeyMeta | null }>;
  /** Delete the stored key from this device. */
  forget(publicKey: Hex): Promise<void>;
}

export class SignerError extends Error {
  constructor(
    public code:
      | "wasm_unavailable"
      | "no_key"
      | "bad_passphrase"
      | "bad_backup"
      | "key_mismatch"
      | "storage_unavailable"
      | "self_check_failed"
      | "internal",
    message: string,
  ) {
    super(message);
    this.name = "SignerError";
  }
}
