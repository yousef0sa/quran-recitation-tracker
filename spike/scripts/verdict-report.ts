// Offline analysis of one bench run: node scripts/verdict-report.ts <results.json> <eventlogs.json> [--word 1:6:1 ...]
// Reads the pair written to spike/results/ (the bench autorun or the bench page downloads) and prints
//   1. header   2. per-word confirm table   3. aggregates + sweep summary line
//   4. words whose verdict was ever "wrong"/"skipped" (false alarms: the owner's recordings are correct readings)
//   5. per-word timelines (verdict changes, cursor enter/leave, verse_match / verse_candidate nearby) for --word args
// Prints positions ("1:6 w1" = ayah 6, word 1) and numbers only, never transcript or verse text.
// Node runs this file by stripping types: erasable syntax only, and only `node:` imports.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Copy of AYAH_WORD_COUNTS in src/fatiha.ts (this script imports nothing from src/).
const AYAH_WORD_COUNTS = [4, 4, 2, 3, 4, 3, 9];
const WORD_COUNT = 29;
/** Seconds around a word's timeline lines in which verse_match / verse_candidate events are shown. */
const VERSE_WINDOW_SEC = 3;

type VerdictState = "ok" | "unsure" | "wrong" | "skipped" | "pending";
const STATES: VerdictState[] = ["ok", "unsure", "wrong", "skipped", "pending"];

export interface CompactVerdict {
  w: number;
  s: VerdictState;
  d: number;
  h: number;
  m: number;
}
export interface LogEvent {
  type: string;
  [key: string]: unknown;
}
export interface LogEntry {
  chunkId: number;
  audioTimeSec: number;
  events: LogEvent[];
  verdicts?: CompactVerdict[];
  flush?: boolean;
}
export interface ResultsFile {
  recording: string;
  metrics: {
    perWord: { word: number; cursorMs: number | null; confirmMs: number | null }[];
    falseAdvances: number;
    restarts: number;
    confirmedWords: number;
  };
  issues: unknown[];
}
export interface ResultsJson {
  variant: string;
  chunkMs: number;
  engineConfig?: { settleFrames?: number };
  backend?: string;
  files: ResultsFile[];
}
export interface LogsJson {
  files: { recording: string; log: { entries: LogEntry[] } }[];
}

const OFFSETS: number[] = [];
{
  let sum = 0;
  for (const count of AYAH_WORD_COUNTS) {
    OFFSETS.push(sum);
    sum += count;
  }
}

/** Global indices of the last word of each ayah. */
export const AYAH_END_WORDS: readonly number[] = AYAH_WORD_COUNTS.map((count, i) => (OFFSETS[i] as number) + count - 1);

/** Global index 0..28 -> "1:<ayah> w<n>" (n = 1-based word in the ayah); 29 = the position after the last word. */
export function wordLabel(global: number): string {
  if (global >= WORD_COUNT) return "end";
  for (let ayah = AYAH_WORD_COUNTS.length; ayah >= 1; ayah--) {
    const offset = OFFSETS[ayah - 1] as number;
    if (global >= offset) return `1:${ayah} w${global - offset + 1}`;
  }
  return `?${global}`;
}

/** "1:6:1" (surah:ayah:word, word 1-based) -> global index 0..28; throws on anything else. */
export function parseWordArg(arg: string): number {
  const match = /^1:([1-7]):(\d+)$/.exec(arg);
  const ayah = match ? Number(match[1]) : 0;
  const word = match ? Number(match[2]) : 0;
  if (!match || word < 1 || word > (AYAH_WORD_COUNTS[ayah - 1] as number)) {
    throw new Error(`bad --word "${arg}" (expected 1:<ayah 1-7>:<word in ayah, 1-based>, e.g. 1:6:1)`);
  }
  return (OFFSETS[ayah - 1] as number) + word - 1;
}

/** Same linear-interpolation percentile as percentile() in src/metrics.ts. */
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

function fmtMs(value: number): string {
  return Number.isNaN(value) ? "-" : String(Math.round(value));
}

function fmtSec(value: number): string {
  return `${value.toFixed(2)} s`;
}

function fmtVerdict(v: CompactVerdict): string {
  return `${v.s} d=${v.d} h=${v.h} m=${v.m}`;
}

export function hasVerdictLog(logs: LogsJson): boolean {
  return logs.files.some((f) => f.log.entries.some((e) => Array.isArray(e.verdicts)));
}

/** The lists recorded in a file's entries, in order, with the audio time they appeared. */
function verdictLists(entries: readonly LogEntry[]): { t: number; list: CompactVerdict[] }[] {
  const out: { t: number; list: CompactVerdict[] }[] = [];
  for (const entry of entries) {
    if (Array.isArray(entry.verdicts)) out.push({ t: entry.audioTimeSec, list: entry.verdicts });
  }
  return out;
}

