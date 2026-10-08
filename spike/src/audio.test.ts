import { describe, expect, it } from "vitest";
import { CHUNK_SAMPLES, splitIntoChunks } from "./audio";

describe("splitIntoChunks", () => {
  it("splits into 2400-sample chunks with a shorter tail", () => {
    const samples = Float32Array.from({ length: 5000 }, (_, i) => i);
    const chunks = splitIntoChunks(samples);
    expect(chunks.map((c) => c.length)).toEqual([CHUNK_SAMPLES, CHUNK_SAMPLES, 200]);
    expect(chunks[2]?.[0]).toBe(4800);
  });
  it("returns independent copies (safe to transfer)", () => {
    const samples = new Float32Array(4800);
    const chunks = splitIntoChunks(samples);
    expect(chunks[0]?.buffer).not.toBe(samples.buffer);
    expect(chunks[0]?.buffer).not.toBe(chunks[1]?.buffer);
  });
  it("handles empty input and rejects a bad size", () => {
    expect(splitIntoChunks(new Float32Array(0))).toEqual([]);
    expect(() => splitIntoChunks(new Float32Array(10), 0)).toThrow();
  });
});
