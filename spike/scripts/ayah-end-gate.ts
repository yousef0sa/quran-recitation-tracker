// Offline simulation of an ayah-end "gate": node scripts/ayah-end-gate.ts <results.json> <eventlogs.json> [--labels-dir <dir>] [--sweep] [--param name=value ...]
// For each ayah-final word (global indices 3, 7, 9, 12, 16, 19, 28) it replays the logged entries causally (only entries at or
// before t) and finds when a gate rule would turn the word green, compared with tilawa's own confirm R0.
//   R0  tilawa's confirm: audio time of the first entry where the word is in entry.confirmed OR in a surah-1 word_progress
//       matched_indices (the rule of computeMetrics in src/metrics.ts); self-checked against perWord[w].confirmMs (1 ms).
//   R1  voicing: verdict shown and h >= H, no issue at the chunk, no raw_transcript in the last N ms, and the last U ms are
//       all unvoiced (rmsDb < running 10th-percentile floor + D dB, or clarity < C). Needs entry.voice.
//   R2  CTC: same (a)/(b), but the last U2 ms hold at least one model step and every one has ctc.blank >= B and ctc.top < P.
//   R3  R1 and R2 both.
// Simulated confirm Sx = min(R0, Rx). Gate-caused early = Rx < R0 and Rx < the labelled word end; baseline early = R0 < end.
// Verdict check: when Rx < R0 the state the gate would show (tilawa's d/m rule on the verdict in force at Rx) must equal the
// word's final state (last non-empty list, else its last non-pending state; "n/a" is reported, not counted), the word must
// never be "wrong" in a list after Rx, and for idx 28 the shown state must equal its last verdict's state.
// Old logs without voice/ctc give R1/R2 "n/a". Labels: wordEnds of results files[].labelsFrom, read from --labels-dir
// (default recordings/ or recordings/<recordingsDir>). Prints positions ("1:6 w1" = ayah 6, word 1), file numbers and numbers only,
// never transcript or verse text. Exit code 1 when the R0 self-check fails, 2 on bad usage or when no recording is in both files.
// Node runs this file by stripping types: erasable syntax only, and only `node:` imports.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Copy of AYAH_WORD_COUNTS in src/fatiha.ts (this script imports nothing from src/).
const AYAH_WORD_COUNTS = [4, 4, 2, 3, 4, 3, 9];
const WORD_COUNT = 29;
const TARGET_RATE = 16000;
/** Entry times are compared with this slack (seconds). */
const EPS = 1e-6;
/** tilawa's defaults (config.js): okDistance, unsureDistance, minMargin. */
const OK_DISTANCE = 0.15;
const UNSURE_DISTANCE = 0.4;
const MIN_MARGIN = 0.35;
/** Floor used until 1.0 s of real-audio history exists, dBFS. */
const FLOOR_DEFAULT_DB = -60;
const FLOOR_HISTORY_SEC = 1.0;
const FLOOR_PERCENTILE = 10;
/** An entry this voiced resets the unvoiced window (research 4.4). */
const STRONG_CLARITY = 0.8;
const SELF_CHECK_MS = 1;

type VerdictState = "ok" | "unsure" | "wrong" | "skipped" | "pending";
export type FinalState = VerdictState | "n/a";
export type ShownState = "ok" | "unsure";
export type Rule = "R1" | "R2" | "R3";
export type ConfirmSource = "confirmed" | "matched" | "both";

export interface CompactVerdict {
  w: number;
  s: VerdictState;
  d: number;
  h: number;
  m: number;
}
export interface LogEvent {
  type: string;
  surah?: number;
  ayah?: number;
  matched_indices?: number[];
}
export interface LogEntry {
  chunkId: number;
  audioTimeSec: number;
  events: LogEvent[];
  confirmed?: number[];
  verdicts?: CompactVerdict[];
  /** Absent in old logs, null for the zero tail. */
  voice?: { rmsDb: number; clarity: number; f0: number | null } | null;
  /** Only on entries with a model run. */
  ctc?: { blank: number | null; top: number | null } | null;
  flush?: boolean;
}
export interface ResultsFile {
  recording: string;
  labelsFrom: string;
  durationSec: number;
  metrics: { perWord: { word: number; cursorMs: number | null; confirmMs: number | null }[] };
  issues: { chunkId: number }[];
}
export interface ResultsJson {
  variant?: string;
  chunkMs: number;
  backend?: string;
  threads?: number;
  recordingsDir?: string | null;
  files: ResultsFile[];
}
export interface LogsJson {
  files: { recording: string; log: { entries: LogEntry[] } }[];
}

