// Owns onnxruntime-web and the tilawa session. All messages run through one promise chain so
// feed() calls (the session is stateful) never overlap. Never throws across the boundary:
// failures are posted as `{ type: "error" }`. Measurement data travels only in typed messages.
import * as ort from "onnxruntime-web/wasm";
import {
  DEFAULT_ZIPFORMER_IO,
  createZipformerSession,
  type CorrectionAction,
  type CorrectionState,
  type WorkerOutbound,
  type ZipformerSession,
} from "@tilawa/core";
import type { MainToWorker, WorkerToMain } from "./messages";
import { toGlobalWordIndex } from "./fatiha";
import { CORPUS_PATH, VARIANTS, applyIoOverride, type VariantId } from "./variants";

const scope = self as unknown as DedicatedWorkerGlobalScope;

const FETCH_HINT =
  "شغّل الأمر npm run fetch-assets داخل مجلد spike لتنزيل النموذج والقاموس / " +
  "Run `npm run fetch-assets` in spike/ to download the model and corpus.";
const WASM_HTML_HINT =
  "تم تقديم ملف wasm كصفحة HTML / onnxruntime-web got an HTML page instead of its .wasm file " +
  "(the wasm URL was served as HTML): check optimizeDeps.exclude and that the .wasm is served.";
/** Safety stop for the issue auto-resolve loop. */
const MAX_ISSUE_ROUNDS = 20;

class LoadError extends Error {}

let session: ZipformerSession | null = null;
let samplesFed = 0;
let notReadyReported = false;
let queue: Promise<void> = Promise.resolve();

