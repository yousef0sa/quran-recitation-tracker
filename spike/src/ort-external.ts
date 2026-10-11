// Production builds (tracker.worker.ts): load ORT's threaded .mjs and .wasm from their own asset URLs, so pthread workers
// can start. The `?url` imports make Vite emit these files. The dev server keeps ORT's default loading.
import * as ort from "onnxruntime-web/wasm";

export async function useExternalOrtWasm(): Promise<void> {
  const [{ default: mjs }, { default: wasm }] = await Promise.all([
    import("onnxruntime-web/ort-wasm-simd-threaded.mjs?url"),
    import("onnxruntime-web/ort-wasm-simd-threaded.wasm?url"),
  ]);
  ort.env.wasm.wasmPaths = { mjs, wasm };
}
