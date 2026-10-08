import { describe, expect, it } from "vitest";
import { parseLabels } from "./labels";

const ends = (n = 29) => Array.from({ length: n }, (_, i) => (i + 1) * 0.5);

describe("parseLabels", () => {
  it("accepts a valid file", () => {
    const labels = parseLabels({ recording: "a.wav", wordEnds: ends(), notes: "slow" });
    expect(labels.wordEnds).toHaveLength(29);
    expect(labels.notes).toBe("slow");
    expect(labels.wordStarts).toBeUndefined();
  });
  it("accepts wordStarts before their ends", () => {
    const wordStarts = ends().map((e) => e - 0.3);
    expect(parseLabels({ recording: "a.wav", wordEnds: ends(), wordStarts }).wordStarts).toEqual(wordStarts);
  });
  it("rejects 28 ends with an Arabic and English message", () => {
    expect(() => parseLabels({ recording: "a.wav", wordEnds: ends(28) })).toThrow(/wordEnds must have exactly 29/);
    expect(() => parseLabels({ recording: "a.wav", wordEnds: ends(28) })).toThrow(/[؀-ۿ]/);
  });
  it("rejects decreasing or equal ends", () => {
    const equal = ends();
    equal[10] = equal[9] as number;
    expect(() => parseLabels({ recording: "a.wav", wordEnds: equal })).toThrow(/strictly increasing/);
    const decreasing = ends();
    decreasing[5] = 0.1;
    expect(() => parseLabels({ recording: "a.wav", wordEnds: decreasing })).toThrow(/strictly increasing/);
  });
  it("rejects NaN and non-numbers", () => {
    const nan = ends();
    nan[3] = Number.NaN;
    expect(() => parseLabels({ recording: "a.wav", wordEnds: nan })).toThrow(/wordEnds\[3\]/);
    const str = ends() as unknown[];
    str[3] = "1.5";
    expect(() => parseLabels({ recording: "a.wav", wordEnds: str })).toThrow(/wordEnds\[3\]/);
  });
  it("rejects a start at or after its end, or wrong length", () => {
    expect(() => parseLabels({ recording: "a.wav", wordEnds: ends(), wordStarts: ends() })).toThrow(
      /wordStarts\[0\]/,
    );
    expect(() => parseLabels({ recording: "a.wav", wordEnds: ends(), wordStarts: ends(3) })).toThrow(/wordStarts/);
  });
  it("rejects a bad shape or missing recording", () => {
    expect(() => parseLabels(null)).toThrow();
    expect(() => parseLabels([])).toThrow();
    expect(() => parseLabels({ wordEnds: ends() })).toThrow(/recording/);
    expect(() => parseLabels({ recording: "a.wav", wordEnds: ends(), notes: 5 })).toThrow(/notes/);
  });
});