export interface Params {
  /** Minimum heardRatio of the verdict. */
  H: number;
  /** No raw_transcript within the last N ms. */
  N: number;
  /** R1 window (ms), floor offset (dB), clarity threshold. */
  U: number;
  D: number;
  C: number;
  /** R2 window (ms), blank and top thresholds. */
  U2: number;
  B: number;
  P: number;
}
export const DEFAULT_PARAMS: Params = { H: 0.7, N: 480, U: 240, D: 8, C: 0.5, U2: 320, B: 0.95, P: 0.2 };
const PARAM_KEYS = Object.keys(DEFAULT_PARAMS) as (keyof Params)[];

const OFFSETS: number[] = [];
{
  let sum = 0;
  for (const count of AYAH_WORD_COUNTS) {
    OFFSETS.push(sum);
    sum += count;
  }
}
/** Global indices of the last word of each ayah: 3, 7, 9, 12, 16, 19, 28. */
export const AYAH_END_WORDS: readonly number[] = AYAH_WORD_COUNTS.map((count, i) => (OFFSETS[i] as number) + count - 1);
const LAST_WORD = WORD_COUNT - 1;

/** Global index 0..28 -> "1:<ayah> w<n>" (n = 1-based word in the ayah). */
export function wordLabel(global: number): string {
  for (let ayah = AYAH_WORD_COUNTS.length; ayah >= 1; ayah--) {
    const offset = OFFSETS[ayah - 1] as number;
    if (global >= offset) return `1:${ayah} w${global - offset + 1}`;
  }
  return `?${global}`;
}

/** (ayah 1..7, word index in ayah) -> global index, or null when out of range (like tryToGlobalWordIndex in src/fatiha.ts). */
function globalIndex(ayah: unknown, wordIndex: unknown): number | null {
  if (typeof ayah !== "number" || typeof wordIndex !== "number" || !Number.isInteger(ayah) || !Number.isInteger(wordIndex)) return null;
  if (ayah < 1 || ayah > AYAH_WORD_COUNTS.length) return null;
  if (wordIndex < 0 || wordIndex >= (AYAH_WORD_COUNTS[ayah - 1] as number)) return null;
  return (OFFSETS[ayah - 1] as number) + wordIndex;
}

/** Same linear-interpolation percentile as percentile() in src/metrics.ts. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return percentileSorted(sorted, p);
}

function percentileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (rank - lo);
}

/** tilawa's state of a verdict as shown on screen, or null when it would not be shown (wrong, skipped, or a pending one failing the d/m rule). */
export function shownState(v: CompactVerdict): ShownState | null {
  if (v.s === "ok" || v.s === "unsure") return v.s;
  if (v.s !== "pending") return null;
  if (v.d <= OK_DISTANCE) return "ok";
  if (v.d <= UNSURE_DISTANCE || v.m < MIN_MARGIN) return "unsure";
  return null;
}

/** Final state of each word 0..28: last non-empty verdict list, else the last non-pending state in any list, else "n/a" (same as compare-runs.ts). */
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

export interface ConfirmTimes {
  time: (number | null)[];
  source: (ConfirmSource | null)[];
}

/** R0 for every word: first entry (flush included, like computeMetrics) where it is in confirmed or in a surah-1 matched_indices. */
export function confirmTimes(entries: readonly LogEntry[]): ConfirmTimes {
  const time: (number | null)[] = new Array<number | null>(WORD_COUNT).fill(null);
  const source: (ConfirmSource | null)[] = new Array<ConfirmSource | null>(WORD_COUNT).fill(null);
  for (const entry of entries) {
    const fromConfirmed = new Set<number>();
    for (const w of entry.confirmed ?? []) if (Number.isInteger(w) && w >= 0 && w < WORD_COUNT) fromConfirmed.add(w);
    const fromMatched = new Set<number>();
    for (const event of entry.events) {
      if (event.type !== "word_progress" || event.surah !== 1) continue;
      for (const index of event.matched_indices ?? []) {
        const w = globalIndex(event.ayah, index);
        if (w !== null) fromMatched.add(w);
      }
    }
    for (const w of new Set([...fromConfirmed, ...fromMatched])) {
      if (time[w] !== null) continue;
      time[w] = entry.audioTimeSec;
      source[w] = fromConfirmed.has(w) && fromMatched.has(w) ? "both" : fromConfirmed.has(w) ? "confirmed" : "matched";
    }
  }
  return { time, source };
}

/**
 * Running floor (dBFS) per entry: 10th percentile of rmsDb over the earlier entries that carry real audio (voice not null),
 * -60 until they cover 1.0 s. Entry i never sees entry i or later, nor the zero tail.
 */
export function runningFloor(entries: readonly LogEntry[], chunkSec: number): number[] {
  const sorted: number[] = [];
  const out: number[] = [];
  for (const entry of entries) {
    out.push(sorted.length * chunkSec >= FLOOR_HISTORY_SEC - EPS ? percentileSorted(sorted, FLOOR_PERCENTILE) : FLOOR_DEFAULT_DB);
    if (entry.voice) {
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((sorted[mid] as number) < entry.voice.rmsDb) lo = mid + 1;
        else hi = mid;
      }
      sorted.splice(lo, 0, entry.voice.rmsDb);
    }
  }
  return out;
}

