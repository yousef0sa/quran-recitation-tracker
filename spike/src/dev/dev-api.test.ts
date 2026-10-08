import { describe, expect, it } from "vitest";
import { resultFileName } from "./dev-api";

describe("resultFileName", () => {
  it("formats local time, variant and chunk size", () => {
    const date = new Date(2026, 9, 8, 7, 5, 9);
    expect(resultFileName(date, "A1", 150, "results")).toBe("20261008-070509_A1_150ms_results.json");
    expect(resultFileName(date, "B1", 80, "eventlogs")).toBe("20261008-070509_B1_80ms_eventlogs.json");
  });
});