/** Last non-empty verdict list of a file (empty lists mean tilawa went back to search), or null. */
export function finalVerdicts(entries: readonly LogEntry[]): CompactVerdict[] | null {
  const lists = verdictLists(entries);
  for (let i = lists.length - 1; i >= 0; i--) {
    const found = lists[i] as { list: CompactVerdict[] };
    if (found.list.length > 0) return found.list;
  }
  return null;
}

// ---------------------------------------------------------------- section 2

export interface WordRow {
  word: number;
  label: string;
  end: boolean;
  /** Confirm ms after the labelled word end, per file; null = never confirmed. */
  cells: (number | null)[];
}

export function perWordTable(results: ResultsJson): WordRow[] {
  const rows: WordRow[] = [];
  for (let word = 0; word < WORD_COUNT; word++) {
    rows.push({
      word,
      label: wordLabel(word),
      end: AYAH_END_WORDS.includes(word),
      cells: results.files.map((f) => f.metrics.perWord.find((p) => p.word === word)?.confirmMs ?? null),
    });
  }
  return rows;
}

// ---------------------------------------------------------------- section 3

export interface StatLine {
  n: number;
  p50: number;
  p95: number;
}

function statOf(values: number[]): StatLine {
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) };
}

export interface Aggregates {
  overall: StatLine;
  ayahEnd: StatLine;
  interior: StatLine;
  trackedPct: number;
  confirmedWords: number;
  totalWords: number;
  falseAdvances: number;
  restarts: number;
  correctionIssues: number;
}

export function aggregates(results: ResultsJson): Aggregates {
  const overall: number[] = [];
  const ayahEnd: number[] = [];
  const interior: number[] = [];
  let confirmedWords = 0;
  let falseAdvances = 0;
  let restarts = 0;
  let correctionIssues = 0;
  for (const file of results.files) {
    confirmedWords += file.metrics.confirmedWords;
    falseAdvances += file.metrics.falseAdvances;
    restarts += file.metrics.restarts;
    correctionIssues += file.issues.length;
    for (const p of file.metrics.perWord) {
      if (p.confirmMs === null) continue;
      overall.push(p.confirmMs);
      (AYAH_END_WORDS.includes(p.word) ? ayahEnd : interior).push(p.confirmMs);
    }
  }
  const totalWords = WORD_COUNT * results.files.length;
  return {
    overall: statOf(overall),
    ayahEnd: statOf(ayahEnd),
    interior: statOf(interior),
    trackedPct: totalWords > 0 ? (confirmedWords / totalWords) * 100 : 0,
    confirmedWords,
    totalWords,
    falseAdvances,
    restarts,
    correctionIssues,
  };
}

// ---------------------------------------------------------------- section 4

export interface FalseAlarm {
  recording: string;
  word: number;
  /** State of the first "wrong"/"skipped" verdict seen for the word in this file. */
  state: "wrong" | "skipped";
  t: number;
  verdict: CompactVerdict;
  /** State in the last non-empty list ("absent" when the word is not listed, "no list" when there is none). */
  finalState: string;
}

/** Every word whose verdict was ever "wrong" or "skipped", once per (file, word), at its first such time. */
export function falseAlarms(logs: LogsJson): FalseAlarm[] {
  const out: FalseAlarm[] = [];
  for (const file of logs.files) {
    const final = finalVerdicts(file.log.entries);
    const seen = new Set<number>();
    for (const { t, list } of verdictLists(file.log.entries)) {
      for (const v of list) {
        if ((v.s !== "wrong" && v.s !== "skipped") || seen.has(v.w)) continue;
        seen.add(v.w);
        out.push({
          recording: file.recording,
          word: v.w,
          state: v.s,
          t,
          verdict: v,
          finalState: final === null ? "no list" : (final.find((f) => f.w === v.w)?.s ?? "absent"),
        });
      }
    }
  }
  return out;
}

/** Per file: count of each state in the last non-empty list, plus the words it does not list. */
export function finalStateCounts(logs: LogsJson): { recording: string; counts: Record<string, number>; endsInSearch: boolean }[] {
  return logs.files.map((file) => {
    const lists = verdictLists(file.log.entries);
    const final = finalVerdicts(file.log.entries);
    const counts: Record<string, number> = {};
    for (const state of STATES) counts[state] = final?.filter((v) => v.s === state).length ?? 0;
    counts.absent = WORD_COUNT - (final?.length ?? 0);
    return { recording: file.recording, counts, endsInSearch: lists.length > 0 && (lists[lists.length - 1] as { list: unknown[] }).list.length === 0 };
  });
}

// ---------------------------------------------------------------- section 5

