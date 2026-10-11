import { describe, expect, it, vi } from "vitest";
import { CTC_BLANK_ID, CTC_VOCAB, createTimedSession, posteriorStats, timeSession, type RunSession, type TensorOut } from "./model-session";

function rows(frames: number, fill: (frame: number, k: number) => number): Float32Array {
  const data = new Float32Array(frames * CTC_VOCAB);
  for (let f = 0; f < frames; f++) for (let k = 0; k < CTC_VOCAB; k++) data[f * CTC_VOCAB + k] = fill(f, k);
  return data;
}

const allBlank = (f: number, k: number) => (k === CTC_BLANK_ID ? 0 : -30);
const uniform = () => Math.log(1 / CTC_VOCAB);

function tensor(data: Float32Array, frames: number): TensorOut {
  return { data, dims: [1, frames, CTC_VOCAB], type: "float32" };
}

describe("posteriorStats", () => {
  it("all mass on blank: blank 1, top near 0", () => {
    const stats = posteriorStats(rows(8, allBlank), 8);
    expect(stats.blank).toBeCloseTo(1, 6);
    expect(stats.top).toBeLessThan(1e-6);
  });

  it("uniform distribution: both about 1/251", () => {
    const stats = posteriorStats(rows(4, uniform), 4);
    expect(stats.blank).toBeCloseTo(1 / 251, 6);
    expect(stats.top).toBeCloseTo(1 / 251, 6);
  });

  it("zero frames gives null values", () => {
    expect(posteriorStats(new Float32Array(0), 0)).toEqual({ blank: null, top: null });
  });

  it("blank is the mean over frames and top the max", () => {
    // frame 0 all blank, frame 1 half blank / half one token
    const data = rows(2, (f, k) => (f === 0 ? allBlank(f, k) : k === CTC_BLANK_ID || k === 3 ? Math.log(0.5) : -30));
    const stats = posteriorStats(data, 2);
    expect(stats.blank).toBeCloseTo(0.75, 6);
    expect(stats.top).toBeCloseTo(0.5, 6);
  });
});

describe("timeSession", () => {
  function fakeSession(delayMs: number, frames: number, fill: (f: number, k: number) => number): { inner: RunSession; outputs: Record<string, TensorOut>[] } {
    const outputs: Record<string, TensorOut>[] = [];
    return {
      outputs,
      inner: {
        async run() {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          const out = { log_probs: tensor(rows(frames, fill), frames), new_state: { data: new Float32Array(1), dims: [1], type: "float32" } };
          outputs.push(out);
          return out;
        },
      },
    };
  }

  it("returns the real outputs untouched", async () => {
    const { inner, outputs } = fakeSession(0, 8, allBlank);
    const timed = timeSession(inner);
    const out = await timed.session.run({});
    expect(out).toBe(outputs[0]);
  });

  it("accumulates time, runs and posteriors, and take() resets", async () => {
    const { inner } = fakeSession(5, 8, allBlank);
    const timed = timeSession(inner);
    await timed.session.run({});
    await timed.session.run({});
    const first = timed.take();
    expect(first.runs).toBe(2);
    expect(first.modelMs).toBeGreaterThanOrEqual(8);
    expect(first.blank).toBeCloseTo(1, 6);
    expect(first.top).toBeLessThan(1e-6);
    expect(timed.take()).toEqual({ modelMs: 0, runs: 0, blank: null, top: null });
  });

  it("stops the timer when the real run resolves, before the posteriors are read", async () => {
    const out = { log_probs: tensor(rows(8, uniform), 8) };
    const timed = timeSession({ run: async () => out });
    // Clock reads: start of run, end of run. A third read (a timer still running during the posteriors) would give 500.
    const reads = [100, 110, 600];
    const now = vi.spyOn(performance, "now").mockImplementation(() => reads.shift() as number);
    try {
      await timed.session.run({});
    } finally {
      now.mockRestore();
    }
    expect(timed.take().modelMs).toBe(10);
  });

  it("outputs without log_probs still count the run", async () => {
    const timed = timeSession({ run: async () => ({}) });
    await timed.session.run({});
    expect(timed.take()).toMatchObject({ runs: 1, blank: null, top: null });
  });
});

describe("createTimedSession", () => {
  it("creates the session with tilawa's options and a Uint8Array", async () => {
    let seen: { model: unknown; options: unknown } | null = null;
    const ort = {
      InferenceSession: {
        async create(model: Uint8Array, options: { executionProviders: string[]; graphOptimizationLevel: "all" }) {
          seen = { model, options };
          return { run: async () => ({}) };
        },
      },
    };
    await createTimedSession(ort, new ArrayBuffer(4));
    const call = seen as unknown as { model: unknown; options: unknown };
    expect(call.model).toBeInstanceOf(Uint8Array);
    expect((call.model as Uint8Array).length).toBe(4);
    expect(call.options).toEqual({ executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  });
});
