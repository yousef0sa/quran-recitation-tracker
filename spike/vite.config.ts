import { defineConfig, type Plugin } from "vite";
import { devHarness } from "./scripts/dev-harness";

// SharedArrayBuffer (onnxruntime-web WASM threads) needs a cross-origin isolated page. Every asset is same-origin.
// A middleware, not `server.headers`: Vite's send() answers an ETag match with a bare 304 before applying
// `server.headers` (vite config.js:22390-22398), and a cached page would then stay non-isolated.
function crossOriginIsolation(): Plugin {
  const set = (_req: unknown, res: { setHeader(name: string, value: string): unknown }, next: () => void) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    next();
  };
  return {
    name: "spike-cross-origin-isolation",
    configureServer(server) {
      server.middlewares.use(set);
    },
    configurePreviewServer(server) {
      server.middlewares.use(set);
    },
  };
}

export default defineConfig({
  // The harness is dev-server only (apply: "serve"): /__dev/ endpoints for spike/recordings and spike/results.
  // server.host is left unset on purpose (Vite default, localhost only).
  plugins: [crossOriginIsolation(), devHarness()],
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
