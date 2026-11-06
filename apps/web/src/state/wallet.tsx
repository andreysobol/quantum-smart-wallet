import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Hex, PublicConfig } from "../../shared/types.js";
import { api } from "../chain/api.js";
import { loadConfig } from "../chain/config.js";
import type { SwapResult } from "../chain/types.js";
import { getSigner } from "../crypto/signer.js";
import type { KeyMeta, Signer } from "../crypto/types.js";
import { clearEngrave, describeError, startEngrave, type EngraveMode } from "./engrave.js";
import { lookupAccount } from "./factory.js";
import { commitWalletRecord, loadWalletRecord, saveWalletRecord, WALLET_STORAGE_KEY, walletToReplace } from "./storage.js";
import type { Screen, WalletRecord } from "./types.js";

/** The transaction the Proof screen shows: a just-finished swap (with result) or a past one (hash only). */
export interface ProofTx {
  hash: Hex;
  result?: SwapResult;
}

/**
 * A Create, Restore or finished engraving that would replace the different wallet this device holds
 * (`current`, possibly saved by another tab). Nothing is replaced until confirmReplace().
 */
export type PendingReplace =
  | { action: "create"; current: WalletRecord }
  | { action: "restore"; current: WalletRecord; publicKey: Hex; meta: KeyMeta | null }
  | { action: "save"; current: WalletRecord; record: WalletRecord };

export interface WalletContextValue {
  /** The single wallet on this device (public data), or null. */
  wallet: WalletRecord | null;
  /** Public server config, verified against the RPC (chain id + genesis); null while loading or on error. */
  config: PublicConfig | null;
  configError: string | null;
  retryConfig(): void;
  screen: Screen;
  go(screen: Screen): void;
  /**
   * Update (or clear) the wallet, persisted in localStorage "qsw.wallet.v1". Returns false, and shows the
   * stored wallet instead, if this device now holds a different wallet (replaced in another tab).
   */
  setWallet(wallet: WalletRecord | null): boolean;
  signer: Signer;
  proofTx: ProofTx | null;
  openProof(hash: Hex, result?: SwapResult): void;
  /** True until the stored wallet's key has been looked up on this device. */
  booting: boolean;
  /** Past onboarding (backup sealed or skipped, restore finished): the header shows nav + account. */
  onboarded: boolean;
  finishOnboarding(): void;
  /** Why the Restore screen was opened at boot (key missing on this device), if it was. */
  keyNotice: string | null;
  /** Genesis "Create wallet": start the engraving flow and show it, or first ask to replace the device's wallet. */
  createWallet(): void;
  /** After importBackup: find (or offer to create) the key's account through the engraving flow, or first ask. */
  restoreWallet(publicKey: Hex, meta: KeyMeta | null): void;
  /** Waiting for the user to replace or keep the device's other wallet. */
  replacing: PendingReplace | null;
  /** Replace the device's wallet; its encrypted key stays in this browser's key store. */
  confirmReplace(): void;
  /** Keep the device's wallet and open it. */
  keepWallet(): void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function WalletProvider({ children }: { children: ReactNode }) {
  const signer = useMemo(() => getSigner(), []);
  const [wallet, setWalletState] = useState<WalletRecord | null>(() => loadWalletRecord());
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configAttempt, setConfigAttempt] = useState(0);
  const [screen, setScreen] = useState<Screen>("genesis");
  const [booting, setBooting] = useState(() => wallet !== null);
  const [onboarded, setOnboarded] = useState(false);
  const [keyNotice, setKeyNotice] = useState<string | null>(null);
  const [proofTx, setProofTx] = useState<ProofTx | null>(null);
  const [replacing, setReplacing] = useState<PendingReplace | null>(null);

