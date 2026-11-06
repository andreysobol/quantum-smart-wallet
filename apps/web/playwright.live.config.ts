import { existsSync } from "node:fs";
import { chromium, defineConfig, devices } from "@playwright/test";

// Live end-to-end run against the shared devnet: real account creation, faucet mint and sponsored swaps.
// Opt-in only, because it spends operator ETH (0.012 ETH stake per account plus sponsored gas):
//   QSW_LIVE=1 npx playwright test -c playwright.live.config.ts             (local dev server, .env.local)
//   QSW_LIVE=1 QSW_LIVE_URL=https://<deployment> npx playwright test -c playwright.live.config.ts
const LOCAL_URL = "http://127.0.0.1:4175";
const target = process.env.QSW_LIVE_URL ?? LOCAL_URL;
const browser = existsSync(chromium.executablePath()) ? {} : { channel: "chrome" };

export default defineConfig({
  testDir: "e2e",
  testMatch: /live\.spec\.ts$/,
  timeout: 600_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], ...browser, baseURL: target, trace: "retain-on-failure" },
  webServer: process.env.QSW_LIVE_URL
    ? undefined
    : {
        // The /api dev plugin loads .env.local, which must hold the operator key.
        command: "npx vite --host 127.0.0.1 --port 4175 --strictPort",
        url: LOCAL_URL,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
