import { describe, expect, it } from "vitest";
import {
  AYAH_END_WORDS,
  DEFAULT_PARAMS,
  analyze,
  buildCtx,
  commonRecordings,
  confirmTimes,
  ctcWindow,
  evaluateCase,
  evaluateRule,
  finalStates,
  fireIndex,
  ruleAvailable,
  runningFloor,
  selfCheck,
  shownState,
  summarize,
  sweepRule,
  type CompactVerdict,
  type FileCtx,
  type LogEntry,
  type LogsJson,
  type Params,
  type ResultsJson,
} from "./ayah-end-gate";

const CHUNK_MS = 80;
const CHUNK_SEC = CHUNK_MS / 1000;
const LOUD = { rmsDb: -20, clarity: 0.9, f0: 150 };
const QUIET = { rmsDb: -80, clarity: 0.1, f0: null };

function v(w: number, s: CompactVerdict["s"], d = 0.05, h = 1, m = 1): CompactVerdict {
  return { w, s, d, h, m };
}

interface EntrySpec {
  voice?: LogEntry["voice"];
  ctc?: LogEntry["ctc"];
  raw?: boolean;
  confirmed?: number[];
  matched?: { ayah: number; indices: number[] };
  verdicts?: CompactVerdict[];
  flush?: boolean;
}

/** Entry k ends at (k + 1) x 80 ms, like the bench (samplesFed / 16000). */
function log(count: number, spec: (k: number) => EntrySpec = () => ({})): LogEntry[] {
  return Array.from({ length: count }, (_, k) => {
    const s = spec(k);
    const events: LogEntry["events"] = [];
    if (s.raw) events.push({ type: "raw_transcript" });
    if (s.matched) events.push({ type: "word_progress", surah: 1, ayah: s.matched.ayah, matched_indices: s.matched.indices });
    return {
      chunkId: s.flush ? -1 : k,
      audioTimeSec: ((k + 1) * 1280) / 16000,
      events,
      ...(s.confirmed ? { confirmed: s.confirmed } : {}),
      ...(s.verdicts ? { verdicts: s.verdicts } : {}),
      ...(s.voice !== undefined ? { voice: s.voice } : {}),
      ...(s.ctc !== undefined ? { ctc: s.ctc } : {}),
      ...(s.flush ? { flush: true } : {}),
    };
  });
}

function ctxOf(
  entries: LogEntry[],
  options: { ends?: Record<number, number>; issues?: number[]; durationSec?: number; tail?: boolean } = {},
): FileCtx {
  const wordEnds = Array.from({ length: 29 }, (_, w) => options.ends?.[w] ?? 100);
  return buildCtx({
    recording: "synthetic.wav",
    wordEnds,
    chunkMs: CHUNK_MS,
    durationSec: options.durationSec ?? 1000,
    issues: (options.issues ?? []).map((chunkId) => ({ chunkId })),
    entries,
    tail: options.tail ?? true,
  });
}

/** The floor needs a quiet start: a recording that is loud throughout would have a floor at its own level. */
const LEAD = 13;

/**
 * Word 3 (the last word of ayah 1): quiet for the first ${LEAD} entries (the noise floor), ok verdict from entry LEAD on,
 * voiced until entry `silentFrom` (>= LEAD), quiet afterwards.
 */
function silenceLog(silentFrom: number, count = 40, extra: (k: number) => EntrySpec = () => ({})): LogEntry[] {
  return log(count, (k) => ({
    voice: k >= LEAD && k < silentFrom ? LOUD : QUIET,
    ...(k === LEAD ? { verdicts: [v(3, "ok")] } : {}),
    ...extra(k),
  }));
}

describe("shownState", () => {
  it("applies tilawa's rule to pending verdicts only", () => {
    expect(shownState(v(1, "ok"))).toBe("ok");
    expect(shownState(v(1, "unsure"))).toBe("unsure");
    expect(shownState(v(1, "wrong"))).toBeNull();
    expect(shownState(v(1, "skipped"))).toBeNull();
    expect(shownState(v(1, "pending", 0.15, 1, 1))).toBe("ok");
    expect(shownState(v(1, "pending", 0.4, 1, 1))).toBe("unsure");
    expect(shownState(v(1, "pending", 0.6, 1, 0.2))).toBe("unsure");
    expect(shownState(v(1, "pending", 0.6, 1, 0.9))).toBeNull();
  });
});

