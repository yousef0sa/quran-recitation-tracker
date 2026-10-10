// Offline benchmark: feeds your recordings to the worker in fixed chunks, builds an
// EventLog per file and computes latency / accuracy metrics against the labels.
import {
  CHUNK_MS_OPTIONS,
  DEFAULT_CHUNK_MS,
  TARGET_RATE,
  chunkSamplesForMs,
  decodeFileTo16kMono,
  splitIntoChunks,
} from "./audio";
import {
  baseName,
  downloadJson,
  el,
  errorMessage,
  fetchDisplayWords,
  formatMs,
  initVariantSelect,
  makeStatus,
} from "./common";
import { engineOverrideFrom, parseSettleFrames, type EngineOverride } from "./engine-config";
import { WORD_COUNT } from "./fatiha";
import { parseLabels, type Labels } from "./labels";
import {
  aggregateMetrics,
  computeMetrics,
  entryFromEvents,
  flushEntryFromStopped,
  type Aggregate,
  type EventLog,
  type EventLogEntry,
  type Metrics,
  type Stats,
} from "./metrics";
import { TrackerClient } from "./tracker-client";
import { parseVariantId, type VariantId } from "./variants";
import { backendLabel, requestThreads, threadsStatusPart, type Threads } from "./wasm-threads";

/** Seconds of zeros fed as ordinary chunks before stop(), so the last word's confirmation has a precise timestamp. */
const TAIL_PADDING_SEC = 2.0;
const FLUSH_NOTE = "flush entry, after +2 s tail inside stop()";

interface IssueRecord {
  chunkId: number;
  samplesFed: number;
  issue: unknown;
}

interface FileResult {
  recording: string;
  labelsFrom: string;
  durationSec: number;
  paddedDurationSec: number;
  metrics: Metrics;
  issues: IssueRecord[];
  log: EventLog;
}

interface RunResult {
  generatedAt: string;
  variant: VariantId;
  chunkMs: number;
  /** Tilawa engine override applied to the session (from `?settle=`); {} = tilawa defaults. */
  engineConfig: EngineOverride;
  backend: string;
  /** WASM threads asked for (`?threads=`), what the worker really used (null until `ready`), and whether the page was cross-origin isolated. */
  requestedThreads: Threads;
  threads: number | null;
  crossOriginIsolated: boolean | null;
  userAgent: string;
  hardwareConcurrency: number;
  tailPaddingSec: number;
  flushNote: string;
  loadMs: number | null;
  error?: string;
  skipped: string[];
  files: FileResult[];
  aggregate: Aggregate | null;
}

const recordingsInput = el<HTMLInputElement>("recordings");
const labelsInput = el<HTMLInputElement>("labels");
const variantSelect = el<HTMLSelectElement>("variant");
const chunkSelect = el<HTMLSelectElement>("chunk");
for (const ms of CHUNK_MS_OPTIONS) {
  const option = new Option(`${ms} ms`, String(ms));
  option.selected = ms === DEFAULT_CHUNK_MS;
  chunkSelect.append(option);
}
const runButton = el<HTMLButtonElement>("run");
const resultsButton = el<HTMLButtonElement>("download-results");
const logsButton = el<HTMLButtonElement>("download-logs");
const statusLine = el<HTMLDivElement>("status");
const output = el<HTMLDivElement>("output");

let displayWords: string[] | null = null;
/** Files chosen through the dev-only "spike/recordings" button; replaces the file inputs while set. */
let injected: { recordings: File[]; labels: File[] } | null = null;
let lastResult: RunResult | null = null;

/** `?settle=<n>` (bench only, no UI control): a bad value falls back to tilawa's default and is noted in the run. */
const settleParam = new URLSearchParams(location.search).get("settle");
const engineOverride = engineOverrideFrom(parseSettleFrames(settleParam));
const settleIgnoredNote =
  settleParam !== null && engineOverride.settleFrames === undefined
    ? `قيمة settle غير صالحة (${settleParam}): استُخدمت قيمة tilawa الافتراضية / invalid settle ignored, tilawa default used`
    : null;

