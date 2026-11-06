/** Typed request/response messages between src/crypto/signer.ts and the signer worker. */
import type { Hex } from "../../shared/types.js";
import type { BackupFile, KeyMeta, SignerError, SignResult } from "./types.js";

type NoArgs = Record<string, never>;

export interface SignerOps {
  ready: { args: NoArgs; result: { ms: number } };
  generate: { args: NoArgs; result: { publicKey: Hex; ms: number } };
  setMeta: { args: { publicKey: Hex; meta: KeyMeta }; result: null };
  hasKey: { args: { publicKey: Hex }; result: boolean };
  sign: { args: { publicKey: Hex; digest: Hex }; result: SignResult };
  exportBackup: { args: { publicKey: Hex; passphrase: string }; result: BackupFile };
  verifyBackup: { args: { backup: BackupFile; passphrase: string; expectedPublicKey: Hex }; result: boolean };
  importBackup: { args: { backup: BackupFile; passphrase: string }; result: { publicKey: Hex; meta: KeyMeta | null } };
  forget: { args: { publicKey: Hex }; result: null };
}

export type SignerOp = keyof SignerOps;

export type SignerRequest = { [K in SignerOp]: { id: number; op: K; args: SignerOps[K]["args"] } }[SignerOp];

export interface WireError {
  code: SignerError["code"];
  message: string;
}

export type SignerResponse =
  | { id: number; ok: true; result: SignerOps[SignerOp]["result"] }
  | { id: number; ok: false; error: WireError };
