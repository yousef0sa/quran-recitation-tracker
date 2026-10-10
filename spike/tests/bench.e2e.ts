// bench.html: offline benchmark. Fed a generated silent WAV with generated labels, so the run is
// fast and its outcome is fixed: the pipeline completes and no word is confirmed.
// Accuracy on your own recordings is measured by the page itself, not asserted here.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import { NO_ASSETS, blockDevWrites, captureBlobs, hasAssets, labelsFile, lastBlobJson, silentWav } from "./fixtures";

const RUN = "شغّل";
const RESULTS = "تنزيل results.json";
const LOGS = "تنزيل السجلات (EventLog)";
const RUN_DONE = 90_000; // model load + feeding every chunk

const RECORDING = silentWav("tests/.generated/bench-silence.wav", 3);
const LABELS = labelsFile("tests/.generated/bench-silence.labels.json", "bench-silence.wav", 0.1);
const UNLABELLED = silentWav("tests/.generated/bench-unlabelled.wav", 1);
const BROKEN = "tests/.generated/broken.labels.json";
writeFileSync(resolve(BROKEN), JSON.stringify({ recording: "bench-unlabelled.wav", wordEnds: [0.1, 0.2, 0.3] }));

interface Results {
  variant: string;
  chunkMs: number;
  tailPaddingSec: number;
  error?: string;
  skipped: string[];
  files: { recording: string; labelsFrom: string; metrics: { confirmedWords: number; missedWords: number[] }; log?: unknown }[];
  aggregate: { files: number; totalWords: number; confirmedWords: number } | null;
}

async function choose(browser: Browser, recordings: string[], labels: string[]): Promise<void> {
  await browser.locator("#recordings").setInputFiles(recordings);
  await browser.locator("#labels").setInputFiles(labels);
}

describe("bench page", () => {
  beforeEach(async ({ app, browser }) => {
    await blockDevWrites(browser);
    await app.open("/bench.html");
  });

  test("starts with downloads locked and explains what to choose", async ({ screen, browser }) => {
    await expect(screen.getByRole("button", RUN)).toBeEnabled();
    await expect(screen.getByRole("button", RESULTS)).toBeDisabled();
    await expect(screen.getByRole("button", LOGS)).toBeDisabled();
    await expect(screen.getByRole("status")).toContainText("اختر التسجيلات وملفات تعليمها");
    // Defaults: variant B2, chunk 80 ms; the chunk options come from CHUNK_MS_OPTIONS in src/audio.ts.
    await expect(browser.locator("#variant")).toHaveValue("B2");
    await expect(browser.locator("#chunk")).toHaveValue("80");
    await expect(browser.locator("#chunk option")).toHaveCount(3);
  });

  test("Run without files asks for recordings and labels", async ({ screen, browser }) => {
    await screen.getByRole("button", RUN).tap();
    await expect(screen.getByRole("status")).toContainText("اختر تسجيلاً واحداً على الأقل");
    await expect(browser).toHaveClass(screen.getByRole("status"), /\berror\b/);
    await expect(screen.getByRole("button", RESULTS)).toBeDisabled();
  });

  test("a labelled recording runs to the end and its results download", async ({ screen, browser }) => {
    test.skip(!hasAssets(), NO_ASSETS);
    await choose(browser, [RECORDING], [LABELS]);
    await screen.getByRole("button", RUN).tap();
    await expect(screen.getByRole("status")).toHaveText("اكتمل: 1 ملف (B2، 80 ms).", { timeout: RUN_DONE });
    await expect(screen.getByRole("button", RUN)).toBeEnabled();
    await expect(screen.getByRole("button", RESULTS)).toBeEnabled();
    await expect(screen.getByRole("button", LOGS)).toBeEnabled();

    // Aggregate table + per-file table + per-word table (29 rows) inside <details>.
    await expect(browser.locator("#output table")).toHaveCount(3);
    await expect(browser.locator("#output details tbody tr")).toHaveCount(29);
    await expect(browser.locator("#output")).toContainText("bench-silence.wav");
    await expect(browser.locator("#output")).toContainText("0/29");

    await captureBlobs(browser);
    const file = await browser.waitForDownload(() => screen.getByRole("button", RESULTS).tap());
    expect(file.suggestedFilename).toBe("results-B2-80ms.json");
    const results = await lastBlobJson<Results>(browser);
    expect(results.variant).toBe("B2");
    expect(results.chunkMs).toBe(80);
    expect(results.tailPaddingSec).toBe(2);
    expect(results.error).toBeUndefined();
    expect(results.skipped).toEqual([]);
    expect(results.files).toHaveLength(1);
    const only = results.files[0]!;
    expect(only.recording).toBe("bench-silence.wav");
    expect(only.labelsFrom).toBe("bench-silence.labels.json");
    expect(only.metrics.confirmedWords).toBe(0); // silence confirms nothing
    expect(only.metrics.missedWords).toHaveLength(29);
    expect(only.log).toBeUndefined(); // logs go in the other download
    expect(results.aggregate).toMatchObject({ files: 1, totalWords: 29, confirmedWords: 0 });

    const logs = await browser.waitForDownload(() => screen.getByRole("button", LOGS).tap());
    expect(logs.suggestedFilename).toBe("eventlogs-B2-80ms.json");
    const eventlogs = await lastBlobJson<{ files: { recording: string; log: { entries: unknown[] } }[] }>(browser);
    expect(eventlogs.files).toHaveLength(1);
    expect(eventlogs.files[0]!.log.entries.length).toBeGreaterThan(1);
  });

  test("the variant and chunk size selectors drive the run", async ({ screen, browser }) => {
    test.skip(!hasAssets(), NO_ASSETS);
    await browser.locator("#variant").selectOption({ value: "A2" });
    await browser.locator("#chunk").selectOption({ value: "300" });
    await choose(browser, [RECORDING], [LABELS]);
    await screen.getByRole("button", RUN).tap();
    await expect(screen.getByRole("status")).toHaveText("اكتمل: 1 ملف (A2، 300 ms).", { timeout: RUN_DONE });

    await captureBlobs(browser);
    const file = await browser.waitForDownload(() => screen.getByRole("button", RESULTS).tap());
    expect(file.suggestedFilename).toBe("results-A2-300ms.json");
    const results = await lastBlobJson<Results>(browser);
    expect(results).toMatchObject({ variant: "A2", chunkMs: 300 });
  });

  test("invalid labels and unlabelled recordings are reported and skipped", async ({ screen, browser }) => {
    test.skip(!hasAssets(), NO_ASSETS);
    await choose(browser, [UNLABELLED], [BROKEN]);
    await screen.getByRole("button", RUN).tap();
    await expect(screen.getByRole("status")).toContainText("لم يُعالَج أي ملف", { timeout: RUN_DONE });
    await expect(browser).toHaveClass(screen.getByRole("status"), /\berror\b/);
    await expect(browser.locator("#output")).toContainText("ملف التعليم broken.labels.json غير صالح");
    await expect(browser.locator("#output")).toContainText("no labels for bench-unlabelled.wav");
    await expect(screen.getByRole("button", RESULTS)).toBeEnabled();
    await expect(screen.getByRole("button", LOGS)).toBeDisabled();
  });
});