function post(message: WorkerToMain): void {
  scope.postMessage(message);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function loadMessage(err: unknown): string {
  const message = describe(err);
  if (err instanceof LoadError) return message;
  if (/magic word|3c 21 44 4f/i.test(message)) return `${WASM_HTML_HINT} (${message})`;
  return message;
}

function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`;
}

async function fetchAsset(path: string): Promise<Response> {
  const url = assetUrl(path);
  const res = await fetch(url);
  if (!res.ok) throw new LoadError(`${url} -> HTTP ${res.status}. ${FETCH_HINT}`);
  if ((res.headers.get("content-type") ?? "").includes("text/html")) {
    throw new LoadError(`${url} returned an HTML page instead of the file. ${FETCH_HINT}`);
  }
  return res;
}

async function fetchModel(path: string): Promise<ArrayBuffer> {
  const bytes = await (await fetchAsset(path)).arrayBuffer();
  if (bytes.byteLength === 0) throw new LoadError(`${assetUrl(path)} is empty. ${FETCH_HINT}`);
  return bytes;
}

async function fetchJson(path: string): Promise<unknown> {
  const text = await (await fetchAsset(path)).text();
  if (text.trimStart().startsWith("<")) {
    throw new LoadError(`${assetUrl(path)} returned an HTML page instead of JSON. ${FETCH_HINT}`);
  }
  return JSON.parse(text);
}

async function initSession(variantId: VariantId): Promise<void> {
  const started = performance.now();
  session = null;
  samplesFed = 0;
  notReadyReported = false;
  const variant = VARIANTS[variantId];

  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;

  const [model, corpus] = await Promise.all([fetchModel(variant.modelPath), fetchJson(CORPUS_PATH)]);
  const created = await createZipformerSession({
    ort,
    model,
    corpus,
    stayOnSurah: true,
    structural: false,
    executionProviders: ["wasm"],
    ...(variant.io ? { io: applyIoOverride(DEFAULT_ZIPFORMER_IO, variant.io) } : {}),
  });
  if (variant.mode === "correction") {
    // setMode first: setExpected is ignored while the session is in tracking mode.
    created.setMode("correction");
    if (variant.expected) created.setExpected(variant.expected);
  }
  session = created;
  console.info("[spike] model ready", { variant: variantId });
  post({ type: "ready", loadMs: performance.now() - started, variant: variantId });
}

/** The latest correction state in `events` if it leaves an issue open (feed() then returns [] until resolved). */
function openCorrection(events: WorkerOutbound[]): CorrectionState | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "correction") {
      const { phase } = event.state;
      return phase === "error" || phase === "corrected" ? event.state : null;
    }
  }
  return null;
}

/**
 * Correction mode: log each open issue to the main thread and close it so feeding continues.
 * `continue` only works from the "corrected" phase; a fresh issue is in "error", where only
 * dismiss / review_later / close move it back to idle.
 */
function resolveIssues(active: ZipformerSession, events: WorkerOutbound[], chunkId: number): WorkerOutbound[] {
  const all = [...events];
  let latest = events;
  for (let round = 0; round < MAX_ISSUE_ROUNDS; round++) {
    const state = openCorrection(latest);
    if (!state) break;
    post({ type: "issue", issue: state.issue, chunkId, samplesFed });
    const action: CorrectionAction = state.phase === "corrected" ? "continue" : "dismiss";
    latest = active.correct(action);
    all.push(...latest);
  }
  return all;
}

/**
 * Surah-1 words whose current verdict is "ok" or "unsure", as global Fatiha indices.
 * WordVerdict.word is the 0-based index within the ayah (wordIndex would be the whole-Quran index).
 * Timed separately from feed() so it never inflates computeMs.
 */
function snapshotConfirmed(active: ZipformerSession): { confirmed: number[]; verdictsMs: number } {
  const started = performance.now();
  const confirmed: number[] = [];
  for (const verdict of active.verdicts()) {
    if (verdict.surah !== 1 || (verdict.state !== "ok" && verdict.state !== "unsure")) continue;
    try {
      confirmed.push(toGlobalWordIndex(verdict.ayah, verdict.word));
    } catch {
      // outside Al-Fatiha's word table: ignore
    }
  }
  confirmed.sort((a, b) => a - b);
  return { confirmed, verdictsMs: performance.now() - started };
}

async function handleAudio(chunkId: number, samples: Float32Array): Promise<void> {
  if (!session) {
    if (!notReadyReported) {
      notReadyReported = true;
      post({ type: "error", stage: "feed", message: "النموذج غير جاهز / model is not loaded" });
    }
    return;
  }
  const started = performance.now();
  const events = await session.feed(samples);
  const computeMs = performance.now() - started;
  samplesFed += samples.length;
  const resolved = resolveIssues(session, events, chunkId);
  const { confirmed, verdictsMs } = snapshotConfirmed(session);
  post({ type: "events", chunkId, samplesFed, computeMs, verdictsMs, confirmed, events: resolved });
}

async function handleStop(): Promise<void> {
  if (!session) {
    post({ type: "error", stage: "stop", message: "النموذج غير جاهز / model is not loaded" });
    return;
  }
  const started = performance.now();
  const events = await session.stop();
  const computeMs = performance.now() - started;
  const resolved = resolveIssues(session, events, -1);
  const { confirmed, verdictsMs } = snapshotConfirmed(session);
  post({ type: "stopped", samplesFed, computeMs, verdictsMs, confirmed, events: resolved });
}

function handle(message: MainToWorker): Promise<void> {
  switch (message.type) {
    case "init":
      return initSession(message.variant).catch((err: unknown) => {
        session = null;
        post({ type: "error", stage: "load", message: loadMessage(err) });
      });
    case "audio":
      return handleAudio(message.chunkId, message.samples).catch((err: unknown) => {
        post({ type: "error", stage: "feed", message: describe(err) });
      });
    case "stop":
      return handleStop().catch((err: unknown) => {
        post({ type: "error", stage: "stop", message: describe(err) });
      });
    case "reset":
      try {
        session?.reset();
        samplesFed = 0;
        post({ type: "resetDone" });
      } catch (err) {
        post({ type: "error", stage: "feed", message: describe(err) });
      }
      return Promise.resolve();
  }
}

scope.onmessage = (event: MessageEvent<MainToWorker>) => {
  queue = queue.then(() => handle(event.data)).catch((err: unknown) => console.error("[spike] worker queue", err));
};
