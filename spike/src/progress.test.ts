import { describe, expect, it } from "vitest";
import type { WorkerOutbound } from "@tilawa/core";
import { INITIAL_PROGRESS, updateProgress } from "./progress";

function wp(ayah: number, word: number, total: number, matched: number[], surah = 1): WorkerOutbound {
  return { type: "word_progress", surah, ayah, word_index: word, total_words: total, matched_indices: matched };
}

describe("updateProgress", () => {
  it("moves the cursor and maps matched_indices to global indices", () => {
    const { state, changed, sawProgress } = updateProgress(INITIAL_PROGRESS, [wp(2, 2, 4, [0, 1])]);
    expect(state.cursor).toBe(6);
    expect([...state.matched].sort()).toEqual([4, 5]);
    expect(changed && sawProgress).toBe(true);
  });

  it("unions in the confirmed snapshot (ayah-final word)", () => {
    const { state } = updateProgress(INITIAL_PROGRESS, [wp(2, 0, 4, [])], [3]);
    expect([...state.matched]).toEqual([3]);
  });

  it("follows a restart: cursor and matched move back", () => {
    const a = updateProgress(INITIAL_PROGRESS, [wp(2, 2, 4, [0, 1])], [0, 1, 2, 3]).state;
    const b = updateProgress(a, [wp(1, 1, 4, [0])], [0]).state;
    expect(b.cursor).toBe(1);
    expect([...b.matched]).toEqual([0]);
  });

  it("keeps the last word_progress matched set across chunks without progress", () => {
    const a = updateProgress(INITIAL_PROGRESS, [wp(1, 2, 4, [0, 1])]).state;
    const { state, changed, sawProgress } = updateProgress(a, [], []);
    expect([...state.matched].sort()).toEqual([0, 1]);
    expect(changed).toBe(false);
    expect(sawProgress).toBe(false);
  });

  it("ignores other surahs and a cursor past the last word", () => {
    expect(updateProgress(INITIAL_PROGRESS, [wp(1, 2, 4, [0], 2)]).state.cursor).toBeNull();
    expect(updateProgress(INITIAL_PROGRESS, [wp(7, 9, 9, [])]).state.cursor).toBeNull();
  });
});
