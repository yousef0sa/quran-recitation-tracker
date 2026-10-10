import { describe, expect, it } from "vitest";
import { resultFileName } from "./dev-api";

describe("resultFileName", () => {
  it("formats local time, variant and chunk size", () => {
    const date = new Date(2026, 9, 8, 7, 5, 9);
    expect(resultFileName(date, "A1", 150, "results")).toBe("20261008-070509_A1_150ms_results.json");
    expect(resultFileName(date, "B1", 80, "eventlogs")).toBe("20261008-070509_B1_80ms_eventlogs.json");
  });

  it("puts an optional engine suffix after the chunk size", () => {
    const date = new Date(2026, 9, 8, 7, 5, 9);
    expect(resultFileName(date, "B2", 80, "results", "_settle12")).toBe("20261008-070509_B2_80ms_settle12_results.json");
    expect(resultFileName(date, "B2", 80, "results", "")).toBe("20261008-070509_B2_80ms_results.json");
  });

  it("puts the thread suffix after the engine suffix", () => {
    const date = new Date(2026, 9, 8, 7, 5, 9);
    expect(resultFileName(date, "B2", 80, "results", "_settle12_t4")).toBe("20261008-070509_B2_80ms_settle12_t4_results.json");
    expect(resultFileName(date, "B2", 80, "eventlogs", "_t2_req4")).toBe("20261008-070509_B2_80ms_t2_req4_eventlogs.json");
  });

  it("adds the recordings folder after the engine suffix, and keeps the old names without one", () => {
    const date = new Date(2026, 9, 8, 7, 5, 9);
    expect(resultFileName(date, "B2", 80, "results", "", "trust")).toBe("20261008-070509_B2_80ms_trust_results.json");
    expect(resultFileName(date, "B2", 80, "eventlogs", "_settle12", "trust")).toBe("20261008-070509_B2_80ms_settle12_trust_eventlogs.json");
    expect(resultFileName(date, "B2", 80, "results", "", null)).toBe("20261008-070509_B2_80ms_results.json");
  });
});
