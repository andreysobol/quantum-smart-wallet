import { Seal } from "../components/Seal.js";
import { specimenPk } from "../design/helpers.js";
import { useWallet } from "../state/wallet.js";

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
      </div>
      <figure className="fig">
        <Seal seed="specimen|slh-dsa" pk={specimenPk()} />
      </figure>
    </section>
  );
}