export interface FileCtx {
  recording: string;
  wordEnds: number[];
  chunkSec: number;
  /** Entries the gate may use: non-flush, and (without tail) only real audio. */
  search: LogEntry[];
  times: number[];
  /** Verdict list in force at each search entry. */
  lists: CompactVerdict[][];
  /** True where no issue was logged at the entry's chunk. */
  noIssue: boolean[];
  floor: number[];
  hasVoice: boolean;
  hasCtc: boolean;
  r0: ConfirmTimes;
  final: FinalState[];
  /** Last verdict of each word in any list of the full log (null if never listed). */
  lastVerdict: (CompactVerdict | null)[];
  /** Latest time at which an entry's own list (flush included) held the word as "wrong"; -Infinity if never. */
  lastWrong: number[];
  cache: Map<string, boolean[]>;
}

export interface CtxInput {
  recording: string;
  wordEnds: number[];
  chunkMs: number;
  durationSec: number;
  issues: { chunkId: number }[];
  entries: readonly LogEntry[];
  /** true: the 2 s zero tail and the flush entry are part of the replay (R0 sees them); false: real audio only. */
  tail: boolean;
}

export function buildCtx(input: CtxInput): FileCtx {
  const real = (e: LogEntry) => e.audioTimeSec <= input.durationSec + EPS;
  const used = input.tail ? input.entries : input.entries.filter(real);
  const search: LogEntry[] = [];
  const lists: CompactVerdict[][] = [];
  let current: CompactVerdict[] = [];
  for (const entry of used) {
    if (Array.isArray(entry.verdicts)) current = entry.verdicts;
    if (entry.flush) continue;
    search.push(entry);
    lists.push(current);
  }
  const issueChunks = new Set(input.issues.map((i) => i.chunkId));
  const chunkSec = input.chunkMs / 1000;
  const lastVerdict: (CompactVerdict | null)[] = new Array<CompactVerdict | null>(WORD_COUNT).fill(null);
  const lastWrong: number[] = new Array<number>(WORD_COUNT).fill(Number.NEGATIVE_INFINITY);
  for (const entry of input.entries) {
    for (const v of entry.verdicts ?? []) {
      if (v.w < 0 || v.w >= WORD_COUNT) continue;
      lastVerdict[v.w] = v;
      if (v.s === "wrong") lastWrong[v.w] = Math.max(lastWrong[v.w] as number, entry.audioTimeSec);
    }
  }
  return {
    recording: input.recording,
    wordEnds: input.wordEnds,
    chunkSec,
    search,
    times: search.map((e) => e.audioTimeSec),
    lists,
    noIssue: search.map((e) => !issueChunks.has(e.chunkId)),
    floor: runningFloor(search, chunkSec),
    hasVoice: input.entries.some((e) => e.voice !== undefined),
    hasCtc: input.entries.some((e) => e.ctc !== undefined),
    r0: confirmTimes(used),
    final: finalStates(input.entries),
    lastVerdict,
    lastWrong,
    cache: new Map(),
  };
}

export function ruleAvailable(ctx: FileCtx, rule: Rule): boolean {
  if (rule === "R1") return ctx.hasVoice;
  if (rule === "R2") return ctx.hasCtc;
  return ctx.hasVoice && ctx.hasCtc;
}

function cached(ctx: FileCtx, key: string, make: () => boolean[]): boolean[] {
  let value = ctx.cache.get(key);
  if (!value) {
    value = make();
    ctx.cache.set(key, value);
  }
  return value;
}

/** Index of the first entry of the window "last ms" ending at entry i (entries with t > t_i - ms). */
function windowStart(ctx: FileCtx, i: number, ms: number): number {
  const from = (ctx.times[i] as number) - ms / 1000 + EPS;
  let j = i;
  while (j > 0 && (ctx.times[j - 1] as number) >= from) j--;
  return j;
}

/** Condition (a): the word's verdict in force at the entry would be shown and h >= H. */
export function eligible(ctx: FileCtx, word: number, H: number): boolean[] {
  return cached(ctx, `e|${word}|${H}`, () =>
    ctx.lists.map((list) => {
      const v = list.find((x) => x.w === word);
      return v !== undefined && shownState(v) !== null && v.h >= H - 1e-9;
    }),
  );
}

/** Condition (b): no raw_transcript in the last N ms (the flush entry is not in `search`). */
export function noRaw(ctx: FileCtx, N: number): boolean[] {
  return cached(ctx, `r|${N}`, () => {
    let lastRaw = Number.NEGATIVE_INFINITY;
    return ctx.search.map((entry, i) => {
      const t = ctx.times[i] as number;
      if (entry.events.some((e) => e.type === "raw_transcript")) lastRaw = t;
      return lastRaw < t - N / 1000 + EPS;
    });
  });
}