/**
 * `?threads=`: absent or invalid uses the device default (4 on a phone, else 1); a production build always uses 1.
 * An ignored value is noted in the run.
 */
const threadsParam = new URLSearchParams(location.search).get("threads");
const requestedThreads = requestThreads(threadsParam, navigator.userAgent, import.meta.env.DEV);
const threadsIgnoredNote =
  threadsParam === null || String(requestedThreads) === threadsParam
    ? null
    : import.meta.env.DEV
      ? `قيمة threads غير صالحة (${threadsParam}): استُخدم العدد الافتراضي ${requestedThreads} / invalid threads ignored, default ${requestedThreads} used`
      : `نسخة البناء تعمل بخيط واحد، تجوهلت threads=${threadsParam} / production build runs 1 thread, threads=${threadsParam} ignored`;

/** " | settleFrames=12" when an override is set, else "". */
function engineLabel(engine: EngineOverride): string {
  return engine.settleFrames === undefined ? "" : ` | settleFrames=${engine.settleFrames}`;
}

/** "" for a plain 1-thread run, else " | threads <requested> -> <effective> | isolated yes/no". */
function threadsLabel(result: RunResult): string {
  if (result.requestedThreads === 1 && result.threads === 1) return "";
  const isolated = result.crossOriginIsolated === null ? "?" : result.crossOriginIsolated ? "yes" : "no";
  return ` | threads ${result.requestedThreads} -> ${result.threads ?? "?"} | isolated ${isolated}`;
}
let tracker: TrackerClient | null = null;

const setStatus = makeStatus(statusLine);

function stat(stats: Stats | null, digits = 0): string {
  return stats ? `${formatMs(stats.p50, digits)} / ${formatMs(stats.p95, digits)} / ${formatMs(stats.max, digits)}` : "-";
}

function td(text: string, className?: string): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function th(text: string): HTMLTableCellElement {
  const cell = document.createElement("th");
  cell.textContent = text;
  return cell;
}

function row(cells: HTMLTableCellElement[]): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.append(...cells);
  return tr;
}

function table(header: string[], rows: HTMLTableRowElement[]): HTMLTableElement {
  const t = document.createElement("table");
  const thead = document.createElement("thead");
  thead.append(row(header.map(th)));
  const tbody = document.createElement("tbody");
  tbody.append(...rows);
  t.append(thead, tbody);
  return t;
}

function para(text: string, className = "note"): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

function seconds(value: number | null): string {
  return value === null ? "-" : value.toFixed(2);
}

