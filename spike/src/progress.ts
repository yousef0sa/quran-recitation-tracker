// Live-view state: where the cursor is and which words count as matched.
// A word is matched when it is in a word_progress.matched_indices (mapped to the global index) OR in
// the verdict snapshot `confirmed` (which also covers ayah-final words). `matched` is cumulative:
// a word stays matched until the state is reset to INITIAL_PROGRESS (live page Start). The snapshot
// is not: tilawa returns to search on silence or completion and `verdicts()` is then empty, so the
// view would drop to the last ayah's words after Stop. The bench already counts words ever
// confirmed, so live and bench agree.
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

  const matched = new Set<number>(prev.matched);
  for (const word of eventMatched) matched.add(word);
  for (const word of confirmed) if (word >= 0 && word < WORD_COUNT) matched.add(word);
  const changed = cursor !== prev.cursor || matched.size !== prev.matched.size;
  return { state: { cursor, matched, eventMatched }, changed, sawProgress };
}
