import { describe, expect, it } from "vitest";
import type { WorkerOutbound } from "@tilawa/core";
import { AYAH_OFFSETS, AYAH_WORD_COUNTS, fromGlobalWordIndex } from "./fatiha";
import type { Labels } from "./labels";
import { aggregateMetrics, computeMetrics, entryFromEvents, flushEntryFromStopped, percentile, summarize, type CompactVerdict, type EventLog, type EventLogEntry } from "./metrics";

// Word w is spoken in [w, w + 0.8] seconds; its labelled end is w + 0.8.
const labels: Labels = {
  recording: "synthetic.wav",
  wordStarts: Array.from({ length: 29 }, (_, w) => w),
  wordEnds: Array.from({ length: 29 }, (_, w) => w + 0.8),
};
const labelsNoStarts: Labels = { recording: "synthetic.wav", wordEnds: labels.wordEnds };

/**
 * word_progress with the cursor at global word `g`, reported inside `ayah` (defaults to g's own ayah).
 * word_index may equal the ayah's word count (cursor just past its last word).
 * matched_indices carries only the matched words of `ayah`, like tilawa's wordProgressFromCursor.
 */
function wp(g: number, matched: number[] = [], surah = 1, ayah = fromGlobalWordIndex(g).ayah): WorkerOutbound {
  return {
    type: "word_progress",
    surah,
    ayah,
    word_index: g - (AYAH_OFFSETS[ayah - 1] as number),
    total_words: AYAH_WORD_COUNTS[ayah - 1] as number,
    matched_indices: matched
      .map(fromGlobalWordIndex)
      .filter((m) => m.ayah === ayah)
      .map((m) => m.word),
  };
}

function entry(chunkId: number, audioTimeSec: number, events: WorkerOutbound[] = [], computeMs = 10): EventLogEntry {
  return { chunkId, audioTimeSec, computeMs, events };
}

function log(entries: EventLogEntry[]): EventLog {
  return { variant: "A1", chunkMs: 150, entries };
}

/**
 * Cursor advances past word w at wordEnd + 0.3 s (cursor = w + 1); word w is confirmed at wordEnd + 0.5 s,
 * reported in w's own ayah (cursor just past its last word when w ends an ayah). Word 28 is confirmed 1.0 s late.
 */
function cleanEntries(skip: { confirm?: number[] } = {}): EventLogEntry[] {
  const entries: EventLogEntry[] = [];
  let id = 0;
  const matched: number[] = [];
  for (let w = 0; w < 28; w++) {
    entries.push(entry(id++, w + 0.8 + 0.3, [wp(w + 1, [...matched])]));
    if (!skip.confirm?.includes(w)) matched.push(w);
    entries.push(entry(id++, w + 0.8 + 0.5, [wp(w + 1, [...matched], 1, fromGlobalWordIndex(w).ayah)]));
  }
  matched.push(28);
  entries.push(entry(id++, 28.8 + 1.0, [wp(28, [...matched])]));
  return entries;
}

describe("percentile", () => {
  it("interpolates linearly: [1..100] -> p50 = 50.5", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBeCloseTo(50.5, 10);
    expect(percentile(values, 95)).toBeCloseTo(95.05, 10);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 100)).toBe(100);
  });
  it("handles unsorted, single and empty input", () => {
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });
  it("summarize returns null for empty", () => {
    expect(summarize([])).toBeNull();
    expect(summarize([1, 2, 3])).toEqual({ n: 3, p50: 2, p95: 2.9, max: 3 });
  });
});

