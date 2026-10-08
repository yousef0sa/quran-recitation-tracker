import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  audioContentType,
  baseOf,
  checkRequest,
  extensionOf,
  hostnameOf,
  isAllowedFetchSite,
  isAudioFile,
  isJsonContentType,
  isLoopbackBindHost,
  isLoopbackHostHeader,
  isSameOrigin,
  isSafeName,
  resolveInside,
  suffixedName,
} from "./dev-harness";

describe("isSafeName", () => {
  it("accepts plain basenames", () => {
    for (const ok of ["a.wav", "take 1.mp3", "rec-01_v2.m4a", "قراءة.wav", "x.labels.json"]) {
      expect(isSafeName(ok), ok).toBe(true);
    }
  });
  it("rejects traversal, separators, NUL, colons, leading dots and empties", () => {
    const bad = ["", ".", "..", "../a.wav", "..\a.wav", "a/b.wav", "a\b.wav", "a..b", ".hidden", ".env", "a\u0000.wav", "C:evil.wav", "a:stream", "a\nb"];
    for (const name of bad) expect(isSafeName(name), JSON.stringify(name)).toBe(false);
    expect(isSafeName(undefined)).toBe(false);
    expect(isSafeName(5)).toBe(false);
    expect(isSafeName("a".repeat(201))).toBe(false);
  });
});

describe("resolveInside", () => {
  const dir = resolve("/tmp/spike/recordings");
  it("returns a path inside the directory for a safe name", () => {
    expect(resolveInside(dir, "a.wav")).toBe(resolve(dir, "a.wav"));
  });
  it("returns null for anything unsafe", () => {
    expect(resolveInside(dir, "../package.json")).toBeNull();
    expect(resolveInside(dir, "..%2Fpackage.json")).toBeNull();
    expect(resolveInside(dir, "sub/a.wav")).toBeNull();
    expect(resolveInside(dir, "")).toBeNull();
    expect(resolveInside(dir, null)).toBeNull();
  });
});

describe("file helpers", () => {
  it("recognises audio extensions case-insensitively", () => {
    for (const name of ["a.wav", "a.MP3", "a.M4A", "a.ogg", "a.opus", "a.webm", "a.flac", "a.AAC"]) {
      expect(isAudioFile(name), name).toBe(true);
    }
    for (const name of ["a.txt", "a.labels.json", "wav", ".wav", "a"]) expect(isAudioFile(name), name).toBe(false);
  });
  it("maps content types", () => {
    expect(audioContentType("a.WAV")).toBe("audio/wav");
    expect(audioContentType("a.mp3")).toBe("audio/mpeg");
    expect(audioContentType("a.m4a")).toBe("audio/mp4");
    expect(audioContentType("a.bin")).toBe("application/octet-stream");
  });
  it("splits base and extension", () => {
    expect(baseOf("take.1.wav")).toBe("take.1");
    expect(extensionOf("take.1.WAV")).toBe("wav");
    expect(baseOf("noext")).toBe("noext");
  });
  it("adds numeric suffixes before the extension", () => {
    expect(suffixedName("r.json", 1)).toBe("r.json");
    expect(suffixedName("r.json", 2)).toBe("r-2.json");
    expect(suffixedName("a_b_results.json", 10)).toBe("a_b_results-10.json");
  });
});

describe("isSameOrigin", () => {
  it("allows no Origin or a matching one, refuses others", () => {
    expect(isSameOrigin(undefined, "localhost:5173")).toBe(true);
    expect(isSameOrigin("http://localhost:5173", "localhost:5173")).toBe(true);
    expect(isSameOrigin("http://evil.example", "localhost:5173")).toBe(false);
    expect(isSameOrigin("http://localhost:9999", "localhost:5173")).toBe(false);
    expect(isSameOrigin("null", "localhost:5173")).toBe(false);
    expect(isSameOrigin("http://localhost:5173", undefined)).toBe(false);
  });
});

describe("isSafeName: Windows hazards", () => {
  it("rejects reserved device names and trailing dot or space", () => {
    for (const bad of ["con", "NUL", "aux.txt", "com1", "LPT9.wav", "prn.labels.json", "name.", "name ", "a.wav "]) {
      expect(isSafeName(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const ok of ["console.wav", "com10.wav", "lpt0.wav", "null.wav", "auxiliary.wav"]) {
      expect(isSafeName(ok), ok).toBe(true);
    }
  });
});

describe("host / origin / fetch-site / content-type guards", () => {
  it("hostnameOf and isLoopbackHostHeader", () => {
    expect(hostnameOf("localhost:5173")).toBe("localhost");
    expect(hostnameOf("[::1]:5173")).toBe("[::1]");
    expect(hostnameOf("LOCALHOST")).toBe("localhost");
    expect(hostnameOf(undefined)).toBeNull();
    for (const ok of ["localhost:5173", "127.0.0.1:5173", "[::1]:5173", "localhost"]) expect(isLoopbackHostHeader(ok), ok).toBe(true);
    for (const bad of ["evil.example", "192.168.1.5:5173", "localhost.evil.example", "127.0.0.1.nip.io:5173", "0.0.0.0:5173", "", undefined]) {
      expect(isLoopbackHostHeader(bad), String(bad)).toBe(false);
    }
  });
  it("isSameOrigin needs exactly http://<Host>", () => {
    expect(isSameOrigin("https://localhost:5173", "localhost:5173")).toBe(false);
    expect(isSameOrigin("http://localhost:5173/", "localhost:5173")).toBe(false);
    expect(isSameOrigin("null", "null")).toBe(false);
  });
  it("isAllowedFetchSite", () => {
    for (const ok of [undefined, "same-origin", "none"]) expect(isAllowedFetchSite(ok), String(ok)).toBe(true);
    for (const bad of ["cross-site", "same-site"]) expect(isAllowedFetchSite(bad), bad).toBe(false);
  });
  it("isJsonContentType", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("Application/JSON; charset=utf-8")).toBe(true);
    for (const bad of ["text/plain", "application/jsonp", "application/x-www-form-urlencoded", "", undefined]) {
      expect(isJsonContentType(bad), String(bad)).toBe(false);
    }
  });
  it("checkRequest combines them; GET needs no content type", () => {
    const ok = { host: "localhost:5173", origin: "http://localhost:5173", secFetchSite: "same-origin", contentType: "application/json" };
    expect(checkRequest("POST", ok)).toBeNull();
    expect(checkRequest("GET", { host: "localhost:5173" })).toBeNull();
    expect(checkRequest("POST", { ...ok, contentType: undefined })?.status).toBe(415);
    expect(checkRequest("GET", { ...ok, host: "evil.example" })?.status).toBe(403);
    expect(checkRequest("GET", { ...ok, origin: "null" })?.status).toBe(403);
    expect(checkRequest("DELETE", { ...ok, secFetchSite: "cross-site" })?.status).toBe(403);
  });
});

describe("isLoopbackBindHost", () => {
  it("accepts unset and loopback, refuses anything that exposes the server", () => {
    for (const ok of [undefined, false, "localhost", "127.0.0.1", "::1", "[::1]", "LocalHost"]) expect(isLoopbackBindHost(ok), String(ok)).toBe(true);
    for (const bad of [true, "0.0.0.0", "::", "192.168.1.5", "my-pc.local", ""]) expect(isLoopbackBindHost(bad), String(bad)).toBe(false);
  });
});
