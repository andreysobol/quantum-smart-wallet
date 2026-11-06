import { CHAIN_ID } from "../../shared/constants.js";
import { explorerAddressUrl, explorerBase } from "../chain/explorer.js";
import { fibers, short } from "../design/helpers.js";
import { useWalletName } from "../state/names.js";
import { useWallet } from "../state/wallet.js";
import { copyLabel, ManualCopy, useCopy } from "./CopyButton.js";
import { accountSeed, cx, Seal } from "./Seal.js";

/** UV security fibres hugging the page edges. */
export function PaperFx() {
  return (
    <div className="paperfx" aria-hidden="true">
      {fibers().map((f, index) => (
        <span
          key={index}
          className="fiber"
          style={{ left: `${f.x}%`, top: `${f.y}%`, color: f.c, transform: `rotate(${f.r}deg) scale(${f.s})` }}
        >
          <svg viewBox="0 0 40 12">
            <path d="M1 7C7 1 13 12 20 6S32 1 39 6"></path>
          </svg>
        </span>
      ))}
    </div>
  );
}

export function Header() {
  const { wallet, config, screen, go, onboarded } = useWallet();
  const [copyState, copy] = useCopy();
  const account = onboarded ? wallet : null;
  const name = useWalletName(config, account?.account);

  const goHome = () => {
    if (screen === "engrave") return;
    if (wallet && onboarded) go("portfolio");
    // A stored wallet that is not open yet (e.g. Genesis after a cancelled engraving): stay put.
    else if (!wallet || screen === "restore") go("genesis");
  };
  const explorer = config ? (account ? explorerAddressUrl(config, account.account) : explorerBase(config)) : null;
  const net = (
    <>
      <span className="dot"></span>
      <span className="net-t">Devnet</span>
    </>
  );

  return (
    <header className="bar">
      <button className="brand" onClick={goHome} aria-label="Quantum Smart Wallet, home">
        <Seal seed="quantum-smart-wallet" lite />
        <span className="wmk">
          <span className="w1">Quantum</span>
          <span className="w2 lab">Smart Wallet</span>
        </span>
      </button>
      {account && (
        <nav className="nav" aria-label="Sections">
          <button className={cx("nb", screen === "portfolio" && "on")} onClick={() => go("portfolio")}>
            Portfolio
          </button>
          <button className={cx("nb", screen === "exchange" && "on")} onClick={() => go("exchange")}>
            Exchange
          </button>
          {config?.ens && (
            <button className={cx("nb", screen === "names" && "on")} onClick={() => go("names")}>
              Names
            </button>
          )}
        </nav>
      )}
      <div className="barR">
        {explorer ? (
          <a
            className="net lab"
            href={explorer}
            target="_blank"
            rel="noopener noreferrer"
            title={account ? "Your account on the devnet explorer" : "Devnet explorer"}
          >
            {net}
          </a>
        ) : (
          <span className="net lab">{net}</span>
        )}
        {account && (
          <button
            type="button"
            className="acct"
            title={name ? `${name} · ${account.account}` : account.account}
            onClick={() => copy(account.account)}
            aria-label={
              copyState === "copied"
                ? "Address copied"
                : copyState === "failed"
                  ? `Copy failed. Address ${account.account}`
                  : `Copy address ${account.account}${name ? ` (${name})` : ""}`
            }
          >
            <Seal seed={accountSeed(account.publicKey)} lite size={30} />
            <span className="mono">{copyState === "idle" ? (name ?? short(account.account)) : copyLabel(copyState, "")}</span>
          </button>
        )}
        {account && copyState === "failed" && <ManualCopy text={account.account} />}
      </div>
    </header>
  );
}

export function Footer() {
  const { configError, retryConfig } = useWallet();
  return (
    <footer className="foot">
      <span className="lab">Devnet {CHAIN_ID} · test tokens only</span>
      {configError && (
        <p className="err mono" role="alert">
          Wallet server unavailable: {configError}{" "}
          <button className="link" onClick={retryConfig}>
            Retry
          </button>
        </p>
      )}
    </footer>
  );
}
