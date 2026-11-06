import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { checkLabel, durationFor } from "../../shared/ens.js";
import type { Address } from "../../shared/types.js";
import { formatDusdc, hasEns, loadNames, quoteName, registrationLabels, type NameQuote, type NameStatus, type OwnedNames } from "../chain/ens.js";
import { startRegistration, useRegistration } from "../chain/ensSession.js";
import { explorerAddressUrl } from "../chain/explorer.js";
import { showRegistration } from "../chain/session.js";
import { Seal } from "../components/Seal.js";
import { TokenMark } from "../components/TokenMark.js";
import { TxLink } from "../components/TxLink.js";
import { short } from "../design/helpers.js";
import { selectName, useSelectedName } from "../state/names.js";
import { useWallet } from "../state/wallet.js";

const ERROR_STYLE = { color: "var(--sealt)" } as const;
const REFRESH_MS = 30_000;
const PLAN_MODES = ["VERIFY", "VERIFY", "SENDER", "SENDER", "SENDER", "SENDER"] as const;

/** Character count for the name field; the stylesheet shrinks long names so they stay fully visible. */
const fitChars = (text: string) => ({ "--chars": Math.max(text.length, 1) }) as CSSProperties;
const dateOf = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

type Check = { label: string; quote: NameQuote | null; error: string | null };

