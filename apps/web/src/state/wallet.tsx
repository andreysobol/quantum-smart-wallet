import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Hex, PublicConfig } from "../../shared/types.js";
import { api } from "../chain/api.js";
import { loadConfig } from "../chain/config.js";
import type { SwapResult } from "../chain/types.js";
import { getSigner } from "../crypto/signer.js";
import type { KeyMeta, Signer } from "../crypto/types.js";
import { describeError, startEngrave, type EngraveDeps } from "./engrave.js";
import { lookupAccount } from "./factory.js";
import { loadWalletRecord, saveWalletRecord } from "./storage.js";
import type { Screen, WalletRecord } from "./types.js";

/** The transaction the Proof screen shows: a just-finished swap (with result) or a past one (hash only). */
export interface ProofTx {
  hash: Hex;
  result?: SwapResult;
}

export interface WalletContextValue {
  /** The single wallet on this device (public data), or null. */
  wallet: WalletRecord | null;
  /** Public server config, verified against the RPC (chain id + genesis); null while loading or on error. */
  config: PublicConfig | null;
  configError: string | null;
  retryConfig(): void;
  screen: Screen;
  go(screen: Screen): void;
  /** Replace (or clear) the wallet; persisted in localStorage "qsw.wallet.v1". */
  setWallet(wallet: WalletRecord | null): void;
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
  /** Genesis "Create wallet": start the engraving flow and show it. */
  createWallet(): void;
  /** After importBackup: find (or offer to create) the key's account through the engraving flow. */
  restoreWallet(publicKey: Hex, meta: KeyMeta | null): void;
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

  // Boot: a stored wallet opens the portfolio only if this device still holds its key.
  useEffect(() => {
    const stored = loadWalletRecord();
    if (!stored) return;
    let cancelled = false;
    signer.hasKey(stored.publicKey).then(
      (has) => {
        if (cancelled) return;
        if (has) {
          setOnboarded(true);
          setScreen("portfolio");
        } else {
          setKeyNotice("This browser remembers your account, but its signing key is not on this device. Restore it from your backup file.");
          setScreen("restore");
        }
        setBooting(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        setKeyNotice(`The key store on this device could not be opened (${describeError(error)}). Restore from your backup file, or reload to try again.`);
        setScreen("restore");
        setBooting(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [signer]);

  const go = useCallback((next: Screen) => {
    setScreen(next);
    globalThis.scrollTo?.(0, 0);
  }, []);

  const setWallet = useCallback((next: WalletRecord | null) => {
    saveWalletRecord(next);
    setWalletState(next);
    if (next) setKeyNotice(null);
  }, []);

  const openProof = useCallback(
    (hash: Hex, result?: SwapResult) => {
      setProofTx(result ? { hash, result } : { hash });
      go("proof");
    },
    [go],
  );

  const engraveDeps = useCallback(
    (): EngraveDeps => ({
      loadConfig,
      signer,
      createAccount: api.createAccount,
      lookupAccount,
      onDone: setWallet,
      paceMs: reducedMotion() ? 0 : 900,
    }),
    [signer, setWallet],
  );

  const createWallet = useCallback(() => {
    setOnboarded(false);
    startEngrave(engraveDeps(), "create");
    go("engrave");
  }, [engraveDeps, go]);

  const restoreWallet = useCallback(
    (publicKey: Hex, meta: KeyMeta | null) => {
      setOnboarded(false);
      startEngrave(engraveDeps(), "restore", { publicKey, meta });
      go("engrave");
    },
    [engraveDeps, go],
  );

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
    }),
    [wallet, config, configError, screen, go, setWallet, signer, proofTx, openProof, booting, onboarded, keyNotice, createWallet, restoreWallet],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet() must be used inside <WalletProvider>");
  return value;
}
