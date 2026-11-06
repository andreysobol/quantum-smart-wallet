import { useEffect, useMemo, useState } from "react";
import { formatEther } from "viem";
import type { Hex } from "../../shared/types.js";
import { formatToken, tokenIn, tokenOut } from "../chain/amounts.js";
import { explorerTxUrl } from "../chain/explorer.js";
import {
  frameRow,
  liveFrameStates,
  PHASES,
  phaseOfStage,
  replayAt,
  replayTimeline,
  treePaths,
  waitingTreeProgress,
  type FrameRunState,
} from "../chain/proof.js";
import { formatDusdc, type RegistrationReport } from "../chain/ens.js";
import { useRegistration } from "../chain/ensSession.js";
import { showLive, useSession } from "../chain/session.js";
import { loadSwapReport, PLAN_MODES, revertMessage, tokenSymbol, type SwapReport } from "../chain/swap.js";
import type { FrameView } from "../chain/types.js";
import { CopyButton } from "../components/CopyButton.js";
import { accountSeed, cx, Seal, TreeLayer } from "../components/Seal.js";
import { TxLink } from "../components/TxLink.js";
import { tree } from "../design/helpers.js";
import { useWallet } from "../state/wallet.js";

const ERROR_STYLE = { color: "var(--sealt)" } as const;
const TICK_MS = 80;

interface Display {
  phase: number;
  frames: Pick<FrameView, "mode" | "label" | "status">[];
  states: FrameRunState[];
  tree: number;
  signing: boolean;
  stamped: boolean;
  done: boolean;
  title: string;
  sub: string;
}

const n = (value: bigint | number) => value.toLocaleString("en-US");
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const ENS_MODES = ["VERIFY", "VERIFY", "SENDER", "SENDER", "SENDER", "SENDER"] as const;
const dateOf = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

function registrationRows(r: RegistrationReport, account: string): { k: string; v: string }[] {
  return [
    { k: "Name", v: r.name },
    { k: "Paid", v: r.status === "success" ? `${formatDusdc(r.paid)} · quoted ${formatDusdc(r.quotedPrice)}` : "Nothing · reverted" },
    { k: "Token owner", v: `Vault ${short(r.check?.owner ?? r.vault)}` },
    { k: "Controller", v: `Account ${short(account)}` },
    { k: "Resolves to", v: r.check?.resolvesTo ? short(r.check.resolvesTo) : "—" },
    { k: "Expires", v: r.check?.registered ? dateOf(r.check.expiry) : "—" },
    { k: "Block", v: n(r.blockNumber) },
    { k: "Paid by", v: `${short(r.payer)}${r.payer.toLowerCase() === r.sponsor.toLowerCase() ? " (sponsor)" : ""}` },
    { k: "PQ validation", v: r.pqValidationGas !== null ? `${n(r.pqValidationGas)} gas (frame 0)` : "—" },
    { k: "Admission", v: r.admission ? `${r.admission.checksPassed}/${r.admission.checksTotal} checks · ${r.admission.outcome}` : "No longer held by the mempool" },
    { k: "Nonce", v: n(r.nonce) },
    { k: "Signed in browser", v: `${n(r.signMs)} ms` },
  ];
}

function receiptRows(r: SwapReport, usdcSymbol: string): { k: string; v: string }[] {
  const from = tokenIn(r.direction);
  const to = tokenOut(r.direction);
  const sym = (t: "usdc" | "weth") => (t === "usdc" ? usdcSymbol : "WETH");
  return [
    {
      k: "Result",
      v: r.status === "success" ? `−${formatToken(r.amountIn, from)} ${sym(from)} · +${formatToken(r.amountOut, to)} ${sym(to)}` : "Reverted · nothing swapped",
    },
    { k: "Min. received", v: r.minOut > 0n ? `${formatToken(r.minOut, to)} ${sym(to)}` : "—" },
    { k: "Block", v: n(r.blockNumber) },
    { k: "Paid by", v: `${short(r.payer)}${r.payer.toLowerCase() === r.sponsor.toLowerCase() ? " (sponsor)" : ""}` },
    { k: "Fee", v: `${formatEther(r.feeWei).slice(0, 8)} ETH · ${n(r.gasUsed)} gas` },
    { k: "PQ validation", v: r.pqValidationGas !== null ? `${n(r.pqValidationGas)} gas (frame 0)` : "—" },
    { k: "Admission", v: r.admission ? `${r.admission.checksPassed}/${r.admission.checksTotal} checks · ${r.admission.outcome}` : "No longer held by the mempool" },
    { k: "Nonce", v: n(r.nonce) },
    ...(r.signMs !== null ? [{ k: "Signed in browser", v: `${n(r.signMs)} ms` }] : []),
  ];
}

