/**
 * Signer module worker: the only place the SLH-DSA secret key exists unencrypted.
 * Requests are processed one at a time; responses carry public data only.
 */
import { algorithmName, generateKeyPair, init, publicKeyOf, sign, sizes, verify } from "slhts";
import wasmUrl from "slhts/pkg/rslh_bg.wasm?url";
import {
  PUBLIC_KEY_BYTES,
  SECRET_KEY_BYTES,
  SIGNATURE_ALGORITHM,
  SIGNATURE_BYTES,
  SIGNATURE_CONTEXT,
} from "../../shared/constants.js";
import type { Hex } from "../../shared/types.js";
import {
  assertPassphrase,
  bytesEqual,
  bytesToHex,
  decryptBackup,
  encryptBackup,
  hexToBytes,
  isBytes32Hex,
  isKeyMeta,
  isPublicKeyHex,
  parseBackup,
} from "./backupCrypto.js";
import type { SignerOp, SignerOps, SignerResponse, WireError } from "./protocol.js";
import { SignerError } from "./types.js";
import { deleteRecord, getRecord, openSecret, putRecord, sealSecret, type KeyRecord } from "./vault.js";

const CONTEXT = new TextEncoder().encode(SIGNATURE_CONTEXT);

let wasm: Promise<void> | null = null;

