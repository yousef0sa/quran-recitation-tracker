import { describe, expect, it } from "vitest";
import { voicingFeatures } from "./voicing";

const RATE = 16000;

/** Seeded uniform noise in [-amp, amp] (mulberry32). */
function noise(length: number, amp: number, seed = 1234): Float32Array {
  let a = seed >>> 0;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1) * amp;
  }
  return out;
}

function sine(freq: number, length: number, peak: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = peak * Math.sin((2 * Math.PI * freq * i) / RATE);
  return out;
}

const MINUS_20_DB_PEAK = 0.1 * Math.SQRT2; // RMS 0.1 = -20 dBFS

describe("voicingFeatures", () => {
  it("a 150 Hz sine at -20 dBFS is clearly voiced", () => {
    const v = voicingFeatures(sine(150, 1280, MINUS_20_DB_PEAK), RATE);
    expect(v.clarity).toBeGreaterThan(0.95);
    expect(v.f0).not.toBeNull();
    expect(Math.abs((v.f0 as number) - 150)).toBeLessThan(3);
    expect(v.rmsDb).toBeGreaterThan(-20.5);
    expect(v.rmsDb).toBeLessThan(-19.5);
  });

  it("a 90 Hz sine (low voice) is still voiced", () => {
    const v = voicingFeatures(sine(90, 1280, MINUS_20_DB_PEAK), RATE);
    expect(v.clarity).toBeGreaterThan(0.9);
    expect(Math.abs((v.f0 as number) - 90)).toBeLessThan(3);
  });

  it("white noise is not voiced", () => {
    const v = voicingFeatures(noise(1280, 0.3), RATE);
    expect(v.clarity).toBeLessThan(0.5);
  });

  it("silence gives -120 dB, clarity 0 and no f0", () => {
    expect(voicingFeatures(new Float32Array(1280), RATE)).toEqual({ rmsDb: -120, clarity: 0, f0: null });
    expect(voicingFeatures(new Float32Array(0), RATE)).toEqual({ rmsDb: -120, clarity: 0, f0: null });
  });

  it("a hard-clipped 150 Hz sine (peak 0.9 clipped at +-0.3) is still voiced", () => {
    const clipped = sine(150, 1280, 0.9).map((x) => Math.max(-0.3, Math.min(0.3, x)));
    const v = voicingFeatures(clipped, RATE);
    expect(v.clarity).toBeGreaterThan(0.8);
    expect(Math.abs((v.f0 as number) - 150)).toBeLessThan(3);
  });

  it("takes the maximum over windows: a sine in samples 0-511 and noise after is voiced", () => {
    const mixed = noise(1280, 0.1, 99);
    mixed.set(sine(150, 512, MINUS_20_DB_PEAK), 0);
    // The windows start at 0, 384 and 768: only the first one is clean.
    const v = voicingFeatures(mixed, RATE);
    expect(v.clarity).toBeGreaterThan(0.9);
  });

  it("a chunk shorter than one window is zero-padded and does not throw", () => {
    const v = voicingFeatures(sine(150, 600, MINUS_20_DB_PEAK), RATE);
    expect(v.clarity).toBeGreaterThan(0.9);
    const tiny = voicingFeatures(sine(150, 100, MINUS_20_DB_PEAK), RATE);
    expect(Number.isFinite(tiny.rmsDb)).toBe(true);
    expect(tiny.clarity).toBeGreaterThanOrEqual(0);
    expect(tiny.clarity).toBeLessThanOrEqual(1);
  });

  it("longer chunks (150 ms, 300 ms) give more windows and work the same", () => {
    expect(voicingFeatures(sine(150, 2400, MINUS_20_DB_PEAK), RATE).clarity).toBeGreaterThan(0.95);
    expect(voicingFeatures(sine(150, 4800, MINUS_20_DB_PEAK), RATE).clarity).toBeGreaterThan(0.95);
  });

  it("does not modify its input", () => {
    const samples = sine(150, 1280, MINUS_20_DB_PEAK);
    const copy = Float32Array.from(samples);
    voicingFeatures(samples, RATE);
    expect(samples).toEqual(copy);
  });
});
