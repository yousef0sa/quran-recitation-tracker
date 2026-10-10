import { describe, expect, it } from "vitest";
import {
  AYAH_END_WORDS,
  aggregates,
  buildReport,
  falseAlarms,
  finalStateCounts,
  hasVerdictLog,
  parseWordArg,
  percentile,
  perWordTable,
  wordLabel,
  wordTimeline,
  type CompactVerdict,
  type LogEntry,
  type LogEvent,
  type LogsJson,
  type ResultsFile,
  type ResultsJson,
} from "./verdict-report";

function v(w: number, s: CompactVerdict["s"], d = 0, h = 1, m = 1): CompactVerdict {
  return { w, s, d, h, m };
}

function cursor(ayah: number, wordIndex: number): LogEvent {
  return { type: "word_progress", surah: 1, ayah, word_index: wordIndex, total_words: 4, matched_indices: [] };
}

function entry(audioTimeSec: number, extra: Partial<LogEntry> = {}): LogEntry {
  return { chunkId: Math.round(audioTimeSec * 10), audioTimeSec, events: [], ...extra };
}

function resultsFile(recording: string, confirm: Record<number, number>, issues = 0): ResultsFile {
  const perWord = Array.from({ length: 29 }, (_, word) => ({ word, cursorMs: null, confirmMs: confirm[word] ?? null }));
  return {
    recording,
    metrics: { perWord, falseAdvances: 0, restarts: 0, confirmedWords: Object.keys(confirm).length },
    issues: new Array(issues).fill({}),
  };
}

function results(files: ResultsFile[]): ResultsJson {
  return { variant: "B2", chunkMs: 80, files };
}

function logs(files: Record<string, LogEntry[]>): LogsJson {
  return { files: Object.entries(files).map(([recording, entries]) => ({ recording, log: { entries } })) };
}

describe("labels and arguments", () => {
  it("labels words as ayah and 1-based word, ayah ends included", () => {
    expect(wordLabel(0)).toBe("1:1 w1");
    expect(wordLabel(17)).toBe("1:6 w1");
    expect(wordLabel(28)).toBe("1:7 w9");
    expect(wordLabel(29)).toBe("end");
    expect(AYAH_END_WORDS).toEqual([3, 7, 9, 12, 16, 19, 28]);
  });

  it("parses --word as surah:ayah:word and rejects the rest", () => {
    expect(parseWordArg("1:6:1")).toBe(17);
    expect(parseWordArg("1:5:4")).toBe(16);
    for (const bad of ["6:1", "2:1:1", "1:8:1", "1:3:3", "1:6:0", "1:6:x", ""]) expect(() => parseWordArg(bad)).toThrow();
  });

  it("percentile interpolates linearly like src/metrics.ts", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile([], 50)).toBeNaN();
  });
});

describe("per-word table and aggregates", () => {
  const run = results([resultsFile("a.wav", { 3: 1700, 4: 300, 17: 600 }, 2), resultsFile("b.wav", { 3: 1500, 4: 500 })]);

  it("has 29 rows with ms cells, MISS (null) and END on ayah-final rows", () => {
    const rows = perWordTable(run);
    expect(rows).toHaveLength(29);
    expect(rows[3]).toMatchObject({ label: "1:1 w4", end: true, cells: [1700, 1500] });
    expect(rows[17]).toMatchObject({ label: "1:6 w1", end: false, cells: [600, null] });
    const text = buildReport(run, logs({ "a.wav": [], "b.wav": [] }));
    expect(text).toMatch(/1:1 w4\s+END\s+1700\s+1500/);
    expect(text).toMatch(/1:6 w1\s+600\s+MISS/);
  });

  it("splits latency by ayah-end and interior words, and sums tracking and issues", () => {
    const a = aggregates(run);
    expect(a.ayahEnd).toMatchObject({ n: 2, p50: 1600 });
    expect(a.interior).toMatchObject({ n: 3, p50: 500 });
    expect(a.overall.n).toBe(5);
    expect(a.confirmedWords).toBe(5);
    expect(a.totalWords).toBe(58);
    expect(a.correctionIssues).toBe(2);
  });
});

