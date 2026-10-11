// Per-word diff of two bench runs: node scripts/compare-runs.ts <a_results> <a_logs> <b_results> <b_logs> [--allow-state-flips N]
// Matches files by recording name and compares the intersection (files present in only one run are listed, not failed). Per file:
//   per-word cursorMs / confirmMs (exact), final verdict state per word, words ever "wrong"/"skipped",
//   issue count, false advances, restarts, timeToFirstLockSec.
// Final state of a word = its state in the last non-empty verdict list; if that is pending or the word is absent,
// its last non-pending state in any list; else "n/a" (reported as a change, never counted as a state flip).
// --allow-state-flips N permits up to N ok<->unsure final-state changes over all files (the float effect); default 0.
// Prints positions ("1:6 w1" = ayah 6, word 1) and numbers only, never transcript or verse text. Exit code 1 on any
// difference that is not an allowed flip, 2 on bad usage, a malformed or duplicate-recording input file, or no common file.
// Node runs this file by stripping types: erasable syntax only, and only `node:` imports.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Copy of AYAH_WORD_COUNTS in src/fatiha.ts (this script imports nothing from src/).
const AYAH_WORD_COUNTS = [4, 4, 2, 3, 4, 3, 9];
const WORD_COUNT = 29;

type VerdictState = "ok" | "unsure" | "wrong" | "skipped" | "pending";
export type FinalState = VerdictState | "n/a";

export interface CompactVerdict {
  w: number;
  s: VerdictState;
  d: number;
  h: number;
  m: number;
}
export interface LogEntry {
  chunkId: number;
  audioTimeSec: number;
  verdicts?: CompactVerdict[];
}
export interface ResultsFile {
  recording: string;
  metrics: {
    perWord: { word: number; cursorMs: number | null; confirmMs: number | null }[];
    falseAdvances: number;
    restarts: number;
    timeToFirstLockSec: number | null;
  };
  issues: unknown[];
}
export interface ResultsJson {
  files: ResultsFile[];
}
export interface LogsJson {
  files: { recording: string; log: { entries: LogEntry[] } }[];
}
export interface Run {
  results: ResultsJson;
  logs: LogsJson;
}
export interface Comparison {
  /** Recordings compared, in run A's order. */
  compared: string[];
  onlyInA: string[];
  onlyInB: string[];
  /** Differences that fail the comparison. */
  differences: string[];
  /** ok<->unsure final-state changes (over all files), allowed or not. */
  flips: string[];
  /** Flips beyond the allowance; when above 0 all flips are also listed in `differences`. */
  flipsOverAllowance: number;
}

const OFFSETS: number[] = [];
{
  let sum = 0;
  for (const count of AYAH_WORD_COUNTS) {
    OFFSETS.push(sum);
    sum += count;
  }
}

/** Global index 0..28 -> "1:<ayah> w<n>" (n = 1-based word in the ayah). */
export function wordLabel(global: number): string {
  for (let ayah = AYAH_WORD_COUNTS.length; ayah >= 1; ayah--) {
    const offset = OFFSETS[ayah - 1] as number;
    if (global >= offset) return `1:${ayah} w${global - offset + 1}`;
  }
  return `?${global}`;
}

/** Final state of each word 0..28 (see the header). */
export function finalStates(entries: readonly LogEntry[]): FinalState[] {
  const lists: CompactVerdict[][] = [];
  for (const entry of entries) if (Array.isArray(entry.verdicts)) lists.push(entry.verdicts);
  const out: FinalState[] = new Array<FinalState>(WORD_COUNT).fill("n/a");
  let last: CompactVerdict[] | null = null;
  for (let i = lists.length - 1; i >= 0 && last === null; i--) {
    if ((lists[i] as CompactVerdict[]).length > 0) last = lists[i] as CompactVerdict[];
  }
  for (let w = 0; w < WORD_COUNT; w++) {
    const inLast = last?.find((v) => v.w === w);
    if (inLast && inLast.s !== "pending") {
      out[w] = inLast.s;
      continue;
    }
    for (let i = lists.length - 1; i >= 0; i--) {
      const found = (lists[i] as CompactVerdict[]).filter((v) => v.w === w && v.s !== "pending").pop();
      if (found) {
        out[w] = found.s;
        break;
      }
    }
  }
  return out;
}

