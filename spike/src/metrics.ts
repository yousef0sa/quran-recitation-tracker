// Pure latency / accuracy computation from an EventLog and the labels of one recording.
// Latency = (audio time of the chunk whose events first show the signal) - (labelled word end),
// so it is independent of CPU speed. Negative values mean the signal came before the label.
import type { WorkerOutbound } from "@tilawa/core";
import { WORD_COUNT, tryCursorToGlobal, tryToGlobalWordIndex } from "./fatiha";
import { TARGET_RATE } from "./audio";
import type { Labels } from "./labels";
import type { WorkerToMain } from "./messages";
import type { VariantId } from "./variants";

/** One tilawa word verdict for a Fatiha word. w = global index 0..28; d/h/m = distance, heardRatio, margin rounded to 3 decimals. */
export interface CompactVerdict {
  w: number;
  s: "ok" | "unsure" | "wrong" | "skipped" | "pending";
  d: number;
  h: number;
  m: number;
}

export interface EventLogEntry {
  chunkId: number;
  /** samplesFed / 16000 after this chunk. */
  audioTimeSec: number;
  /** Time of feed() only (verdicts snapshot excluded). */
  computeMs: number;
  /** Time of the session.verdicts() snapshot, reported separately. Absent in older logs. */
  verdictsMs?: number;
  events: WorkerOutbound[];
  /**
   * Global Al-Fatiha word indices whose verdict was "ok"/"unsure" in a session.verdicts() snapshot
   * taken after this chunk. Covers ayah-final words that word_progress.matched_indices cannot report
   * once the cursor is in the next ayah. Absent in older logs.
   */
  confirmed?: number[];
  /**
   * Full surah-1 verdict list after this chunk, present only when it differs from the previous entry's
   * (an empty array means tilawa returned to search). Absent in older logs.
   */
  verdicts?: CompactVerdict[];
  /**
   * Bench only: the entry built from the stop() result (after the +2 s tail inside stop()).
   * Its computeMs is the stop() time; it is kept out of the per-chunk compute stats but counts for RTF.
   */
  flush?: boolean;
}

/** Log entry for a worker "events" message (audio time = samplesFed / 16000). */
export function entryFromEvents(message: Extract<WorkerToMain, { type: "events" }>): EventLogEntry {
  return {
    chunkId: message.chunkId,
    audioTimeSec: message.samplesFed / TARGET_RATE,
    computeMs: message.computeMs,
    verdictsMs: message.verdictsMs,
    events: message.events,
    confirmed: message.confirmed,
    ...(message.verdicts ? { verdicts: message.verdicts } : {}),
  };
}

/** Final log entry for the worker "stopped" message (chunkId -1, flush: true). */
export function flushEntryFromStopped(message: Extract<WorkerToMain, { type: "stopped" }>): EventLogEntry {
  return {
    chunkId: -1,
    audioTimeSec: message.samplesFed / TARGET_RATE,
    computeMs: message.computeMs,
    verdictsMs: message.verdictsMs,
    events: message.events,
    confirmed: message.confirmed,
    ...(message.verdicts ? { verdicts: message.verdicts } : {}),
    flush: true,
  };
}

export interface EventLog {
  variant: VariantId;
  chunkMs: number;
  entries: EventLogEntry[];
}