describe("confirmTimes (R0)", () => {
  it("takes the first entry with the word in confirmed or in a surah-1 matched_indices", () => {
    const entries = log(10, (k) => ({
      ...(k === 2 ? { confirmed: [3] } : {}),
      ...(k === 5 ? { matched: { ayah: 7, indices: [8] } } : {}),
      ...(k === 6 ? { confirmed: [28], matched: { ayah: 7, indices: [8, 2] } } : {}),
    }));
    const r0 = confirmTimes(entries);
    expect(r0.time[3]).toBeCloseTo(0.24, 9);
    expect(r0.source[3]).toBe("confirmed");
    expect(r0.time[28]).toBeCloseTo(0.48, 9);
    expect(r0.source[28]).toBe("matched");
    expect(r0.time[0]).toBeNull();
  });

  it("reports both when the same entry has both, and ignores other surahs and bad indices", () => {
    const entries = log(3, (k) => ({ ...(k === 1 ? { confirmed: [3], matched: { ayah: 1, indices: [3, 99] } } : {}) }));
    entries[2]?.events.push({ type: "word_progress", surah: 2, ayah: 1, matched_indices: [0] });
    const r0 = confirmTimes(entries);
    expect(r0.source[3]).toBe("both");
    expect(r0.time[0]).toBeNull();
  });

  it("self-check matches perWord.confirmMs and reports a difference", () => {
    const entries = log(5, (k) => (k === 2 ? { confirmed: [3] } : {}));
    const ctx = ctxOf(entries, { ends: { 3: 0.1 } });
    const perWord = (confirm3: number | null) =>
      Array.from({ length: 29 }, (_, word) => ({ word, cursorMs: null, confirmMs: word === 3 ? confirm3 : null }));
    const results = (confirm3: number | null): ResultsJson => ({
      chunkMs: CHUNK_MS,
      files: [{ recording: "synthetic.wav", labelsFrom: "x", durationSec: 1000, metrics: { perWord: perWord(confirm3) }, issues: [] }],
    });
    expect(selfCheck(results(140), [ctx])).toEqual([]);
    expect(selfCheck(results(142), [ctx])).toHaveLength(1);
    expect(selfCheck(results(null), [ctx])).toHaveLength(1);
  });
});

describe("finalStates", () => {
  it("uses the last non-empty list, then the last non-pending state, else n/a", () => {
    const entries = log(6, (k) => ({
      ...(k === 1 ? { verdicts: [v(0, "ok"), v(28, "pending")] } : {}),
      ...(k === 3 ? { verdicts: [v(0, "unsure"), v(28, "pending")] } : {}),
      ...(k === 5 ? { verdicts: [] } : {}),
    }));
    const states = finalStates(entries);
    expect(states[0]).toBe("unsure");
    expect(states[28]).toBe("n/a");
  });
});

describe("runningFloor", () => {
  it("is -60 until 1.0 s of real audio, then the 10th percentile of earlier entries", () => {
    const entries = log(30, () => ({ voice: LOUD }));
    const floor = runningFloor(entries, CHUNK_SEC);
    expect(floor.slice(0, 13).every((f) => f === -60)).toBe(true);
    expect(floor[13]).toBe(-20);
  });

  it("ignores future entries and zero-tail (voice null) entries", () => {
    const base = log(20, (k) => ({ voice: { rmsDb: -30 + (k % 3), clarity: 0.9, f0: 150 } }));
    const withFuture = [...base, ...log(10, () => ({ voice: { rmsDb: 0, clarity: 0.9, f0: 150 } })).map((e, k) => ({ ...e, chunkId: 20 + k }))];
    const a = runningFloor(base, CHUNK_SEC);
    const b = runningFloor(withFuture, CHUNK_SEC);
    expect(b.slice(0, 20)).toEqual(a);
    const tailOnly = runningFloor(log(40, (k) => ({ voice: k < 10 ? LOUD : null })), CHUNK_SEC);
    expect(tailOnly.every((f) => f === -60)).toBe(true);
  });
});

