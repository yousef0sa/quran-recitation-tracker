import { defineConfig } from "vite";
import { devHarness } from "./scripts/dev-harness";

export default defineConfig({
  // Dev-server only (apply: "serve"): /__dev/ endpoints for spike/recordings and spike/results.
  // server.host is left unset on purpose (Vite default, localhost only).
  plugins: [devHarness()],
  server: { cors: false },
  worker: { format: "es" },
  // Pre-bundling breaks onnxruntime-web's wasm URL lookup.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  build: {
    rollupOptions: {
      // Relative to the project root (vite is run from spike/).
      input: ["index.html", "label.html", "bench.html"],
    },
  },
});