function render(result: RunResult): void {
  output.replaceChildren();
  output.append(
    para(
      `${result.variant} | chunk ${result.chunkMs} ms${engineLabel(result.engineConfig)} | ${result.backend}${threadsLabel(result)} | cores ${result.hardwareConcurrency} | load ${formatMs(result.loadMs)} ms`,
      "note ltr",
    ),
  );
  if (result.error) {
    const err = para(`فشل: ${result.error}`, "status error");
    output.append(err);
  }
  for (const skipped of result.skipped) output.append(para(skipped, "note"));

  if (result.aggregate && result.files.length > 0) {
    const a = result.aggregate;
    output.append(
      (() => {
        const h = document.createElement("h2");
        h.textContent = "المجموع (مدمج عبر الملفات) / Aggregate (pooled)";
        return h;
      })(),
      table(
        ["files", "tracked", "cursor p50/p95/max ms", "confirm p50/p95/max ms", "false adv.", "restarts", "lock p50 s", "compute p50/p95/max ms", "RTF", "RTF+verdicts"],
        [
          row([
            td(String(a.files)),
            td(`${a.confirmedWords}/${a.totalWords} (${(a.trackedFraction * 100).toFixed(1)}%)`),
            td(stat(a.cursor)),
            td(stat(a.confirm)),
            td(String(a.falseAdvances)),
            td(String(a.restarts)),
            td(a.timeToFirstLock ? a.timeToFirstLock.p50.toFixed(2) : "-"),
            td(stat(a.compute, 1)),
            td(a.rtf === null ? "-" : a.rtf.toFixed(3)),
            td(a.rtfWithVerdicts === null ? "-" : a.rtfWithVerdicts.toFixed(3)),
          ]),
        ],
      ),
    );
  }

  if (result.files.length > 0) {
    output.append(
      table(
        ["file", "audio s (padded)", "tracked", "missed words", "cursor p50/p95/max ms", "confirm p50/p95/max ms", "false adv.", "restarts", "lock s", "compute p50/p95/max ms", "RTF"],
        result.files.map((f) =>
          row([
            td(f.recording, "ltr"),
            td(`${f.durationSec.toFixed(2)} (${f.paddedDurationSec.toFixed(2)})`),
            td(`${f.metrics.confirmedWords}/${WORD_COUNT}`),
            td(f.metrics.missedWords.length ? f.metrics.missedWords.map((w) => w + 1).join(",") : "-"),
            td(stat(f.metrics.cursor)),
            td(stat(f.metrics.confirm)),
            td(String(f.metrics.falseAdvances)),
            td(String(f.metrics.restarts)),
            td(seconds(f.metrics.timeToFirstLockSec)),
            td(stat(f.metrics.compute, 1)),
            td(f.metrics.rtf === null ? "-" : f.metrics.rtf.toFixed(3)),
          ]),
        ),
      ),
    );
  }

  for (const f of result.files) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `${f.recording} (labels: ${f.labelsFrom})`;
    details.append(
      summary,
      para(`Last word: ${FLUSH_NOTE}. Cursor latency does not exist for word 29 (no next word).`, "note ltr"),
      table(
        ["#", "word", "cursor ms", "confirm ms"],
        f.metrics.perWord.map((w) =>
          row([
            td(String(w.word + 1)),
            td(displayWords?.[w.word] ?? "", "word-cell"),
            td(formatMs(w.cursorMs)),
            td(formatMs(w.confirmMs)),
          ]),
        ),
      ),
    );
    if (f.issues.length > 0) details.append(para(`Correction issues auto-closed: ${f.issues.length}`, "note ltr"));
    output.append(details);
  }
}

/** Parsed labels and the label file they came from. */
type LabelSource = { labels: Labels; from: string };

function findLabels(
  recording: File,
  byRecording: Map<string, LabelSource>,
  byFileName: Map<string, LabelSource>,
): LabelSource | undefined {
  return byRecording.get(recording.name) ?? byFileName.get(`${baseName(recording.name)}.labels.json`);
}

async function loadLabelFiles(files: File[]): Promise<{
  byRecording: Map<string, LabelSource>;
  byFileName: Map<string, LabelSource>;
  problems: string[];
}> {
  const byRecording = new Map<string, LabelSource>();
  const byFileName = new Map<string, LabelSource>();
  const problems: string[] = [];
  for (const file of files) {
    try {
      const labels = parseLabels(JSON.parse(await file.text()));
      const entry = { labels, from: file.name };
      byRecording.set(labels.recording, entry);
      byFileName.set(file.name, entry);
    } catch (err) {
      problems.push(`ملف التعليم ${file.name} غير صالح: ${errorMessage(err)}`);
    }
  }
  return { byRecording, byFileName, problems };
}

function currentSelection(): { recordings: File[]; labels: File[] } {
  return injected ?? { recordings: [...(recordingsInput.files ?? [])], labels: [...(labelsInput.files ?? [])] };
}

