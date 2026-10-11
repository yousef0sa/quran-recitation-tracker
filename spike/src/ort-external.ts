// Test-only (VITE_EXPERIMENT_PROD_THREADS=1 builds and dev server): load ORT's threaded .mjs and .wasm from their own asset
// URLs, so a production build can start pthread workers. Without the flag ORT loads exactly as before.
// The `?url` imports make Vite emit these files wherever this module is resolved, so vite.config.ts aliases this module to
// ort-external-off.ts unless the flag is set: a plain build never resolves this file and its asset list is unchanged.
import * as ort from "onnxruntime-web/wasm";

export async function useExternalOrtWasm(): Promise<void> {
  const [{ default: mjs }, { default: wasm }] = await Promise.all([
    import("onnxruntime-web/ort-wasm-simd-threaded.mjs?url"),
    import("onnxruntime-web/ort-wasm-simd-threaded.wasm?url"),
  ]);
  ort.env.wasm.wasmPaths = { mjs, wasm };
}
