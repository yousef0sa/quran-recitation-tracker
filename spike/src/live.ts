// Live mic page: words highlight as you recite; stats on screen; EventLog downloadable.
// `?variant=` picks the variant (default B2) and `?chunk=` the audio chunk size (default 80 ms; see src/audio.ts),
// `?threads=` the WASM thread count (default 4 on a phone, else 1; see src/wasm-threads.ts).
import { startMic, parseChunkMs, MicError, TARGET_RATE, type MicHandle } from "./audio";
import {
  downloadJson,
  el,
  errorMessage,
  fetchDisplayWords,
  formatMs,
  initVariantSelect,
  makeStatus,
  renderWords,
} from "./common";
import type { WorkerToMain } from "./messages";
import { entryFromEvents, flushEntryFromStopped, summarize, type EventLog } from "./metrics";
import { INITIAL_PROGRESS, updateProgress, type ProgressState } from "./progress";
import { TrackerClient } from "./tracker-client";
import { backendLabel, requestThreads } from "./wasm-threads";

const query = new URLSearchParams(location.search);
const chunkMs = parseChunkMs(query.get("chunk"));
const requestedThreads = requestThreads(query.get("threads"), navigator.userAgent, import.meta.env.DEV);

const variantSelect = el<HTMLSelectElement>("variant");
const variantId = initVariantSelect(variantSelect);
const startButton = el<HTMLButtonElement>("start");
const stopButton = el<HTMLButtonElement>("stop");
const downloadButton = el<HTMLButtonElement>("download");
const statusLine = el<HTMLDivElement>("status");
const wordsBox = el<HTMLDivElement>("words");

let wordNodes: HTMLSpanElement[] = [];
let progress: ProgressState = INITIAL_PROGRESS;
let mic: MicHandle | null = null;
let ready = false;
let running = false;
let chunkId = 0;
/** Incremented by every resetSession(); late callbacks from an older session compare against it and bail out. */
let epoch = 0;
/** True between the Stop click and the worker's "stopped" (or an error): Start, the variant select and Download stay disabled. */
let stopping = false;
let loadMs: number | null = null;
/** Effective WASM threads and isolation, known after `ready`; the label shows the requested count until then. */
let threads: number | null = null;
let isolated: boolean | null = null;
let log: EventLog = { variant: variantId, chunkMs, entries: [] };
const arrival = new Map<number, number>();
const computeValues: number[] = [];
const lagValues: number[] = [];
let computeSum = 0;
let audioSec = 0;

const setStatus = makeStatus(statusLine);

function paintProgress(): void {
  wordNodes.forEach((node, index) => {
    node.classList.toggle("matched", progress.matched.has(index));
    node.classList.toggle("cursor", progress.cursor === index);
  });
}

function renderStats(): void {
  const compute = summarize(computeValues);
  const lag = summarize(lagValues);
  el("stat-load").textContent = formatMs(loadMs);
  el("stat-compute").textContent = compute ? `${formatMs(compute.p50, 1)} / ${formatMs(compute.p95, 1)}` : "-";
  el("stat-rtf").textContent = audioSec > 0 ? (computeSum / (audioSec * 1000)).toFixed(3) : "-";
  el("stat-lag").textContent = lag ? `${formatMs(lag.p50)} / ${formatMs(lag.p95)}` : "-";
  el("stat-backend").textContent = `${variantId} / ${chunkMs} ms / ${backendLabel(threads ?? requestedThreads)}`;
}

function onEvents(message: Extract<WorkerToMain, { type: "events" }>): void {
  // Every chunk is registered in `arrival` when posted and `arrival` is cleared on reset, so an
  // unknown id is a late result from an older session.
  const arrivedAt = arrival.get(message.chunkId);
  if (arrivedAt === undefined) return;
  const entry = entryFromEvents(message);
  log.entries.push(entry);
  computeValues.push(message.computeMs);
  computeSum += message.computeMs;
  audioSec = entry.audioTimeSec;

  const update = updateProgress(progress, message.events, message.confirmed);
  progress = update.state;
  if (update.changed) {
    paintProgress();
    // Lag = paint time - arrival time of the chunk from the worklet (excludes speech-to-chunk buffering).
    const sessionEpoch = epoch;
    requestAnimationFrame(() => {
      if (sessionEpoch !== epoch) return; // the session was reset meanwhile
      lagValues.push(performance.now() - arrivedAt);
      renderStats();
    });
  }
  arrival.delete(message.chunkId);
  renderStats();
}

