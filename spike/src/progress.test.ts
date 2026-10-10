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

  it("follows a restart: the cursor moves back, matched words stay", () => {
    const a = updateProgress(INITIAL_PROGRESS, [wp(2, 2, 4, [0, 1])], [0, 1, 2, 3]).state;
    const b = updateProgress(a, [wp(1, 1, 4, [0])], [0]).state;
    expect(b.cursor).toBe(1);
    expect([...b.matched].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("keeps a snapshot-confirmed word after a later empty snapshot", () => {
    const a = updateProgress(INITIAL_PROGRESS, [wp(1, 2, 4, [0, 1])], [0, 1, 2]).state;
    const { state, changed } = updateProgress(a, [], []);
    expect([...state.matched].sort()).toEqual([0, 1, 2]);
    expect(changed).toBe(false);
  });

  it("keeps matched_indices words after a word_progress for the next ayah", () => {
    const a = updateProgress(INITIAL_PROGRESS, [wp(1, 3, 4, [0, 1, 2])]).state;
    const { state, changed } = updateProgress(a, [wp(2, 1, 4, [0])]);
    expect([...state.matched].sort()).toEqual([0, 1, 2, 4]);
    expect(state.cursor).toBe(5);
    expect(changed).toBe(true);
  });

  it("is cleared by resetting to INITIAL_PROGRESS", () => {
    const a = updateProgress(INITIAL_PROGRESS, [wp(1, 2, 4, [0, 1])], [0, 1, 2]).state;
    expect(a.matched.size).toBe(3);
    const { state, changed } = updateProgress(INITIAL_PROGRESS, [], []);
    expect(state.matched.size).toBe(0);
    expect(state.cursor).toBeNull();
    expect(changed).toBe(false);
  });

  it("reports no change when nothing new is added", () => {
    const a = updateProgress(INITIAL_PROGRESS, [wp(1, 2, 4, [0, 1])], [0, 1]).state;
    expect(updateProgress(a, [wp(1, 2, 4, [0, 1])], [1]).changed).toBe(false);
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
