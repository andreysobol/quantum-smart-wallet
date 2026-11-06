/**
 * The wallet's selected Devnet ENSv2 name. Only the choice is stored (localStorage "qsw.ens.v1", per
 * account); it is shown only after the chain confirms that the account's vault holds the name and it
 * resolves to the account, re-checked every minute.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { Address, PublicConfig } from "../../shared/types.js";
import { checkNames, hasEns, loadVault } from "../chain/ens.js";

const KEY = "qsw.ens.v1";
const RECHECK_MS = 60_000;

interface Selection {
  account: string;
  name: string;
  /** Null while unchecked. */
  verified: boolean | null;
}

let selection: Selection | null = read();
const listeners = new Set<() => void>();

function read(): Selection | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { account?: unknown; name?: unknown };
    if (typeof value.account !== "string" || typeof value.name !== "string") return null;
    return { account: value.account.toLowerCase(), name: value.name, verified: null };
  } catch {
    return null;
  }
}

function publish(next: Selection | null) {
  selection = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => selection;

/** Choose (or clear) the name the wallet shows for `account`; `verified` when the caller just checked it. */
export function selectName(account: string, name: string | null, verified: boolean | null = null) {
  try {
    if (name) globalThis.localStorage?.setItem(KEY, JSON.stringify({ account: account.toLowerCase(), name }));
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Storage may be unavailable (private mode): keep the choice for this session only.
  }
  publish(name ? { account: account.toLowerCase(), name, verified } : null);
}

/** The selected name of `account` if the chain verifies it, else null. */
export function useWalletName(config: PublicConfig | null, account: Address | null | undefined): string | null {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const mine = current && account && current.account === account.toLowerCase() ? current : null;
  const name = mine?.name ?? null;

  useEffect(() => {
    if (!name || !account || !hasEns(config)) return;
    const namespace = `.${config.ens.namespace}`;
    if (!name.endsWith(namespace)) {
      publish(selection && { ...selection, verified: false });
      return;
    }
    let alive = true;
    const check = async () => {
      try {
        const vault = await loadVault(config, account);
        const [status] = await checkNames(config, account, vault.vault, [name.slice(0, -namespace.length)]);
        if (alive && selection?.name === name) publish({ ...selection, verified: !!status?.verified });
      } catch {
        // Keep the last known state when the RPC is unreachable.
      }
    };
    void check();
    const id = setInterval(() => void check(), RECHECK_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [config, account, name]);

  return mine?.verified ? mine.name : null;
}

/** The raw selection for `account` (verified or not), for the Names screen. */
export function useSelectedName(account: Address | null | undefined): Selection | null {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return current && account && current.account === account.toLowerCase() ? current : null;
}
