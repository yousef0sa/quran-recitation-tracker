// Live-view state: where the cursor is and which words count as matched.
// A word is matched when it is in the latest word_progress.matched_indices (mapped to the global
// index) OR in the verdict snapshot `confirmed` (which also covers ayah-final words).
import type { WorkerOutbound } from "@tilawa/core";
import { WORD_COUNT, tryCursorToGlobal, tryToGlobalWordIndex } from "./fatiha";

export interface ProgressState {
  /** Global cursor word 0..28, or null before the first lock. */
  cursor: number | null;
  matched: ReadonlySet<number>;
  /** matched_indices of the latest word_progress, kept between chunks that carry none. */
  eventMatched: readonly number[];
}

export const INITIAL_PROGRESS: ProgressState = { cursor: null, matched: new Set(), eventMatched: [] };

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export function updateProgress(
  prev: ProgressState,
  events: readonly WorkerOutbound[],
  confirmed: readonly number[] = [],
): { state: ProgressState; changed: boolean; sawProgress: boolean } {
  let cursor = prev.cursor;
  let eventMatched = prev.eventMatched;
  let sawProgress = false;

  for (const event of events) {
    if (event.type !== "word_progress" || event.surah !== 1) continue;
    sawProgress = true;
    const global = tryCursorToGlobal(event.ayah, event.word_index);
    // a position outside Al-Fatiha's table keeps the previous cursor
    if (global !== null) cursor = global < WORD_COUNT ? global : null;
    eventMatched = event.matched_indices.flatMap((index) => {
      const word = tryToGlobalWordIndex(event.ayah, index);
      return word === null ? [] : [word];
    });
  }

  const matched = new Set<number>([...eventMatched, ...confirmed.filter((w) => w >= 0 && w < WORD_COUNT)]);
  const changed = cursor !== prev.cursor || !sameSet(matched, prev.matched);
  return { state: { cursor, matched, eventMatched }, changed, sawProgress };
}