describe("computeMetrics", () => {
  it("cursor latency is 300 ms for every word 0..27, confirm only for the last word", () => {
    const m = computeMetrics(log(cleanEntries()), labels);
    for (let w = 0; w < 28; w++) {
      expect(m.perWord[w]?.cursorMs).toBeCloseTo(300, 6);
      expect(m.perWord[w]?.confirmMs).toBeCloseTo(500, 6);
    }
    expect(m.cursor?.p50).toBeCloseTo(300, 6);
    expect(m.cursor?.n).toBe(28);
    expect(m.missedWords).toEqual([]);
    expect(m.falseAdvances).toBe(0);
    expect(m.restarts).toBe(0);
    expect(m.trackedFraction).toBe(1);
  });

  it("last word has no cursor latency, only confirm latency", () => {
    const m = computeMetrics(log(cleanEntries()), labels);
    expect(m.perWord[28]?.cursorMs).toBeNull();
    expect(m.perWord[28]?.confirmMs).toBeCloseTo(1000, 6);
    expect(m.cursorMissedWords).toEqual([]);
    expect(m.confirm?.n).toBe(29);
  });

  it("uses the first crossing and counts a restart (cursor 10 -> 6 -> 12)", () => {
    const m = computeMetrics(
      log([
        entry(0, 10.8 + 0.3, [wp(10)]),
        entry(1, 12.5, [wp(6)]),
        entry(2, 13.0, [wp(12)]),
      ]),
      labels,
    );
    expect(m.restarts).toBe(1);
    // word 9 was first crossed when the cursor reached 10, not when it came back to 12.
    expect(m.perWord[9]?.cursorMs).toBeCloseTo((11.1 - 9.8) * 1000, 6);
    // word 10 and 11 first crossed when the cursor reached 12.
    expect(m.perWord[10]?.cursorMs).toBeCloseTo((13.0 - 10.8) * 1000, 6);
  });

  it("counts several word_progress events inside one entry in order", () => {
    const m = computeMetrics(log([entry(0, 5.0, [wp(3), wp(1), wp(4)])]), labels);
    expect(m.restarts).toBe(1);
    expect(m.perWord[2]?.cursorMs).toBeCloseTo((5.0 - 2.8) * 1000, 6);
    expect(m.cursorMissedWords).toContain(4);
  });

  it("reports a never-matched word as missed", () => {
    const m = computeMetrics(log(cleanEntries({ confirm: [15] })), labels);
    // word 15 is confirmed in no entry.
    expect(m.missedWords).toEqual([15]);
    expect(m.perWord[15]?.confirmMs).toBeNull();
    expect(m.confirmedWords).toBe(28);
    expect(m.trackedFraction).toBeCloseTo(28 / 29, 10);
  });

  it("flags a cursor that moved past a word before it started (wordStarts)", () => {
    const entries = cleanEntries();
    // At t = 9.5 the cursor jumps to 11: crosses word 9 (starts at 9, ok) and word 10 (starts at 10, false).
    entries.unshift(entry(-1, 9.5, [wp(11)]));
    const m = computeMetrics(log(entries), labels);
    expect(m.falseAdvances).toBe(1);
    expect(m.falseAdvanceWords).toEqual([10]);
  });

  it("falls back to the previous word end when wordStarts are absent", () => {
    // Crossing word 10 at 9.5 is before word 9 ends (9.8).
    const entries = cleanEntries();
    entries.unshift(entry(-1, 9.5, [wp(11)]));
    const m = computeMetrics(log(entries), labelsNoStarts);
    expect(m.falseAdvanceWords).toEqual([10]);
    // Word 9 crossed at 9.5 >= end of word 8 (8.8): fine.
    expect(m.falseAdvances).toBe(1);
  });

  it("silence only: no events, no false advances, no lock", () => {
    const m = computeMetrics(log([entry(0, 0.15), entry(1, 0.3)]), labels);
    expect(m.falseAdvances).toBe(0);
    expect(m.timeToFirstLockSec).toBeNull();
    expect(m.missedWords).toHaveLength(29);
    expect(m.cursor).toBeNull();
    expect(m.confirm).toBeNull();
  });

  it("ignores word_progress for other surahs and invalid positions", () => {
    const other = wp(5, [0, 1, 2], 2);
    const bogus: WorkerOutbound = { type: "word_progress", surah: 1, ayah: 9, word_index: 0, total_words: 3, matched_indices: [0] };
    const m = computeMetrics(log([entry(0, 3.0, [other, bogus])]), labels);
    expect(m.confirmedWords).toBe(0);
    expect(m.cursor).toBeNull();
    expect(m.restarts).toBe(0);
  });

  it("word_progress of another surah is not a lock", () => {
    const m = computeMetrics(log([entry(0, 3.0, [wp(5, [], 2)])]), labels);
    expect(m.timeToFirstLockSec).toBeNull();
  });

  it("time to first lock is the first surah-1 word_progress", () => {
    const m = computeMetrics(log([entry(0, 0.15), entry(1, 1.2, [wp(0)]), entry(2, 2.0, [wp(1)])]), labels);
    expect(m.timeToFirstLockSec).toBe(1.2);
  });

  it("compute stats and RTF", () => {
    const entries = [entry(0, 1.0, [], 100), entry(1, 2.0, [], 300)];
    const m = computeMetrics(log(entries), labels);
    expect(m.compute).toEqual({ n: 2, p50: 200, p95: 290, max: 300 });
    expect(m.audioDurationSec).toBe(2);
    expect(m.rtf).toBeCloseTo(400 / 2000, 10);
  });

  it("cursor past the last word of an ayah counts as the next ayah's first word", () => {
    // ayah 1 has 4 words; word_index 4 = global 4. Crosses words 0..3.
    const event: WorkerOutbound = { type: "word_progress", surah: 1, ayah: 1, word_index: 4, total_words: 4, matched_indices: [] };
    const m = computeMetrics(log([entry(0, 4.0, [event])]), labels);
    expect(m.perWord[3]?.cursorMs).toBeCloseTo((4.0 - 3.8) * 1000, 6);
    expect(m.perWord[4]?.cursorMs).toBeNull();
  });
});

