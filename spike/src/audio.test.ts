import { describe, expect, it } from "vitest";
import { CHUNK_MS_OPTIONS, DEFAULT_CHUNK_MS, chunkSamplesForMs, parseChunkMs, splitIntoChunks } from "./audio";

describe("parseChunkMs", () => {
  it("accepts every allowed size", () => {
    expect(CHUNK_MS_OPTIONS).toEqual([80, 150, 300]);
    expect(parseChunkMs("80")).toBe(80);
    expect(parseChunkMs("150")).toBe(150);
    expect(parseChunkMs("300")).toBe(300);
  });
  it("defaults to 80 ms", () => {
    expect(DEFAULT_CHUNK_MS).toBe(80);
    expect(parseChunkMs(null)).toBe(80);
    expect(parseChunkMs(undefined)).toBe(80);
    expect(parseChunkMs("")).toBe(80);
  });
  it("falls back to the default for anything not in the list", () => {
    for (const bad of ["100", "0", "-80", "abc", "80.5", " 150", "1e2", "0x50", "NaN"]) {
      expect(parseChunkMs(bad)).toBe(80);
    }
  });
});

describe("chunkSamplesForMs", () => {
  it("converts ms to samples at 16 kHz", () => {
    expect(chunkSamplesForMs(80)).toBe(1280);
    expect(chunkSamplesForMs(150)).toBe(2400);
    expect(chunkSamplesForMs(300)).toBe(4800);
    expect(chunkSamplesForMs(1000)).toBe(16000);
  });
  it("gives a whole number for every allowed size", () => {
    for (const ms of CHUNK_MS_OPTIONS) expect(Number.isInteger(chunkSamplesForMs(ms))).toBe(true);
  });
});

describe("splitIntoChunks", () => {
  it("splits into default-size (80 ms) chunks with a shorter tail", () => {
    const size = chunkSamplesForMs(DEFAULT_CHUNK_MS);
    const samples = Float32Array.from({ length: 2 * size + 200 }, (_, i) => i);
    const chunks = splitIntoChunks(samples);
    expect(chunks.map((c) => c.length)).toEqual([size, size, 200]);
    expect(chunks[2]?.[0]).toBe(2 * size);
  });
  it("takes an explicit chunk size", () => {
    const chunks = splitIntoChunks(new Float32Array(5000), chunkSamplesForMs(150));
    expect(chunks.map((c) => c.length)).toEqual([2400, 2400, 200]);
  });
  it("returns independent copies (safe to transfer)", () => {
    const samples = new Float32Array(2 * chunkSamplesForMs(DEFAULT_CHUNK_MS));
    const chunks = splitIntoChunks(samples);
    expect(chunks[0]?.buffer).not.toBe(samples.buffer);
    expect(chunks[0]?.buffer).not.toBe(chunks[1]?.buffer);
  });
  it("handles empty input and rejects a bad size", () => {
    expect(splitIntoChunks(new Float32Array(0))).toEqual([]);
    expect(() => splitIntoChunks(new Float32Array(10), 0)).toThrow();
  });
});