describe("R1 (voicing)", () => {
  it("never fires on a held vowel: voiced, no new characters", () => {
    const ctx = ctxOf(silenceLog(1000));
    expect(fireIndex(ctx, "R1", DEFAULT_PARAMS, 3)).toBeNull();
  });

  it("fires at the first entry after U ms of silence", () => {
    // raw_transcript only at entry 5; silence starts at entry 25, so the 3-entry window is clean at entry 27.
    const ctx = ctxOf(silenceLog(25, 40, (k) => (k === 5 ? { raw: true } : {})));
    const index = fireIndex(ctx, "R1", DEFAULT_PARAMS, 3);
    expect(index).toBe(27);
    expect(ctx.times[27]).toBeCloseTo(2.24, 9);
  });

  it("is blocked while raw_transcript keeps arriving, and fires N ms after the last one", () => {
    const ctx = ctxOf(silenceLog(20, 40, (k) => (k <= 24 ? { raw: true } : {})));
    // silent window is clean at entry 22; last raw at entry 24 (t = 2.0): the 480 ms window is clear at t = 2.48 = entry 30.
    expect(fireIndex(ctx, "R1", DEFAULT_PARAMS, 3)).toBe(30);
  });

  it("needs the verdict to be shown and h >= H", () => {
    const wrong = log(40, (k) => ({ voice: QUIET, ...(k === 0 ? { verdicts: [v(3, "wrong")] } : {}) }));
    expect(fireIndex(ctxOf(wrong), "R1", DEFAULT_PARAMS, 3)).toBeNull();
    const low = log(40, (k) => ({ voice: QUIET, ...(k === 0 ? { verdicts: [v(3, "ok", 0.05, 0.6)] } : {}) }));
    expect(fireIndex(ctxOf(low), "R1", DEFAULT_PARAMS, 3)).toBeNull();
    expect(fireIndex(ctxOf(low), "R1", { ...DEFAULT_PARAMS, H: 0.5 }, 3)).not.toBeNull();
  });

  it("is not eligible at a chunk with a logged issue", () => {
    const entries = silenceLog(20);
    const open = fireIndex(ctxOf(entries), "R1", DEFAULT_PARAMS, 3) as number;
    const blocked = fireIndex(ctxOf(entries, { issues: [entries[open]?.chunkId as number] }), "R1", DEFAULT_PARAMS, 3);
    expect(blocked).toBe(open + 1);
  });

  it("never uses the zero tail: voice null does not fire", () => {
    const ctx = ctxOf(log(40, (k) => ({ voice: k < 10 ? LOUD : null, ...(k === 0 ? { verdicts: [v(3, "ok")] } : {}) })));
    expect(fireIndex(ctx, "R1", DEFAULT_PARAMS, 3)).toBeNull();
  });

  it("a strongly voiced entry in the window blocks it even when clarity is below the threshold of a looser C", () => {
    const entries = silenceLog(20, 40, (k) => (k === 21 ? { voice: { rmsDb: -10, clarity: 0.85, f0: 150 } } : {}));
    // Without the strong-voice reset, clarity 0.85 < C = 0.9 would count as unvoiced and the gate would fire at entry 22.
    expect(fireIndex(ctxOf(entries), "R1", { ...DEFAULT_PARAMS, C: 0.9 }, 3)).toBe(24);
  });
});

