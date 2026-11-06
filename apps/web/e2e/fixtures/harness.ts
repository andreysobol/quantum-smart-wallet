/**
 * Test-only page (never part of the app build): records every message crossing the signer
 * worker boundary, then exposes the real src/crypto signer to Playwright.
 */
import { init, publicKeyOf, verify } from "slhts";
import wasmUrl from "slhts/pkg/rslh_bg.wasm?url";
import { SIGNATURE_CONTEXT } from "../../shared/constants.js";
import type { Hex } from "../../shared/types.js";
import { bytesToHex, decryptBackup, hexToBytes } from "../../src/crypto/backupCrypto.js";
import { downloadBackup, getSigner, readBackupFile } from "../../src/crypto/signer.js";
import { SignerError, type BackupFile } from "../../src/crypto/types.js";

const log = {
  spawned: [] as { url: string; type: string }[],
  /** Everything the worker posted to the main thread. */
  received: [] as unknown[],
  /** Everything the main thread posted to the worker. */
  sent: [] as unknown[],
};

const NativeWorker = window.Worker;
window.Worker = class RecordingWorker extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    log.spawned.push({ url: String(url), type: options?.type ?? "classic" });
    this.addEventListener("message", (event: MessageEvent<unknown>) => log.received.push(event.data));
  }
  override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
    log.sent.push(message);
    if (Array.isArray(options)) super.postMessage(message, options);
    else super.postMessage(message, options);
  }
};

let mainThreadWasm: Promise<void> | null = null;
const loadMainThreadWasm = () => (mainThreadWasm ??= init(wasmUrl));

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
    for (let i = 0; i < needle.length; i++) if (haystack[start + i] !== needle[i]) continue outer;
    return true;
  }
  return false;
}

/** Byte interpretations of a string: as hex and as base64, when it parses as either. */
function decodings(text: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const hex = text.startsWith("0x") ? text : `0x${text}`;
  if (/^0x(?:[0-9a-fA-F]{2})+$/.test(hex)) out.push(hexToBytes(hex));
  try {
    out.push(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
  } catch {
    // not base64
  }
  return out;
}

interface ScanReport {
  messages: number;
  strings: number;
  binaries: number;
  hits: string[];
}

function scan(value: unknown, secret: Uint8Array, path: string, report: ScanReport) {
  if (typeof value === "string") {
    report.strings++;
    const leaked =
      value.toLowerCase().includes(bytesToHex(secret).slice(2)) || decodings(value).some((bytes) => containsBytes(bytes, secret));
    if (leaked) report.hits.push(path);
  } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    report.binaries++;
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (containsBytes(bytes, secret)) report.hits.push(path);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) scan(child, secret, `${path}.${key}`, report);
  }
}

const harness = {
  signer: getSigner(),
  log,
  downloadBackup,

  async readSelectedFile(): Promise<BackupFile> {
    const file = document.querySelector<HTMLInputElement>("#backup-file")?.files?.[0];
    if (!file) throw new Error("no file selected");
    return readBackupFile(file);
  },

  /** Independent check on the main thread with slhts (the worker also self-verifies). */
  async verifyOnMainThread(publicKey: Hex, digest: Hex, signature: Hex, context = SIGNATURE_CONTEXT): Promise<boolean> {
    await loadMainThreadWasm();
    return verify("sha2", hexToBytes(publicKey), hexToBytes(digest), hexToBytes(signature), new TextEncoder().encode(context));
  },

  /** TEST ONLY: decrypt a backup here to learn the secret that the worker must never post. */
  async revealBackupSecret(backup: BackupFile, passphrase: string): Promise<{ secretSeedHex: Hex; derivedPublicKey: Hex }> {
    await loadMainThreadWasm();
    const secretKey = await decryptBackup(backup, passphrase);
    // SK.seed || SK.prf: the secret half (the last 32 bytes are the public key).
    return { secretSeedHex: bytesToHex(secretKey.subarray(0, 32)), derivedPublicKey: bytesToHex(publicKeyOf(secretKey)) };
  },

  /** Search every recorded worker message (both directions) for the secret, in any encoding. */
  scanForSecret(secretSeedHex: Hex): { received: ScanReport; sent: ScanReport } {
    const secret = hexToBytes(secretSeedHex);
    const report = (messages: unknown[]) => {
      const result: ScanReport = { messages: messages.length, strings: 0, binaries: 0, hits: [] };
      messages.forEach((message, index) => scan(message, secret, `[${index}]`, result));
      return result;
    };
    return { received: report(log.received), sent: report(log.sent) };
  },

  /** Await a promise and return its outcome as plain data (errors keep their SignerError code). */
  async outcome<T>(promise: Promise<T>) {
    try {
      return { ok: true as const, value: await promise };
    } catch (error) {
      const { name, message } = error as Error;
      return { ok: false as const, name, code: error instanceof SignerError ? error.code : null, message };
    }
  },
};

export type Harness = typeof harness;

declare global {
  interface Window {
    harness: Harness;
  }
}

window.harness = harness;
document.querySelector("#status")!.textContent = "ready";
