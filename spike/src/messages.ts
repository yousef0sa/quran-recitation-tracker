// Typed main <-> worker protocol. The worker never throws across the boundary: it posts `error`.
import type { WorkerOutbound } from "@tilawa/core";
import type { EngineOverride } from "./engine-config";
import type { CompactVerdict, CtcStats } from "./metrics";
import type { VariantId } from "./variants";
import type { Threads } from "./wasm-threads";

export type MainToWorker =
  /**
   * `engine` is the bench's optional tilawa override; absent or empty means tilawa's defaults. `threads` is the requested WASM thread count (default 1).
   * `model` is the bench's `?model=<name>.onnx` (a file in models/, loaded with the variant's io); absent means the variant's own model.
   */
  | { type: "init"; variant: VariantId; engine?: EngineOverride; threads?: Threads; model?: string; io?: string }
  | { type: "audio"; chunkId: number; samples: Float32Array }
  | { type: "stop" }
  | { type: "reset" };

export type WorkerToMain =
  /**
   * `engine` is the override actually applied to the session ({} = tilawa defaults). `threads` is the effective
   * WASM thread count (1 when the page is not cross-origin isolated), `requestedThreads` what init asked for.
   */
  | {
      type: "ready";
      loadMs: number;
      variant: VariantId;
      engine: EngineOverride;
      requestedThreads: Threads;
      threads: number;
      crossOriginIsolated: boolean;
      /** Model path actually loaded (under the site root), e.g. "models/x.onnx". */
      modelPath: string;
      /** io manifest loaded with `init.io` (under the site root); null when the variant's own io applies. */
      ioPath: string | null;
    }
  /** Acknowledges {type:"reset"}; a failed reset posts an error instead. */
  | { type: "resetDone" }
  | {
      type: "events";
      chunkId: number;
      /** Total samples fed (16 kHz) after this chunk; audio time = samplesFed / 16000. */
      samplesFed: number;
      /** Time of feed() only. */
      computeMs: number;
      /** Time of the session.verdicts() snapshot, kept out of computeMs. */
      verdictsMs: number;
      /** Global Fatiha word indices (0..28) with verdict "ok" or "unsure" after this chunk. */
      confirmed: number[];
      /** Full surah-1 verdict list, only when it differs from the previous one posted this session (empty = tilawa is back in search). */
      verdicts?: CompactVerdict[];
      /** Σ of the model's session.run times inside this feed() (part of computeMs), and how many runs. */
      modelMs?: number;
      modelRuns?: number;
      /** CTC posteriors of this chunk's model steps; present only when modelRuns > 0. */
      ctc?: CtcStats;
      events: WorkerOutbound[];
    }
  | {
      type: "stopped";
      /** Samples fed before the flush (stop() itself appends tailSeconds of silence). */
      samplesFed: number;
      /** Time of session.stop() (includes the tail silence it appends). */
      computeMs: number;
      verdictsMs: number;
      confirmed: number[];
      /** Always present: the final full verdict list. */
      verdicts?: CompactVerdict[];
      modelMs?: number;
      modelRuns?: number;
      ctc?: CtcStats;
      events: WorkerOutbound[];
    }
  /** Correction variants (A2/B2): a correction issue was opened and auto-resolved so feeding can continue. */
  | { type: "issue"; issue: unknown; chunkId: number; samplesFed: number }
  | { type: "error"; stage: "load" | "feed" | "stop"; message: string };
