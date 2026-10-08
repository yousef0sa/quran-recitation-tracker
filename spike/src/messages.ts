// Typed main <-> worker protocol. The worker never throws across the boundary: it posts `error`.
import type { WorkerOutbound } from "@tilawa/core";
import type { VariantId } from "./variants";

export type MainToWorker =
  | { type: "init"; variant: VariantId }
  | { type: "audio"; chunkId: number; samples: Float32Array }
  | { type: "stop" }
  | { type: "reset" };

export type WorkerToMain =
  | { type: "ready"; loadMs: number; variant: VariantId }
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
      events: WorkerOutbound[];
    }
  /** Correction variants (A2/B2): a correction issue was opened and auto-resolved so feeding can continue. */
  | { type: "issue"; issue: unknown; chunkId: number; samplesFed: number }
  | { type: "error"; stage: "load" | "feed" | "stop"; message: string };