  useEffect(() => {
    let cancelled = false;
    setConfigError(null);
    loadConfig().then(
      (loaded) => !cancelled && setConfig(loaded),
      (error: unknown) => !cancelled && setConfigError(describeError(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [configAttempt]);

  /** Show a stored wallet: the portfolio if this device still holds its key, else Restore with the reason. */
  const openWallet = useCallback(
    (stored: WalletRecord, live: () => boolean = () => true) => {
      setWalletState(stored);
      signer.hasKey(stored.publicKey).then(
        (has) => {
          if (!live()) return;
          if (has) {
            setKeyNotice(null);
            setOnboarded(true);
            setScreen("portfolio");
          } else {
            setKeyNotice("This browser remembers your account, but its signing key is not on this device. Restore it from your backup file.");
            setScreen("restore");
          }
          setBooting(false);
        },
        (error: unknown) => {
          if (!live()) return;
          setKeyNotice(`The key store on this device could not be opened (${describeError(error)}). Restore from your backup file, or reload to try again.`);
          setScreen("restore");
          setBooting(false);
        },
      );
    },
    [signer],
  );

  // Boot: a stored wallet opens the portfolio only if this device still holds its key.
  useEffect(() => {
    const stored = loadWalletRecord();
    if (!stored) return;
    let cancelled = false;
    openWallet(stored, () => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [openWallet]);

  // Another tab saved or replaced the wallet: follow it, so this tab never shows or writes back a stale one.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === WALLET_STORAGE_KEY) setWalletState(loadWalletRecord());
    };
    globalThis.addEventListener?.("storage", onStorage);
    return () => globalThis.removeEventListener?.("storage", onStorage);
  }, []);

  const go = useCallback((next: Screen) => {
    // Leaving the screen dismisses a pending Create/Restore question; a finished engraving still needs an answer.
    setReplacing((pending) => (pending?.action === "save" ? pending : null));
    setScreen(next);
    globalThis.scrollTo?.(0, 0);
  }, []);

  /** Compare-and-set save (commitWalletRecord): on refusal this tab shows the wallet that is stored. */
  const save = useCallback((next: WalletRecord, replaces: Hex | null) => {
    const result = commitWalletRecord(next, replaces);
    setWalletState(result.saved ? next : result.current);
    if (result.saved) setKeyNotice(null);
    return result;
  }, []);

  const setWallet = useCallback(
    (next: WalletRecord | null) => {
      if (next) return save(next, null).saved;
      saveWalletRecord(null);
      setWalletState(null);
      return true;
    },
    [save],
  );

  const openProof = useCallback(
    (hash: Hex, result?: SwapResult) => {
      setProofTx(result ? { hash, result } : { hash });
      go("proof");
    },
    [go],
  );

  /** Start the engraving flow; its wallet may replace only `replaces`, the wallet the user agreed to replace. */
  const startFlow = useCallback(
    (mode: EngraveMode, replaces: Hex | null, restored?: { publicKey: Hex; meta: KeyMeta | null }) => {
      setReplacing(null);
      setOnboarded(false);
      const onDone = (record: WalletRecord) => {
        const result = save(record, replaces);
        // Another tab saved a different wallet meanwhile: ask before replacing it.
        if (!result.saved) setReplacing({ action: "save", current: result.current, record });
      };
      startEngrave(
        { loadConfig, signer, createAccount: api.createAccount, lookupAccount, onDone, paceMs: reducedMotion() ? 0 : 900 },
        mode,
        restored,
      );
      go("engrave");
    },
    [signer, save, go],
  );

  // Both read storage rather than this tab's state: another tab may have saved a wallet since.
  const createWallet = useCallback(() => {
    const current = walletToReplace(loadWalletRecord(), null);
    if (current) setReplacing({ action: "create", current });
    else startFlow("create", null);
  }, [startFlow]);

  const restoreWallet = useCallback(
    (publicKey: Hex, meta: KeyMeta | null) => {
      const current = walletToReplace(loadWalletRecord(), publicKey);
      if (current) setReplacing({ action: "restore", current, publicKey, meta });
      else startFlow("restore", null, { publicKey, meta });
    },
    [startFlow],
  );

  const confirmReplace = useCallback(() => {
    if (!replacing) return;
    const replaces = replacing.current.publicKey;
    if (replacing.action === "create") return startFlow("create", replaces);
    if (replacing.action === "restore") return startFlow("restore", replaces, { publicKey: replacing.publicKey, meta: replacing.meta });
    const { record } = replacing;
    const result = save(record, replaces);
    // Yet another wallet was saved in the meantime: ask about that one instead.
    setReplacing(result.saved ? null : { action: "save", current: result.current, record });
  }, [replacing, startFlow, save]);

  const keepWallet = useCallback(() => {
    if (!replacing) return;
    setReplacing(null);
    if (replacing.action === "save") clearEngrave();
    setBooting(true);
    openWallet(loadWalletRecord() ?? replacing.current);
  }, [replacing, openWallet]);

  const value = useMemo<WalletContextValue>(
    () => ({
      wallet,
      config,
      configError,
      retryConfig: () => setConfigAttempt((n) => n + 1),
      screen,
      go,
      setWallet,
      signer,
      proofTx,
      openProof,
      booting,
      onboarded,
      finishOnboarding: () => setOnboarded(true),
      keyNotice,
      createWallet,
      restoreWallet,
      replacing,
      confirmReplace,
      keepWallet,
    }),
    [
      wallet,
      config,
      configError,
      screen,
      go,
      setWallet,
      signer,
      proofTx,
      openProof,
      booting,
      onboarded,
      keyNotice,
      createWallet,
      restoreWallet,
      replacing,
      confirmReplace,
      keepWallet,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet() must be used inside <WalletProvider>");
  return value;
}