describe("confirmation sources (matched_indices OR entry.confirmed)", () => {
  it("confirms from matched_indices alone", () => {
    const m = computeMetrics(log([entry(0, 2.0, [wp(2, [0, 1])])]), labels);
    expect(m.perWord[1]?.confirmMs).toBeCloseTo((2.0 - 1.8) * 1000, 6);
    expect(m.perWord[2]?.confirmMs).toBeNull();
  });

  it("confirms from entry.confirmed alone", () => {
    const e: EventLogEntry = { ...entry(0, 2.0), confirmed: [0, 1] };
    const m = computeMetrics(log([e]), labels);
    expect(m.perWord[0]?.confirmMs).toBeCloseTo((2.0 - 0.8) * 1000, 6);
    expect(m.perWord[1]?.confirmMs).toBeCloseTo((2.0 - 1.8) * 1000, 6);
    expect(m.missedWords).toHaveLength(27);
  });

  it("an ayah-final word, absent from matched_indices once the cursor moved on, is confirmed only via confirmed", () => {
    // Word 3 ends ayah 1. The cursor is already in ayah 2, so matched_indices (ayah 2 only) cannot list it.
    const inNextAyah = wp(4, [3]);
    expect(inNextAyah.type === "word_progress" && inNextAyah.matched_indices).toEqual([]);
    const withoutConfirmed = computeMetrics(log([entry(0, 5.0, [inNextAyah])]), labels);
    expect(withoutConfirmed.perWord[3]?.confirmMs).toBeNull();
    expect(withoutConfirmed.missedWords).toContain(3);

    const e: EventLogEntry = { ...entry(0, 5.0, [inNextAyah]), confirmed: [3] };
    const withConfirmed = computeMetrics(log([e]), labels);
    expect(withConfirmed.perWord[3]?.confirmMs).toBeCloseTo((5.0 - 3.8) * 1000, 6);
    expect(withConfirmed.missedWords).not.toContain(3);
  });

  it("uses the earlier of the two sources", () => {
    const first: EventLogEntry = { ...entry(0, 4.0, [wp(2, [1])]) };
    const second: EventLogEntry = { ...entry(1, 5.0), confirmed: [1] };
    const m = computeMetrics(log([first, second]), labels);
    expect(m.perWord[1]?.confirmMs).toBeCloseTo((4.0 - 1.8) * 1000, 6);
    const swapped = computeMetrics(
      log([{ ...entry(0, 4.0), confirmed: [1] }, entry(1, 5.0, [wp(2, [1])])]),
      labels,
    );
    expect(swapped.perWord[1]?.confirmMs).toBeCloseTo((4.0 - 1.8) * 1000, 6);
  });

  it("ignores out-of-range confirmed values and old logs without the field", () => {
    const e: EventLogEntry = { ...entry(0, 2.0), confirmed: [-1, 29, 1.5, 0] };
    const m = computeMetrics(log([e]), labels);
    expect(m.confirmedWords).toBe(1);
  });

  it("verdicts time is separate from compute and RTF", () => {
    const entries: EventLogEntry[] = [
      { ...entry(0, 1.0, [], 100), verdictsMs: 20 },
      { ...entry(1, 2.0, [], 300), verdictsMs: 40 },
    ];
    const m = computeMetrics(log(entries), labels);
    expect(m.compute).toEqual({ n: 2, p50: 200, p95: 290, max: 300 });
    expect(m.verdicts).toEqual({ n: 2, p50: 30, p95: 39, max: 40 });
    expect(m.rtf).toBeCloseTo(0.2, 10);
    expect(m.rtfWithVerdicts).toBeCloseTo(460 / 2000, 10);
    expect(computeMetrics(log([entry(0, 1.0)]), labels).verdicts).toBeNull();
  });
});

