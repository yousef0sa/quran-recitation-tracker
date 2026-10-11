import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  compareRuns,
  everWrongOrSkipped,
  fileProblems,
  finalStates,
  formatComparison,
  wordLabel,
  type CompactVerdict,
  type LogEntry,
  type Run,
} from "./compare-runs";

function v(w: number, s: CompactVerdict["s"], d = 0, h = 1, m = 1): CompactVerdict {
  return { w, s, d, h, m };
}

function entry(audioTimeSec: number, verdicts?: CompactVerdict[]): LogEntry {
  return { chunkId: Math.round(audioTimeSec * 10), audioTimeSec, ...(verdicts ? { verdicts } : {}) };
}

interface FileSpec {
  confirm?: Record<number, number>;
  issues?: number;
  falseAdvances?: number;
  restarts?: number;
  firstLock?: number | null;
  entries?: LogEntry[];
}

// Every word w is confirmed at 100 + w ms unless `confirm` says otherwise (a missing key means never confirmed).
function run(files: Record<string, FileSpec>): Run {
  const names = Object.keys(files);
  return {
    results: {
      files: names.map((recording) => {
        const spec = files[recording] as FileSpec;
        const confirm = spec.confirm ?? Object.fromEntries(Array.from({ length: 29 }, (_, w) => [w, 100 + w]));
        return {
          recording,
          metrics: {
            perWord: Array.from({ length: 29 }, (_, word) => ({
              word,
              cursorMs: word < 28 ? 200 + word : null,
              confirmMs: confirm[word] ?? null,
            })),
            falseAdvances: spec.falseAdvances ?? 0,
            restarts: spec.restarts ?? 0,
            timeToFirstLockSec: spec.firstLock === undefined ? 1.44 : spec.firstLock,
          },
          issues: new Array(spec.issues ?? 0).fill({}),
        };
      }),
    },
    logs: {
      files: names.map((recording) => ({
        recording,
        log: { entries: (files[recording] as FileSpec).entries ?? [entry(1, [v(0, "ok"), v(1, "unsure")])] },
      })),
    },
  };
}

describe("finalStates", () => {
  it("uses the last non-empty list and ignores a trailing empty (flush) list", () => {
    const states = finalStates([entry(1, [v(0, "ok"), v(1, "unsure")]), entry(2, [v(0, "unsure")]), entry(3, [])]);
    expect(states[0]).toBe("unsure");
    // word 1 is absent from the last non-empty list: falls back to its last non-pending state
    expect(states[1]).toBe("unsure");
  });

  it("falls back to the last non-pending state when the final state is pending", () => {
    const states = finalStates([entry(1, [v(28, "ok")]), entry(2, [v(28, "pending")]), entry(3, [])]);
    expect(states[28]).toBe("ok");
  });

  it("is n/a for a word that was only ever pending or never listed", () => {
    const states = finalStates([entry(1, [v(28, "pending")]), entry(2, [v(0, "ok")])]);
    expect(states[28]).toBe("n/a");
    expect(states[5]).toBe("n/a");
    expect(finalStates([entry(1)])[0]).toBe("n/a");
  });

  it("lists words ever wrong or skipped from any list", () => {
    const entries = [entry(1, [v(3, "wrong")]), entry(2, [v(3, "ok"), v(9, "skipped")]), entry(3, [])];
    expect(everWrongOrSkipped(entries)).toEqual([3, 9]);
    expect(everWrongOrSkipped([entry(1, [v(0, "ok")])])).toEqual([]);
  });
});

