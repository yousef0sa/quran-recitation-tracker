// ORT session wrapper for the worker. It creates the session exactly like tilawa's own ZipformerRunner.create
// (same options, same Uint8Array input) and hands tilawa `{ session, Tensor }`, so that
//  - every session.run is timed on its own (modelMs, outside the CTC statistics), and
//  - the CTC posteriors of each step (blank mass, strongest non-blank) are read from log_probs.
// The wrapper returns tilawa's outputs untouched. Nothing here may change what the tracker sees.

/** Same shape as tilawa's TensorLike (not exported from @tilawa/core). */
export interface TensorOut {
  data: Float32Array | BigInt64Array | Int32Array;
  dims: readonly number[];
  type: string;
}

/** Same shape as tilawa's OrtSessionLike. */
export interface RunSession {
  run(feeds: Record<string, TensorOut>): Promise<Record<string, TensorOut>>;
}

/** The part of `onnxruntime-web` this module needs. */
export interface OrtForSession {
  InferenceSession: {
    create(model: Uint8Array, options: { executionProviders: string[]; graphOptimizationLevel: "all" }): Promise<RunSession>;
  };
}

/** Vocabulary of the zipformer CTC head (tokens.js) and the id of its blank. */
export const CTC_VOCAB = 251;
export const CTC_BLANK_ID = 250;

export interface PosteriorStats {
  /** Mean over frames of P(blank). Null without frames. */
  blank: number | null;
  /** Max over frames of the strongest non-blank probability. Null without frames. */
  top: number | null;
}

/** Posteriors of `frames` log-softmax rows of `vocab` values each (row-major). */
export function posteriorStats(logProbs: ArrayLike<number>, frames: number, vocab = CTC_VOCAB, blankId = CTC_BLANK_ID): PosteriorStats {
  if (frames <= 0 || vocab <= 0) return { blank: null, top: null };
  let blankSum = 0;
  let top = 0;
  for (let f = 0; f < frames; f++) {
    const row = f * vocab;
    blankSum += Math.exp(logProbs[row + blankId] as number);
    for (let k = 0; k < vocab; k++) {
      if (k === blankId) continue;
      const p = Math.exp(logProbs[row + k] as number);
      if (p > top) top = p;
    }
  }
  return { blank: blankSum / frames, top };
}

/** What happened in the model since the last `take()`. */
export interface TimedTake {
  /** Σ of the real `run` durations (the timer stops when `run` resolves). */
  modelMs: number;
  /** Number of `run` calls. */
  runs: number;
  /** Mean P(blank) over all frames of those runs; null when there were none. */
  blank: number | null;
  /** Max non-blank probability over those frames; null when there were none. */
  top: number | null;
}

export interface TimedSession {
  session: RunSession;
  /** Returns the accumulated values and resets them. */
  take(): TimedTake;
}

/** Wraps `inner`: times each run, then reads log_probs (outside the timed part). */
export function timeSession(inner: RunSession): TimedSession {
  let modelMs = 0;
  let runs = 0;
  let blankSum = 0;
  let frameCount = 0;
  let top = 0;
  return {
    session: {
      async run(feeds) {
        const started = performance.now();
        const out = await inner.run(feeds);
        modelMs += performance.now() - started;
        runs++;
        const lp = out.log_probs;
        if (lp) {
          const frames = lp.dims.length >= 2 ? Number(lp.dims[1]) : Math.floor(lp.data.length / CTC_VOCAB);
          const stats = posteriorStats(lp.data as Float32Array, frames);
          if (stats.blank !== null && stats.top !== null) {
            blankSum += stats.blank * frames;
            frameCount += frames;
            if (stats.top > top) top = stats.top;
          }
        }
        return out;
      },
    },
    take() {
      const taken: TimedTake = {
        modelMs,
        runs,
        blank: frameCount > 0 ? blankSum / frameCount : null,
        top: frameCount > 0 ? top : null,
      };
      modelMs = 0;
      runs = 0;
      blankSum = 0;
      frameCount = 0;
      top = 0;
      return taken;
    },
  };
}

/** Creates the ORT session with tilawa's own options and returns it wrapped by {@link timeSession}. */
export async function createTimedSession(ort: OrtForSession, modelBytes: ArrayBuffer | Uint8Array): Promise<TimedSession> {
  const bytes = modelBytes instanceof Uint8Array ? modelBytes : new Uint8Array(modelBytes);
  const inner = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  return timeSession(inner);
}