/** R1 condition (c): every entry in the last U ms has real audio and is unvoiced (floor taken at the firing entry). */
export function voiceWindow(ctx: FileCtx, U: number, D: number, C: number): boolean[] {
  return cached(ctx, `v|${U}|${D}|${C}`, () =>
    ctx.search.map((_, i) => {
      if ((ctx.times[i] as number) < U / 1000 - EPS) return false;
      const limit = (ctx.floor[i] as number) + D;
      for (let j = windowStart(ctx, i, U); j <= i; j++) {
        const voice = ctx.search[j]?.voice;
        if (!voice) return false;
        if (voice.clarity >= STRONG_CLARITY && voice.rmsDb >= limit) return false;
        if (!(voice.rmsDb < limit || voice.clarity < C)) return false;
      }
      return true;
    }),
  );
}

/** R2 condition (c): the last U2 ms hold at least one model step, and every one has blank >= B and top < P. */
export function ctcWindow(ctx: FileCtx, U2: number, B: number, P: number): boolean[] {
  return cached(ctx, `c|${U2}|${B}|${P}`, () =>
    ctx.search.map((_, i) => {
      if ((ctx.times[i] as number) < U2 / 1000 - EPS) return false;
      let steps = 0;
      for (let j = windowStart(ctx, i, U2); j <= i; j++) {
        const ctc = ctx.search[j]?.ctc;
        if (!ctc || ctc.blank === null || ctc.top === null) continue;
        steps++;
        if (!(ctc.blank >= B && ctc.top < P)) return false;
      }
      return steps > 0;
    }),
  );
}

/** Index in ctx.search of the first entry where the rule fires for the word, or null. */
export function fireIndex(ctx: FileCtx, rule: Rule, p: Params, word: number): number | null {
  if (!ruleAvailable(ctx, rule)) return null;
  const elig = eligible(ctx, word, p.H);
  const quiet = noRaw(ctx, p.N);
  const voice = rule === "R2" ? null : voiceWindow(ctx, p.U, p.D, p.C);
  const ctc = rule === "R1" ? null : ctcWindow(ctx, p.U2, p.B, p.P);
  for (let i = 0; i < ctx.search.length; i++) {
    if (elig[i] && ctx.noIssue[i] && quiet[i] && (voice === null || voice[i]) && (ctc === null || ctc[i])) return i;
  }
  return null;
}

export interface CaseResult {
  word: number;
  endSec: number;
  /** Tilawa's confirm, seconds of audio; null = never confirmed. */
  r0: number | null;
  r0Source: ConfirmSource | null;
  /** Gate time; null when the rule never fired (or n/a). */
  rx: number | null;
  sx: number | null;
  /** (Sx - labelled end) in ms; null when never confirmed. */
  latencyMs: number | null;
  /** Rx < R0 (R0 null counts as +infinity). */
  gateFires: boolean;
  gateEarly: boolean;
  baseEarly: boolean;
  /** (Rx - end) in ms when the gate fires before R0. */
  marginMs: number | null;
  shown: ShownState | null;
  final: FinalState;
  /** Last verdict's shown state (idx 28 only). */
  lastShown: ShownState | null;
  stateMismatch: boolean;
  wrongAfter: boolean;
  lastMismatch: boolean;
  mismatch: boolean;
}

export function evaluateCase(ctx: FileCtx, rule: Rule | "R0", p: Params, word: number): CaseResult {
  const endSec = ctx.wordEnds[word] as number;
  const r0 = ctx.r0.time[word] ?? null;
  const index = rule === "R0" ? null : fireIndex(ctx, rule, p, word);
  const rx = index === null ? null : (ctx.times[index] as number);
  const gateFires = rx !== null && (r0 === null || rx < r0 - EPS);
  const sx = rx === null ? r0 : r0 === null ? rx : Math.min(r0, rx);
  const verdict = index === null ? undefined : (ctx.lists[index] as CompactVerdict[]).find((v) => v.w === word);
  const shown = gateFires && verdict ? shownState(verdict) : null;
  const final = ctx.final[word] as FinalState;
  const last = ctx.lastVerdict[word];
  const lastShown = word === LAST_WORD && last ? shownState(last) : null;
  const stateMismatch = gateFires && final !== "n/a" && shown !== final;
  const wrongAfter = gateFires && rx !== null && (ctx.lastWrong[word] as number) > rx + EPS;
  const lastMismatch = gateFires && word === LAST_WORD && shown !== lastShown;
  return {
    word,
    endSec,
    r0,
    r0Source: ctx.r0.source[word] ?? null,
    rx,
    sx,
    latencyMs: sx === null ? null : (sx - endSec) * 1000,
    gateFires,
    gateEarly: gateFires && rx !== null && rx < endSec,
    baseEarly: r0 !== null && r0 < endSec,
    marginMs: gateFires && rx !== null ? (rx - endSec) * 1000 : null,
    shown,
    final,
    lastShown,
    stateMismatch,
    wrongAfter,
    lastMismatch,
    mismatch: stateMismatch || wrongAfter || lastMismatch,
  };
}