/** The worker answered the Stop (stopped or error): the log is complete, controls come back. */
function finishStop(): void {
  stopping = false;
  startButton.disabled = false;
  variantSelect.disabled = false;
  downloadButton.disabled = false;
}

const tracker = new TrackerClient((message) => {
  switch (message.type) {
    case "ready":
      ready = true;
      loadMs = message.loadMs;
      threads = message.threads;
      isolated = message.crossOriginIsolated;
      setStatus(`النموذج جاهز (${message.loadMs.toFixed(0)} ms). اضغط «ابدأ» وابدأ التلاوة.`);
      startButton.disabled = false;
      renderStats();
      break;
    case "events":
      onEvents(message);
      break;
    case "stopped":
      if (!stopping) break; // late result of an older session
      log.entries.push(flushEntryFromStopped(message));
      progress = updateProgress(progress, message.events, message.confirmed).state;
      paintProgress();
      finishStop();
      setStatus("تم الإيقاف.");
      break;
    case "issue":
      // Correction variants (A2/B2): a correction issue was opened and auto-closed; it is kept in the log events.
      break;
    case "error":
      console.error("[spike] worker error", message.stage, message.message);
      setStatus(`خطأ (${message.stage}): ${message.message}`, true);
      if (message.stage === "load") startButton.disabled = true;
      else if (stopping) finishStop();
      break;
  }
});

function resetSession(): void {
  epoch++;
  tracker.post({ type: "reset" });
  progress = INITIAL_PROGRESS;
  paintProgress();
  log = { variant: variantId, chunkMs, entries: [] };
  arrival.clear();
  computeValues.length = 0;
  lagValues.length = 0;
  computeSum = 0;
  audioSec = 0;
  chunkId = 0;
  renderStats();
}

startButton.addEventListener("click", () => {
  if (!ready || running) return;
  running = true;
  startButton.disabled = true;
  variantSelect.disabled = true;
  downloadButton.disabled = true;
  resetSession();
  setStatus("جارٍ تشغيل الميكروفون…");
  // startMic creates the AudioContext here, inside the click handler (autoplay policy).
  startMic((samples, arrivalMs) => {
    const id = chunkId++;
    arrival.set(id, arrivalMs);
    tracker.post({ type: "audio", chunkId: id, samples }, [samples.buffer]);
  }, chunkMs)
    .then((handle) => {
      mic = handle;
      stopButton.disabled = false;
      setStatus(
        handle.contextRate === TARGET_RATE
          ? "يستمع… ابدأ التلاوة."
          : `يستمع… (معدل الجهاز ${handle.contextRate} Hz، يُعاد التقطيع إلى 16000)`,
      );
    })
    .catch((err: unknown) => {
      running = false;
      startButton.disabled = false;
      variantSelect.disabled = false;
      const text = err instanceof MicError ? err.message : String(err);
      console.error("[spike] mic error", text);
      setStatus(text, true);
    });
});

stopButton.addEventListener("click", () => {
  if (!running) return;
  mic?.stop();
  mic = null;
  running = false;
  stopping = true;
  stopButton.disabled = true;
  setStatus("جارٍ إنهاء التحليل…");
  tracker.post({ type: "stop" });
});

downloadButton.addEventListener("click", () => {
  downloadJson(`eventlog-${variantId}-${Date.now()}.json`, {
    ...log,
    meta: {
      userAgent: navigator.userAgent,
      backend: backendLabel(threads ?? requestedThreads),
      requestedThreads,
      threads,
      crossOriginIsolated: isolated,
      loadMs,
      source: "live-mic",
    },
  });
});

variantSelect.addEventListener("change", () => {
  // Keep the other query params (e.g. ?chunk=, ?threads=); only the variant changes.
  const params = new URLSearchParams(location.search);
  params.set("variant", variantSelect.value);
  location.search = `?${params}`;
});

renderStats();
fetchDisplayWords()
  .then((words) => {
    wordNodes = renderWords(wordsBox, words);
    setStatus("جارٍ تحميل النموذج…");
    tracker.post({ type: "init", variant: variantId, threads: requestedThreads });
  })
  .catch((err: unknown) => {
    const text = errorMessage(err);
    console.error("[spike] corpus error", text);
    setStatus(text, true);
  });
