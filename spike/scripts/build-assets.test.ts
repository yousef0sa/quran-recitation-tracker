// A production build must emit ORT's threaded .mjs and .wasm (the worker loads them via wasmPaths, needed for threads):
// builds the real app into a temp dir (no public/ copy) and lists the asset names.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function assetNames(): Promise<string[]> {
  const outDir = mkdtempSync(join(tmpdir(), "spike-build-"));
  try {
    await build({ root: ROOT, configFile: join(ROOT, "vite.config.ts"), mode: "production", logLevel: "silent", publicDir: false, build: { outDir, emptyOutDir: true } });
    return readdirSync(join(outDir, "assets"));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

describe("production build assets", () => {
  it("emits ORT's threaded .mjs and .wasm", async () => {
    const assets = await assetNames();
    expect(assets.filter((name) => /^ort-wasm-simd-threaded.*\.mjs$/.test(name))).toHaveLength(1);
    expect(assets.filter((name) => /^ort-wasm-simd-threaded.*\.wasm$/.test(name))).toHaveLength(1);
  }, 60_000);
});
