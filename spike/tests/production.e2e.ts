// The production build of index.html, served by `vite preview` on 127.0.0.1 (the other e2e tests use the dev server).
// Guards the threaded ORT loading of src/ort-external.ts: a build that loads ORT's default files starts no pthread
// workers and the model never gets ready (the hang), or runs on 1 thread. The build goes to a temp dir with the
// default model and the corpus copied in (no other model, no recordings); the dev harness is not part of a build.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import { build, preview, type PreviewServer } from "vite";
import { NO_ASSETS, blockDevWrites, installFakeMic } from "./fixtures";

const MODEL_READY = 60_000; // WASM model load, cold cache
const ASSETS = ["audio-processor.js", "data/zipformer_quran.json", "models/zipformer_p_arabic_v3_c16.int8.onnx"];

// Only this suite's own files: fixtures' hasAssets() also needs the a0w model, which the production build does not use.
function hasProductionAssets(): boolean {
  return ASSETS.every((asset) => existsSync(resolve("public", asset)));
}

let outDir = "";
let isolated: PreviewServer | undefined; // the project's vite.config.ts: COOP/COEP headers
let plain: PreviewServer | undefined; // no config: the same files without the isolation headers

function origin(server: PreviewServer): string {
  const url = server.resolvedUrls?.local[0];
  if (!url?.startsWith("http://127.0.0.1:")) throw new Error(`preview is not on loopback: ${url}`);
  return url;
}

describe("production build", () => {
  beforeAll(async () => {
    if (!hasProductionAssets()) return;
    outDir = mkdtempSync(join(tmpdir(), "spike-prod-"));
    await build({ root: resolve("."), configFile: resolve("vite.config.ts"), mode: "production", logLevel: "silent", publicDir: false, build: { outDir, emptyOutDir: true } });
    for (const asset of ASSETS) {
      mkdirSync(join(outDir, asset, ".."), { recursive: true });
      copyFileSync(resolve("public", asset), join(outDir, asset));
    }
    const server = { host: "127.0.0.1", port: 0, strictPort: false };
    isolated = await preview({ root: resolve("."), configFile: resolve("vite.config.ts"), logLevel: "silent", build: { outDir }, preview: server });
    plain = await preview({ root: resolve("."), configFile: false, logLevel: "silent", build: { outDir }, preview: server });
  });

  beforeEach(async ({ browser }) => {
    await blockDevWrites(browser);
  });

  afterAll(async () => {
    await isolated?.close();
    await plain?.close();
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  async function open(browser: Browser, server: PreviewServer | undefined, query: string): Promise<void> {
    if (!server) throw new Error("preview server is not running");
    await browser.addInitScript(installFakeMic, { kind: "silence" });
    await browser.goto(`${origin(server)}index.html${query}`);
  }

  test("?threads=4 runs the model on 4 threads", async ({ screen, browser }) => {
    test.skip(!hasProductionAssets(), NO_ASSETS);
    await open(browser, isolated, "?threads=4");
    // A build that cannot start its pthread workers never gets here.
    await expect(screen.getByRole("status")).toContainText("النموذج جاهز", { timeout: MODEL_READY });
    expect(await browser.evaluate(() => self.crossOriginIsolated)).toBe(true);
    // After ready the label shows the effective count (what ORT really uses), not the requested one.
    await expect(browser.locator("#stat-backend")).toHaveText("B2 / 80 ms / WASM 4 threads");
  });

  test("without cross-origin isolation ?threads=4 falls back to 1 thread and still gets ready", async ({ screen, browser }) => {
    test.skip(!hasProductionAssets(), NO_ASSETS);
    await open(browser, plain, "?threads=4");
    await expect(screen.getByRole("status")).toContainText("النموذج جاهز", { timeout: MODEL_READY });
    expect(await browser.evaluate(() => self.crossOriginIsolated)).toBe(false);
    await expect(browser.locator("#stat-backend")).toHaveText("B2 / 80 ms / WASM single-thread");
  });
});
