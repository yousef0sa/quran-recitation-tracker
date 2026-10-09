// label.html: tap labelling of the 29 word ends. Deterministic: a generated silent WAV is loaded,
// the audio is seeked to exact times in the page, then Space / Backspace are pressed.
// Words are checked by position and class only (matched / target), never by their text.
import { beforeEach, describe, test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import { blockDevWrites, captureBlobs, lastBlobJson, silentWav } from "./fixtures";

const WORDS = 29;
const RECORDING = silentWav("tests/.generated/silence.wav", 20);
const SECOND_RECORDING = silentWav("tests/.generated/silence-2.wav", 5);

const PLAY = "تشغيل / إيقاف مؤقت";
const UNDO = "تراجع (Backspace)";
const DOWNLOAD = "تنزيل labels.json";

const words = (browser: Browser) => browser.locator("#words .word");
const matched = (browser: Browser) => browser.locator("#words .word.matched");

async function loadRecording(browser: Browser, path = RECORDING): Promise<void> {
  await browser.locator("#file").setInputFiles([path]);
  await expect
    .poll(() => browser.evaluate(() => (document.getElementById("audio") as HTMLAudioElement).readyState))
    .toBeGreaterThanOrEqual(1); // HAVE_METADATA: seeking works from here
}

/** Seeks the paused audio to `seconds`, then presses Space to mark the current word's end there. */
async function markAt(browser: Browser, seconds: number): Promise<void> {
  const now = await browser.evaluate((t: number) => {
    const audio = document.getElementById("audio") as HTMLAudioElement;
    audio.currentTime = t;
    return audio.currentTime;
  }, seconds);
  expect(now).toBeCloseTo(seconds, 3);
  await browser.keyboard.press("Space");
}

describe("label page", () => {
  beforeEach(async ({ app, browser }) => {
    await blockDevWrites(browser);
    await app.open("/label.html");
    await expect(words(browser)).toHaveCount(WORDS);
  });

  test("starts with every control locked until a recording is chosen", async ({ screen, browser }) => {
    await expect(screen.getByRole("button", PLAY)).toBeDisabled();
    await expect(screen.getByRole("button", UNDO)).toBeDisabled();
    await expect(screen.getByRole("button", DOWNLOAD)).toBeDisabled();
    await expect(screen.getByRole("status")).toContainText("اختر ملف تسجيل");
    await expect(matched(browser)).toHaveCount(0);

    // Space before a recording is loaded marks nothing.
    await browser.keyboard.press("Space");
    await expect(matched(browser)).toHaveCount(0);
  });

  test("loading a recording targets word 1 and enables play", async ({ screen, browser }) => {
    await loadRecording(browser);
    await expect(screen.getByRole("button", PLAY)).toBeEnabled();
    await expect(screen.getByRole("button", UNDO)).toBeDisabled();
    await expect(screen.getByRole("status")).toContainText(`الكلمة 1 من ${WORDS}`);
    await expect(browser).toHaveClass(words(browser).nth(0), /\btarget\b/);
  });

  test("Space marks the current word at the playback time and moves on", async ({ screen, browser }) => {
    await loadRecording(browser);
    await markAt(browser, 0.5);

    await expect(matched(browser)).toHaveCount(1);
    await expect(browser).toHaveClass(words(browser).nth(0), /\bmatched\b/);
    await expect(browser).toHaveClass(words(browser).nth(1), /\btarget\b/);
    await expect(browser.locator("#marks")).toHaveText("1: 0.500s");
    await expect(screen.getByRole("status")).toContainText(`الكلمة 2 من ${WORDS}`);
    await expect(screen.getByRole("button", UNDO)).toBeEnabled();
  });

  test("a mark that is not after the previous one is refused", async ({ screen, browser }) => {
    await loadRecording(browser);
    await markAt(browser, 0.5);
    await markAt(browser, 0.25);

    await expect(matched(browser)).toHaveCount(1);
    await expect(browser).toHaveClass(screen.getByRole("status"), /\berror\b/);
    await expect(screen.getByRole("status")).toContainText("ليس بعد العلامة السابقة");
    await expect(browser.locator("#marks")).toHaveText("1: 0.500s");
  });

  test("Backspace and the undo button each remove the last mark", async ({ screen, browser }) => {
    await loadRecording(browser);
    await markAt(browser, 0.5);
    await markAt(browser, 1);
    await expect(matched(browser)).toHaveCount(2);

    await browser.keyboard.press("Backspace");
    await expect(matched(browser)).toHaveCount(1);
    await expect(browser).toHaveClass(words(browser).nth(1), /\btarget\b/);

    await screen.getByRole("button", UNDO).tap();
    await expect(matched(browser)).toHaveCount(0);
    await expect(browser).toHaveClass(words(browser).nth(0), /\btarget\b/);
    await expect(screen.getByRole("button", UNDO)).toBeDisabled();
    await expect(browser.locator("#marks")).toHaveText("");
  });

  test("29 marks unlock the download of a valid labels file", async ({ screen, browser }) => {
    await loadRecording(browser);
    const times = Array.from({ length: WORDS }, (_, i) => 0.5 * (i + 1));
    for (const t of times.slice(0, -1)) await markAt(browser, t);
    await expect(screen.getByRole("button", DOWNLOAD)).toBeDisabled();

    await markAt(browser, times[WORDS - 1] as number);
    await expect(matched(browser)).toHaveCount(WORDS);
    await expect(screen.getByRole("button", DOWNLOAD)).toBeEnabled();
    await expect(screen.getByRole("status")).toContainText("اكتملت");

    // A 30th Space is ignored.
    await markAt(browser, 19);
    await expect(matched(browser)).toHaveCount(WORDS);

    await captureBlobs(browser);
    const file = await browser.waitForDownload(() => screen.getByRole("button", DOWNLOAD).tap());
    expect(file.suggestedFilename).toBe("silence.labels.json");
    const labels = await lastBlobJson<{ recording: string; wordEnds: number[]; notes: string }>(browser);
    expect(labels.recording).toBe("silence.wav");
    expect(labels.wordEnds).toHaveLength(WORDS);
    labels.wordEnds.forEach((t, i) => expect(t).toBeCloseTo(times[i] as number, 3));
    expect(labels.notes).toContain("0.50x");
    await expect(screen.getByRole("status")).toContainText("تم تنزيل silence.labels.json");
  });

  test("the rate selector sets the playback rate", async ({ browser }) => {
    await loadRecording(browser);
    const rate = () => browser.evaluate(() => (document.getElementById("audio") as HTMLAudioElement).playbackRate);
    expect(await rate()).toBe(0.5);
    await browser.locator("#rate").selectOption({ value: "1" });
    await expect.poll(rate).toBe(1);
  });

  test("loading another recording clears the marks", async ({ screen, browser }) => {
    await loadRecording(browser);
    await markAt(browser, 0.5);
    await markAt(browser, 1);
    await expect(matched(browser)).toHaveCount(2);

    // A different file: picking the same file again fires no change event.
    await loadRecording(browser, SECOND_RECORDING);
    await expect(matched(browser)).toHaveCount(0);
    await expect(screen.getByRole("status")).toContainText(`الكلمة 1 من ${WORDS}`);
  });
});
