import type { ReactNode } from "react";
import { Footer, Header, PaperFx } from "./components/Shell.js";
import { Backup } from "./screens/Backup.js";
import { Engrave } from "./screens/Engrave.js";
import { Exchange } from "./screens/Exchange.js";
import { Genesis } from "./screens/Genesis.js";
import { Portfolio } from "./screens/Portfolio.js";
import { Proof } from "./screens/Proof.js";
import { Restore } from "./screens/Restore.js";
import { useEngrave } from "./state/engrave.js";
import type { Screen } from "./state/types.js";
import { useWallet } from "./state/wallet.js";

/** Screens that need a wallet on this device; without one they fall back to Genesis. */
const WALLET_SCREENS: Record<Exclude<Screen, "genesis" | "engrave" | "restore">, () => ReactNode> = {
  backup: () => <Backup />,
  portfolio: () => <Portfolio />,
  exchange: () => <Exchange />,
  proof: () => <Proof />,
};

function CurrentScreen() {
  const { screen, wallet, booting } = useWallet();
  const { job } = useEngrave();
  if (booting) {
    return (
      <section className="scr narrow">
        <p className="status mono">Opening your wallet…</p>
      </section>
    );
  }
  if (screen === "restore") return <Restore />;
  if (screen === "engrave" && job) return <Engrave />;
  if (screen === "genesis" || screen === "engrave" || !wallet) return <Genesis />;
  return WALLET_SCREENS[screen]();
}

export function App() {
  return (
    <div className="qs">
      <PaperFx />
      <Header />
      <div className="strip" aria-hidden="true"></div>
      <main className="main">
        <CurrentScreen />
      </main>
      <Footer />
    </div>
  );
}