export interface Summary {
  /** Ayah-end cases (files x 7 words). */
  cases: number;
  /** Cases never confirmed by Sx. */
  never: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  gateFires: number;
  gateEarly: number;
  /** Most negative (Rx - end) over gate-caused early cases, ms. */
  worstEarlyMs: number | null;
  baseEarly: number;
  mismatches: number;
  /** Cases where the gate fired before R0 and the final state is "n/a" (reported, not counted). */
  finalNa: number;
  /** Smallest (Rx - end) over the cases where the gate fires before R0, ms. */
  marginMs: number | null;
  nullR0: number;
  nullR0Gated: number;
}

export function summarize(cases: readonly CaseResult[]): Summary {
  const latencies = cases.flatMap((c) => (c.latencyMs === null ? [] : [c.latencyMs]));
  const early = cases.filter((c) => c.gateEarly);
  const margins = cases.flatMap((c) => (c.marginMs === null ? [] : [c.marginMs]));
  const pick = (v: number) => (Number.isNaN(v) ? null : v);
  return {
    cases: cases.length,
    never: cases.length - latencies.length,
    p50: pick(percentile(latencies, 50)),
    p95: pick(percentile(latencies, 95)),
    max: latencies.length > 0 ? Math.max(...latencies) : null,
    gateFires: cases.filter((c) => c.gateFires).length,
    gateEarly: early.length,
    worstEarlyMs: early.length > 0 ? Math.min(...early.map((c) => c.marginMs as number)) : null,
    baseEarly: cases.filter((c) => c.baseEarly).length,
    mismatches: cases.filter((c) => c.mismatch).length,
    finalNa: cases.filter((c) => c.gateFires && c.final === "n/a").length,
    marginMs: margins.length > 0 ? Math.min(...margins) : null,
    nullR0: cases.filter((c) => c.r0 === null).length,
    nullR0Gated: cases.filter((c) => c.r0 === null && c.rx !== null).length,
  };
}

/** Every ayah-end case of every context for one rule (null when the rule is n/a for any file). */
export function evaluateRule(ctxs: readonly FileCtx[], rule: Rule | "R0", p: Params): CaseResult[] | null {
  if (rule !== "R0" && ctxs.some((c) => !ruleAvailable(c, rule))) return null;
  return ctxs.flatMap((ctx) => AYAH_END_WORDS.map((w) => evaluateCase(ctx, rule, p, w)));
}

/** Number of ayah-end cases that have a shown verdict with h >= H at some entry. */
export function eligibleCount(ctxs: readonly FileCtx[], H: number): number {
  let n = 0;
  for (const ctx of ctxs) for (const w of AYAH_END_WORDS) if (eligible(ctx, w, H).some(Boolean)) n++;
  return n;
}

// ---- sweep ----

const H_GRID = [0.34, 0.5, 0.7, 0.85];
const N_GRID = [320, 400, 480, 640];
const U_GRID = [160, 240, 400];
const U2_GRID = [320, 640];
const D_GRID = [6, 8, 10];
const C_GRID = [0.4, 0.5, 0.6];
const B_GRID = [0.9, 0.95];
const P_GRID = [0.1, 0.2];

function* gridFor(rule: Rule, base: Params): Generator<Params> {
  const voice = rule !== "R2";
  const ctc = rule !== "R1";
  for (const H of H_GRID)
    for (const N of N_GRID)
      for (const U of voice ? U_GRID : [base.U])
        for (const D of voice ? D_GRID : [base.D])
          for (const C of voice ? C_GRID : [base.C])
            for (const U2 of ctc ? U2_GRID : [base.U2])
              for (const B of ctc ? B_GRID : [base.B])
                for (const P of ctc ? P_GRID : [base.P]) yield { H, N, U, D, C, U2, B, P };
}

export interface SweepRow {
  params: Params;
  summary: Summary;
}

export interface SweepResult {
  total: number;
  /** Rows with 0 gate-caused early and 0 mismatches, best first (lowest p95, then p50, then largest margin). */
  valid: SweepRow[];
}

