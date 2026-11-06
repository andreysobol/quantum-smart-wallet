import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const slhts = fileURLToPath(new URL("../../slhts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  server: {
    // The signer package is linked from the repository, outside this app root.
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url)), slhts] },
  },
  build: { target: "es2022", sourcemap: true },
});
