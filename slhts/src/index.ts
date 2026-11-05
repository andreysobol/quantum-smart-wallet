/**
 * TypeScript API for rslh (FIPS 205 SLH-DSA-SHA2-128s / SLH-DSA-SHAKE-128s) compiled to WebAssembly.
 *
 * Call `await init()` once before anything else. Keys and signatures use the raw
 * FIPS 205 byte layout (64-byte private key, 32-byte public key, 7,856-byte signature),
 * the same bytes `rslh export` writes and OpenSSL uses.
 *
 * WARNING: research code, not audited. Do not use to protect real funds.
 */
import initWasm, * as wasm from "../pkg/rslh.js";

export type Algorithm = "sha2" | "shake";

export interface KeyPair {
  algorithm: Algorithm;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface SignOptions {
  /** FIPS 205 context string, at most 255 bytes (default: empty). */
  context?: Uint8Array;
  /** Deterministic signature instead of hedged with crypto.getRandomValues (default: false). */
  deterministic?: boolean;
}

let ready: Promise<void> | undefined;

/** Load the WebAssembly module. `wasmUrl` defaults to rslh_bg.wasm next to the bindings. */
export function init(wasmUrl?: string | URL): Promise<void> {
  ready ??= initWasm(wasmUrl ? { module_or_path: wasmUrl } : undefined).then(() => undefined);
  return ready;
}

export const sizes = () => ({
  secretKey: wasm.secretKeyBytes(),
  publicKey: wasm.publicKeyBytes(),
  signature: wasm.signatureBytes(),
});

/** Full algorithm name, e.g. "SLH-DSA-SHA2-128s". */
export const algorithmName = (alg: Algorithm): string => wasm.algorithmName(alg);

/** New random key pair (browser randomness). */
export function generateKeyPair(algorithm: Algorithm = "sha2"): KeyPair {
  const secretKey = wasm.generateSecretKey(algorithm);
  return { algorithm, secretKey, publicKey: wasm.publicKey(secretKey) };
}

/** Deterministic key pair from a 48-byte seed (SK.seed || SK.prf || PK.seed); tests only. */
export function keyPairFromSeed(algorithm: Algorithm, seed: Uint8Array): KeyPair {
  const secretKey = wasm.secretKeyFromSeed(algorithm, seed);
  return { algorithm, secretKey, publicKey: wasm.publicKey(secretKey) };
}

/** Public key contained in a private key. */
export const publicKeyOf = (secretKey: Uint8Array): Uint8Array => wasm.publicKey(secretKey);

/** Sign a message; slow (seconds) for the 128s parameter sets. */
export function sign(
  algorithm: Algorithm,
  secretKey: Uint8Array,
  message: Uint8Array,
  { context = new Uint8Array(), deterministic = false }: SignOptions = {},
): Uint8Array {
  return wasm.sign(algorithm, secretKey, message, context, deterministic);
}

/** Verify a signature; false for any invalid signature. */
export function verify(
  algorithm: Algorithm,
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
  context: Uint8Array = new Uint8Array(),
): boolean {
  return wasm.verify(algorithm, publicKey, message, context, signature);
}

export const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function fromHex(h: string): Uint8Array {
  if (h.length % 2 !== 0 || /[^0-9a-f]/i.test(h)) throw new Error("invalid hex");
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}
