import { describe, expect, it } from "vitest";
import {
  AYAH_OFFSETS,
  AYAH_WORD_COUNTS,
  WORD_COUNT,
  cursorToGlobal,
  fromGlobalWordIndex,
  loadFatihaDisplayWords,
  toGlobalWordIndex,
  tryCursorToGlobal,
  tryToGlobalWordIndex,
} from "./fatiha";

describe("Al-Fatiha constants", () => {
  it("has 29 words in 7 ayahs and matching offsets", () => {
    expect(AYAH_WORD_COUNTS.reduce((a, b) => a + b, 0)).toBe(WORD_COUNT);
    expect([...AYAH_OFFSETS]).toEqual([0, 4, 8, 10, 13, 17, 20]);
  });
});

describe("toGlobalWordIndex", () => {
  it("maps bounds", () => {
    expect(toGlobalWordIndex(1, 0)).toBe(0);
    expect(toGlobalWordIndex(2, 0)).toBe(4);
    expect(toGlobalWordIndex(7, 8)).toBe(28);
  });
  it("throws out of range", () => {
    expect(() => toGlobalWordIndex(3, 2)).toThrow();
    expect(() => toGlobalWordIndex(8, 0)).toThrow();
    expect(() => toGlobalWordIndex(0, 0)).toThrow();
    expect(() => toGlobalWordIndex(1, -1)).toThrow();
    expect(() => toGlobalWordIndex(1, 1.5)).toThrow();
  });
  it("round-trips all 29 indices", () => {
    for (let g = 0; g < WORD_COUNT; g++) {
      const { ayah, word } = fromGlobalWordIndex(g);
      expect(toGlobalWordIndex(ayah, word)).toBe(g);
    }
    expect(fromGlobalWordIndex(28)).toEqual({ ayah: 7, word: 8 });
    expect(fromGlobalWordIndex(4)).toEqual({ ayah: 2, word: 0 });
  });
  it("fromGlobalWordIndex throws out of range", () => {
    expect(() => fromGlobalWordIndex(29)).toThrow();
    expect(() => fromGlobalWordIndex(-1)).toThrow();
  });
});

describe("cursorToGlobal", () => {
  it("matches toGlobalWordIndex inside the ayah", () => {
    expect(cursorToGlobal(1, 0)).toBe(0);
    expect(cursorToGlobal(7, 8)).toBe(28);
  });
  it("allows word === count: first word of the next ayah, 29 after ayah 7", () => {
    expect(cursorToGlobal(1, 4)).toBe(4);
    expect(cursorToGlobal(3, 2)).toBe(10);
    expect(cursorToGlobal(7, 9)).toBe(29);
  });
  it("throws beyond count or for a bad ayah", () => {
    expect(() => cursorToGlobal(3, 3)).toThrow();
    expect(() => cursorToGlobal(8, 0)).toThrow();
    expect(() => cursorToGlobal(1, -1)).toThrow();
  });
});

describe("loadFatihaDisplayWords", () => {
  const fakeCorpus = (counts: readonly number[]) => ({
    v: 2,
    surahs: [
      {
        ayahs: counts.map((n, i) => ({
          n: i + 1,
          w: Array.from({ length: n }, (_, j) => ["g", "p", `w${i + 1}.${j}`]),
        })),
      },
    ],
  });
  it("returns 29 words in order", () => {
    const words = loadFatihaDisplayWords(fakeCorpus(AYAH_WORD_COUNTS));
    expect(words).toHaveLength(29);
    expect(words[0]).toBe("w1.0");
    expect(words[28]).toBe("w7.8");
  });
  it("throws when counts differ", () => {
    expect(() => loadFatihaDisplayWords(fakeCorpus([4, 4, 2, 3, 4, 3, 8]))).toThrow(/ayah 7/);
  });
  it("throws on a wrong shape", () => {
    expect(() => loadFatihaDisplayWords({})).toThrow();
    expect(() => loadFatihaDisplayWords(null)).toThrow();
  });
});

describe("tryToGlobalWordIndex / tryCursorToGlobal", () => {
  it("return the same value as the throwing versions when in range", () => {
    expect(tryToGlobalWordIndex(7, 8)).toBe(28);
    expect(tryCursorToGlobal(7, 9)).toBe(29);
    expect(tryCursorToGlobal(1, 4)).toBe(4);
  });
  it("return null instead of throwing", () => {
    expect(tryToGlobalWordIndex(3, 2)).toBeNull();
    expect(tryToGlobalWordIndex(8, 0)).toBeNull();
    expect(tryCursorToGlobal(3, 3)).toBeNull();
    expect(tryCursorToGlobal(0, 0)).toBeNull();
  });
});