async function run(recordings: File[], labelFiles: File[]): Promise<RunResult | null> {
  if (recordings.length === 0 || labelFiles.length === 0) {
    setStatus("اختر تسجيلاً واحداً على الأقل وملفات التعليم.", true);
    return null;
  }
  const variantId = parseVariantId(variantSelect.value);
  const chunkMs = Number(chunkSelect.value);
  const chunkSamples = chunkSamplesForMs(chunkMs);

  runButton.disabled = true;
  resultsButton.disabled = true;
  logsButton.disabled = true;
  tracker?.terminate();

  const result: RunResult = {
    generatedAt: new Date().toISOString(),
    variant: variantId,
    chunkMs,
    engineConfig: engineOverride,
    backend: backendLabel(requestedThreads),
    requestedThreads,
    threads: null,
    crossOriginIsolated: null,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    tailPaddingSec: TAIL_PADDING_SEC,
    flushNote: FLUSH_NOTE,
    loadMs: null,
    skipped: [],
    files: [],
    aggregate: null,
  };
  lastResult = result;

  const { byRecording, byFileName, problems } = await loadLabelFiles(labelFiles);
  result.skipped.push(...problems);
  if (settleIgnoredNote) result.skipped.push(settleIgnoredNote);
  if (threadsIgnoredNote) result.skipped.push(threadsIgnoredNote);

  let issues: IssueRecord[] = [];
  const client = new TrackerClient((message) => {
    if (message.type === "issue") {
      issues.push({ chunkId: message.chunkId, samplesFed: message.samplesFed, issue: message.issue });
    } else if (message.type === "error") {
      console.error("[spike] worker error", message.stage, message.message);
    }
  });
  tracker = client;

  try {
    // Fresh worker + init for every run (variant).
    setStatus(`جارٍ تحميل النموذج (${variantId})…`);
    const ready = client.next("ready");
    client.post({ type: "init", variant: variantId, engine: engineOverride, threads: requestedThreads });
    const readyMessage = await ready;
    result.loadMs = readyMessage.loadMs;
    result.engineConfig = readyMessage.engine; // what the worker really applied
    result.threads = readyMessage.threads;
    result.crossOriginIsolated = readyMessage.crossOriginIsolated;
    result.backend = backendLabel(readyMessage.threads);

    for (const [index, recording] of recordings.entries()) {
      const found = findLabels(recording, byRecording, byFileName);
      if (!found) {
        result.skipped.push(`لا توجد تعليمات للتسجيل ${recording.name}: تم تجاوزه / no labels for ${recording.name}, skipped`);
        continue;
      }
      const prefix = `(${index + 1}/${recordings.length}) ${recording.name}`;
      setStatus(`${prefix}: فك الترميز…`);
      const audio = await decodeFileTo16kMono(recording);

      const resetDone = client.next("resetDone");
      client.post({ type: "reset" });
      await resetDone;
      issues = [];
      const entries: EventLogEntry[] = [];
      const chunks = [
        ...splitIntoChunks(audio, chunkSamples),
        ...splitIntoChunks(new Float32Array(Math.round(TAIL_PADDING_SEC * TARGET_RATE)), chunkSamples),
      ];
      for (const [chunkId, samples] of chunks.entries()) {
        const next = client.next("events");
        client.post({ type: "audio", chunkId, samples }, [samples.buffer]);
        const message = await next;
        entries.push(entryFromEvents(message));
        if (chunkId % 20 === 0) setStatus(`${prefix}: ${chunkId + 1}/${chunks.length}`);
      }
      setStatus(`${prefix}: إنهاء (stop)…`);
      const stopped = client.next("stopped");
      client.post({ type: "stop" });
      const flush = await stopped;
      entries.push(flushEntryFromStopped(flush));

      const log: EventLog = { variant: variantId, chunkMs, entries };
      const metrics = computeMetrics(log, found.labels);
      result.files.push({
        recording: recording.name,
        labelsFrom: found.from,
        durationSec: audio.length / TARGET_RATE,
        paddedDurationSec: metrics.audioDurationSec,
        metrics,
        issues,
        log,
      });
      result.aggregate = aggregateMetrics(result.files);
      render(result);
    }
    setStatus(
      result.files.length > 0
        ? `اكتمل: ${result.files.length} ملف (${variantId}، ${chunkMs} ms${result.engineConfig.settleFrames === undefined ? "" : `، settleFrames=${result.engineConfig.settleFrames}`}${threadsStatusPart(result.threads)}).`
        : "لم يُعالَج أي ملف: تأكد من مطابقة أسماء ملفات التعليم.",
      result.files.length === 0,
    );
  } catch (err) {
    result.error = errorMessage(err);
    console.error("[spike] bench failed", result.error);
    setStatus(`فشل التشغيل (${variantId}): ${result.error}`, true);
  } finally {
    client.terminate();
    tracker = null;
    result.aggregate = result.files.length > 0 ? aggregateMetrics(result.files) : null;
    render(result);
    runButton.disabled = false;
    resultsButton.disabled = false;
    logsButton.disabled = result.files.length === 0;
  }
  return result;
}

