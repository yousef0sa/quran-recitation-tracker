// Per-chunk voicing features for the bench EventLog: RMS level, pitch clarity and f0 (McLeod NSDF).
// Used offline to ask "is the reciter still sounding?" (an ayah-end cue); nothing here touches the tracker.
// Only these three numbers are logged, never audio.
export interface VoiceFeatures {
  /** RMS of the chunk in dBFS, floored at -120. */
  rmsDb: number;
  /** NSDF value at the pitch peak, 0..1; the maximum over the chunk's windows. 1 = clearly periodic. */
  clarity: number;
  /** Pitch (Hz) of the window with that clarity; null when no pitch peak was found. */
  f0: number | null;
}

export const RMS_FLOOR_DB = -120;
/** NSDF window and hop: an 80 ms chunk (1280 samples) gives exactly 3 windows (starts 0, 384, 768). */
export const WINDOW = 512;
export const HOP = 384;
/** Lags 40..200 at 16 kHz = F0 400..80 Hz (at least ~2.5 periods fit in the window). */
export const LAG_MIN = 40;
export const LAG_MAX = 200;
/** The pitch peak is the first key maximum at least this fraction of the highest one (McLeod & Wyvill 2005). */
const KEY_FRACTION = 0.8;

const nsdf = new Float64Array(LAG_MAX + 2);
const prefix = new Float64Array(WINDOW + 1);

interface Pitch {
  clarity: number;
  f0: number | null;
}

/** NSDF pitch of one WINDOW-sample window (`window.length === WINDOW`). */
function windowPitch(window: Float32Array, rate: number): Pitch {
  prefix[0] = 0;
  for (let i = 0; i < WINDOW; i++) {
    const x = window[i] as number;
    prefix[i + 1] = (prefix[i] as number) + x * x;
  }
  const total = prefix[WINDOW] as number;
  if (total === 0) return { clarity: 0, f0: null };

  // nsdf[t] = 2 r(t) / m(t); m(t) from prefix sums of squares.
  for (let t = 0; t <= LAG_MAX + 1; t++) {
    let r = 0;
    for (let j = 0; j + t < WINDOW; j++) r += (window[j] as number) * (window[j + t] as number);
    const m = (prefix[WINDOW - t] as number) + (total - (prefix[t] as number));
    nsdf[t] = m > 0 ? (2 * r) / m : 0;
  }

  // Key maxima: the highest point of each positive region after the first negative dip (skips the lobe at lag 0).
  let t = 1;
  while (t <= LAG_MAX && (nsdf[t] as number) > 0) t++;
  const keys: number[] = [];
  while (t <= LAG_MAX) {
    while (t <= LAG_MAX && (nsdf[t] as number) <= 0) t++;
    let best = -1;
    while (t <= LAG_MAX && (nsdf[t] as number) > 0) {
      if (best < 0 || (nsdf[t] as number) > (nsdf[best] as number)) best = t;
      t++;
    }
    if (best >= LAG_MIN) keys.push(best);
  }
  if (keys.length === 0) return { clarity: 0, f0: null };

  let highest = 0;
  for (const k of keys) highest = Math.max(highest, nsdf[k] as number);
  const peak = keys.find((k) => (nsdf[k] as number) >= KEY_FRACTION * highest) as number;

  // Parabolic interpolation around the peak (neighbours exist: peak <= LAG_MAX, nsdf has LAG_MAX + 2 entries).
  const a = nsdf[peak - 1] as number;
  const b = nsdf[peak] as number;
  const c = nsdf[peak + 1] as number;
  const denom = a - 2 * b + c;
  const shift = denom < 0 ? (0.5 * (a - c)) / denom : 0;
  const lag = peak + Math.max(-1, Math.min(1, shift));
  return { clarity: Math.max(0, Math.min(1, b)), f0: rate / lag };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * RMS dBFS and the best pitch clarity of a chunk. NSDF runs on 512-sample windows hopped by 384 (no padding;
 * a chunk shorter than 512 samples gives one zero-padded window). The chunk value is the maximum clarity over its
 * windows, with that window's f0: a held vowel must never look unvoiced because one window is noisy.
 * Values are rounded (0.01 dB, 0.001, 0.1 Hz) for the log.
 */
export function voicingFeatures(samples: Float32Array, rate = 16000): VoiceFeatures {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] as number;
    sumSquares += x * x;
  }
  const rms = samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0;
  const rmsDb = rms > 0 ? Math.max(RMS_FLOOR_DB, 20 * Math.log10(rms)) : RMS_FLOOR_DB;

  let best: Pitch = { clarity: 0, f0: null };
  if (samples.length < WINDOW) {
    const padded = new Float32Array(WINDOW);
    padded.set(samples);
    best = windowPitch(padded, rate);
  } else {
    for (let start = 0; start + WINDOW <= samples.length; start += HOP) {
      const pitch = windowPitch(samples.subarray(start, start + WINDOW), rate);
      if (pitch.clarity > best.clarity) best = pitch;
    }
  }
  return { rmsDb: round(rmsDb, 2), clarity: round(best.clarity, 3), f0: best.f0 === null ? null : round(best.f0, 1) };
}
