import { useEffect, useMemo, useState } from "react";
import { formatEther } from "viem";
import { loadPoolState, quoteExactIn, type PoolState } from "../../shared/quote.js";
import type { SwapDirection } from "../../shared/types.js";
import {
  formatToken,
  parseAmountInput,
  rawToInput,
  sanitizeAmountInput,
  TOKEN_DECIMALS,
  TOKEN_DP,
  toNumber,
  tokenIn,
  tokenOut,
  type TokenKey,
} from "../chain/amounts.js";
import { loadBalances } from "../chain/balances.js";
import { showLive, startSwap, useSession } from "../chain/session.js";
import { PLAN_MODES, swapFrameLabels, tokenSymbol } from "../chain/swap.js";
import type { Balances } from "../chain/types.js";
import { TokenMark } from "../components/TokenMark.js";
import { useWallet } from "../state/wallet.js";

const SLIPPAGE_BPS = 50;
const REFRESH_MS = 15_000;
/** Gas a sponsored swap uses (demo receipt: 1,727,304), for the fee estimate shown before signing. */
const EST_SWAP_GAS = 1_730_000n;
const ERROR_STYLE = { color: "var(--sealt)" } as const;
const MARK: Record<TokenKey, "USDC" | "WETH"> = { usdc: "USDC", weth: "WETH" };