describe("flush entry", () => {
  it("is kept out of per-chunk stats but counts for RTF", () => {
    const entries: EventLogEntry[] = [
      { ...entry(0, 1.0, [], 100), verdictsMs: 10 },
      { ...entry(-1, 2.0, [], 300), verdictsMs: 50, flush: true },
    ];
    const m = computeMetrics(log(entries), labels);
    expect(m.compute).toEqual({ n: 1, p50: 100, p95: 100, max: 100 });
    expect(m.verdicts).toEqual({ n: 1, p50: 10, p95: 10, max: 10 });
    expect(m.rtf).toBeCloseTo(400 / 2000, 10);
    expect(m.rtfWithVerdicts).toBeCloseTo(460 / 2000, 10);
  });
  it("still supplies confirmation for the last word", () => {
    const flush: EventLogEntry = { ...entry(-1, 31.0), confirmed: [28], flush: true };
    const m = computeMetrics(log([flush]), labels);
    expect(m.perWord[28]?.confirmMs).toBeCloseTo((31.0 - 28.8) * 1000, 6);
  });
});

describe("aggregateMetrics", () => {
  it("pools word latencies across files and sums compute / duration", () => {
    const a = log(cleanEntries());
    const b = log([...cleanEntries().map((e) => ({ ...e, audioTimeSec: e.audioTimeSec + 0.1 }))]);
    const ma = computeMetrics(a, labels);
    const mb = computeMetrics(b, labels);
    const agg = aggregateMetrics([
      { metrics: ma, log: a },
      { metrics: mb, log: b },
    ]);
    expect(agg.files).toBe(2);
    expect(agg.cursor?.n).toBe(56);
    expect(agg.confirm?.n).toBe(58);
    // file a is 300 ms for every word, file b 400 ms: pooled p50 = 350 ms.
    expect(agg.cursor?.p50).toBeCloseTo(350, 6);
    expect(agg.trackedFraction).toBe(1);
    expect(agg.totalWords).toBe(58);
    expect(agg.rtf).toBeCloseTo((a.entries.length + b.entries.length) * 10 / ((ma.audioDurationSec + mb.audioDurationSec) * 1000), 10);
  });
  it("handles no files", () => {
    const agg = aggregateMetrics([]);
    expect(agg.files).toBe(0);
    expect(agg.cursor).toBeNull();
    expect(agg.rtf).toBeNull();
  });
});