export function sweepRule(ctxs: readonly FileCtx[], rule: Rule, base: Params): SweepResult {
  let total = 0;
  const valid: SweepRow[] = [];
  for (const params of gridFor(rule, base)) {
    const cases = evaluateRule(ctxs, rule, params);
    if (cases === null) return { total: 0, valid: [] };
    total++;
    const summary = summarize(cases);
    if (summary.gateEarly === 0 && summary.mismatches === 0 && summary.p95 !== null) valid.push({ params, summary });
  }
  const key = (r: SweepRow) => [r.summary.p95 as number, r.summary.p50 as number, -(r.summary.marginMs ?? Number.POSITIVE_INFINITY)];
  valid.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return (ka[i] as number) - (kb[i] as number);
    return 0;
  });
  return { total, valid };
}

// ---- output ----

function ms(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  const r = Math.round(value);
  return r > 0 ? `+${r}` : String(r);
}

function paramText(rule: Rule, p: Params): string {
  const parts = [`H=${p.H}`, `N=${p.N}`];
  if (rule !== "R2") parts.push(`U=${p.U}`, `D=${p.D}`, `C=${p.C}`);
  if (rule !== "R1") parts.push(`U2=${p.U2}`, `B=${p.B}`, `P=${p.P}`);
  return parts.join(" ");
}

function summaryLine(label: string, s: Summary): string {
  return [
    label.padEnd(6),
    `n=${s.cases}`.padEnd(5),
    `p50=${ms(s.p50)}`.padEnd(10),
    `p95=${ms(s.p95)}`.padEnd(10),
    `max=${ms(s.max)}`.padEnd(10),
    `gateEarly=${s.gateEarly}`.padEnd(12),
    `worst=${ms(s.worstEarlyMs)}`.padEnd(11),
    `baseEarly=${s.baseEarly}`.padEnd(12),
    `mismatch=${s.mismatches}`.padEnd(11),
    `margin=${ms(s.marginMs)}`.padEnd(12),
    `fires=${s.gateFires}`.padEnd(9),
    `never=${s.never}`.padEnd(8),
    `nullR0=${s.nullR0}(gated ${s.nullR0Gated})`,
  ].join(" ");
}

function caseLine(file: number, c: CaseResult): string {
  return `  f${file} ${wordLabel(c.word).padEnd(7)} R0=${ms(c.r0 === null ? null : (c.r0 - c.endSec) * 1000)} (${c.r0Source ?? "never"})  Rx=${ms(
    c.rx === null ? null : (c.rx - c.endSec) * 1000,
  )}  Sx=${ms(c.latencyMs)}  shown=${c.shown ?? "-"} final=${c.final}${c.word === LAST_WORD ? ` last=${c.lastShown ?? "-"}` : ""}${
    c.gateEarly ? "  GATE-EARLY" : ""
  }${c.baseEarly ? "  base-early" : ""}${c.mismatch ? "  MISMATCH" : ""}`;
}

export interface Analysis {
  header: string[];
  selfCheck: string[];
  lines: string[];
}

export interface RunInput {
  results: ResultsJson;
  logs: LogsJson;
  labelsFor: (file: ResultsFile) => { wordEnds: number[] };
  params: Params;
  sweep: boolean;
}

/** Recordings present in both the results file and the event logs (in results order), and those present in only one. */
export function commonRecordings(
  results: ResultsJson,
  logs: LogsJson,
): { common: string[]; onlyInResults: string[]; onlyInLogs: string[] } {
  const inLogs = new Set(logs.files.map((f) => f.recording));
  const inResults = new Set(results.files.map((f) => f.recording));
  return {
    common: results.files.map((f) => f.recording).filter((name) => inLogs.has(name)),
    onlyInResults: results.files.map((f) => f.recording).filter((name) => !inLogs.has(name)),
    onlyInLogs: logs.files.map((f) => f.recording).filter((name) => !inResults.has(name)),
  };
}

function buildCtxs(input: RunInput, tail: boolean): FileCtx[] {
  const logs = new Map(input.logs.files.map((f) => [f.recording, f.log.entries]));
  const out: FileCtx[] = [];
  for (const file of input.results.files) {
    const entries = logs.get(file.recording);
    if (!entries) continue;
    out.push(
      buildCtx({
        recording: file.recording,
        wordEnds: input.labelsFor(file).wordEnds,
        chunkMs: input.results.chunkMs,
        durationSec: file.durationSec,
        issues: file.issues,
        entries,
        tail,
      }),
    );
  }
  return out;
}

/** R0 against perWord.confirmMs for all 29 words; returns the mismatch lines. */
export function selfCheck(results: ResultsJson, ctxs: readonly FileCtx[]): string[] {
  const out: string[] = [];
  const byName = new Map(results.files.map((f) => [f.recording, f]));
  ctxs.forEach((ctx, k) => {
    const file = byName.get(ctx.recording) as ResultsFile;
    for (let w = 0; w < WORD_COUNT; w++) {
      const expected = file.metrics.perWord.find((p) => p.word === w)?.confirmMs ?? null;
      const r0 = ctx.r0.time[w] ?? null;
      const mine = r0 === null ? null : (r0 - (ctx.wordEnds[w] as number)) * 1000;
      const same = (mine === null && expected === null) || (mine !== null && expected !== null && Math.abs(mine - expected) <= SELF_CHECK_MS);
      if (!same) out.push(`f${k + 1} ${wordLabel(w)}: R0 ${ms(mine)} ms vs perWord.confirmMs ${ms(expected)} ms`);
    }
  });
  return out;
}

