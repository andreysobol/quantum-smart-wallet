import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/**
 * Test-only production build of e2e/fixtures/signer.html: the real src/crypto signer and
 * worker bundled exactly as in the app, plus a harness that records worker messages.
 */
export default defineConfig({
  root: path("./fixtures"),
  worker: { format: "es" },
  server: { fs: { allow: [path(".."), path("../../../slhts")] } },
  build: {
    target: "es2022",
    outDir: path("../node_modules/.qsw-e2e-signer"),
    emptyOutDir: true,
    rolldownOptions: { input: path("./fixtures/signer.html") },
  },
  preview: { host: "127.0.0.1", port: 4174, strictPort: true },
});
