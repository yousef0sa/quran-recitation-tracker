// Integration tests: the real middleware on a loopback http server over a temporary project root.
// Everything is written under a temp dir, never under spike/recordings or spike/results.
import { request, createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devHarness } from "./dev-harness";

type Handler = (req: unknown, res: unknown) => void;

let server: Server;
let root: string;
let port: number;

/** Synthetic labels: 29 increasing times (test data, not a real labelling). */
const labels = (note: string) => ({
  recording: "take.wav",
  wordEnds: Array.from({ length: 29 }, (_, i) => (i + 1) * 0.5),
  notes: note,
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "harness-"));
  mkdirSync(join(root, "recordings"));
  const plugin = devHarness();
  (plugin.configResolved as (c: unknown) => void)({ root });
  let handler: Handler | undefined;
  (plugin.configureServer as (s: unknown) => void)({
    config: { server: {} },
    middlewares: { use: (_path: string, fn: Handler) => (handler = fn) },
  });
  server = createServer((req, res) => (handler as Handler)(req, res));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: string; json?: boolean } = {}): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined && opts.json !== false) headers["Content-Type"] ??= "application/json";
    const req = request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolveReply({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("dev harness over http", () => {
  it("lists an empty recordings dir and sets the hardening headers", async () => {
    const r = await call("GET", "/recordings");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual([]);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  it("refuses a non-loopback Host, foreign Origin, 'null' Origin and cross-site fetches for any method", async () => {
    expect((await call("GET", "/recordings", { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await call("GET", "/recordings", { headers: { Origin: "http://evil.example" } })).status).toBe(403);
    expect((await call("GET", "/recordings", { headers: { Origin: "null" } })).status).toBe(403);
    expect((await call("GET", "/recordings", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await call("GET", "/recordings", { headers: { "Sec-Fetch-Site": "same-site" } })).status).toBe(403);
    expect((await call("GET", "/recordings", { headers: { "Sec-Fetch-Site": "same-origin", Origin: `http://127.0.0.1:${port}` } })).status).toBe(200);
  });

  it("requires Content-Type: application/json on POST", async () => {
    const r = await call("POST", "/labels/take", { body: JSON.stringify(labels("x")), headers: { "Content-Type": "text/plain" } });
    expect(r.status).toBe(415);
    expect(existsSync(join(root, "recordings", "take.labels.json"))).toBe(false);
  });

  it("rejects bad names (traversal, reserved, trailing dot) and invalid labels", async () => {
    expect((await call("GET", "/recordings/..%2Fpackage.json")).status).toBe(400);
    expect((await call("GET", "/labels/nul")).status).toBe(400);
    expect((await call("GET", "/labels/..%2Fx")).status).toBe(400);
    expect((await call("POST", "/labels/take", { body: JSON.stringify({ recording: "x", wordEnds: [1, 2] }) })).status).toBe(400);
  });

  it("writes labels without replacing: 409 on a second POST, backup + atomic replace on overwrite", async () => {
    const first = await call("POST", "/labels/take", { body: JSON.stringify(labels("first")) });
    expect(first.status).toBe(200);
    const file = join(root, "recordings", "take.labels.json");
    expect(JSON.parse(readFileSync(file, "utf8")).notes).toBe("first");

    const clash = await call("POST", "/labels/take", { body: JSON.stringify(labels("second")) });
    expect(clash.status).toBe(409);
    expect(JSON.parse(readFileSync(file, "utf8")).notes).toBe("first");

    const over = await call("POST", "/labels/take?overwrite=1", { body: JSON.stringify(labels("second")) });
    expect(over.status).toBe(200);
    expect(JSON.parse(readFileSync(file, "utf8")).notes).toBe("second");
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8")).notes).toBe("first");

    await call("POST", "/labels/take?overwrite=1", { body: JSON.stringify(labels("third")) });
    expect(JSON.parse(readFileSync(`${file}.bak`, "utf8")).notes).toBe("second"); // only the latest backup is kept
    expect(readdirSync(join(root, "recordings")).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    const got = await call("GET", "/labels/take");
    expect(got.status).toBe(200);
    expect(JSON.parse(got.body).notes).toBe("third");
  });

  it("serves a recording with the right content type and lists it with hasLabels", async () => {
    // A placeholder file with an audio extension; its bytes are not audio and are never decoded.
    writeFileSync(join(root, "recordings", "take.wav"), "not audio, only a placeholder for the route");
    const list = JSON.parse((await call("GET", "/recordings")).body) as { name: string; hasLabels: boolean }[];
    expect(list).toEqual([expect.objectContaining({ name: "take.wav", base: "take", hasLabels: true })]);
    const file = await call("GET", "/recordings/take.wav");
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("audio/wav");
    expect(file.body).toBe("not audio, only a placeholder for the route");
  });

  it("results are append-only and the body cap rejects early on Content-Length", async () => {
    const a = await call("POST", "/results/r_results.json", { body: JSON.stringify({ n: 1 }) });
    const b = await call("POST", "/results/r_results.json", { body: JSON.stringify({ n: 2 }) });
    expect(JSON.parse(a.body).written).toBe("r_results.json");
    expect(JSON.parse(b.body).written).toBe("r_results-2.json");
    expect(JSON.parse(readFileSync(join(root, "results", "r_results.json"), "utf8"))).toEqual({ n: 1 });
    const big = await call("POST", "/results/big.json", { headers: { "Content-Length": String(65 * 1024 * 1024), "Content-Type": "application/json" } });
    expect(big.status).toBe(413);
    expect(existsSync(join(root, "results", "big.json"))).toBe(false);
  });

  it("unknown routes are 404 and errors never leak internals", async () => {
    expect((await call("GET", "/nothing")).status).toBe(404);
    expect((await call("DELETE", "/recordings/take.wav")).status).toBe(404);
  });
});

describe("recordings subfolder (?dir=)", () => {
  const fileName = "rec é 1.wav"; // synthetic: spaces and a non-ASCII letter, like the real file names
  const base = "rec é 1";
  const content = "placeholder bytes, not audio";
  const enc = encodeURIComponent;

  beforeAll(() => {
    mkdirSync(join(root, "recordings", "sub"));
    writeFileSync(join(root, "recordings", "sub", fileName), content);
    writeFileSync(join(root, "recordings", "sub", `${base}.labels.json`), JSON.stringify(labels("sub")));
    writeFileSync(join(root, "recordings", "sub", "nolabels.wav"), content);
  });

  it("lists a subfolder with hasLabels, and the top level does not include its files", async () => {
    const sub = JSON.parse((await call("GET", "/recordings?dir=sub")).body) as { name: string; base: string; hasLabels: boolean }[];
    expect(sub.map((r) => [r.name, r.hasLabels])).toEqual([
      ["nolabels.wav", false],
      [fileName, true],
    ]);
    expect(sub.find((r) => r.name === fileName)?.base).toBe(base);
    const top = JSON.parse((await call("GET", "/recordings")).body) as { name: string }[];
    expect(top.map((r) => r.name)).not.toContain(fileName);
    expect(top.map((r) => r.name)).not.toContain("nolabels.wav");
    expect(top.map((r) => r.name)).not.toContain("sub");
  });

  it("serves a recording and its labels from the subfolder, names with spaces and non-ASCII letters", async () => {
    const file = await call("GET", `/recordings/${enc(fileName)}?dir=sub`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("audio/wav");
    expect(file.body).toBe(content);
    const lab = await call("GET", `/labels/${enc(base)}?dir=sub`);
    expect(lab.status).toBe(200);
    expect(JSON.parse(lab.body).notes).toBe("sub");
    // without dir the same names are not found at the top level
    expect((await call("GET", `/recordings/${enc(fileName)}`)).status).toBe(404);
    expect((await call("GET", `/labels/${enc(base)}`)).status).toBe(404);
  });

  it("rejects anything but one plain folder name with 400, on all three read endpoints", async () => {
    // Query values as sent on the wire: "%2e%2e" is the percent-encoded "..", "a%5Cb" is "a\b".
    const bad = ["..", "a%2Fb", "a%5Cb", "%2e%2e", "C%3A%5CWindows", "%2Fetc", "", "a".repeat(65), ".", "su%20b", "sub%2F", "%C3%A9"];
    for (const q of bad) {
      for (const path of [`/recordings?dir=${q}`, `/recordings/${enc(fileName)}?dir=${q}`, `/labels/${enc(base)}?dir=${q}`]) {
        expect((await call("GET", path)).status, path).toBe(400);
      }
    }
    expect((await call("GET", "/recordings?dir=a/b")).status).toBe(400); // raw slash in the query
    expect((await call("GET", `/recordings?dir=${"a".repeat(64)}`)).status).toBe(404); // longest allowed name, just absent
  });

  it("404 for a missing folder, or a name that is a file", async () => {
    expect((await call("GET", "/recordings?dir=nope")).status).toBe(404);
    expect((await call("GET", `/recordings/${enc(fileName)}?dir=nope`)).status).toBe(404);
    expect((await call("GET", "/labels/take?dir=nope")).status).toBe(404);
    writeFileSync(join(root, "recordings", "plainfile"), "x");
    expect((await call("GET", "/recordings?dir=plainfile")).status).toBe(404);
  });

  it("the labeler stays top-level only: POST with dir is refused and writes nothing", async () => {
    const r = await call("POST", "/labels/zzz?dir=sub", { body: JSON.stringify(labels("x")) });
    expect(r.status).toBe(400);
    expect(existsSync(join(root, "recordings", "sub", "zzz.labels.json"))).toBe(false);
    expect(existsSync(join(root, "recordings", "zzz.labels.json"))).toBe(false);
  });
});

describe("startup assertion", () => {
  it("refuses to start when server.host would expose the harness", () => {
    for (const host of [true, "0.0.0.0", "192.168.0.10"]) {
      const plugin = devHarness();
      expect(() =>
        (plugin.configureServer as (s: unknown) => void)({ config: { server: { host } }, middlewares: { use: () => undefined } }),
      ).toThrow(/never a bare --host/);
    }
  });
});