function loadWasm(): Promise<void> {
  wasm ??= init(wasmUrl)
    .then(() => {
      const s = sizes();
      if (
        s.secretKey !== SECRET_KEY_BYTES ||
        s.publicKey !== PUBLIC_KEY_BYTES ||
        s.signature !== SIGNATURE_BYTES ||
        algorithmName("sha2") !== SIGNATURE_ALGORITHM
      ) {
        throw new Error("unexpected parameter set");
      }
    })
    .catch((error: unknown) => {
      throw new SignerError("wasm_unavailable", `The SLH-DSA WebAssembly module failed to load (${describe(error)}).`);
    });
  return wasm;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

function requirePublicKey(publicKey: unknown): Hex {
  if (!isPublicKeyHex(publicKey)) throw new SignerError("internal", "Invalid public key.");
  return publicKey.toLowerCase() as Hex;
}

async function requireRecord(publicKey: unknown): Promise<KeyRecord> {
  const record = await getRecord(requirePublicKey(publicKey));
  if (!record) throw new SignerError("no_key", "The key for this wallet is not stored on this device. Restore it from your backup file.");
  return record;
}

/** The public key re-derived from a secret key must equal the expected one. */
function checkKeyPair(secretKey: Uint8Array, publicKey: Hex, code: "self_check_failed" | "key_mismatch") {
  if (!bytesEqual(publicKeyOf(secretKey), hexToBytes(publicKey))) {
    throw new SignerError(code, "The secret key does not match its public key.");
  }
}

/** Decrypt the stored secret, hand it to `use`, and always zeroize it afterwards. */
async function withStoredSecret<T>(publicKey: Hex, use: (secretKey: Uint8Array, record: KeyRecord) => T | Promise<T>) {
  await loadWasm();
  const record = await requireRecord(publicKey);
  const secretKey = await openSecret(record);
  try {
    checkKeyPair(secretKey, record.publicKey, "self_check_failed");
    return await use(secretKey, record);
  } finally {
    secretKey.fill(0);
  }
}

/** Decrypt a backup file and hand its (verified) secret to `use`; always zeroize afterwards. */
async function withBackupSecret<T>(backup: unknown, passphrase: string, use: (secretKey: Uint8Array, publicKey: Hex) => T | Promise<T>) {
  const file = parseBackup(backup);
  await loadWasm();
  const secretKey = await decryptBackup(file, passphrase);
  try {
    checkKeyPair(secretKey, file.publicKey, "key_mismatch");
    return await use(secretKey, file.publicKey);
  } finally {
    secretKey.fill(0);
  }
}

const elapsed = (started: number) => Math.max(1, Math.round(performance.now() - started));

const handlers: { [K in SignerOp]: (args: SignerOps[K]["args"]) => Promise<SignerOps[K]["result"]> } = {
  async ready() {
    const started = performance.now();
    await loadWasm();
    return { ms: elapsed(started) };
  },

  async generate() {
    await loadWasm();
    const started = performance.now();
    const pair = generateKeyPair("sha2");
    try {
      const publicKey = bytesToHex(pair.publicKey);
      checkKeyPair(pair.secretKey, publicKey, "self_check_failed");
      await putRecord({ publicKey, ...(await sealSecret(pair.secretKey, publicKey)), meta: null, createdAt: Date.now() });
      return { publicKey, ms: elapsed(started) };
    } finally {
      pair.secretKey.fill(0);
    }
  },

  async setMeta({ publicKey, meta }) {
    if (!isKeyMeta(meta)) throw new SignerError("internal", "Invalid key metadata.");
    const record = await requireRecord(publicKey);
    const { chainId, account, factory, salt } = meta;
    await putRecord({ ...record, meta: { chainId, account, factory, salt } });
    return null;
  },

  async hasKey({ publicKey }) {
    return isPublicKeyHex(publicKey) && (await getRecord(publicKey)) !== undefined;
  },

  async sign({ publicKey, digest }) {
    if (!isBytes32Hex(digest)) throw new SignerError("internal", "Expected a 32-byte digest to sign.");
    const message = hexToBytes(digest);
    return withStoredSecret(publicKey, (secretKey, record) => {
      const started = performance.now();
      const signature = sign("sha2", secretKey, message, { context: CONTEXT });
      const ms = elapsed(started);
      if (signature.length !== SIGNATURE_BYTES || !verify("sha2", hexToBytes(record.publicKey), message, signature, CONTEXT)) {
        throw new SignerError("self_check_failed", "The new signature failed self-verification and was discarded.");
      }
      return { signature: bytesToHex(signature), ms };
    });
  },

  async exportBackup({ publicKey, passphrase }) {
    assertPassphrase(passphrase);
    return withStoredSecret(publicKey, (secretKey, record) =>
      encryptBackup({ secretKey, publicKey: record.publicKey, passphrase, meta: record.meta }),
    );
  },

  async verifyBackup({ backup, passphrase, expectedPublicKey }) {
    const expected = requirePublicKey(expectedPublicKey);
    return withBackupSecret(backup, passphrase, (_secretKey, publicKey) => publicKey === expected);
  },

  async importBackup({ backup, passphrase }) {
    const file = parseBackup(backup);
    return withBackupSecret(file, passphrase, async (secretKey, publicKey) => {
      const existing = await getRecord(publicKey);
      const meta = file.meta ?? existing?.meta ?? null;
      await putRecord({ publicKey, ...(await sealSecret(secretKey, publicKey)), meta, createdAt: existing?.createdAt ?? Date.now() });
      return { publicKey, meta };
    });
  },

  async forget({ publicKey }) {
    await deleteRecord(requirePublicKey(publicKey));
    return null;
  },
};

function toWireError(error: unknown): WireError {
  if (error instanceof SignerError) return { code: error.code, message: error.message };
  return { code: "internal", message: `The signer failed unexpectedly (${describe(error)}).` };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

async function handle(data: unknown): Promise<SignerResponse> {
  const id = isObject(data) && typeof data.id === "number" ? data.id : -1;
  try {
    if (!isObject(data) || typeof data.op !== "string" || !Object.hasOwn(handlers, data.op)) {
      throw new SignerError("internal", "Unknown signer request.");
    }
    const handler = handlers[data.op as SignerOp] as (args: unknown) => Promise<SignerOps[SignerOp]["result"]>;
    return { id, ok: true, result: await handler(isObject(data.args) ? data.args : {}) };
  } catch (error) {
    return { id, ok: false, error: toWireError(error) };
  }
}

interface WorkerScope {
  postMessage(message: SignerResponse): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}
const scope = self as unknown as WorkerScope;

let queue = Promise.resolve();
scope.addEventListener("message", (event) => {
  queue = queue
    .then(() => handle(event.data))
    .then((response) => scope.postMessage(response))
    .catch(() => undefined);
});
