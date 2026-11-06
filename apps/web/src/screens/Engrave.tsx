import { CHAIN_ID } from "../../shared/constants.js";
import { explorerTxUrl } from "../chain/explorer.js";
import { accountSeed, Seal } from "../components/Seal.js";
import { Serial } from "../components/Serial.js";
import { TxLink } from "../components/TxLink.js";
import { short } from "../design/helpers.js";
import { clearEngrave, useEngrave, type EngraveState } from "../state/engrave.js";
import { useWallet } from "../state/wallet.js";

const TITLES: Record<EngraveState["phase"], [string, string]> = {
  running: ["Engraving", "your seal"],
  done: ["Your", "seal"],
  error: ["Engraving", "paused"],
  unavailable: ["Engraving", "unavailable"],
  offer: ["No account", "yet"],
};

export function Engrave() {
  const { config, go, finishOnboarding } = useWallet();
  const { job, state } = useEngrave();
  if (!job || !state) return null;

  const [titleA, titleB] = TITLES[state.phase];
  const back = () => {
    clearEngrave();
    go("genesis");
  };
  const proceed = () => {
    if (state.mode === "restore") {
      finishOnboarding();
      go("portfolio");
    } else {
      go("backup");
    }
  };
  const stake = state.stakeEth ?? "0.012";

  return (
    <section className="scr eng" aria-labelledby="eng-h">
      <div className="eng-copy">
        <h2 className="s-h" id="eng-h">
          {titleA} <em>{titleB}</em>
        </h2>
        {state.phase === "running" && (
          <p className="status mono" aria-live="polite">
            {state.status}
          </p>
        )}
        {state.phase === "error" && (
          <div className="eng-done">
            <p className="err mono" role="alert">
              {state.error}
            </p>
            <div className="row">
              <button className="btn" onClick={() => void job.retry()}>
                Try again
              </button>
              <button className="btn ghost" onClick={back}>
                Back
              </button>
            </div>
          </div>
        )}
        {state.phase === "unavailable" && (
          <div className="eng-done">
            <p className="err mono" role="alert">
              Operator not configured: this server has no operator key, so it cannot create accounts on devnet {CHAIN_ID}.
            </p>
            <p className="lede">
              {state.publicKey ? "Your key stays on this device: try again once the operator is configured. " : ""}A wallet
              whose account already exists can still be restored from its backup file.
            </p>
            <div className="row">
              <button className="btn" onClick={() => void job.retry()}>
                Try again
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  clearEngrave();
                  go("restore");
                }}
              >
                Restore
              </button>
              <button className="btn ghost" onClick={back}>
                Back
              </button>
            </div>
          </div>
        )}
        {state.phase === "offer" && (
          <div className="eng-done">
            <p className="lede">
              Your key is restored, but it has no account on devnet {CHAIN_ID} (the devnet may have been reset). The
              operator can create one for it and lock its {stake} ETH stake.
            </p>
            <div className="row">
              <button className="btn" onClick={() => void job.acceptCreate()}>
                Create account
              </button>
              <button className="btn ghost" onClick={back}>
                Back
              </button>
            </div>
          </div>
        )}
        {state.phase === "done" && (
          <div className="eng-done">
            <p className="lede">Drawn from your public key. You’ll see it every time you sign.</p>
            {state.txHash && config && (
              <div className="txline">
                <span className="lab">Account created · {stake} ETH staked by the operator</span>
                <TxLink href={explorerTxUrl(config, state.txHash)} label={`View transaction ${state.txHash} on the explorer`}>
                  {short(state.txHash)}
                </TxLink>
              </div>
            )}
            <div className="row">
              <button className="btn" onClick={proceed}>
                {state.mode === "restore" ? "Continue" : "Back up"}
              </button>
            </div>
          </div>
        )}
      </div>
      <figure className="fig">
        {state.publicKey ? (
          <Seal key={state.publicKey} seed={accountSeed(state.publicKey)} pk={state.publicKey} className="engr" />
        ) : (
          <div className="seal" aria-hidden="true" />
        )}
        {state.phase === "done" && state.account && <Serial address={state.account} />}
      </figure>
    </section>
  );
}
