// Stateful linear resampler with continuous phase across blocks.
// A per-block (stateless) resampler restarts its phase every block and drifts the tempo
// (tilawa fixed a 0.78 % bug of this kind). The same algorithm lives in
// public/audio-processor.js (worklets cannot import app modules): keep the two in sync.

export interface LinearResampler {
  process(block: Float32Array): Float32Array;
}

export function createLinearResampler(inRate: number, outRate: number): LinearResampler {
  if (!(inRate > 0) || !(outRate > 0)) throw new RangeError("sample rates must be positive");
  const step = inRate / outRate;
  // Position of the next output sample in input coordinates relative to the current block start;
  // index -1 is the last sample of the previous block.
  let pos = 0;
  let prev = 0;

  return {
    process(block: Float32Array): Float32Array {
      const n = block.length;
      if (n === 0) return new Float32Array(0);
      // Upper bound on the number of output samples for this block.
      const out = new Float32Array(Math.max(0, Math.ceil((n - pos) / step)) + 1);
      let count = 0;
      while (pos <= n - 1) {
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const s0 = i0 < 0 ? prev : (block[i0] as number);
        const s1 = i0 + 1 <= n - 1 ? (block[i0 + 1] as number) : s0;
        out[count++] = s0 + (s1 - s0) * frac;
        pos += step;
      }
      pos -= n;
      prev = block[n - 1] as number;
      return out.slice(0, count);
    },
  };
}