describe("R2 (CTC) and R3", () => {
  const stepEvery4 = (blank: number, top: number) => (k: number): EntrySpec => ({
    voice: QUIET,
    ...(k % 4 === 3 ? { ctc: { blank, top } } : {}),
    ...(k === 0 ? { verdicts: [v(3, "ok")] } : {}),
  });

  it("is not satisfied by a window without any model step", () => {
    const ctx = ctxOf(log(20, stepEvery4(0.99, 0.01)));
    const ok = ctcWindow(ctx, 160, 0.95, 0.2);
    expect(ok[3]).toBe(true);
    expect(ok[4]).toBe(true);
    expect(ok[5]).toBe(false);
    expect(ok[6]).toBe(false);
    expect(ok[7]).toBe(true);
  });

  it("every step in the window must be blank-heavy and quiet", () => {
    const ctx = ctxOf(log(20, (k) => (k === 7 ? { ...stepEvery4(0.5, 0.01)(k) } : stepEvery4(0.99, 0.01)(k))));
    const ok = ctcWindow(ctx, 320, 0.95, 0.2);
    expect(ok[2]).toBe(false); // t < U2 is not a full window
    expect(ok[3]).toBe(true);
    expect(ok[7]).toBe(false);
    expect(ok[10]).toBe(false); // window 7..10 still holds the bad step
    expect(ok[11]).toBe(true);
    const top = ctxOf(log(20, stepEvery4(0.99, 0.3)));
    expect(ctcWindow(top, 320, 0.95, 0.2).some(Boolean)).toBe(false);
  });

  it("R2 fires on a blank-heavy window; R3 needs voicing too", () => {
    const quiet = ctxOf(log(40, stepEvery4(0.99, 0.01)));
    expect(fireIndex(quiet, "R2", DEFAULT_PARAMS, 3)).toBe(3);
    expect(fireIndex(quiet, "R3", DEFAULT_PARAMS, 3)).toBe(3);
    // quiet lead, then a held vowel: the CTC is blank-heavy throughout, but the voicing says "still sounding".
    const held = ctxOf(
      log(40, (k) => ({
        ...stepEvery4(0.99, 0.01)(k),
        voice: k < LEAD ? QUIET : LOUD,
        verdicts: k === LEAD ? [v(3, "ok")] : undefined,
      })),
    );
    expect(fireIndex(held, "R2", DEFAULT_PARAMS, 3)).toBe(LEAD);
    expect(fireIndex(held, "R3", DEFAULT_PARAMS, 3)).toBeNull();
  });

  it("R2 is available with ctc only; R1 with voice only", () => {
    const ctcOnly = ctxOf(log(10, (k) => (k === 3 ? { ctc: { blank: 1, top: 0 } } : {})));
    expect(ruleAvailable(ctcOnly, "R1")).toBe(false);
    expect(ruleAvailable(ctcOnly, "R2")).toBe(true);
    expect(ruleAvailable(ctcOnly, "R3")).toBe(false);
  });
});

