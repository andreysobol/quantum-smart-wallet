/**
 * Main-thread Signer over the signer module worker. Requests run one at a time (the worker
 * is single-threaded and SLH-DSA signing blocks it for seconds), each with its own timeout;
 * a timed-out or crashed worker is terminated and replaced on the next call.
 */
import type { Hex } from "../../shared/types.js";
import { MAX_BACKUP_FILE_BYTES, parseBackupJson } from "./backupCrypto.js";
import type { SignerOp, SignerOps, SignerRequest, SignerResponse } from "./protocol.js";
import { SignerError, type BackupFile, type KeyMeta, type Signer, type SignResult } from "./types.js";

const TIMEOUT_MS: Record<SignerOp, number> = {
  ready: 30_000,
  generate: 30_000,
  setMeta: 15_000,
  hasKey: 15_000,
  sign: 60_000,
  exportBackup: 60_000,
  verifyBackup: 60_000,
  importBackup: 60_000,
  forget: 15_000,
};

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: SignerError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Ask the browser not to evict the stored key under storage pressure (best effort). */
function requestPersistentStorage() {
  void navigator.storage?.persist?.().catch(() => false);
}

class WorkerSigner implements Signer {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();

  async ready(): Promise<void> {
    await this.call("ready", {});
  }

  async generate(): Promise<{ publicKey: Hex; ms: number }> {
    const result = await this.call("generate", {});
    requestPersistentStorage();
    return result;
  }

  async setMeta(publicKey: Hex, meta: KeyMeta): Promise<void> {
    await this.call("setMeta", { publicKey, meta });
  }

  hasKey(publicKey: Hex): Promise<boolean> {
    return this.call("hasKey", { publicKey });
  }

  sign(publicKey: Hex, digest: Hex): Promise<SignResult> {
    return this.call("sign", { publicKey, digest });
  }

  exportBackup(publicKey: Hex, passphrase: string): Promise<BackupFile> {
    return this.call("exportBackup", { publicKey, passphrase });
  }

  verifyBackup(backup: BackupFile, passphrase: string, expectedPublicKey: Hex): Promise<boolean> {
    return this.call("verifyBackup", { backup, passphrase, expectedPublicKey });
  }

  async importBackup(backup: BackupFile, passphrase: string): Promise<{ publicKey: Hex; meta: KeyMeta | null }> {
    const result = await this.call("importBackup", { backup, passphrase });
    requestPersistentStorage();
    return result;
  }

  async forget(publicKey: Hex): Promise<void> {
    await this.call("forget", { publicKey });
  }

  private call<K extends SignerOp>(op: K, args: SignerOps[K]["args"]): Promise<SignerOps[K]["result"]> {
    const send = () => this.send(op, args);
    const result = this.queue.then(send, send);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private send<K extends SignerOp>(op: K, args: SignerOps[K]["args"]): Promise<SignerOps[K]["result"]> {
    return new Promise<SignerOps[K]["result"]>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = this.spawn();
      } catch {
        return reject(new SignerError("wasm_unavailable", "This browser cannot run the signing engine (module workers are unsupported)."));
      }
      const id = this.nextId++;
      const seconds = TIMEOUT_MS[op] / 1000;
      const timer = setTimeout(
        () => this.reset(new SignerError("internal", `The signer did not finish "${op}" within ${seconds} s and was restarted. Please try again.`)),
        TIMEOUT_MS[op],
      );
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        worker.postMessage({ id, op, args } as SignerRequest);
      } catch {
        this.settle(id)?.reject(new SignerError("internal", "The request could not be sent to the signer."));
      }
    });
  }

  private spawn(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./signer.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<SignerResponse>) => this.receive(event.data));
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      this.reset(new SignerError("wasm_unavailable", "The signing engine failed to load. Reload the page and try again."));
    });
    worker.addEventListener("messageerror", () =>
      this.reset(new SignerError("internal", "The signer sent a message that could not be read.")),
    );
    this.worker = worker;
    return worker;
  }

  private settle(id: number): Pending | undefined {
    const entry = this.pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
    }
    return entry;
  }

  private receive(response: SignerResponse) {
    const entry = this.settle(response.id);
    if (!entry) return;
    if (response.ok) return entry.resolve(response.result);
    entry.reject(new SignerError(response.error.code, response.error.message));
    // A failed WASM load is cached inside the worker; start a fresh one next time.
    if (response.error.code === "wasm_unavailable") this.reset();
  }

  /** Terminate the worker and reject everything in flight. */
  private reset(error = new SignerError("internal", "The signer was restarted. Please try again.")) {
    this.worker?.terminate();
    this.worker = null;
    for (const id of [...this.pending.keys()]) {
      const entry = this.settle(id);
      entry?.reject(error);
    }
  }
}

let instance: Signer | null = null;

/** The app-wide signer (the worker starts lazily on first use). */
export function getSigner(): Signer {
  instance ??= new WorkerSigner();
  return instance;
}

/** Read and validate a backup file chosen by the user. */
export async function readBackupFile(file: File): Promise<BackupFile> {
  if (file.size === 0) throw new SignerError("bad_backup", "The selected file is empty.");
  if (file.size > MAX_BACKUP_FILE_BYTES) throw new SignerError("bad_backup", "This file is too large to be a wallet backup.");
  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new SignerError("bad_backup", "The selected file could not be read.");
  }
  return parseBackupJson(text);
}

export function backupFileName(backup: BackupFile): string {
  const id = (backup.meta?.account ?? backup.publicKey).toLowerCase().slice(0, 10);
  return `qsw-backup-${id}.json`;
}

/** Save the backup as a JSON file via the browser's download flow. */
export function downloadBackup(backup: BackupFile): void {
  const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = backupFileName(backup);
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
