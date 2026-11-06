import { concat, keccak256, stringToBytes, toBytes } from "viem";
import { ACCOUNT_SALT_DOMAIN, PUBLIC_KEY_BYTES } from "./constants.js";
import type { Hex } from "./types.js";

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;

/** True for a 0x-prefixed, nonzero 32-byte SLH-DSA public key (PK.seed || PK.root). */
export function isPublicKey(value: unknown): value is Hex {
  return typeof value === "string" && HEX_32.test(value) && !/^0x0{64}$/.test(value);
}

/**
 * Deterministic CREATE2 salt for the account of a public key. One account per key:
 * repeated creation requests are idempotent, and a restored backup can always find
 * its account again from the public key alone.
 */
export function accountSalt(publicKey: Hex): Hex {
  if (!isPublicKey(publicKey)) throw new Error("Expected a nonzero 32-byte public key");
  const key = toBytes(publicKey);
  if (key.length !== PUBLIC_KEY_BYTES) throw new Error("Expected a 32-byte public key");
  return keccak256(concat([stringToBytes(ACCOUNT_SALT_DOMAIN), key]));
}
