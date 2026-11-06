import "./design/fonts.css";
import "./design/design.css";
import "./design/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { WalletProvider } from "./state/wallet.js";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <WalletProvider>
      <App />
    </WalletProvider>
  </StrictMode>,
);