/** Cursor position of a word_progress event as a global index, or null when it is not a surah-1 position. */
function cursorOf(event: LogEvent): number | null {
  if (event.type !== "word_progress" || event.surah !== 1) return null;
  const ayah = event.ayah;
  const index = event.word_index;
  if (typeof ayah !== "number" || typeof index !== "number") return null;
  const count = AYAH_WORD_COUNTS[ayah - 1];
  if (count === undefined || !Number.isInteger(index) || index < 0 || index > count) return null;
  return (OFFSETS[ayah - 1] as number) + index;
}

function describeVerseEvent(event: LogEvent): string | null {
  if (event.type === "verse_match") {
    return `verse_match ${event.surah}:${event.ayah} confidence ${event.confidence}`;
  }
  if (event.type === "verse_candidate" && Array.isArray(event.candidates)) {
    const parts = (event.candidates as Record<string, unknown>[]).map(
      (c) => `${c.surah}:${c.ayah} rank ${c.rank} conf ${c.confidence}`,
    );
    return `verse_candidate [${parts.join("; ")}] stable=${event.stable} final_flush=${event.final_flush}`;
  }
  return null;
}

/** Status of word `w` in a verdict list: tilawa lists only words inside the tracker's span. */
function statusIn(list: readonly CompactVerdict[], w: number): { key: string; text: string } {
  if (list.length === 0) return { key: "search", text: "— (list empty: tilawa is in search)" };
  const v = list.find((x) => x.w === w);
  return v ? { key: JSON.stringify(v), text: fmtVerdict(v) } : { key: "absent", text: "absent (not in the verdict list)" };
}

/** Timeline of one word in one file: verdict changes, cursor entering/leaving, verse events nearby. */
export function wordTimeline(entries: readonly LogEntry[], w: number): string[] {
  const core: { t: number; order: number; text: string }[] = [];
  const verse: { t: number; order: number; text: string }[] = [];
  let order = 0;
  let prevStatus: string | null = null;
  let prevCursor: number | null = null;
  for (const entry of entries) {
    const t = entry.audioTimeSec;
    if (Array.isArray(entry.verdicts)) {
      const status = statusIn(entry.verdicts, w);
      if (status.key !== prevStatus) {
        core.push({ t, order: order++, text: `verdict ${status.text}` });
        prevStatus = status.key;
      }
    }
    for (const event of entry.events) {
      const cursor = cursorOf(event);
      if (cursor !== null) {
        if (cursor !== prevCursor) {
          if (prevCursor === w) core.push({ t, order: order++, text: `cursor leaves ${wordLabel(w)} -> ${wordLabel(cursor)}` });
          else if (cursor === w) {
            core.push({ t, order: order++, text: `cursor enters ${wordLabel(w)} from ${prevCursor === null ? "start" : wordLabel(prevCursor)}` });
          }
          prevCursor = cursor;
        }
        continue;
      }
      const text = describeVerseEvent(event);
      if (text) verse.push({ t, order: order++, text });
    }
  }
  const near = verse.filter((v) => core.some((c) => Math.abs(c.t - v.t) <= VERSE_WINDOW_SEC));
  return [...core, ...near]
    .sort((a, b) => a.t - b.t || a.order - b.order)
    .map((item) => `    t=${fmtSec(item.t)}  ${item.text}`);
}

// ---------------------------------------------------------------- report

export function engineLabel(results: ResultsJson): string {
  const config = results.engineConfig;
  if (!config || Object.keys(config).length === 0) return "tilawa defaults";
  return JSON.stringify(config);
}

function pad(text: string, width: number): string {
  return text.padEnd(width);
}