describe("accounting", () => {
  it("is not gate-caused early when Rx >= R0, but R0 itself may be early", () => {
    // gate fires at entry 22 (t = 1.84); tilawa confirmed at entry 5 (t = 0.48); the word ends at 5 s.
    const entries = silenceLog(20, 40, (k) => (k === 5 ? { confirmed: [3] } : {}));
    const c = evaluateCase(ctxOf(entries, { ends: { 3: 5 } }), "R1", DEFAULT_PARAMS, 3);
    expect(c.rx).toBeCloseTo(1.84, 9);
    expect(c.gateFires).toBe(false);
    expect(c.gateEarly).toBe(false);
    expect(c.baseEarly).toBe(true);
    expect(c.sx).toBeCloseTo(0.48, 9);
    expect(c.mismatch).toBe(false);
  });

  it("is not gate-caused early when Rx and R0 are the same entry", () => {
    const base = silenceLog(20, 40);
    const rx = fireIndex(ctxOf(base), "R1", DEFAULT_PARAMS, 3) as number;
    const entries = silenceLog(20, 40, (k) => (k === rx ? { confirmed: [3] } : {}));
    const c = evaluateCase(ctxOf(entries, { ends: { 3: 5 } }), "R1", DEFAULT_PARAMS, 3);
    expect(c.rx).toBe(c.r0);
    expect(c.gateFires).toBe(false);
    expect(c.gateEarly).toBe(false);
    expect(c.baseEarly).toBe(true);
  });

  it("counts a gate that fires before the word starts as early (no label-based window), also with R0 never reached", () => {
    const ctx = ctxOf(silenceLog(20), { ends: { 3: 5 } });
    const c = evaluateCase(ctx, "R1", DEFAULT_PARAMS, 3);
    expect(c.r0).toBeNull();
    expect(c.gateFires).toBe(true);
    expect(c.gateEarly).toBe(true);
    const s = summarize([c]);
    expect(s.gateEarly).toBe(1);
    expect(s.nullR0).toBe(1);
    expect(s.nullR0Gated).toBe(1);
    expect(s.worstEarlyMs).toBeLessThan(0);
  });

  it("with R0 never reached and the label before Rx, Sx = Rx and it is not early", () => {
    const ctx = ctxOf(silenceLog(20), { ends: { 3: 0.2 } });
    const c = evaluateCase(ctx, "R1", DEFAULT_PARAMS, 3);
    expect(c.gateEarly).toBe(false);
    expect(c.sx).toBe(c.rx);
    expect(c.latencyMs).toBeCloseTo(((c.rx as number) - 0.2) * 1000, 6);
  });

  it("margin is the smallest (Rx - end) over gate-fires, positive = safe", () => {
    const ctx = ctxOf(silenceLog(20));
    ctx.lists = ctx.lists.map((list, i) => (i >= LEAD ? [...list, v(7, "ok")] : list));
    const rx = ctx.times[fireIndex(ctx, "R1", DEFAULT_PARAMS, 3) as number] as number;
    ctx.wordEnds[3] = rx - 0.3;
    ctx.wordEnds[7] = rx - 0.1;
    const s = summarize(evaluateRule([ctx], "R1", DEFAULT_PARAMS) as never);
    expect(s.gateEarly).toBe(0);
    expect(s.marginMs).toBeCloseTo(100, 6);
    expect(s.gateFires).toBe(2);
  });

  it("counts a verdict mismatch when the shown state differs from the final state", () => {
    // ok at the gate, unsure in the last list.
    const entries = silenceLog(20, 40, (k) => (k === 30 ? { verdicts: [v(3, "unsure", 0.3)] } : {}));
    const c = evaluateCase(ctxOf(entries, { ends: { 3: 0.2 } }), "R1", DEFAULT_PARAMS, 3);
    expect(c.shown).toBe("ok");
    expect(c.final).toBe("unsure");
    expect(c.stateMismatch).toBe(true);
    expect(summarize([c]).mismatches).toBe(1);
  });

  it("does not count a match, and reports an n/a final state without counting it", () => {
    const same = silenceLog(20, 40, (k) => (k === 30 ? { verdicts: [v(3, "ok")] } : {}));
    expect(evaluateCase(ctxOf(same, { ends: { 3: 0.2 } }), "R1", DEFAULT_PARAMS, 3).mismatch).toBe(false);
    const pendingOnly = log(40, (k) => ({ voice: k < 10 ? LOUD : QUIET, ...(k === 0 ? { verdicts: [v(3, "pending", 0.1, 1, 1)] } : {}) }));
    const c = evaluateCase(ctxOf(pendingOnly, { ends: { 3: 0.2 } }), "R1", DEFAULT_PARAMS, 3);
    expect(c.final).toBe("n/a");
    expect(c.shown).toBe("ok");
    expect(c.stateMismatch).toBe(false);
    expect(summarize([c]).finalNa).toBe(1);
  });

  it("counts wrong in a list after Rx as a mismatch", () => {
    const entries = silenceLog(20, 40, (k) => (k === 30 ? { verdicts: [v(3, "wrong", 0.9, 1, 0.9)] } : k === 35 ? { verdicts: [v(3, "ok")] } : {}));
    const c = evaluateCase(ctxOf(entries, { ends: { 3: 0.2 } }), "R1", DEFAULT_PARAMS, 3);
    expect(c.final).toBe("ok");
    expect(c.stateMismatch).toBe(false);
    expect(c.wrongAfter).toBe(true);
    expect(c.mismatch).toBe(true);
  });

  it("checks idx 28 against its last verdict although its final state is n/a", () => {
    const entries = (last: CompactVerdict) =>
      log(40, (k) => ({
        voice: k < 10 ? LOUD : QUIET,
        ...(k === 0 ? { verdicts: [v(28, "pending", 0.3, 1, 0.9)] } : {}),
        ...(k === 35 ? { verdicts: [last] } : {}),
      }));
    const agree = evaluateCase(ctxOf(entries(v(28, "pending", 0.3, 1, 0.9)), { ends: { 28: 0.2 } }), "R1", DEFAULT_PARAMS, 28);
    expect(agree.final).toBe("n/a");
    expect(agree.shown).toBe("unsure");
    expect(agree.lastShown).toBe("unsure");
    expect(agree.mismatch).toBe(false);
    const differ = evaluateCase(ctxOf(entries(v(28, "pending", 0.1, 1, 0.9)), { ends: { 28: 0.2 } }), "R1", DEFAULT_PARAMS, 28);
    expect(differ.lastShown).toBe("ok");
    expect(differ.lastMismatch).toBe(true);
    expect(differ.mismatch).toBe(true);
  });
});

