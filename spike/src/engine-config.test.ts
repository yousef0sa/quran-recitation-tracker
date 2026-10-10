import { describe, expect, it } from "vitest";
import { engineConfigSuffix, engineOverrideFrom, parseSettleFrames } from "./engine-config";

describe("parseSettleFrames", () => {
  it("accepts integers 1..200", () => {
    expect(parseSettleFrames("1")).toBe(1);
    expect(parseSettleFrames("12")).toBe(12);
    expect(parseSettleFrames("25")).toBe(25);
    expect(parseSettleFrames("200")).toBe(200);
  });

  it("returns null for anything else", () => {
    for (const bad of [null, undefined, "", "0", "201", "-5", "+5", "1.5", "12a", " 12", "12 ", "1e1"]) {
      expect(parseSettleFrames(bad)).toBeNull();
    }
  });
});

describe("engineOverrideFrom", () => {
  it("is empty without a value and keeps an explicit default value", () => {
    expect(engineOverrideFrom(null)).toEqual({});
    expect(engineOverrideFrom(25)).toEqual({ settleFrames: 25 });
  });
});

describe("engineConfigSuffix", () => {
  it("is empty without overrides and names settleFrames otherwise", () => {
    expect(engineConfigSuffix({})).toBe("");
    expect(engineConfigSuffix({ settleFrames: 12 })).toBe("_settle12");
    expect(engineConfigSuffix({ settleFrames: 25 })).toBe("_settle25");
  });
});