/** Full text report. `words` are global indices for the section-5 timelines. */
export function buildReport(results: ResultsJson, logs: LogsJson, words: readonly number[] = []): string {
  const lines: string[] = [];
  const names = results.files.map((f) => f.recording);

  lines.push("== 1. Run ==");
  lines.push(`variant ${results.variant} | chunk ${results.chunkMs} ms | engineConfig ${engineLabel(results)} | backend ${results.backend ?? "?"}`);
  lines.push(`files: ${names.join(", ")}`);
  lines.push("");

  lines.push("== 2. Confirm ms after the labelled word end (MISS = never confirmed; END = last word of its ayah) ==");
  const colWidth = Math.max(8, ...names.map((n) => n.length + 1));
  lines.push(pad("word", 12) + pad("", 5) + names.map((n) => pad(n, colWidth)).join(""));
  for (const row of perWordTable(results)) {
    lines.push(pad(row.label, 12) + pad(row.end ? "END" : "", 5) + row.cells.map((c) => pad(c === null ? "MISS" : String(Math.round(c)), colWidth)).join(""));
  }
  lines.push("");

  const agg = aggregates(results);
  const logged = hasVerdictLog(logs);
  const alarms = logged ? falseAlarms(logs) : [];
  const everWrong = alarms.filter((a) => a.verdict.s === "wrong").length;
  const everSkipped = alarms.filter((a) => a.verdict.s === "skipped").length;
  lines.push("== 3. Aggregates (confirm latency in ms, pooled over all files) ==");
  lines.push(`overall   n=${agg.overall.n} p50 ${fmtMs(agg.overall.p50)} p95 ${fmtMs(agg.overall.p95)}`);
  lines.push(`ayah-end  n=${agg.ayahEnd.n} p50 ${fmtMs(agg.ayahEnd.p50)} p95 ${fmtMs(agg.ayahEnd.p95)}`);
  lines.push(`interior  n=${agg.interior.n} p50 ${fmtMs(agg.interior.p50)} p95 ${fmtMs(agg.interior.p95)}`);
  lines.push(`tracked ${agg.confirmedWords}/${agg.totalWords} (${agg.trackedPct.toFixed(1)} %)`);
  lines.push(`false advances ${agg.falseAdvances} | restarts ${agg.restarts} | correction issues ${agg.correctionIssues}`);
  const firstWord = AYAH_WORD_COUNTS.slice(0, 5).reduce((a, b) => a + b, 0);
  const w1 = results.files.map((f) => {
    const ms = f.metrics.perWord.find((p) => p.word === firstWord)?.confirmMs ?? null;
    return `${f.recording} ${ms === null ? "MISS" : `${Math.round(ms)} ms`}`;
  });
  lines.push(`${wordLabel(firstWord)}: ${w1.join(", ")}`);
  lines.push(
    `SUMMARY engine=${engineLabel(results)} end p50/p95 ${fmtMs(agg.ayahEnd.p50)}/${fmtMs(agg.ayahEnd.p95)} interior ${fmtMs(agg.interior.p50)}/${fmtMs(agg.interior.p95)} overall ${fmtMs(agg.overall.p50)}/${fmtMs(agg.overall.p95)} tracked ${agg.trackedPct.toFixed(1)}% falseAdv ${agg.falseAdvances} restarts ${agg.restarts} issues ${agg.correctionIssues} everWrong ${logged ? everWrong : "n/a"} everSkipped ${logged ? everSkipped : "n/a"}`,
  );
  lines.push("");

  lines.push("== 4. False alarms: verdicts that were ever wrong or skipped (all recordings are correct readings) ==");
  if (!logged) {
    lines.push("no verdict log in this eventlogs file (older run)");
  } else {
    lines.push(`words ever wrong: ${everWrong} | words ever skipped: ${everSkipped} (counted per file and word)`);
    if (alarms.length === 0) lines.push("none");
    for (const a of alarms) {
      lines.push(`  ${a.recording}  ${wordLabel(a.word)}  first ${a.state} at ${fmtSec(a.t)}  d=${a.verdict.d} h=${a.verdict.h} m=${a.verdict.m}  final ${a.finalState}`);
    }
    lines.push("final verdict list per file (last non-empty list):");
    for (const f of finalStateCounts(logs)) {
      const counts = Object.entries(f.counts).map(([k, v]) => `${k} ${v}`).join(", ");
      lines.push(`  ${f.recording}: ${counts}${f.endsInSearch ? " (log ends in search)" : ""}`);
    }
  }
  lines.push("");

  lines.push("== 5. Timelines ==");
  if (words.length === 0) lines.push("(none requested: pass --word 1:<ayah>:<word>)");
  else if (!logged) lines.push("no verdict log in this eventlogs file (older run)");
  else {
    for (const w of words) {
      lines.push(`${wordLabel(w)}${AYAH_END_WORDS.includes(w) ? " (ayah end)" : ""}`);
      for (const file of logs.files) {
        lines.push(`  ${file.recording}`);
        const timeline = wordTimeline(file.log.entries, w);
        lines.push(...(timeline.length > 0 ? timeline : ["    (no events for this word)"]));
      }
    }
  }
  return lines.join("\n");
}

function main(argv: string[]): void {
  const files: string[] = [];
  const words: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--word") words.push(parseWordArg(argv[++i] ?? ""));
    else files.push(arg);
  }
  const [resultsPath, logsPath] = files;
  if (!resultsPath || !logsPath || files.length !== 2) {
    console.error("usage: node scripts/verdict-report.ts <results.json> <eventlogs.json> [--word 1:<ayah>:<word> ...]");
    process.exitCode = 2;
    return;
  }
  const results = JSON.parse(readFileSync(resultsPath, "utf8")) as ResultsJson;
  const logs = JSON.parse(readFileSync(logsPath, "utf8")) as LogsJson;
  console.log(buildReport(results, logs, words));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