const RULES: Rule[] = ["R1", "R2", "R3"];

export function analyze(input: RunInput): Analysis {
  const { results, params } = input;
  if (commonRecordings(results, input.logs).common.length === 0) throw new Error("no recording is in both the results file and the event logs");
  const full = buildCtxs(input, true);
  const noTail = buildCtxs(input, false);
  const lines: string[] = [];
  const header = [
    `variant=${results.variant ?? "?"} chunk=${results.chunkMs} ms backend=${results.backend ?? "?"} threads=${results.threads ?? "?"} set=${
      results.recordingsDir ?? "main"
    } files=${full.length}`,
    ...full.map((c, k) => `f${k + 1} = ${c.recording}`),
    `voice in log: ${full.map((c) => (c.hasVoice ? "yes" : "no")).join(" ")}; ctc in log: ${full.map((c) => (c.hasCtc ? "yes" : "no")).join(" ")}`,
  ];
  const check = selfCheck(results, full);

  const base = evaluateRule(full, "R0", params) as CaseResult[];
  lines.push("", "== R0 (tilawa's own confirm) per ayah-end word: latency vs labelled end, ms ==");
  full.forEach((_, k) => {
    for (const c of base.slice(k * AYAH_END_WORDS.length, (k + 1) * AYAH_END_WORDS.length)) {
      lines.push(
        `  f${k + 1} ${wordLabel(c.word).padEnd(7)} R0=${ms(c.latencyMs)} (${c.r0Source ?? "never"})${c.baseEarly ? "  base-early" : ""}`,
      );
    }
  });

  lines.push("", `== eligibility: ayah-end cases (of ${full.length * AYAH_END_WORDS.length}) with a shown verdict and h >= H at some entry ==`);
  lines.push("  " + H_GRID.map((H) => `H=${H}: ${eligibleCount(full, H)}`).join("   "));

  lines.push("", "== default parameters ==");
  lines.push("  " + summaryLine("R0", summarize(base)));
  const defaults = new Map<Rule, CaseResult[] | null>();
  for (const rule of RULES) {
    const cases = evaluateRule(full, rule, params);
    defaults.set(rule, cases);
    lines.push(cases === null ? `  ${rule.padEnd(6)} n/a (log has no ${rule === "R1" ? "voice" : rule === "R2" ? "ctc" : "voice or ctc"} fields)` : "  " + summaryLine(rule, summarize(cases)));
    lines.push(`         params: ${paramText(rule, params)}`);
  }

  for (const rule of RULES) {
    const cases = defaults.get(rule);
    if (!cases) continue;
    const fired = cases.map((c, i) => ({ c, file: Math.floor(i / AYAH_END_WORDS.length) + 1 })).filter((x) => x.c.gateFires);
    lines.push("", `== ${rule} cases where the gate fires before R0 (${fired.length}) ==`);
    for (const x of fired) lines.push(caseLine(x.file, x.c));
  }

  lines.push("", `== 1:7 w9 (idx ${LAST_WORD}) per file, default parameters: latency vs labelled end, ms ==`);
  const last = AYAH_END_WORDS.indexOf(LAST_WORD);
  for (const [name, ctxs] of [
    ["with zero tail", full],
    ["without tail ", noTail],
  ] as const) {
    ctxs.forEach((ctx, k) => {
      const parts: string[] = [];
      const row = (rule: Rule | "R0") => {
        const cases = evaluateRule([ctx], rule, params);
        if (cases === null) return `${rule}: n/a`;
        const c = cases[last] as CaseResult;
        const rx = c.rx === null ? "-" : ms((c.rx - c.endSec) * 1000);
        return rule === "R0"
          ? `R0: ${ms(c.latencyMs)}${c.baseEarly ? " base-early" : ""}`
          : `${rule}: Rx=${rx} Sx=${ms(c.latencyMs)}${c.gateEarly ? " GATE-EARLY" : ""}${c.gateFires ? ` shown=${c.shown ?? "-"} last=${c.lastShown ?? "-"}${c.mismatch ? " MISMATCH" : ""}` : ""}`;
      };
      for (const rule of ["R0", ...RULES] as const) parts.push(row(rule));
      lines.push(`  f${k + 1} ${name}  ${parts.join(" | ")}`);
    });
  }

  if (input.sweep) {
    lines.push("", `== sweep (criterion: 0 gate-caused early and 0 mismatches on this set; ${full.length} files cannot support a Pareto claim) ==`);
    for (const rule of RULES) {
      if (!ruleAvailable(full[0] as FileCtx, rule) || full.some((c) => !ruleAvailable(c, rule))) {
        lines.push(`  ${rule} n/a`);
        continue;
      }
      const result = sweepRule(full, rule, params);
      lines.push(`  ${rule}: ${result.valid.length} of ${result.total} parameter rows pass; best rows (lowest ayah-end p95):`);
      for (const row of result.valid.slice(0, 5)) lines.push("    " + summaryLine(rule, row.summary) + "  | " + paramText(rule, row.params));
      const d = defaults.get(rule);
      if (d) lines.push("    default row:      " + summaryLine(rule, summarize(d)) + "  | " + paramText(rule, params));
    }
  }
  return { header, selfCheck: check, lines };
}