describe("compareRuns", () => {
  it("says identical for the same run", () => {
    const a = run({ "1.aac": {}, "2.aac": {} });
    const c = compareRuns(a, run({ "1.aac": {}, "2.aac": {} }));
    expect(c.differences).toEqual([]);
    expect(formatComparison(c)).toContain("identical");
  });

  it("reports a moved confirm time by position", () => {
    const spec = Object.fromEntries(Array.from({ length: 29 }, (_, w) => [w, 100 + w]));
    const moved = { ...spec, 17: 140 };
    const c = compareRuns(run({ "1.aac": {} }), run({ "1.aac": { confirm: moved } }));
    expect(c.differences).toEqual(["1.aac: 1:6 w1 confirmMs a=117 b=140"]);
  });

  it("reports a word that is no longer confirmed", () => {
    const spec = Object.fromEntries(Array.from({ length: 28 }, (_, w) => [w, 100 + w]));
    const c = compareRuns(run({ "1.aac": {} }), run({ "1.aac": { confirm: spec } }));
    expect(c.differences).toEqual(["1.aac: 1:7 w9 confirmMs a=128 b=none"]);
  });

  it("reports a changed final state, a new wrong word, issues, false advances, restarts and first lock", () => {
    const a = run({ "1.aac": {} });
    const b = run({
      "1.aac": {
        issues: 1,
        falseAdvances: 2,
        restarts: 3,
        firstLock: 2.08,
        entries: [entry(1, [v(0, "wrong"), v(1, "unsure")]), entry(2, [v(0, "ok"), v(1, "unsure")])],
      },
    });
    const text = compareRuns(a, b).differences.join("\n");
    expect(text).toContain("ever wrong/skipped a=[] b=[1:1 w1]");
    expect(text).toContain("issues a=0 b=1");
    expect(text).toContain("false advances a=0 b=2");
    expect(text).toContain("restarts a=0 b=3");
    expect(text).toContain("first lock sec a=1.44 b=2.08");
  });

  it("treats ok/unsure flips as differences by default and allows them with --allow-state-flips", () => {
    const flipped = run({ "1.aac": { entries: [entry(1, [v(0, "unsure"), v(1, "unsure")])] } });
    const base = run({ "1.aac": {} });
    const strict = compareRuns(base, flipped);
    expect(strict.differences).toEqual(["1.aac: 1:1 w1 final state a=ok b=unsure"]);
    const allowed = compareRuns(base, flipped, 1);
    expect(allowed.differences).toEqual([]);
    expect(allowed.flips).toHaveLength(1);
    expect(formatComparison(allowed, 1)).toContain("within the allowed 1");
  });

  it("fails when flips exceed the allowance over all files", () => {
    const flipped = { entries: [entry(1, [v(0, "unsure"), v(1, "ok")])] };
    const c = compareRuns(run({ "1.aac": {}, "2.aac": {} }), run({ "1.aac": flipped, "2.aac": flipped }), 1);
    // each file flips word 0 (ok -> unsure) and word 1 (unsure -> ok): 4 flips, 1 allowed
    expect(c.flips).toHaveLength(4);
    expect(c.flipsOverAllowance).toBe(3);
    expect(c.differences).toHaveLength(4);
  });

  it("never allows a flip into or out of wrong, or a change to n/a", () => {
    const base = run({ "1.aac": {} });
    const wrong = run({ "1.aac": { entries: [entry(1, [v(0, "wrong"), v(1, "unsure")])] } });
    const c = compareRuns(base, wrong, 5);
    expect(c.differences.join("\n")).toContain("1:1 w1 final state a=ok b=wrong");
    const none = run({ "1.aac": { entries: [entry(1, [v(1, "unsure")])] } });
    expect(compareRuns(base, none, 5).differences).toEqual(["1.aac: 1:1 w1 final state a=ok b=n/a"]);
  });

  it("compares the intersection of the file sets and lists the rest", () => {
    const a = run({ "1.aac": {}, "2.aac": {}, "3.aac": {} });
    const b = run({ "2.aac": {}, "9.aac": {} });
    const c = compareRuns(a, b);
    expect(c.compared).toEqual(["2.aac"]);
    expect(c.onlyInA).toEqual(["1.aac", "3.aac"]);
    expect(c.onlyInB).toEqual(["9.aac"]);
    expect(c.differences).toEqual([]);
    const text = formatComparison(c);
    expect(text).toContain("only in a (not compared): 1.aac, 3.aac");
    expect(text).toContain("only in b (not compared): 9.aac");
    expect(text).toContain("identical");
  });

  it("labels positions as ayah and 1-based word", () => {
    expect(wordLabel(0)).toBe("1:1 w1");
    expect(wordLabel(17)).toBe("1:6 w1");
    expect(wordLabel(28)).toBe("1:7 w9");
  });
});

