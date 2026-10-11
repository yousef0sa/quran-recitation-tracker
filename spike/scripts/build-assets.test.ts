// A plain production build must not emit ORT's threaded .mjs (only a VITE_EXPERIMENT_PROD_THREADS=1 build does): builds the
// real app twice into a temp dir (no public/ copy) and lists the asset names.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function assetNames(flag: "1" | undefined): Promise<string[]> {
  const outDir = mkdtempSync(join(tmpdir(), "spike-build-"));
  const saved = process.env.VITE_EXPERIMENT_PROD_THREADS;
  if (flag === undefined) delete process.env.VITE_EXPERIMENT_PROD_THREADS;
  else process.env.VITE_EXPERIMENT_PROD_THREADS = flag;
  try {
    await build({ root: ROOT, configFile: join(ROOT, "vite.config.ts"), mode: "production", logLevel: "silent", publicDir: false, build: { outDir, emptyOutDir: true } });
    return readdirSync(join(outDir, "assets"));
  } finally {
    if (saved === undefined) delete process.env.VITE_EXPERIMENT_PROD_THREADS;
    else process.env.VITE_EXPERIMENT_PROD_THREADS = saved;
    rmSync(outDir, { recursive: true, force: true });
  }
}

describe("production build assets", () => {
  it("a plain build emits no threaded ORT .mjs; the flagged build does", async () => {
    const plain = await assetNames(undefined);
    expect(plain.filter((name) => /^ort-wasm-simd-threaded.*\.mjs$/.test(name))).toEqual([]);
    expect(plain.some((name) => /^ort-wasm-simd-threaded.*\.wasm$/.test(name))).toBe(true); // ORT's own wasm, as on main
    const flagged = await assetNames("1");
    expect(flagged.filter((name) => /^ort-wasm-simd-threaded.*\.mjs$/.test(name))).toHaveLength(1);
  }, 60_000);
});