// ---- CLI ----

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function parseParams(args: readonly string[]): Params | string {
  const params: Params = { ...DEFAULT_PARAMS };
  for (const arg of args) {
    const match = /^([A-Za-z0-9]+)=(-?\d+(?:\.\d+)?)$/.exec(arg);
    const key = match ? (match[1] as keyof Params) : undefined;
    if (!match || key === undefined || !PARAM_KEYS.includes(key)) return `bad --param "${arg}" (expected ${PARAM_KEYS.join("|")}=<number>)`;
    params[key] = Number(match[2]);
  }
  return params;
}

function main(argv: string[]): void {
  const files: string[] = [];
  const paramArgs: string[] = [];
  let labelsDir: string | null = null;
  let sweep = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--sweep") sweep = true;
    else if (arg === "--labels-dir") labelsDir = argv[++i] ?? null;
    else if (arg === "--param") paramArgs.push(argv[++i] ?? "");
    else files.push(arg);
  }
  const [resultsPath, logsPath] = files;
  const params = parseParams(paramArgs);
  if (!resultsPath || !logsPath || files.length !== 2 || typeof params === "string") {
    console.error(typeof params === "string" ? params : "");
    console.error(
      "usage: node scripts/ayah-end-gate.ts <results.json> <eventlogs.json> [--labels-dir <dir>] [--sweep] [--param H|N|U|D|C|U2|B|P=<number> ...]",
    );
    process.exitCode = 2;
    return;
  }
  const results = readJson<ResultsJson>(resultsPath);
  const logs = readJson<LogsJson>(logsPath);
  const match = commonRecordings(results, logs);
  if (match.common.length === 0) {
    console.error("no recording is in both the results file and the event logs (results and logs must come from the same run)");
    console.error(`results: ${match.onlyInResults.join(", ") || "(none)"}`);
    console.error(`logs: ${match.onlyInLogs.join(", ") || "(none)"}`);
    process.exitCode = 2;
    return;
  }
  if (match.onlyInResults.length > 0) console.error(`warning: in the results only, skipped: ${match.onlyInResults.join(", ")}`);
  if (match.onlyInLogs.length > 0) console.error(`warning: in the logs only, skipped: ${match.onlyInLogs.join(", ")}`);
  const dir = labelsDir ?? (results.recordingsDir ? join("recordings", results.recordingsDir) : "recordings");
  let missing = false;
  const labelCache = new Map<string, { wordEnds: number[] }>();
  const analysis = analyze({
    results,
    logs,
    params,
    sweep,
    labelsFor: (file) => {
      const path = join(dir, file.labelsFrom);
      const hit = labelCache.get(path);
      if (hit) return hit;
      try {
        const labels = readJson<{ wordEnds?: number[] }>(path);
        if (!Array.isArray(labels.wordEnds) || labels.wordEnds.length !== WORD_COUNT) throw new Error("no wordEnds");
        const loaded = { wordEnds: labels.wordEnds };
        labelCache.set(path, loaded);
        return loaded;
      } catch {
        missing = true;
        console.error(`cannot read labels for file ${results.files.indexOf(file) + 1} from ${dir}`);
        const empty = { wordEnds: new Array<number>(WORD_COUNT).fill(Number.NaN) };
        labelCache.set(path, empty);
        return empty;
      }
    },
  });
  if (missing) {
    process.exitCode = 2;
    return;
  }
  console.log(analysis.header.join("\n"));
  if (analysis.selfCheck.length > 0) {
    console.log(`R0 self-check FAILED (${analysis.selfCheck.length} word(s) differ from perWord.confirmMs by more than ${SELF_CHECK_MS} ms):`);
    for (const line of analysis.selfCheck) console.log("  " + line);
    process.exitCode = 1;
  } else {
    console.log(`R0 self-check: all ${match.common.length * WORD_COUNT} words match perWord.confirmMs within ${SELF_CHECK_MS} ms`);
  }
  console.log(analysis.lines.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
