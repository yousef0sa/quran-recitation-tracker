import { describe, expect, it } from "vitest";
import {
  DEFAULT_THREADS,
  PHONE_THREADS,
  THREAD_OPTIONS,
  backendLabel,
  defaultThreads,
  parseThreads,
  requestThreads,
  threadsFileSuffix,
  threadsStatusPart,
} from "./wasm-threads";

describe("parseThreads", () => {
  it("accepts the listed options", () => {
    expect(THREAD_OPTIONS.map((n) => parseThreads(String(n)))).toEqual([1, 2, 4]);
  });

  it("falls back to the default for anything else", () => {
    for (const value of [null, undefined, "", "3", "8", "0", "-2", "2.0", " 2", "two"]) {
      expect(parseThreads(value)).toBe(DEFAULT_THREADS);
    }
    expect(DEFAULT_THREADS).toBe(1);
  });
});

describe("defaultThreads", () => {
  const android = "Mozilla/5.0 (Linux; Android 9; Redmi Note 8) AppleWebKit/537.36 Chrome/138.0.0.0 Mobile Safari/537.36";

  const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36";

  it("uses PHONE_THREADS on phones and DEFAULT_THREADS elsewhere", () => {
    expect(PHONE_THREADS).toBe(4);
    expect(defaultThreads(android)).toBe(4);
    expect(defaultThreads("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148")).toBe(4);
    expect(defaultThreads(desktop)).toBe(1);
    expect(defaultThreads("")).toBe(1);
  });

  it("requestThreads honours ?threads= and the device default on the dev server", () => {
    expect(requestThreads(null, android, true)).toBe(4);
    expect(requestThreads("2", desktop, true)).toBe(2);
    expect(requestThreads("3", desktop, true)).toBe(1);
  });

  it("requestThreads stays on 1 in a production build, even with ?threads=, where more threads hang at load", () => {
    expect(requestThreads(null, android, false)).toBe(1);
    expect(requestThreads("4", android, false)).toBe(1);
    expect(requestThreads("2", desktop, false)).toBe(1);
  });

  it("is the fallback of parseThreads", () => {
    expect(parseThreads(null, PHONE_THREADS)).toBe(4);
    expect(parseThreads("3", PHONE_THREADS)).toBe(4);
    expect(parseThreads("1", PHONE_THREADS)).toBe(1);
  });
});

describe("backendLabel", () => {
  it("keeps the single-thread text exactly", () => {
    expect(backendLabel(1)).toBe("WASM single-thread");
    expect(backendLabel(2)).toBe("WASM 2 threads");
    expect(backendLabel(4)).toBe("WASM 4 threads");
  });
});

describe("threadsFileSuffix", () => {
  it("is empty for 1 thread and before ready", () => {
    expect(threadsFileSuffix(1, 1)).toBe("");
    expect(threadsFileSuffix(4, null)).toBe("");
  });

  it("carries the effective count, and the request when it differs", () => {
    expect(threadsFileSuffix(4, 4)).toBe("_t4");
    expect(threadsFileSuffix(4, 1)).toBe("_req4");
    expect(threadsFileSuffix(4, 2)).toBe("_t2_req4");
  });
});

describe("threadsStatusPart", () => {
  it("is empty for 1 thread and before ready", () => {
    expect(threadsStatusPart(1)).toBe("");
    expect(threadsStatusPart(null)).toBe("");
  });

  it("names the effective backend otherwise", () => {
    expect(threadsStatusPart(4)).toBe("، WASM 4 threads");
  });
});