export function Names() {
  const { wallet, config, signer, go } = useWallet();
  const registration = useRegistration();
  const selected = useSelectedName(wallet?.account);
  const [input, setInput] = useState("");
  const [years, setYears] = useState(1);
  const [check, setCheck] = useState<Check | null>(null);
  const [owned, setOwned] = useState<OwnedNames | null>(null);
  const [ownedError, setOwnedError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const alive = useRef(true);

  const ens = hasEns(config) ? config : null;
  const account = wallet?.account ?? null;
  const parsed = ens ? checkLabel(input, ens.ens.namespace) : null;
  const label = parsed?.ok ? parsed.label : null;

  const refreshOwned = useCallback(async () => {
    if (!ens || !account) return;
    try {
      const next = await loadNames(ens, account);
      if (!alive.current) return;
      setOwned(next);
      setOwnedError(null);
    } catch (e) {
      if (alive.current) setOwnedError(e instanceof Error ? e.message : "Could not read your names.");
    }
  }, [ens, account]);

  useEffect(() => {
    alive.current = true;
    void refreshOwned();
    const id = setInterval(() => void refreshOwned(), REFRESH_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [refreshOwned, registration?.running]);

  // Availability and the registrar's price for the typed name, debounced.
  useEffect(() => {
    if (!ens || !account || !label) {
      setCheck(null);
      return;
    }
    let live = true;
    setCheck({ label, quote: null, error: null });
    const timer = setTimeout(() => {
      quoteName(ens, account, label, years)
        .then((quote) => live && setCheck({ label, quote, error: null }))
        .catch((e: unknown) => live && setCheck({ label, quote: null, error: e instanceof Error ? e.message : "Could not check this name." }));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [ens, account, label, years, registration?.running]);

  if (!wallet || !config) return null;
  if (!ens) {
    return (
      <section className="scr narrow">
        <p className="lab">Devnet ENSv2</p>
        <p className="lede">Names are not available on this server: its deployment has no verified Devnet ENSv2 namespace.</p>
      </section>
    );
  }

  const namespace = ens.ens.namespace;
  const maxYears = ens.ens.maxYears;
  const quote = check?.label === label ? check.quote : null;
  const running = !!registration?.running;
  const price = quote?.price ?? (label ? BigInt(ens.ens.pricePerYear) * BigInt(years) : null);
  const expiry = Math.floor(Date.now() / 1000) + Number(durationFor(years));
  const sponsor = config.sponsor;
  const vault = owned?.vault ?? null;
  const frameLabels = registrationLabels(ens, label ?? "name", price);

  let status = `Type a name to check it under .${namespace}.`;
  let statusError = false;
  if (parsed && !parsed.ok && input.trim()) [status, statusError] = [parsed.reason, true];
  else if (label && label !== input.trim()) status = `Normalized to ${label}.${namespace}`;
  if (label && quote) {
    if (!quote.available) [status, statusError] = [`${label}.${namespace} is taken`, true];
    else status = `${label}.${namespace} is available${label !== input.trim() ? " (normalized)" : ""}`;
  } else if (label && check?.error) [status, statusError] = [check.error, true];
  else if (label && !quote) status = `Checking ${label}.${namespace}…`;

  let action = label ? `Register ${label}.${namespace}` : "Register";
  let locked = false;
  if (running) action = "View registration in progress";
  else if (!config.operatorReady || !sponsor) [action, locked] = ["Sponsor unavailable", true];
  else if (!label) [action, locked] = ["Type a name", true];
  else if (!quote) [action, locked] = [check?.error ? "Registrar unavailable" : "Checking…", true];
  else if (!quote.available) [action, locked] = ["Name taken", true];
  else if (quote.balance < quote.price) [action, locked] = [`Needs ${formatDusdc(quote.price)}`, true];

  const register = () => {
    if (running && registration) {
      showRegistration(registration.id);
      return go("proof");
    }
    if (locked || !label || !quote) return;
    try {
      setStartError(null);
      const started = startRegistration(ens, wallet, signer, { label, years }, quote.price, (report) => {
        if (!selected) selectName(wallet.account, report.name, true);
        void refreshOwned();
      });
      showRegistration(started.id);
      go("proof");
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "Could not start the registration.");
    }
  };

  return (
    <section className="scr">
      <div className="x-grid">
        <div className="slip">
          <div className="half">
            <label className="lab" htmlFor="ens-name">
              Name
            </label>
            <div className="amt-row">
              <input
                id="ens-name"
                className="amt ens-in"
                type="text"
                inputMode="text"
                enterKeyHint="search"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                placeholder="alice"
                value={input}
                style={fitChars(input || "alice")}
                onChange={(e) => setInput(e.target.value)}
                aria-describedby="ens-status"
                aria-invalid={statusError ? "true" : undefined}
              />
              <span className="tok">
                <span className="mono">.{namespace}</span>
              </span>
            </div>
            <div className="sub-row">
              <span id="ens-status" className="mono" role="status" style={statusError ? ERROR_STYLE : undefined}>
                {status}
              </span>
            </div>
          </div>
          <div className="perf" aria-hidden="true"></div>
          <div className="half recv">
            <p className="lab">Price</p>
            <div className="amt-row">
              <p className="amt" aria-live="polite" style={fitChars(price !== null ? formatDusdc(price).replace(" dUSDC", "") : "0")}>
                {price !== null ? formatDusdc(price).replace(" dUSDC", "") : "0"}
              </p>
              <span className="tok">
                <TokenMark sym="USDC" small />
                <span className="mono">dUSDC</span>
              </span>
            </div>
            <div className="sub-row">
              <span className="mono">Balance {quote ? formatDusdc(quote.balance) : "…"}</span>
              <div className="yrs" role="group" aria-label="Registration length">
                {Array.from({ length: maxYears }, (_, i) => i + 1).map((y) => (
                  <button key={y} type="button" className="tbtn" aria-pressed={years === y ? "true" : "false"} onClick={() => setYears(y)}>
                    {y} yr
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="terms ens-terms">
          <dl className="tbl">
            <div>
              <dt className="lab">Duration</dt>
              <dd className="mono">
                {years} year{years === 1 ? "" : "s"} · until {dateOf(expiry)} · {formatDusdc(BigInt(ens.ens.pricePerYear))} a year
              </dd>
            </div>
            <div>
              <dt className="lab">Token owner</dt>
              <dd className="mono" title={vault ?? undefined}>
                {vault ? `Your name vault ${short(vault)}${owned?.deployed ? "" : " · opened by this transaction"}` : "Your name vault"}
              </dd>
            </div>
            <div>
              <dt className="lab">Controller</dt>
              <dd className="mono" title={wallet.account}>
                Your account {short(wallet.account)}
              </dd>
            </div>
            <div>
              <dt className="lab">Resolves to</dt>
              <dd className="mono">Your account {short(wallet.account)}</dd>
            </div>
            <div>
              <dt className="lab">Network fee</dt>
              <dd className="mono">{sponsor ? `Sponsored · paid by ${short(sponsor)}` : "No sponsor"}</dd>
            </div>
          </dl>
          <button type="button" className="btn wide" onClick={register} disabled={locked}>
            {action}
          </button>
          {startError && (
            <p className="lab" role="alert" style={ERROR_STYLE}>
              {startError}
            </p>
          )}
          <div className="frames">
            <p className="lab">1 transaction · {frameLabels.length} frames · one atomic batch</p>
            <ol className="frl">
              {frameLabels.map((frame, i) => (
                <li key={i} className="fr">
                  <span className="fi mono">{i}</span>
                  <span className={`fm mono m-${(PLAN_MODES[i] ?? "SENDER").toLowerCase()}`}>{PLAN_MODES[i]}</span>
                  <span className="fd">{frame}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
      <section className="ledger" aria-labelledby="nm-h">
        <h3 id="nm-h">Your names</h3>
        {ownedError && (
          <div className="row">
            <p className="lab" role="alert" style={ERROR_STYLE}>
              {ownedError}
            </p>
            <button type="button" className="tbtn" onClick={() => void refreshOwned()}>
              Retry
            </button>
          </div>
        )}
        {!owned && !ownedError && <p className="lab">Reading your names…</p>}
        {owned && owned.names.length === 0 && <p className="lab">No names yet. A registered name is held by your vault and resolves to your account.</p>}
        {owned && owned.names.length > 0 && (
          <ol className="lg-list">
            {owned.names.map((name) => (
              <NameRow key={name.name} name={name} vault={owned.vault} chosen={selected?.name === name.name} onChoose={(chosen) => selectName(wallet.account, chosen ? name.name : null, chosen ? name.verified : null)} explorer={(a) => explorerAddressUrl(config, a)} />
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

function NameRow({
  name,
  vault,
  chosen,
  onChoose,
  explorer,
}: {
  name: NameStatus;
  vault: Address;
  chosen: boolean;
  onChoose: (chosen: boolean) => void;
  explorer: (address: string) => string;
}) {
  const meta = name.verified
    ? `Verified · held by your vault, resolves to your account · until ${dateOf(name.expiry)}`
    : !name.registered
      ? "Expired or released"
      : name.owner && name.owner.toLowerCase() !== vault.toLowerCase()
        ? `Moved out of your vault to ${short(name.owner)}`
        : "Not verified: it does not resolve to your account";
  return (
    <li className="lg-row">
      <Seal seed={`ens|${name.name}`} lite />
      <span className="lg-main">
        <span className="tt">{name.name}</span>
        <span className="lab" style={name.verified ? undefined : ERROR_STYLE}>
          {meta}
        </span>
      </span>
      <TxLink href={explorer(vault)} label={`View your name vault ${vault} on the explorer`}>
        Vault {short(vault)}
      </TxLink>
      {name.verified && (
        <button type="button" className="tbtn" aria-pressed={chosen ? "true" : "false"} onClick={() => onChoose(!chosen)}>
          {chosen ? "Wallet name" : "Use as wallet name"}
        </button>
      )}
    </li>
  );
}