describe("old logs and tail", () => {
  it("gives n/a for R1/R2/R3 when entries have no voice/ctc", () => {
    const ctx = ctxOf(log(40, (k) => (k === 0 ? { verdicts: [v(3, "ok")] } : {})));
    for (const rule of ["R1", "R2", "R3"] as const) {
      expect(ruleAvailable(ctx, rule)).toBe(false);
      expect(fireIndex(ctx, rule, DEFAULT_PARAMS, 3)).toBeNull();
      expect(evaluateRule([ctx], rule, DEFAULT_PARAMS)).toBeNull();
    }
    expect(evaluateRule([ctx], "R0", DEFAULT_PARAMS)).toHaveLength(AYAH_END_WORDS.length);
  });

  it("without tail drops the entries after the audio, including R0 and the flush entry", () => {
    const entries = log(41, (k) => (k === 30 ? { confirmed: [28] } : k === 40 ? { flush: true, confirmed: [3] } : {}));
    const withTail = ctxOf(entries, { durationSec: 1.6, tail: true });
    const noTail = ctxOf(entries, { durationSec: 1.6, tail: false });
    expect(withTail.r0.time[28]).not.toBeNull();
    expect(withTail.r0.time[3]).not.toBeNull();
    expect(noTail.r0.time[28]).toBeNull();
    expect(noTail.r0.time[3]).toBeNull();
    expect(withTail.search).toHaveLength(40);
    expect(noTail.search).toHaveLength(20);
  });

  it("keeps the flush entry out of the gate search", () => {
    // quiet lead, loud held vowel, then a quiet flush entry that must not count.
    const entries = log(30, (k) => ({
      voice: k >= LEAD && k < 29 ? LOUD : QUIET,
      ...(k === LEAD ? { verdicts: [v(3, "ok")] } : {}),
      ...(k === 29 ? { flush: true } : {}),
    }));
    expect(ctxOf(entries).search).toHaveLength(29);
    expect(fireIndex(ctxOf(entries), "R1", DEFAULT_PARAMS, 3)).toBeNull();
  });
});

describe("commonRecordings and analyze without a common recording", () => {
  const results = {
    chunkMs: 80,
    files: ["1.aac", "2.aac"].map((recording) => ({
      recording,
      durationSec: 1,
      labelsFrom: `${recording}.json`,
      metrics: { perWord: [] },
      issues: [],
    })),
  } as unknown as ResultsJson;
  const logsOf = (...names: string[]): LogsJson => ({ files: names.map((recording) => ({ recording, log: { entries: [] } })) }) as unknown as LogsJson;

  it("splits the names into common / results only / logs only", () => {
    expect(commonRecordings(results, logsOf("2.aac", "T1.aac"))).toEqual({ common: ["2.aac"], onlyInResults: ["1.aac"], onlyInLogs: ["T1.aac"] });
    expect(commonRecordings(results, logsOf("T1.aac", "T2.aac")).common).toEqual([]);
  });

  it("analyze refuses to run (with or without --sweep) when nothing matches", () => {
    for (const sweep of [false, true]) {
      expect(() => analyze({ results, logs: logsOf("T1.aac"), labelsFor: () => ({ wordEnds: [] }), params: DEFAULT_PARAMS, sweep })).toThrow(/no recording/);
    }
  });
});

describe("sweepRule", () => {
  it("evaluates the full grid and keeps rows with 0 early and 0 mismatches, best p95 first", () => {
    const ctx = ctxOf(silenceLog(20), { ends: { 3: 0.2 } });
    const r1 = sweepRule([ctx], "R1", DEFAULT_PARAMS);
    expect(r1.total).toBe(4 * 4 * 3 * 3 * 3);
    expect(r1.valid.length).toBeGreaterThan(0);
    const p95 = r1.valid.map((r) => r.summary.p95 as number);
    expect([...p95].sort((a, b) => a - b)).toEqual(p95);
    for (const row of r1.valid) {
      expect(row.summary.gateEarly).toBe(0);
      expect(row.summary.mismatches).toBe(0);
    }
    expect(sweepRule([ctx], "R2", DEFAULT_PARAMS)).toEqual({ total: 0, valid: [] });
  });

  it("uses the R2 and R3 grids", () => {
    const entries = log(40, (k) => ({ voice: QUIET, ctc: k % 4 === 3 ? { blank: 0.99, top: 0.01 } : undefined, ...(k === 0 ? { verdicts: [v(3, "ok")] } : {}) }));
    const ctx = ctxOf(entries, { ends: { 3: 0.2 } });
    const params: Params = { ...DEFAULT_PARAMS };
    expect(sweepRule([ctx], "R2", params).total).toBe(4 * 4 * 2 * 2 * 2);
    expect(sweepRule([ctx], "R3", params).total).toBe(4 * 4 * 3 * 3 * 3 * 2 * 2 * 2);
  });
});