export function Exchange() {
  const { wallet, config, signer, go } = useWallet();
  const session = useSession();
  const [direction, setDirection] = useState<SwapDirection>("USDC_TO_WETH");
  const [amount, setAmount] = useState("");
  const [balances, setBalances] = useState<Balances | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [balanceAttempt, setBalanceAttempt] = useState(0);
  const [pool, setPool] = useState<PoolState | null>(null);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const from = tokenIn(direction);
  const to = tokenOut(direction);
  const amountIn = parseAmountInput(amount, TOKEN_DECIMALS[from]);

  // Balances: on entry, after each swap, on Retry and every 15 s, so one failed read never sticks.
  useEffect(() => {
    if (!config || !wallet) return;
    let live = true;
    const load = () =>
      loadBalances(config, wallet.account)
        .then((b) => {
          if (!live) return;
          setBalances(b);
          setBalanceError(null);
        })
        .catch((e: unknown) => live && setBalanceError(e instanceof Error ? e.message : "Could not read balances."));
    void load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [config, wallet, session.live?.running, balanceAttempt]);

  // Fresh pool state for the live quote: debounced on input, refreshed every 15 s.
  useEffect(() => {
    if (!config) return;
    let live = true;
    const load = () =>
      loadPoolState(config.rpcUrl, config)
        .then((p) => {
          if (!live) return;
          setPool(p);
          setPoolError(null);
        })
        .catch(() => live && setPoolError("Could not read the pool price."));
    const debounce = setTimeout(load, 350);
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearTimeout(debounce);
      clearInterval(interval);
    };
  }, [config, amount, direction]);

  const quote = useMemo(() => {
    if (!pool || !amountIn || amountIn <= 0n) return null;
    try {
      const q = quoteExactIn(pool, direction, amountIn);
      return q.amountOut > 0n ? q : null;
    } catch {
      return null;
    }
  }, [pool, direction, amountIn]);

  if (!wallet || !config) return null;
  const fromSym = tokenSymbol(config, from);
  const toSym = tokenSymbol(config, to);
  const balance = balances ? (from === "usdc" ? balances.usdc : balances.weth) : null;
  const cap = BigInt(from === "usdc" ? config.limits.maxAmountInUsdc : config.limits.maxAmountInWeth);
  const minOut = quote ? (quote.amountOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n : null;
  const spot = quote?.spotUsdcPerWeth ?? balances?.usdcPerWeth ?? Number.NaN;
  const rate =
    quote && amountIn
      ? from === "usdc"
        ? toNumber(amountIn, 6) / toNumber(quote.amountOut, 18)
        : toNumber(quote.amountOut, 6) / toNumber(amountIn, 18)
      : spot;
  const outUsd = quote ? (to === "usdc" ? toNumber(quote.amountOut, 6) : toNumber(quote.amountOut, 18) * spot) : null;
  const sponsor = config.sponsor;
  const estFee = formatEther(EST_SWAP_GAS * BigInt(config.fees.maxPriorityFeePerGas || "0")).slice(0, 7);
  const labels = swapFrameLabels(config, direction, amountIn);
  const running = !!session.live?.running;

  let signLabel = "Sign";
  let signLocked = false;
  if (running) signLabel = "View swap in progress";
  else if (!config.operatorReady || !sponsor) [signLabel, signLocked] = ["Sponsor unavailable", true];
  else if (!balances) [signLabel, signLocked] = [balanceError ? "Balances unavailable" : "Reading balances…", true];
  else if (balances.usdc === 0n && balances.weth === 0n) [signLabel, signLocked] = ["Get devnet funds first", true];
  else if (!amountIn || amountIn <= 0n) [signLabel, signLocked] = ["Enter an amount", true];
  else if (balance !== null && amountIn > balance) [signLabel, signLocked] = [`Not enough ${fromSym}`, true];
  else if (amountIn > cap) [signLabel, signLocked] = [`Max ${formatToken(cap, from)} ${fromSym} per swap`, true];
  else if (!quote || !minOut || minOut <= 0n) [signLabel, signLocked] = [poolError ? "Pool price unavailable" : "Quoting…", true];

  const sign = () => {
    if (running) {
      // Proof may still be showing a replay of an older swap: point it back at this one.
      showLive();
      return go("proof");
    }
    if (signLocked || !amountIn) return;
    try {
      setStartError(null);
      startSwap(config, wallet, signer, { direction, amountIn, slippageBps: SLIPPAGE_BPS });
      go("proof");
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "Could not start the swap.");
    }
  };
  const setMax = () => {
    if (balance === null) return;
    const max = balance < cap ? balance : cap;
    // Full token precision: display rounding here would leave dust behind on "sell everything".
    setAmount(rawToInput(max, TOKEN_DECIMALS[from], TOKEN_DECIMALS[from]));
  };
  const flip = () => {
    setDirection(direction === "USDC_TO_WETH" ? "WETH_TO_USDC" : "USDC_TO_WETH");
    setAmount(quote ? rawToInput(quote.amountOut, TOKEN_DECIMALS[to], TOKEN_DP[to]) : "");
  };
  const onAmt = (value: string) => {
    const clean = sanitizeAmountInput(value);
    const [whole = "", fraction] = clean.split(".");
    setAmount(fraction !== undefined ? `${whole}.${fraction.slice(0, TOKEN_DECIMALS[from])}` : clean);
  };

  return (
    <section className="scr">
      <div className="x-grid">
        <div className="slip">
          <div className="half">
            <label className="lab" htmlFor="amt">
              You pay
            </label>
            <div className="amt-row">
              <input
                id="amt"
                className="amt"
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={amount}
                onChange={(e) => onAmt(e.target.value)}
                autoComplete="off"
              />
              <span className="tok">
                <TokenMark sym={MARK[from]} small />
                <span className="mono">{fromSym}</span>
              </span>
            </div>
            <div className="sub-row">
              <span className="mono">Balance {balance === null ? "…" : formatToken(balance, from)}</span>
              <button type="button" className="tbtn" onClick={setMax}>
                Max
              </button>
            </div>
          </div>
          <div className="perf">
            <button type="button" className="flip" onClick={flip} aria-label="Swap direction">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 4v16M8 4 4.5 7.5M8 4l3.5 3.5M16 20V4M16 20l-3.5-3.5M16 20l3.5-3.5" />
              </svg>
            </button>
          </div>
          <div className="half recv">
            <p className="lab">You receive</p>
            <div className="amt-row">
              <p className="amt" aria-live="polite">
                {quote ? formatToken(quote.amountOut, to) : "0"}
              </p>
              <span className="tok">
                <TokenMark sym={MARK[to]} small />
                <span className="mono">{toSym}</span>
              </span>
            </div>
            <div className="sub-row">
              <span className="mono">
                {outUsd !== null && Number.isFinite(outUsd)
                  ? `≈ $${outUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : ""}
                {quote && quote.priceImpactBps > 0 ? ` · impact ${(quote.priceImpactBps / 100).toFixed(2)}%` : ""}
              </span>
            </div>
          </div>
        </div>
        <div className="terms">
          <dl className="tbl">
            <div>
              <dt className="lab">Rate</dt>
              <dd className="mono">
                {Number.isFinite(rate)
                  ? `1 WETH = ${rate.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${config.faucet.symbol || "dUSDC"}`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="lab">Min. received</dt>
              <dd className="mono">{minOut ? `${formatToken(minOut, to)} ${toSym} (${SLIPPAGE_BPS / 100}%)` : "—"}</dd>
            </div>
            <div>
              <dt className="lab">Network fee</dt>
              <dd className="mono">
                {sponsor ? `Sponsored · ≈${estFee} ETH paid by ${sponsor.slice(0, 6)}…${sponsor.slice(-4)}` : "No sponsor"}
              </dd>
            </div>
          </dl>
          <div>
            <p className="lab">1 transaction · {labels.length} frames</p>
            <ol className="frl">
              {labels.map((label, i) => {
                const mode = PLAN_MODES[i] ?? "SENDER";
                return (
                  <li key={i} className="fr">
                    <span className="fi mono">{i}</span>
                    <span className={`fm mono m-${mode.toLowerCase()}`}>{mode}</span>
                    <span className="fd">{label}</span>
                  </li>
                );
              })}
            </ol>
          </div>
          <button type="button" className="btn wide" onClick={sign} disabled={signLocked}>
            {signLabel}
          </button>
          {(startError || poolError) && (
            <p className="lab" role="alert" style={ERROR_STYLE}>
              {startError ?? poolError}
            </p>
          )}
          {balanceError && (
            <div className="row">
              <p className="lab" role="alert" style={ERROR_STYLE}>
                {balanceError}
              </p>
              <button type="button" className="tbtn" onClick={() => setBalanceAttempt((n) => n + 1)}>
                Retry
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