export interface Stats {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export interface WordMetric {
  /** Global word index 0..28. */
  word: number;
  /** First cursor advance past this word, ms after its labelled end. Null for word 28 or if never advanced. */
  cursorMs: number | null;
  /** First time the word appears in matched_indices, ms after its labelled end. Null if never confirmed. */
  confirmMs: number | null;
}

export interface Metrics {
  perWord: WordMetric[];
  cursor: Stats | null;
  confirm: Stats | null;
  /** Per-chunk compute time (ms), feed() only. */
  compute: Stats | null;
  /** Per-chunk session.verdicts() snapshot time (ms); null for logs without verdictsMs. */
  verdicts: Stats | null;
  /** Words (0..28) never confirmed. */
  missedWords: number[];
  /** Words (0..27) the cursor never advanced past. */
  cursorMissedWords: number[];
  /** Words the cursor moved past before the word started (see falseAdvanceWords). */
  falseAdvances: number;
  falseAdvanceWords: number[];
  /** Backward cursor moves. */
  restarts: number;
  audioDurationSec: number;
  /** Sum of compute / audio duration. Null when there is no audio. */
  rtf: number | null;
  /** Same, with the verdicts snapshot time added. */
  rtfWithVerdicts: number | null;
  /** Audio time of the first surah-1 word_progress. Null if the tracker never locked. */
  timeToFirstLockSec: number | null;
  confirmedWords: number;
  /** confirmedWords / 29. */
  trackedFraction: number;
}

/** Linear-interpolation percentile (p in 0..100) of unsorted values; NaN when empty. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (rank - lo);
}

/** p50 / p95 / max of the values, or null when empty (also usable to pool values across files). */
export function summarize(values: readonly number[]): Stats | null {
  if (values.length === 0) return null;
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
  };
}

export function computeMetrics(log: EventLog, labels: Labels): Metrics {
  const cursorTime: (number | undefined)[] = new Array(WORD_COUNT).fill(undefined);
  const confirmTime: (number | undefined)[] = new Array(WORD_COUNT).fill(undefined);
  let prevCursor: number | null = null;
  let restarts = 0;
  let firstLock: number | null = null;
  let audioDurationSec = 0;
  let computeSum = 0;
  const computeValues: number[] = [];
  const verdictsValues: number[] = [];
  let verdictsSum = 0;

  for (const entry of log.entries) {
    const t = entry.audioTimeSec;
    audioDurationSec = Math.max(audioDurationSec, t);
    computeSum += entry.computeMs;
    if (!entry.flush) {
      computeValues.push(entry.computeMs);
      if (entry.verdictsMs !== undefined) verdictsValues.push(entry.verdictsMs);
    }
    verdictsSum += entry.verdictsMs ?? 0;

    // A word is confirmed at the first entry where it is in matched_indices (mapped) OR in entry.confirmed.
    for (const w of entry.confirmed ?? []) {
      if (Number.isInteger(w) && w >= 0 && w < WORD_COUNT && confirmTime[w] === undefined) confirmTime[w] = t;
    }

    for (const event of entry.events) {
      if (event.type !== "word_progress" || event.surah !== 1) continue;
      if (firstLock === null) firstLock = t;

      const cursor = tryCursorToGlobal(event.ayah, event.word_index);
      if (cursor !== null) {
        if (prevCursor !== null && cursor < prevCursor) restarts++;
        prevCursor = cursor;
        // The cursor passing word w means every word below the cursor is crossed.
        for (let w = 0; w < Math.min(cursor, WORD_COUNT); w++) {
          if (cursorTime[w] === undefined) cursorTime[w] = t;
        }
      }
      for (const index of event.matched_indices) {
        const w = tryToGlobalWordIndex(event.ayah, index);
        if (w !== null && confirmTime[w] === undefined) confirmTime[w] = t;
      }
    }
  }

  const perWord: WordMetric[] = [];
  const missedWords: number[] = [];
  const cursorMissedWords: number[] = [];
  const falseAdvanceWords: number[] = [];
  const cursorLatencies: number[] = [];
  const confirmLatencies: number[] = [];

  for (let w = 0; w < WORD_COUNT; w++) {
    const end = labels.wordEnds[w] as number;
    const lastWord = w === WORD_COUNT - 1;

    const crossed = cursorTime[w];
    let cursorMs: number | null = null;
    // The last word has no next word, so the cursor cannot advance past it: no cursor latency.
    if (!lastWord) {
      if (crossed === undefined) {
        cursorMissedWords.push(w);
      } else {
        cursorMs = (crossed - end) * 1000;
        cursorLatencies.push(cursorMs);
        const notBefore = labels.wordStarts ? (labels.wordStarts[w] as number) : w > 0 ? (labels.wordEnds[w - 1] as number) : 0;
        if (crossed < notBefore) falseAdvanceWords.push(w);
      }
    }

    const confirmed = confirmTime[w];
    let confirmMs: number | null = null;
    if (confirmed === undefined) {
      missedWords.push(w);
    } else {
      confirmMs = (confirmed - end) * 1000;
      confirmLatencies.push(confirmMs);
    }
    perWord.push({ word: w, cursorMs, confirmMs });
  }

  const confirmedWords = WORD_COUNT - missedWords.length;
  return {
    perWord,
    cursor: summarize(cursorLatencies),
    confirm: summarize(confirmLatencies),
    compute: summarize(computeValues),
    verdicts: summarize(verdictsValues),
    missedWords,
    cursorMissedWords,
    falseAdvances: falseAdvanceWords.length,
    falseAdvanceWords,
    restarts,
    audioDurationSec,
    rtf: audioDurationSec > 0 ? computeSum / (audioDurationSec * 1000) : null,
    rtfWithVerdicts:
      audioDurationSec > 0 ? (computeSum + verdictsSum) / (audioDurationSec * 1000) : null,
    timeToFirstLockSec: firstLock,
    confirmedWords,
    trackedFraction: confirmedWords / WORD_COUNT,
  };
}

