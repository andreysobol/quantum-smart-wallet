import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther } from "viem";
import { loadActivity } from "../chain/activity.js";
import { formatAmount, toNumber, TOKEN_DECIMALS } from "../chain/amounts.js";
import { ApiError, api } from "../chain/api.js";
import { loadBalances } from "../chain/balances.js";
import { explorerTxUrl } from "../chain/explorer.js";
import { showReplay } from "../chain/session.js";
import type { Balances, LedgerEntry } from "../chain/types.js";
import { CopyButton } from "../components/CopyButton.js";
import { accountSeed, Seal } from "../components/Seal.js";
import { Serial } from "../components/Serial.js";
import { TokenMark } from "../components/TokenMark.js";
import { TxLink } from "../components/TxLink.js";
import type { TokenSym } from "../design/helpers.js";
import { useWallet } from "../state/wallet.js";

const ERROR_STYLE = { color: "var(--sealt)" } as const;
const REFRESH_MS = 20_000;

interface Holding {
  sym: TokenSym;
  name: string;
  label: string;
  raw: bigint;
  decimals: number;
  dp: number;
  usd: number;
}

const usd = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function holdings(b: Balances, usdcSymbol: string): Holding[] {
  const price = Number.isFinite(b.usdcPerWeth) ? b.usdcPerWeth : 0;
  return [
    { sym: "ETH", name: "Ether", label: "ETH", raw: b.eth, decimals: 18, dp: 4, usd: toNumber(b.eth, 18) * price },
    { sym: "WETH", name: "Wrapped Ether", label: "WETH", raw: b.weth, decimals: 18, dp: 4, usd: toNumber(b.weth, 18) * price },
    {
      sym: "USDC",
      name: "Demo USD Coin",
      label: usdcSymbol,
      raw: b.usdc,
      decimals: TOKEN_DECIMALS.usdc,
      dp: 2,
      usd: toNumber(b.usdc, TOKEN_DECIMALS.usdc),
    },
  ];
}

const CLS: Record<TokenSym, string> = { ETH: "t-eth", WETH: "t-weth", USDC: "t-usdc" };