describe("log entry builders (pin the existing worker-message -> EventLogEntry mapping)", () => {
  const events: WorkerOutbound[] = [wp(2, [0, 1])];

  it("entryFromEvents maps an events message", () => {
    const entry = entryFromEvents({
      type: "events",
      chunkId: 7,
      samplesFed: 24000,
      computeMs: 12.5,
      verdictsMs: 3.25,
      confirmed: [0, 3],
      events,
    });
    expect(entry).toEqual({
      chunkId: 7,
      audioTimeSec: 1.5,
      computeMs: 12.5,
      verdictsMs: 3.25,
      events,
      confirmed: [0, 3],
    });
    expect(Object.keys(entry)).toEqual(["chunkId", "audioTimeSec", "computeMs", "verdictsMs", "events", "confirmed"]);
    expect("flush" in entry).toBe(false);
  });

  it("flushEntryFromStopped maps a stopped message to chunkId -1 with flush: true", () => {
    const entry = flushEntryFromStopped({
      type: "stopped",
      samplesFed: 32000,
      computeMs: 40,
      verdictsMs: 5,
      confirmed: [28],
      events,
    });
    expect(entry).toEqual({
      chunkId: -1,
      audioTimeSec: 2,
      computeMs: 40,
      verdictsMs: 5,
      events,
      confirmed: [28],
      flush: true,
    });
    expect(Object.keys(entry)).toEqual(["chunkId", "audioTimeSec", "computeMs", "verdictsMs", "events", "confirmed", "flush"]);
  });

  it("copy the verdict list when the message has one (an empty list included) and keep the key absent otherwise", () => {
    const verdicts: CompactVerdict[] = [
      { w: 0, s: "ok", d: 0, h: 1, m: 2.5 },
      { w: 1, s: "pending", d: 0.125, h: 0.5, m: 0 },
    ];
    const base = { samplesFed: 16000, computeMs: 1, verdictsMs: 1, confirmed: [0], events };
    const withList = entryFromEvents({ type: "events", chunkId: 0, ...base, verdicts });
    expect(withList.verdicts).toEqual(verdicts);
    expect("verdicts" in entryFromEvents({ type: "events", chunkId: 0, ...base })).toBe(false);
    expect(entryFromEvents({ type: "events", chunkId: 0, ...base, verdicts: [] }).verdicts).toEqual([]);

    const flush = flushEntryFromStopped({ type: "stopped", ...base, verdicts });
    expect(flush.verdicts).toEqual(verdicts);
    expect(flush.flush).toBe(true);
    expect("verdicts" in flushEntryFromStopped({ type: "stopped", ...base })).toBe(false);
  });

  it("verdicts do not change the metrics", () => {
    const plain = log(cleanEntries());
    const withVerdicts = log(
      plain.entries.map((e, i) => (i % 3 === 0 ? { ...e, verdicts: [{ w: 0, s: "wrong" as const, d: 9, h: 0, m: 0 }] } : e)),
    );
    expect(computeMetrics(withVerdicts, labels)).toEqual(computeMetrics(plain, labels));
  });

  it("the builders' output feeds computeMetrics like a hand-built entry", () => {
    const flush = flushEntryFromStopped({ type: "stopped", samplesFed: 31 * 16000, computeMs: 1, verdictsMs: 1, confirmed: [28], events: [] });
    const m = computeMetrics(log([flush]), labels);
    expect(m.perWord[28]?.confirmMs).toBeCloseTo((31 - 28.8) * 1000, 6);
    expect(m.compute).toBeNull(); // flush entries stay out of per-chunk compute stats
  });
});
