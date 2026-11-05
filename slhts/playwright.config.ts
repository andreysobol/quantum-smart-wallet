import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test",
  // SLH-DSA-128s signing takes seconds, more in WebAssembly.
  timeout: 120_000,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], headless: true } }],
});
