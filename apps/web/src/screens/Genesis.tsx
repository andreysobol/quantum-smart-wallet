import { Seal } from "../components/Seal.js";
import { short, specimenPk } from "../design/helpers.js";
import { useWallet, type PendingReplace } from "../state/wallet.js";

export function Genesis() {
  const { createWallet, go } = useWallet();
  return (
    <section className="scr gen" aria-labelledby="gen-h">
      <div className="gen-copy">
        <h1 className="gen-h" id="gen-h">
          <span>Nothing but</span> <em>hashes.</em>
        </h1>
        <p className="lede">A post-quantum Ethereum wallet. Signed with SLH-DSA, verified by your own EIP-8141 account.</p>
        <div className="row">
          <button className="btn" onClick={createWallet}>
            Create wallet
          </button>
          <button className="btn ghost" onClick={() => go("restore")}>
            Restore
          </button>
        </div>
        <ReplaceWallet action="create" />
      </div>
      <figure className="fig">
        <Seal seed="specimen|slh-dsa" pk={specimenPk()} />
      </figure>
    </section>
  );
}

/**
 * Inline confirmation before Create, Restore or a finished engraving replaces the different wallet this
 * device holds (one wallet record per device). Rendered by the screen that asked; "Replace it" is the
 * explicit second action, and the replaced wallet's encrypted key stays in the browser's key store.
 */
export function ReplaceWallet({ action }: { action: PendingReplace["action"] }) {
  const { replacing, confirmReplace, keepWallet } = useWallet();
  if (replacing?.action !== action) return null;
  const { current } = replacing;
  return (
    <div className="eng-done" role="group" aria-labelledby="rpl-h">
      <p className="lab" id="rpl-h">
        {action === "save" ? "Another tab saved a wallet on this device" : "This device already holds a wallet"}
      </p>
      <p className="lede">
        Account <span className="mono">{short(current.account)}</span> is {current.backedUp ? "backed up" : "not backed up"}.{" "}
        {current.backedUp
          ? "Replacing it keeps its encrypted key in this browser; restore its backup file to use it again."
          : "Replacing it keeps its encrypted key in this browser, but the app will no longer open it: without a backup file you lose access to its funds."}
      </p>
      <div className="row">
        <button type="button" className="btn" onClick={keepWallet} autoFocus>
          Keep it
        </button>
        <button type="button" className="link warn" onClick={confirmReplace}>
          Replace it
        </button>
      </div>
    </div>
  );
}
