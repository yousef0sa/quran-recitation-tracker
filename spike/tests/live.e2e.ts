// index.html: the live mic page. getUserMedia is replaced in the page (fixtures.installFakeMic) by
// silence, a refusal, or one of your labelled recordings, so no real microphone is needed.
// Missing assets are simulated by answering the asset request with 404.
import { beforeEach, describe, test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  NO_ASSETS,
  blockDevWrites,
  captureBlobs,
  hasAssets,
  installFakeMic,
  labelledRecording,
  lastBlobJson,
  type FakeMic,
} from "./fixtures";

const WORDS = 29;
const START = "ابدأ";
const STOP = "أوقف";
const DOWNLOAD = "تنزيل السجل";
const MODEL_READY = 60_000; // WASM model load, cold cache

const words = (browser: Browser) => browser.locator("#words .word");
const matched = (browser: Browser) => browser.locator("#words .word.matched");

async function openLive(app: { open(path: string): Promise<void> }, browser: Browser, mic: FakeMic, query = "") {
  await browser.addInitScript(installFakeMic, mic);
  await app.open(`/index.html${query}`);
}

interface LiveLog {
  variant: string;
  chunkMs: number;
  entries: unknown[];
  meta: { source: string; backend: string; loadMs: number };
}

describe("live page", () => {
  beforeEach(async ({ browser }) => {
    await blockDevWrites(browser);
  });

  test("loads the model and unlocks Start", async ({ app, screen, browser }) => {
    test.skip(!hasAssets(), NO_ASSETS);
    await openLive(app, browser, { kind: "silence" });
    await expect(words(browser)).toHaveCount(WORDS);
    await expect(screen.getByRole("status")).toContainText("النموذج جاهز", { timeout: MODEL_READY });
    await expect(screen.getByRole("button", START)).toBeEnabled();
    await expect(screen.getByRole("button", STOP)).toBeDisabled();
    await expect(screen.getByRole("button", DOWNLOAD)).toBeDisabled();
    await expect(browser.locator("#stat-load")).toHaveText(/^\d+$/);
    await expect(browser.locator("#stat-backend")).toHaveText("A1 / WASM single-thread");
    await expect(screen.getByText("قد يخطئ التطبيق، ولا يغني أبداً عن الشيخ")).toBeVisible();
  });

  test("silence runs through the pipeline without highlighting any word", async ({ app, screen, browser }) => {
    test.skip(!hasAssets(), NO_ASSETS);
    await openLive(app, browser, { kind: "silence" });
    await expect(screen.getByRole("button", START)).toBeEnabled({ timeout: MODEL_READY });

    await screen.getByRole("button", START).tap();
    await expect(screen.getByRole("status")).toContainText("يستمع");
    await expect(screen.getByRole("button", STOP)).toBeEnabled();
    // Chunks reach the worker and come back with compute times.
    await expect(browser.locator("#stat-compute")).toHaveText(/\d/, { timeout: 15_000 });
    await expect(browser.locator("#stat-rtf")).toHaveText(/^\d+\.\d{3}$/);

    await screen.getByRole("button", STOP).tap();
    await expect(screen.getByRole("status")).toHaveText("تم الإيقاف.", { timeout: 15_000 });
    await expect(matched(browser)).toHaveCount(0);
    await expect(screen.getByRole("button", START)).toBeEnabled();
    await expect(screen.getByRole("button", DOWNLOAD)).toBeEnabled();

    await captureBlobs(browser);
    const file = await browser.waitForDownload(() => screen.getByRole("button", DOWNLOAD).tap());
    expect(file.suggestedFilename).toMatch(/^eventlog-A1-\d+\.json$/);
    const log = await lastBlobJson<LiveLog>(browser);
    expect(log.variant).toBe("A1");
    expect(log.chunkMs).toBe(150);
    expect(log.entries.length).toBeGreaterThan(1);
    expect(log.meta.source).toBe("live-mic");
    expect(log.meta.backend).toBe("WASM single-thread");
  });

  test("a refused microphone shows the reason and leaves Start usable", async ({ app, screen, browser }) => {
    test.skip(!hasAssets(), NO_ASSETS);
    await openLive(app, browser, { kind: "deny" });
    await expect(screen.getByRole("button", START)).toBeEnabled({ timeout: MODEL_READY });

    await screen.getByRole("button", START).tap();
    await expect(screen.getByRole("status")).toContainText("تم رفض إذن الميكروفون");
    await expect(browser).toHaveClass(screen.getByRole("status"), /\berror\b/);
    await expect(screen.getByRole("button", START)).toBeEnabled();
    await expect(screen.getByRole("button", STOP)).toBeDisabled();
  });

  test("?variant= picks the variant and the selector switches it", async ({ app, screen, browser }) => {
    await openLive(app, browser, { kind: "silence" }, "?variant=A2");
    await expect(browser.locator("#stat-backend")).toHaveText("A2 / WASM single-thread");
    await expect(browser.locator("#variant")).toHaveValue("A2");

    await browser.locator("#variant").selectOption({ value: "B1" });
    await expect(browser).toHaveURL(/\/index\.html\?variant=B1$/);
    await expect(browser.locator("#stat-backend")).toHaveText("B1 / WASM single-thread");
    await expect(screen.getByRole("button", START)).toBeDisabled();
  });

  test("a missing corpus tells you to run fetch-assets", async ({ app, screen, browser }) => {
    await browser.route("**/data/zipformer_quran.json", (route) => route.fulfill({ status: 404, body: "" }));
    await openLive(app, browser, { kind: "silence" });
    await expect(screen.getByRole("status")).toContainText("npm run fetch-assets");
    await expect(browser).toHaveClass(screen.getByRole("status"), /\berror\b/);
    await expect(screen.getByRole("button", START)).toBeDisabled();
  });

  test("a missing model reports a load error and keeps Start locked", async ({ app, screen, browser }) => {
    test.skip(!hasAssets(), NO_ASSETS);
    await browser.route("**/models/zipformer_a0w_ep1_a05.int8.onnx", (route) => route.fulfill({ status: 404, body: "" }));
    await openLive(app, browser, { kind: "silence" });
    await expect(screen.getByRole("status")).toContainText("(load)", { timeout: MODEL_READY });
    await expect(browser).toHaveClass(screen.getByRole("status"), /\berror\b/);
    await expect(screen.getByRole("button", START)).toBeDisabled();
  });

  // Local only: needs one of your recordings with <base>.labels.json in spike/recordings.
  // Real time (the whole recording plays), so it is the slowest test.
  test("a labelled recording played as the mic is tracked word by word", { timeout: 240_000 }, async ({ app, screen, browser }) => {
    const recording = labelledRecording();
    test.skip(!hasAssets() || recording === null, "needs assets and a labelled recording in spike/recordings");
    await browser.route("**/__e2e/recording", (route) => route.fulfill({ path: recording as string }));
    await openLive(app, browser, { kind: "file", url: "/__e2e/recording" });
    await expect(screen.getByRole("button", START)).toBeEnabled({ timeout: MODEL_READY });

    await screen.getByRole("button", START).tap();
    await expect(screen.getByRole("status")).toContainText("يستمع");
    await expect
      .poll(() => browser.evaluate(() => (window as unknown as { fakeMic: { ended: boolean } }).fakeMic.ended), {
        timeout: 180_000,
        interval: 1000,
      })
      .toBe(true);
    await screen.getByRole("button", STOP).tap();
    await expect(screen.getByRole("status")).toHaveText("تم الإيقاف.", { timeout: 15_000 });

    // A1 tracked 95% of words on the maintainer's recordings (RESULTS.md); the weakest file was 25/29.
    // 24 is a pipeline smoke threshold, not an accuracy measurement (bench.html does that).
    const count = await matched(browser).count();
    expect(count).toBeGreaterThanOrEqual(24);
    await expect(browser.locator("#stat-lag")).toHaveText(/\d/);
  });
});