describe("false alarms", () => {
  it("lists a word that goes pending -> wrong -> ok once, with its first wrong time and final state", () => {
    const log = logs({
      "a.wav": [
        entry(1, { verdicts: [v(5, "pending")] }),
        entry(2, { verdicts: [v(5, "wrong", 0.8, 0.9, 3)] }),
        entry(3, { verdicts: [v(5, "wrong", 0.7, 0.9, 3)] }),
        entry(4, { verdicts: [v(5, "ok")] }),
        entry(5, { flush: true, verdicts: [v(5, "ok"), v(6, "ok")] }),
      ],
    });
    const alarms = falseAlarms(log);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ recording: "a.wav", word: 5, state: "wrong", t: 2, finalState: "ok" });
    expect(alarms[0]?.verdict).toEqual(v(5, "wrong", 0.8, 0.9, 3));
    expect(buildReport(results([resultsFile("a.wav", {})]), log)).toContain("words ever wrong: 1 | words ever skipped: 0");
  });

  it("counts skipped separately and keeps files apart", () => {
    const log = logs({
      "a.wav": [entry(1, { verdicts: [v(2, "skipped")] })],
      "b.wav": [entry(1, { verdicts: [v(2, "skipped")] })],
    });
    expect(falseAlarms(log).map((a) => [a.recording, a.state])).toEqual([
      ["a.wav", "skipped"],
      ["b.wav", "skipped"],
    ]);
  });

  it("treats an empty list after search as no change to wrong/skipped and uses the last non-empty list as final", () => {
    const log = logs({
      "a.wav": [
        entry(1, { verdicts: [v(0, "ok"), v(1, "pending")] }),
        entry(2, { verdicts: [] }),
        entry(3, { flush: true, verdicts: [] }),
      ],
    });
    expect(falseAlarms(log)).toEqual([]);
    const final = finalStateCounts(log)[0];
    expect(final?.counts).toMatchObject({ ok: 1, pending: 1, wrong: 0, skipped: 0, absent: 27 });
    expect(final?.endsInSearch).toBe(true);
  });
});

describe("old logs without verdicts", () => {
  const run = results([resultsFile("a.wav", { 3: 1700 })]);
  const old = logs({ "a.wav": [entry(1, { events: [cursor(1, 2)] })] });

  it("still print sections 1-3 and say there is no verdict log for 4-5", () => {
    expect(hasVerdictLog(old)).toBe(false);
    const text = buildReport(run, old, [17]);
    expect(text).toContain("== 1. Run ==");
    expect(text).toContain("== 2.");
    expect(text).toContain("overall   n=1");
    expect(text.match(/no verdict log in this eventlogs file/g)).toHaveLength(2);
  });
});

describe("word timeline", () => {
  const w = 17; // 1:6 w1
  const entries: LogEntry[] = [
    entry(1, { verdicts: [v(16, "pending")], events: [cursor(5, 3)] }),
    entry(2, { verdicts: [v(16, "ok"), v(18, "pending")], events: [cursor(6, 1)] }),
    entry(3, { verdicts: [v(16, "ok"), v(17, "pending", 0.5, 0.2, 0), v(18, "ok")] }),
    entry(4, { verdicts: [v(17, "ok", 0.1, 1, 2)] }),
    entry(20, { verdicts: [] }),
    entry(21, { events: [{ type: "verse_match", surah: 1, ayah: 6, confidence: 0.67 }] }),
    entry(40, { events: [{ type: "verse_match", surah: 1, ayah: 7, confidence: 0.56 }] }),
  ];

  it("reports absent, each verdict change and the empty list, once per change", () => {
    const lines = wordTimeline(entries, w);
    expect(lines.filter((l) => l.includes("verdict"))).toEqual([
      "    t=1.00 s  verdict absent (not in the verdict list)",
      "    t=3.00 s  verdict pending d=0.5 h=0.2 m=0",
      "    t=4.00 s  verdict ok d=0.1 h=1 m=2",
      "    t=20.00 s  verdict — (list empty: tilawa is in search)",
    ]);
  });

  it("shows a cursor that jumps over the word as never entering it, and verse events only near the lines", () => {
    const text = wordTimeline(entries, w).join("\n");
    expect(text).not.toContain("cursor enters");
    expect(text).toContain("t=21.00 s  verse_match 1:6 confidence 0.67");
    expect(text).not.toContain("1:7 confidence");
  });

  it("shows the cursor entering and leaving a word", () => {
    const moving: LogEntry[] = [
      entry(1, { events: [cursor(5, 3)] }),
      entry(2, { events: [cursor(6, 0)] }),
      entry(3, { events: [cursor(6, 0)] }),
      entry(4, { events: [cursor(6, 1)] }),
    ];
    expect(wordTimeline(moving, w)).toEqual([
      "    t=2.00 s  cursor enters 1:6 w1 from 1:5 w4",
      "    t=4.00 s  cursor leaves 1:6 w1 -> 1:6 w2",
    ]);
  });
});