export function Proof() {
  const { wallet, config, go, proofTx } = useWallet();
  const session = useSession();
  const view = session.view ?? (proofTx ? { kind: "replay" as const, hash: proofTx.hash } : null);
  const live = view?.kind === "live" && session.live?.id === view.id ? session.live : null;
  const registration = useRegistration();
  const ens = view?.kind === "ens" && registration?.id === view.id ? registration : null;
  // The live run on screen: a swap or a name registration (same stages, phases and frame states).
  const run = ens ?? live;
  const runReport: SwapReport | RegistrationReport | null = ens ? ens.result : live ? live.result : null;
  const replayHash: Hex | null = view?.kind === "replay" ? view.hash : null;
  // A replay of another transaction hides the live (or last) swap: offer the way back to it.
  const hiddenLive =
    replayHash && session.live && session.live.txHash?.toLowerCase() !== replayHash.toLowerCase() ? session.live : null;

  const [loaded, setLoaded] = useState<{ hash: Hex; report: SwapReport | null; error: string | null } | null>(null);
  const [clock, setClock] = useState({ t: 0, playing: false });
  const [now, setNow] = useState(() => Date.now());
  const frameCount = ens ? ens.labels.length : 5;
  const timeline = useMemo(() => replayTimeline(frameCount), [frameCount]);

  // Replays: load the report by hash (reuse the live result when it is the same swap).
  useEffect(() => {
    if (!replayHash || !config || !wallet) return;
    const own = session.live?.result;
    if (own && own.txHash.toLowerCase() === replayHash.toLowerCase()) {
      setLoaded({ hash: replayHash, report: own, error: null });
      setClock({ t: 0, playing: true });
      return;
    }
    let alive = true;
    setLoaded(null);
    loadSwapReport(config, wallet.account, replayHash)
      .then((report) => {
        if (!alive) return;
        setLoaded({ hash: replayHash, report, error: null });
        setClock({ t: 0, playing: true });
      })
      .catch((e: unknown) => alive && setLoaded({ hash: replayHash, report: null, error: e instanceof Error ? e.message : "Could not load this transaction." }));
    return () => {
      alive = false;
    };
  }, [replayHash, config, wallet, session.live?.result]);

  // A just-finished live run lands on its final frame; a replay plays once when it opens.
  useEffect(() => {
    if (runReport) setClock({ t: timeline.total, playing: false });
  }, [runReport, timeline.total]);

  useEffect(() => {
    if (!clock.playing) return;
    const id = setInterval(
      () =>
        setClock((c) => {
          const t = Math.min(timeline.total, c.t + TICK_MS);
          return { ...c, t, playing: t < timeline.total };
        }),
      TICK_MS,
    );
    return () => clearInterval(id);
  }, [clock.playing, timeline.total]);

  const waiting = !!run?.running && phaseOfStage(run.stage) === 2;
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [waiting]);

  if (!wallet || !config) return null;
  const usdcSymbol = config.faucet.symbol || "dUSDC";
  const report: SwapReport | RegistrationReport | null = run ? runReport : (loaded?.report ?? null);
  const error = run ? run.error : (loaded?.error ?? null);
  const hash = report?.txHash ?? run?.txHash ?? replayHash ?? null;
  const modes: readonly string[] = ens ? ENS_MODES : PLAN_MODES;
  const geometry = tree(accountSeed(wallet.publicKey));

  let d: Display;
  const playback = !!report && (!run || !run.running) && (clock.playing || clock.t > 0 || !run);
  if (report && playback) {
    const r = replayAt(timeline, clock.t);
    const verified = report.frames[0]?.status === "success";
    const subs = [
      `${report.frames.length} frames · 1 signature`,
      "SLH-DSA-SHA2-128s · 7,856 bytes",
      r.tree >= 1 && report.pqValidationGas !== null ? `Root matches · ${n(report.pqValidationGas)} gas` : "Verifying on-chain",
      "Running as your account",
      `Block ${n(report.blockNumber)}`,
    ];
    d = {
      phase: r.done ? 4 : r.phase,
      frames: report.frames,
      states: r.frames,
      tree: r.tree,
      signing: r.signing,
      // A registration that was included but did not verify (vault, resolution) is not complete.
      stamped: r.stamped && verified && !(ens && error),
      done: r.done,
      title: r.done ? (report.status !== "success" ? "Reverted" : ens && error ? "Not completed" : "Verified") : (PHASES[r.phase]?.title ?? ""),
      sub: r.done && report.status !== "success" ? (ens ? (error ?? "The registration reverted.") : revertMessage(report.frames)) : (subs[r.phase] ?? ""),
    };
  } else if (run) {
    const phase = phaseOfStage(run.stage);
    const failed = !!run.error;
    const pastVerify = phase >= 3;
    d = {
      phase,
      frames: run.labels.map((label, i) => ({ mode: (modes[i] ?? "SENDER") as FrameView["mode"], label, status: null })),
      states: liveFrameStates(run.stage, run.labels.length, false),
      tree: pastVerify ? 1 : run.submittedAt ? waitingTreeProgress(now - run.submittedAt) : 0,
      signing: run.stage === "sign" && run.state === "active",
      stamped: pastVerify && !failed,
      done: failed,
      title: failed ? (run.unresolved ? "Status unknown" : "Not completed") : (PHASES[phase]?.title ?? ""),
      sub: run.message,
    };
  } else {
    d = {
      phase: 0,
      frames: [],
      states: [],
      tree: 0,
      signing: false,
      stamped: false,
      done: false,
      title: error ? "Unavailable" : view ? "Loading" : "No proof yet",
      sub: error ?? (view ? "Reading the transaction from the chain…" : "Sign a swap on the Exchange to see its proof."),
    };
  }

  const includedAt = run?.history.find((p) => p.stage === "inclusion" && p.state === "done")?.detail?.blockNumber;
  const stampBlock = report ? report.blockNumber : typeof includedAt === "number" ? includedAt : null;
  const paths = treePaths(geometry, d.tree);
  const locked = d.tree >= 1;

  return (
    <section className="scr" aria-label="Proof">
      <ol className="rail" aria-label="Phases">
        {PHASES.map((p, i) => (
          <li key={p.name} className={`ph ${(d.done && !error) || i < d.phase ? "done" : i === d.phase ? "now" : ""}`}>
            <span className="lab">{p.name}</span>
          </li>
        ))}
      </ol>
      <div className="p-grid">
        <aside className="p-frames" aria-label="Frames">
          <ol className="pfl">
            {d.frames.map((f, i) => {
              const row = frameRow(f, d.states[i] ?? "hidden");
              return (
                <li key={i} className={`pf ${row.cls}`}>
                  <span className={`fm mono m-${f.mode.toLowerCase()}`}>{f.mode}</span>
                  <span className="pf-t">{f.label}</span>
                  <span className="pf-s mono">{row.status}</span>
                </li>
              );
            })}
          </ol>
        </aside>
        <div className="p-stage">
          <Seal
            seed={accountSeed(wallet.publicKey)}
            pk={wallet.publicKey}
            rosette={false}
            className={cx("proof", d.signing && "signing", locked && "locked")}
          >
            <TreeLayer {...paths} />
            {d.stamped && (
              <div className="stamp" aria-hidden="true">
                <span className="st1">Verified</span>
                <span className="st2 mono">Block {stampBlock !== null ? n(stampBlock) : "…"}</span>
              </div>
            )}
          </Seal>
          <p className="p-title">
            <em>{d.title}</em>
          </p>
          <p className="p-sub mono" aria-live="polite" role={error ? "alert" : undefined} style={error ? ERROR_STYLE : undefined}>
            {error ?? d.sub}
          </p>
          {hiddenLive && (
            <button type="button" className="tbtn" onClick={showLive}>
              {hiddenLive.running ? "Back to live swap" : "Back to last swap"}
            </button>
          )}
        </div>
      </div>
      {(d.done || error) && (
        <div className="receipt">
          <div className="rc-wrap">
            {hash && (
              <div className="txline">
                <span className="lab">Transaction</span>
                <TxLink href={report?.explorerTxUrl ?? explorerTxUrl(config, hash, { frame: true })} label={`View transaction ${hash} on the explorer`}>
                  {hash.slice(0, 10)}…{hash.slice(-6)}
                </TxLink>
                <CopyButton text={hash} label="Copy hash" />
              </div>
            )}
            {report && d.done && (
              <dl className="rc">
                {(ens ? registrationRows(report as RegistrationReport, wallet.account) : receiptRows(report as SwapReport, usdcSymbol)).map((row) => (
                  <div key={row.k}>
                    <dt className="lab">{row.k}</dt>
                    <dd className="mono">{row.v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {!report && error && ens && (
              <p className="lab">
                {ens.unresolved ? "Outcome unknown" : "Failed"} at the {ens.stage} step. {ens.txHash ? "" : "Nothing was sent to the network."} Name {ens.name},{" "}
                {ens.input.years} year{ens.input.years === 1 ? "" : "s"}.
              </p>
            )}
            {!report && error && live && (
              <p className="lab">
                {live.unresolved ? "Outcome unknown" : "Failed"} at the {live.stage} step. {live.txHash ? "" : "Nothing was sent to the network."} Swap amount{" "}
                {formatToken(live.input.amountIn, tokenIn(live.input.direction))} {tokenSymbol(config, tokenIn(live.input.direction))}.
              </p>
            )}
          </div>
          <div className="row">
            {/* No way back to a retry while the transaction may still land: that could swap twice. */}
            {error && live && !live.unresolved && (
              <button type="button" className="btn ghost" onClick={() => go("exchange")}>
                Back to exchange
              </button>
            )}
            {ens && !ens.unresolved && (
              <button type="button" className="btn ghost" onClick={() => go("names")}>
                Back to names
              </button>
            )}
            <button type="button" className="btn" onClick={() => go("portfolio")}>
              Back to portfolio
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
