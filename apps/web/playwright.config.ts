import { existsSync, readdirSync } from "node:fs";
import { chromium, defineConfig, devices } from "@playwright/test";

const SIGNER_URL = "http://127.0.0.1:4174";
const APP_URL = "http://127.0.0.1:4173";

// Chromium only. Prefer Playwright's bundled build (`npx playwright install chromium`);
// without it, drive the locally installed Google Chrome instead of failing.
const browser = existsSync(chromium.executablePath()) ? {} : { channel: "chrome" };

// App specs (any e2e/*.spec.ts except signer.spec.ts) drive the Vite dev server with the /api dev plugin;
// start it only when such specs exist.
const hasAppSpecs = readdirSync(new URL("./e2e", import.meta.url)).some(
  (name) => name.endsWith(".spec.ts") && name !== "signer.spec.ts" && name !== "live.spec.ts",
);
// QSW_E2E_PREVIEW=1 runs them against the production build instead (vite preview sends vercel.json's headers).
const appServer = process.env.QSW_E2E_PREVIEW
  ? "npm run build && npx vite preview --host 127.0.0.1 --port 4173 --strictPort"
  : "npx vite --host 127.0.0.1 --port 4173 --strictPort";

export default defineConfig({
  testDir: "e2e",
  // SLH-DSA-SHA2-128s signing takes seconds in WebAssembly; PBKDF2 600k adds ~1 s per backup step.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    {
      name: "signer",
      testMatch: /signer\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], ...browser, baseURL: SIGNER_URL },
    },
    {
      name: "app",
      // live.spec.ts spends devnet funds: it runs only through playwright.live.config.ts.
      testIgnore: [/signer\.spec\.ts$/, /live\.spec\.ts$/],
      use: { ...devices["Desktop Chrome"], ...browser, baseURL: APP_URL },
    },
  ],
  webServer: [
    {
      // Always rebuild: a stale harness build would test old code.
      command: "npx vite build -c e2e/vite.signer.config.ts && npx vite preview -c e2e/vite.signer.config.ts",
      url: `${SIGNER_URL}/signer.html`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    ...(hasAppSpecs
      ? [
          {
            command: appServer,
            url: APP_URL,
            // Never reuse: the app specs need a server started without operator credentials.
            reuseExistingServer: false,
            timeout: 300_000,
            // Set (empty) so .env.local cannot supply them: the specs expect an operator-less server.
            env: { QSW_OPERATOR_PRIVATE_KEY: "", QSW_SPONSOR_PRIVATE_KEY: "" },
          },
        ]
      : []),
  ],
});