/** Words (0..28) whose verdict was "wrong" or "skipped" in any list. */
export function everWrongOrSkipped(entries: readonly LogEntry[]): number[] {
  const words = new Set<number>();
  for (const entry of entries) {
    for (const v of entry.verdicts ?? []) if (v.s === "wrong" || v.s === "skipped") words.add(v.w);
  }
  return [...words].sort((a, b) => a - b);
}

function fmt(value: number | null | undefined): string {
  return value === null || value === undefined ? "none" : String(value);
}

function isFlip(a: FinalState, b: FinalState): boolean {
  return (a === "ok" && b === "unsure") || (a === "unsure" && b === "ok");
}

function sameValue(a: number | null | undefined, b: number | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

export function compareRuns(a: Run, b: Run, allowStateFlips = 0): Comparison {
  const logsA = new Map(a.logs.files.map((f) => [f.recording, f.log.entries]));
  const logsB = new Map(b.logs.files.map((f) => [f.recording, f.log.entries]));
  const filesA = new Map(a.results.files.map((f) => [f.recording, f]));
  const filesB = new Map(b.results.files.map((f) => [f.recording, f]));
  const out: Comparison = { compared: [], onlyInA: [], onlyInB: [], differences: [], flips: [], flipsOverAllowance: 0 };
  for (const name of filesA.keys()) {
    if (filesB.has(name) && logsA.has(name) && logsB.has(name)) out.compared.push(name);
    else out.onlyInA.push(name);
  }
  for (const name of filesB.keys()) if (!filesA.has(name)) out.onlyInB.push(name);

  const flipLines: string[] = [];
  for (const name of out.compared) {
    const fa = filesA.get(name) as ResultsFile;
    const fb = filesB.get(name) as ResultsFile;
    const diff = (text: string) => out.differences.push(`${name}: ${text}`);

    const wordsA = new Map(fa.metrics.perWord.map((p) => [p.word, p]));
    const wordsB = new Map(fb.metrics.perWord.map((p) => [p.word, p]));
    for (let w = 0; w < WORD_COUNT; w++) {
      const pa = wordsA.get(w);
      const pb = wordsB.get(w);
      if (!sameValue(pa?.cursorMs, pb?.cursorMs)) diff(`${wordLabel(w)} cursorMs a=${fmt(pa?.cursorMs)} b=${fmt(pb?.cursorMs)}`);
      if (!sameValue(pa?.confirmMs, pb?.confirmMs)) diff(`${wordLabel(w)} confirmMs a=${fmt(pa?.confirmMs)} b=${fmt(pb?.confirmMs)}`);
    }

    const stateA = finalStates(logsA.get(name) as LogEntry[]);
    const stateB = finalStates(logsB.get(name) as LogEntry[]);
    for (let w = 0; w < WORD_COUNT; w++) {
      const sa = stateA[w] as FinalState;
      const sb = stateB[w] as FinalState;
      if (sa === sb) continue;
      if (isFlip(sa, sb)) flipLines.push(`${name}: ${wordLabel(w)} final state a=${sa} b=${sb}`);
      else diff(`${wordLabel(w)} final state a=${sa} b=${sb}`);
    }

    const badA = everWrongOrSkipped(logsA.get(name) as LogEntry[]);
    const badB = everWrongOrSkipped(logsB.get(name) as LogEntry[]);
    if (badA.join() !== badB.join()) {
      diff(`ever wrong/skipped a=[${badA.map(wordLabel).join(", ")}] b=[${badB.map(wordLabel).join(", ")}]`);
    }

    if (fa.issues.length !== fb.issues.length) diff(`issues a=${fa.issues.length} b=${fb.issues.length}`);
    if (fa.metrics.falseAdvances !== fb.metrics.falseAdvances) {
      diff(`false advances a=${fa.metrics.falseAdvances} b=${fb.metrics.falseAdvances}`);
    }
    if (fa.metrics.restarts !== fb.metrics.restarts) diff(`restarts a=${fa.metrics.restarts} b=${fb.metrics.restarts}`);
    if (!sameValue(fa.metrics.timeToFirstLockSec, fb.metrics.timeToFirstLockSec)) {
      diff(`first lock sec a=${fmt(fa.metrics.timeToFirstLockSec)} b=${fmt(fb.metrics.timeToFirstLockSec)}`);
    }
  }

  out.flips = flipLines;
  out.flipsOverAllowance = Math.max(0, flipLines.length - allowStateFlips);
  // Over the allowance, every flip is reported as a failing difference.
  if (out.flipsOverAllowance > 0) out.differences.push(...flipLines);
  return out;
}

export function formatComparison(c: Comparison, allowStateFlips = 0): string {
  const lines: string[] = [];
  lines.push(`compared ${c.compared.length} file(s): ${c.compared.join(", ") || "-"}`);
  if (c.onlyInA.length > 0) lines.push(`only in a (not compared): ${c.onlyInA.join(", ")}`);
  if (c.onlyInB.length > 0) lines.push(`only in b (not compared): ${c.onlyInB.join(", ")}`);
  if (c.differences.length === 0 && c.flips.length === 0) {
    lines.push("identical");
    return lines.join("\n");
  }
  if (c.differences.length > 0) {
    lines.push(`${c.differences.length} difference(s):`);
    for (const d of c.differences) lines.push(`  ${d}`);
  }
  if (c.flips.length > 0 && c.flipsOverAllowance === 0) {
    lines.push(`${c.flips.length} ok/unsure final-state flip(s), within the allowed ${allowStateFlips}:`);
    for (const f of c.flips) lines.push(`  ${f}`);
    if (c.differences.length === 0) lines.push("identical apart from allowed flips");
  }
  return lines.join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Names that occur more than once, each listed once, in first-seen order. */
function duplicates(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const name of names) (seen.has(name) ? dup : seen).add(name);
  return [...dup];
}

/** Why a parsed results/logs file cannot be compared (wrong shape, duplicate recording names); empty when it can. */
export function fileProblems(kind: "results" | "logs", json: unknown): string[] {
  const files = isObject(json) ? json.files : undefined;
  if (!Array.isArray(files)) return ['no "files" array'];
  const problems: string[] = [];
  const names: string[] = [];
  files.forEach((f: unknown, i) => {
    const name = isObject(f) && typeof f.recording === "string" ? f.recording : null;
    if (name === null) return void problems.push(`files[${i}] has no "recording" name`);
    names.push(name);
    if (!isObject(f)) return;
    if (kind === "results") {
      const perWord = isObject(f.metrics) ? f.metrics.perWord : undefined;
      if (!Array.isArray(perWord) || !perWord.every(isObject)) problems.push(`${name}: no "metrics.perWord" array`);
      if (!Array.isArray(f.issues)) problems.push(`${name}: no "issues" array`);
    } else {
      const entries = isObject(f.log) ? f.log.entries : undefined;
      if (!Array.isArray(entries) || !entries.every(isObject)) problems.push(`${name}: no "log.entries" array`);
    }
  });
  const dup = duplicates(names);
  if (dup.length > 0) problems.push(`duplicate recording name(s): ${dup.join(", ")}`);
  return problems;
}

/** Reads and checks one input file; prints each problem and returns null when it cannot be compared. */
function readInput<T>(kind: "results" | "logs", path: string): T | null {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`${path}: cannot read as JSON (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
  const problems = fileProblems(kind, json);
  for (const problem of problems) console.error(`${path}: ${problem}`);
  return problems.length === 0 ? (json as T) : null;
}

function main(argv: string[]): void {
  const files: string[] = [];
  let allow = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--allow-state-flips") {
      const value = argv[++i] ?? "";
      if (!/^\d+$/.test(value)) {
        console.error(`bad --allow-state-flips "${value}" (expected a non-negative integer)`);
        process.exitCode = 2;
        return;
      }
      allow = Number(value);
    } else files.push(arg);
  }
  const [aResults, aLogs, bResults, bLogs] = files;
  if (!aResults || !aLogs || !bResults || !bLogs || files.length !== 4) {
    console.error(
      "usage: node scripts/compare-runs.ts <a_results.json> <a_eventlogs.json> <b_results.json> <b_eventlogs.json> [--allow-state-flips N]",
    );
    process.exitCode = 2;
    return;
  }
  const inputs = [
    readInput<ResultsJson>("results", aResults),
    readInput<LogsJson>("logs", aLogs),
    readInput<ResultsJson>("results", bResults),
    readInput<LogsJson>("logs", bLogs),
  ];
  if (inputs.includes(null)) {
    process.exitCode = 2;
    return;
  }
  const [ar, al, br, bl] = inputs as [ResultsJson, LogsJson, ResultsJson, LogsJson];
  const a: Run = { results: ar, logs: al };
  const b: Run = { results: br, logs: bl };
  const comparison = compareRuns(a, b, allow);
  console.log(formatComparison(comparison, allow));
  if (comparison.compared.length === 0) process.exitCode = 2;
  else if (comparison.differences.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