export function Portfolio() {
  const { wallet, config, go, openProof } = useWallet();
  const [balances, setBalances] = useState<Balances | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetNote, setFaucetNote] = useState<{ text: string; error: boolean } | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!config || !wallet) return;
    const [b, l] = await Promise.allSettled([loadBalances(config, wallet.account), loadActivity(config, wallet.account)]);
    if (!alive.current) return;
    if (b.status === "fulfilled") {
      setBalances(b.value);
      setError(null);
    } else {
      setError(b.reason instanceof Error ? b.reason.message : "Could not read balances.");
    }
    if (l.status === "fulfilled") setLedger(l.value);
  }, [config, wallet]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  if (!wallet || !config) return null;
  const usdcSymbol = config.faucet.symbol || "dUSDC";
  const faucetAmount = formatAmount(BigInt(config.faucet.amount || "0"), config.faucet.decimals, 0);

  const faucet = async () => {
    if (faucetBusy) return;
    setFaucetBusy(true);
    setFaucetNote(null);
    try {
      const res = await api.faucet({ account: wallet.account });
      if (!alive.current) return;
      setFaucetNote({ text: `Received ${formatAmount(BigInt(res.amount), config.faucet.decimals, 2)} ${usdcSymbol}.`, error: false });
      await refresh();
    } catch (e) {
      if (!alive.current) return;
      setFaucetNote({ text: e instanceof ApiError || e instanceof Error ? e.message : "The faucet request failed.", error: true });
    } finally {
      if (alive.current) setFaucetBusy(false);
    }
  };

  const rows = balances ? holdings(balances, usdcSymbol) : [];
  const total = rows.reduce((sum, h) => sum + h.usd, 0);
  const funded = !!balances && (balances.usdc > 0n || balances.weth > 0n);
  const [totInt, totCents = "00"] = usd(total).split(".");
  const segs = rows.filter((h) => total > 0 && h.usd / total > 0.002);
  const compLabel =
    "Allocation: " +
    rows
      .filter((h) => h.raw > 0n)
      .map((h) => `${h.label} ${total > 0 ? ((h.usd / total) * 100).toFixed(1) : "0"}%`)
      .join(", ");
  const faucetDisabled = faucetBusy || !config.faucet.enabled || !config.operatorReady;
  const faucetLabel = faucetBusy
    ? "Dripping…"
    : !config.faucet.enabled || !config.operatorReady
      ? "Faucet unavailable"
      : `Get ${faucetAmount} test ${usdcSymbol}`;
  const replay = (hash: LedgerEntry["hash"]) => {
    showReplay(hash);
    openProof(hash);
  };

  return (
    <section className="scr" aria-labelledby="v-h">
      {/* The header tab already names the page; keep the heading for screen readers only. */}
      <h2 className="vh" id="v-h">
        Portfolio
      </h2>
      <div className="v-grid">
        <div className="v-main">
          {!balances && !error && <p className="lab">Reading balances…</p>}
          {error && (
            <div className="row">
              <p className="lab" role="alert" style={ERROR_STYLE}>
                {error}
              </p>
              <button type="button" className="tbtn" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          )}
          {balances && funded && (
            <>
              <div className="bal">
                <p className="lab">Total balance</p>
                <p className="big">
                  <span className="cur">$</span>
                  {totInt}
                  <span className="cents">.{totCents}</span>
                </p>
              </div>
              <div className="comp" role="img" aria-label={compLabel}>
                {segs.map((h) => (
                  <span key={h.sym} className={`seg ${CLS[h.sym]}`} style={{ flexGrow: ((h.usd / total) * 100).toFixed(2) }} />
                ))}
              </div>
              <div className="hhead" aria-hidden="true">
                <span />
                <span className="lab">Asset</span>
                <span className="lab hamt">Balance</span>
                <span className="lab hval">Value</span>
              </div>
              <ul className="holdings">
                {rows.map((h) => (
                  <li key={h.sym} className={`hrow ${h.raw > 0n ? "" : "zero"}`}>
                    <TokenMark sym={h.sym} />
                    <span className="hname">
                      <span className="nm">{h.name}</span>
                      <span className="lab">{h.label}</span>
                    </span>
                    <span className="hamt mono">{formatAmount(h.raw, h.decimals, h.dp)}</span>
                    <span className="hval">{Number.isFinite(balances.usdcPerWeth) || h.sym === "USDC" ? `$${usd(h.usd)}` : "—"}</span>
                  </li>
                ))}
              </ul>
              <p className="lab">
                Spendable ETH is 0 by design: gas is paid by the sponsor.
                {balances.stake !== null && balances.stake > 0n
                  ? ` ${formatEther(balances.stake)} ETH is locked as your account's mempool stake.`
                  : ""}
              </p>
              <div className="row">
                <button type="button" className="tbtn" onClick={() => void faucet()} disabled={faucetDisabled}>
                  {faucetLabel}
                </button>
                <button type="button" className="tbtn" onClick={() => go("exchange")}>
                  Exchange
                </button>
              </div>
            </>
          )}
          {balances && !funded && (
            <div className="empty">
              <div className="bal">
                <p className="lab">Total balance</p>
                <p className="big">
                  <span className="cur">$</span>0<span className="cents">.00</span>
                </p>
              </div>
              <button type="button" className="btn" onClick={() => void faucet()} disabled={faucetDisabled}>
                {faucetLabel}
              </button>
            </div>
          )}
          {faucetNote && (
            <p className="lab" role={faucetNote.error ? "alert" : "status"} style={faucetNote.error ? ERROR_STYLE : undefined}>
              {faucetNote.text}
            </p>
          )}
        </div>
        <aside className="v-acct" aria-label="Account">
          <Seal seed={accountSeed(wallet.publicKey)} pk={wallet.publicKey} />
          <Serial address={wallet.account} />
          <CopyButton text={wallet.account} label="Copy address" />
          {!wallet.backedUp && (
            <button type="button" className="link warn" style={{ alignSelf: "center" }} onClick={() => go("backup")}>
              Back up your key
            </button>
          )}
        </aside>
      </div>
      {ledger && ledger.length > 0 && (
        <section className="ledger" aria-labelledby="lg-h">
          <h3 id="lg-h">Activity</h3>
          <ol className="lg-list">
            {ledger.map((l) => (
              <li key={l.hash} className="lg-row">
                <Seal seed={"tx|" + l.hash.slice(2)} lite />
                <span className="lg-main">
                  <span className="tt">{l.title}</span>
                  <span className="lab">{l.meta}</span>
                </span>
                <TxLink href={explorerTxUrl(config, l.hash, { frame: l.kind === "swap" })} label={`View transaction ${l.hash} on the explorer`}>
                  {l.hash.slice(0, 8)}…{l.hash.slice(-4)}
                </TxLink>
                {l.kind === "swap" && (
                  <button type="button" className="tbtn" onClick={() => replay(l.hash)}>
                    Replay proof
                  </button>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}