export interface Aggregate {
  files: number;
  /** Per-word latencies pooled over all files. */
  cursor: Stats | null;
  confirm: Stats | null;
  /** Per-chunk compute pooled over all files (flush entries excluded). */
  compute: Stats | null;
  /** Σ compute (flush included) / Σ audio duration. */
  rtf: number | null;
  rtfWithVerdicts: number | null;
  audioDurationSec: number;
  confirmedWords: number;
  totalWords: number;
  trackedFraction: number;
  falseAdvances: number;
  restarts: number;
  /** Seconds to first lock, pooled over the files that locked. */
  timeToFirstLock: Stats | null;
  filesWithoutLock: number;
}

/** Pool per-file results (word latencies pooled, not averaged per file). */
export function aggregateMetrics(items: readonly { metrics: Metrics; log: EventLog }[]): Aggregate {
  const cursor: number[] = [];
  const confirm: number[] = [];
  const compute: number[] = [];
  const locks: number[] = [];
  let computeSum = 0;
  let verdictsSum = 0;
  let duration = 0;
  let confirmedWords = 0;
  let falseAdvances = 0;
  let restarts = 0;
  for (const { metrics, log } of items) {
    for (const word of metrics.perWord) {
      if (word.cursorMs !== null) cursor.push(word.cursorMs);
      if (word.confirmMs !== null) confirm.push(word.confirmMs);
    }
    for (const entry of log.entries) {
      computeSum += entry.computeMs;
      verdictsSum += entry.verdictsMs ?? 0;
      if (!entry.flush) compute.push(entry.computeMs);
    }
    if (metrics.timeToFirstLockSec !== null) locks.push(metrics.timeToFirstLockSec);
    duration += metrics.audioDurationSec;
    confirmedWords += metrics.confirmedWords;
    falseAdvances += metrics.falseAdvances;
    restarts += metrics.restarts;
  }
  const totalWords = items.length * WORD_COUNT;
  return {
    files: items.length,
    cursor: summarize(cursor),
    confirm: summarize(confirm),
    compute: summarize(compute),
    rtf: duration > 0 ? computeSum / (duration * 1000) : null,
    rtfWithVerdicts: duration > 0 ? (computeSum + verdictsSum) / (duration * 1000) : null,
    audioDurationSec: duration,
    confirmedWords,
    totalWords,
    trackedFraction: totalWords > 0 ? confirmedWords / totalWords : 0,
    falseAdvances,
    restarts,
    timeToFirstLock: summarize(locks),
    filesWithoutLock: items.length - locks.length,
  };
}