describe("input checks (fileProblems)", () => {
  const good = run({ "1.aac": {}, "2.aac": {} });

  it("accepts well-formed results and logs", () => {
    expect(fileProblems("results", good.results)).toEqual([]);
    expect(fileProblems("logs", good.logs)).toEqual([]);
  });

  it("reports a missing files array, perWord, issues and log.entries", () => {
    expect(fileProblems("results", { x: 1 })).toEqual(['no "files" array']);
    expect(fileProblems("logs", null)).toEqual(['no "files" array']);
    expect(fileProblems("results", { files: [{ recording: "1.aac", metrics: {}, issues: [] }] })).toEqual(['1.aac: no "metrics.perWord" array']);
    expect(fileProblems("results", { files: [{ recording: "1.aac", metrics: { perWord: [] } }] })).toEqual(['1.aac: no "issues" array']);
    expect(fileProblems("logs", { files: [{ recording: "1.aac", log: {} }] })).toEqual(['1.aac: no "log.entries" array']);
    expect(fileProblems("logs", { files: [{ log: { entries: [] } }] })).toEqual(['files[0] has no "recording" name']);
  });

  it("lists each duplicate recording name once, in results and in logs", () => {
    const twice = run({ "1.aac": {}, "2.aac": {} });
    const results = { files: [...twice.results.files, ...twice.results.files, twice.results.files[0]] };
    const logs = { files: [...twice.logs.files, twice.logs.files[1]] };
    expect(fileProblems("results", results)).toEqual(["duplicate recording name(s): 1.aac, 2.aac"]);
    expect(fileProblems("logs", logs)).toEqual(["duplicate recording name(s): 2.aac"]);
  });
});

describe("command line: bad input exits 2, a difference exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "compare-runs-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(__dirname, "compare-runs.ts");

  function write(name: string, json: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, typeof json === "string" ? json : JSON.stringify(json));
    return path;
  }
  function cli(...paths: string[]) {
    const r = spawnSync(process.execPath, [script, ...paths], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  const a = run({ "1.aac": {}, "2.aac": {} });
  const base = [write("a_results.json", a.results), write("a_logs.json", a.logs)] as const;

  it("exits 0 for identical runs and 1 for a difference", () => {
    const same = [write("s_results.json", a.results), write("s_logs.json", a.logs)];
    expect(cli(...base, ...same).code).toBe(0);
    const b = run({ "1.aac": { restarts: 1 }, "2.aac": {} });
    expect(cli(...base, write("d_results.json", b.results), write("d_logs.json", b.logs)).code).toBe(1);
  });

  // The bad file takes the place of run B's results (slot 2) or logs (slot 3).
  it.each([
    ["no files array", 2, { x: 1 }, 'no "files" array'],
    ["no perWord", 2, { files: [{ recording: "1.aac", metrics: {}, issues: [] }] }, 'no "metrics.perWord" array'],
    ["no issues", 2, { files: [{ recording: "1.aac", metrics: { perWord: [] } }] }, 'no "issues" array'],
    ["no log.entries", 3, { files: [{ recording: "1.aac", log: {} }] }, 'no "log.entries" array'],
    ["not JSON", 3, "{not json", "cannot read as JSON"],
  ])("exits 2 with a message, no stack trace: %s", (_label, slot, json, message) => {
    const paths: string[] = [...base, write("ok_results.json", a.results), write("ok_logs.json", a.logs)];
    paths[slot] = write("bad.json", json);
    const r = cli(...paths);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
    expect(r.err).not.toContain("TypeError");
  });

  it("exits 2 and names the recording when a results or logs file repeats one", () => {
    const dupResults = { files: [...a.results.files, { ...(a.results.files[0] as object), metrics: { ...(a.results.files[0] as { metrics: object }).metrics, restarts: 99 } }] };
    const dupLogs = { files: [...a.logs.files, { recording: "2.aac", log: { entries: [] } }] };
    const rr = cli(...base, write("dup_results.json", dupResults), base[1]);
    expect(rr.code).toBe(2);
    expect(rr.err).toContain("duplicate recording name(s): 1.aac");
    const rl = cli(...base, base[0], write("dup_logs.json", dupLogs));
    expect(rl.code).toBe(2);
    expect(rl.err).toContain("duplicate recording name(s): 2.aac");
    expect(rl.out).toBe("");
  });
});
