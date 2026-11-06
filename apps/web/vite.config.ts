import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { apiDevPlugin } from "./server/dev.js";

const slhts = fileURLToPath(new URL("../../slhts", import.meta.url));

// `vite preview` sends the production response headers from vercel.json (CSP and friends),
// so a local preview breaks the same way a deployment would.
type VercelHeaders = { headers?: { source: string; headers: { key: string; value: string }[] }[] };
const vercel = JSON.parse(readFileSync(new URL("./vercel.json", import.meta.url), "utf8")) as VercelHeaders;
const productionHeaders = Object.fromEntries(
  (vercel.headers?.find((rule) => rule.source === "/(.*)")?.headers ?? []).map(({ key, value }) => [key, value]),
);

export default defineConfig({
  plugins: [react(), apiDevPlugin()],
  worker: { format: "es" },
  server: {
    // The signer package is linked from the repository, outside this app root.
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url)), slhts] },
  },
  preview: { headers: productionHeaders },
  build: { target: "es2022", sourcemap: true },
});
