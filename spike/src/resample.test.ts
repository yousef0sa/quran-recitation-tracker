import { describe, expect, it } from "vitest";
import workletSource from "../public/audio-processor.js?raw";
import { createLinearResampler } from "./resample";

// Synthetic 440 Hz sine: a DSP unit-test signal, not recitation audio.
function sine(rate: number, seconds: number, hz = 440): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

function runInBlocks(input: Float32Array, blockSizes: number[], inRate: number, outRate: number): Float32Array {
  const resampler = createLinearResampler(inRate, outRate);
  const parts: Float32Array[] = [];
  let at = 0;
  let k = 0;
  while (at < input.length) {
    const size = blockSizes[k++ % blockSizes.length] as number;
    parts.push(resampler.process(input.subarray(at, Math.min(input.length, at + size))));
    at += size;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("createLinearResampler", () => {
  const uneven = [128, 1, 333, 1000, 7, 4096, 129, 500];

  it("48 kHz -> 16 kHz: 1 s in uneven blocks gives 16000 +- 1 samples", () => {
    const out = runInBlocks(sine(48000, 1), uneven, 48000, 16000);
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(1);
  });

  it("44.1 kHz -> 16 kHz gives 16000 +- 1 samples", () => {
    const out = runInBlocks(sine(44100, 1), uneven, 44100, 16000);
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(1);
  });

  it("output does not depend on block boundaries (no phase reset, no discontinuity)", () => {
    const input = sine(48000, 1);
    const whole = runInBlocks(input, [input.length], 48000, 16000);
    const chunked = runInBlocks(input, uneven, 48000, 16000);
    expect(chunked.length).toBe(whole.length);
    let maxDiff = 0;
    for (let i = 0; i < whole.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs((whole[i] as number) - (chunked[i] as number)));
    }
    expect(maxDiff).toBeLessThan(1e-6);
  });

  it("consecutive output samples never jump more than the sine's own slope", () => {
    const out = runInBlocks(sine(48000, 1), uneven, 48000, 16000);
    // 440 Hz at 16 kHz: max step = 2 * sin(pi * 440 / 16000) ~ 0.173
    let maxStep = 0;
    for (let i = 1; i < out.length; i++) {
      maxStep = Math.max(maxStep, Math.abs((out[i] as number) - (out[i - 1] as number)));
    }
    expect(maxStep).toBeLessThan(0.2);
  });

  it("keeps the tempo: the resampled sine still has 440 Hz", () => {
    const out = runInBlocks(sine(48000, 1), uneven, 48000, 16000);
    let crossings = 0;
    for (let i = 1; i < out.length; i++) {
      if ((out[i - 1] as number) < 0 && (out[i] as number) >= 0) crossings++;
    }
    expect(Math.abs(crossings - 440)).toBeLessThanOrEqual(1);
  });

  it("equal rates pass samples through unchanged", () => {
    const input = sine(16000, 0.1);
    const out = runInBlocks(input, uneven, 16000, 16000);
    expect(out.length).toBe(input.length);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("handles empty blocks and rejects bad rates", () => {
    const r = createLinearResampler(48000, 16000);
    expect(r.process(new Float32Array(0)).length).toBe(0);
    expect(() => createLinearResampler(0, 16000)).toThrow();
  });
});

describe("public/audio-processor.js stays in sync with the resampler", () => {
  type Processor = {
    port: { postMessage(msg: { samples: Float32Array; contextTime: number }, transfer: Transferable[]): void };
    process(inputs: Float32Array[][]): boolean;
  };

  function loadWorklet(sampleRate: number, posted: Float32Array[]): Processor {
    let ctor: (new () => Processor) | undefined;
    class FakeBase {
      port = {
        postMessage: (msg: { samples: Float32Array }) => {
          posted.push(msg.samples);
        },
      };
    }
    const factory = new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", "currentTime", workletSource);
    factory(FakeBase, (_name: string, c: new () => Processor) => (ctor = c), sampleRate, 0);
    if (!ctor) throw new Error("worklet did not register a processor");
    return new ctor();
  }

  it.each([48000, 44100, 16000])("emits 2400-sample chunks equal to the resampler output (%i Hz)", (rate) => {
    const posted: Float32Array[] = [];
    const worklet = loadWorklet(rate, posted);
    const input = sine(rate, 1);
    const reference = createLinearResampler(rate, 16000);
    const expected: number[] = [];
    for (let at = 0; at < input.length; at += 128) {
      const block = input.subarray(at, Math.min(input.length, at + 128));
      worklet.process([[block]]);
      expected.push(...reference.process(block));
    }
    expect(posted.length).toBeGreaterThanOrEqual(5);
    posted.forEach((chunk) => expect(chunk.length).toBe(2400));
    const got = posted.flatMap((c) => Array.from(c));
    expect(got).toEqual(expected.slice(0, got.length));
  });
});