function resultsJson(result: RunResult) {
  const { files, ...rest } = result;
  return {
    ...rest,
    files: files.map(({ log: _log, ...file }) => {
      void _log;
      return file;
    }),
  };
}

function logsJson(result: RunResult): unknown {
  return {
    variant: result.variant,
    chunkMs: result.chunkMs,
    engineConfig: result.engineConfig,
    backend: result.backend,
    requestedThreads: result.requestedThreads,
    threads: result.threads,
    crossOriginIsolated: result.crossOriginIsolated,
    userAgent: result.userAgent,
    files: result.files.map((f) => ({ recording: f.recording, log: f.log })),
  };
}

/** Compact JSON of the run: per-file headline numbers and the pooled aggregate. */
function summaryJson(result: RunResult) {
  return {
    variant: result.variant,
    chunkMs: result.chunkMs,
    engineConfig: result.engineConfig,
    backend: result.backend,
    requestedThreads: result.requestedThreads,
    threads: result.threads,
    crossOriginIsolated: result.crossOriginIsolated,
    userAgent: result.userAgent,
    hardwareConcurrency: result.hardwareConcurrency,
    tailPaddingSec: result.tailPaddingSec,
    flushNote: result.flushNote,
    loadMs: result.loadMs,
    error: result.error ?? null,
    skipped: result.skipped,
    files: result.files.map((f) => ({
      recording: f.recording,
      durationSec: f.durationSec,
      paddedDurationSec: f.paddedDurationSec,
      confirmedWords: f.metrics.confirmedWords,
      missedWords: f.metrics.missedWords,
      cursor: f.metrics.cursor,
      confirm: f.metrics.confirm,
      falseAdvances: f.metrics.falseAdvances,
      restarts: f.metrics.restarts,
      timeToFirstLockSec: f.metrics.timeToFirstLockSec,
      compute: f.metrics.compute,
      rtf: f.metrics.rtf,
      rtfWithVerdicts: f.metrics.rtfWithVerdicts,
      issues: f.issues.length,
    })),
    aggregate: result.aggregate,
  };
}

resultsButton.addEventListener("click", () => {
  if (lastResult) downloadJson(`results-${lastResult.variant}-${lastResult.chunkMs}ms.json`, resultsJson(lastResult));
});
logsButton.addEventListener("click", () => {
  if (lastResult) downloadJson(`eventlogs-${lastResult.variant}-${lastResult.chunkMs}ms.json`, logsJson(lastResult));
});
runButton.addEventListener("click", () => {
  const { recordings, labels } = currentSelection();
  void run(recordings, labels);
});
recordingsInput.addEventListener("change", () => (injected = null));
labelsInput.addEventListener("change", () => (injected = null));

initVariantSelect(variantSelect);
fetchDisplayWords()
  .then((words) => {
    displayWords = words;
  })
  .catch((err: unknown) => console.error("[spike] corpus error", err));

if (import.meta.env.DEV) {
  // Dev-server only: use spike/recordings and optionally autorun (?autorun=1&variant=A1&chunk=150).
  void import("./dev/bench-dev").then((m) =>
    m.initBenchDev({
      controls: document.querySelector<HTMLElement>(".controls") ?? document.body,
      variantSelect,
      chunkSelect,
      setStatus,
      select: (recordings, labels) => {
        injected = { recordings, labels };
      },
      run: () => {
        const { recordings, labels } = currentSelection();
        return run(recordings, labels);
      },
      toResultsJson: resultsJson,
      toLogsJson: logsJson,
      toSummaryJson: summaryJson,
      didFail: (result) => Boolean(result.error) || result.files.length === 0,
    }),
  );
}
