/// <reference types="node" />
// Dev-only helper endpoints under /__dev/, mounted by the Vite plugin below with `apply: "serve"`:
// the production build never contains this module or any "/__dev/" path.
//   GET  /__dev/recordings                list audio files in spike/recordings/
//   GET  /__dev/recordings/<name>         serve one of them
//   GET  /__dev/labels/<base>             spike/recordings/<base>.labels.json or 404
//   The three GETs above accept ?dir=<name> to read ONE subfolder of spike/recordings/ instead (name per
//   RECORDINGS_DIR_PATTERN, else 400; missing folder 404). POST /__dev/labels stays top-level only.
//   POST /__dev/labels/<base>             validate (parseLabels) and write it; 409 unless ?overwrite=1
//                                         (an overwrite first keeps the previous file as <base>.labels.json.bak)
//   POST /__dev/results/<file>.json       write spike/results/<file>.json, append-only (numeric suffix on clash)
// It never edits or deletes an existing recording, and never overwrites a result file.
// Every request, any method, must come from the loopback host with a same-origin browser context.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import type { Plugin } from "vite";
import { isValidRecordingsDir } from "../src/dev/recordings-dir";
import { parseLabels } from "../src/labels";

const AUDIO_TYPES: Readonly<Record<string, string>> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
  flac: "audio/flac",
  aac: "audio/aac",
};
const LABELS_SUFFIX = ".labels.json";
const MAX_LABELS_BYTES = 1024 * 1024;
const MAX_RESULTS_BYTES = 64 * 1024 * 1024;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export interface RecordingInfo {
  name: string;
  base: string;
  size: number;
  hasLabels: boolean;
}

/**
 * A plain basename only: no separators, "..", NUL, drive/stream colons, leading dot, control chars,
 * Windows reserved device names, or a trailing dot / space (Windows would silently strip those).
 */
export function isSafeName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 200) return false;
  if (name.startsWith(".") || name.includes("..")) return false;
  if (name.endsWith(".") || name.endsWith(" ")) return false;
  if (WINDOWS_RESERVED.test(name)) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\\/:\u0000-\u001f]/.test(name);
}

/** Absolute path of `name` inside `dir`, or null when the name is unsafe or escapes `dir`. */
export function resolveInside(dir: string, name: unknown): string | null {
  if (!isSafeName(name)) return null;
  const root = resolve(dir);
  const full = resolve(root, name);
  return full.startsWith(root + sep) ? full : null;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isAudioFile(name: string): boolean {
  return extensionOf(name) in AUDIO_TYPES;
}

export function audioContentType(name: string): string {
  return AUDIO_TYPES[extensionOf(name)] ?? "application/octet-stream";
}

/** "a.wav" -> "a" (the label file for it is "a.labels.json"). */
export function baseOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** "x.json" -> "x-2.json", "x-3.json" ... for the n-th attempt (n >= 2). */
export function suffixedName(name: string, attempt: number): string {
  if (attempt <= 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${attempt}${name.slice(dot)}` : `${name}-${attempt}`;
}

/** Hostname part of a Host header ("localhost:5173" -> "localhost", "[::1]:5173" -> "[::1]"), lower-cased. */
export function hostnameOf(host: string | undefined): string | null {
  if (!host) return null;
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host);
  return match ? (match[1] as string).toLowerCase() : null;
}

/** True for localhost, 127.0.0.1 and [::1] Host headers (blocks DNS-rebinding names and LAN addresses). */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  const name = hostnameOf(host);
  return name !== null && LOOPBACK_HOSTNAMES.has(name);
}

/** No Origin header, or exactly `http://<Host>`. The literal "null" origin is never accepted. */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!host || origin === "null") return false;
  return origin === `http://${host}`;
}

/** Sec-Fetch-Site values other than cross-site / same-site (absent = non-browser client, allowed). */
export function isAllowedFetchSite(value: string | undefined): boolean {
  return value !== "cross-site" && value !== "same-site";
}

export function isJsonContentType(value: string | undefined): boolean {
  return value !== undefined && /^application\/json\s*(;|$)/i.test(value.trim());
}

export interface RequestHeaders {
  host?: string;
  origin?: string;
  secFetchSite?: string;
  contentType?: string;
}

/** Guard for every /__dev request. Returns the rejection or null when the request may proceed. */
export function checkRequest(method: string, headers: RequestHeaders): { status: number; message: string } | null {
  if (!isLoopbackHostHeader(headers.host)) return { status: 403, message: "host not allowed" };
  if (!isSameOrigin(headers.origin, headers.host)) return { status: 403, message: "cross-origin request refused" };
  if (!isAllowedFetchSite(headers.secFetchSite)) return { status: 403, message: "cross-site request refused" };
  if (method === "POST" && !isJsonContentType(headers.contentType)) {
    return { status: 415, message: "POST needs Content-Type: application/json" };
  }
  return null;
}

/** Vite `server.host` values the harness may run under: unset or loopback only (never exposed on a LAN). */
export function isLoopbackBindHost(host: string | boolean | undefined): boolean {
  if (host === undefined || host === false) return true;
  if (typeof host !== "string") return false;
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase());
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) return Promise.reject(new HttpError(413, "body too large"));
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "bad percent-encoding");
  }
}

function safePath(dir: string, name: string): string {
  const full = resolveInside(dir, name);
  if (!full) throw new HttpError(400, "invalid name");
  return full;
}

/**
 * The folder a read request works in: spike/recordings itself, or the one subfolder named by `?dir=`
 * (a single [A-Za-z0-9_-] segment, resolved with safePath so it cannot leave the recordings dir).
 */
async function readDir(recordingsDir: string, url: URL): Promise<string> {
  const dir = url.searchParams.get("dir");
  if (dir === null) return recordingsDir;
  if (!isValidRecordingsDir(dir)) throw new HttpError(400, "invalid dir");
  const full = safePath(recordingsDir, dir);
  const info = await stat(full).catch(() => null);
  if (!info?.isDirectory()) throw new HttpError(404, "no such folder");
  return full;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listRecordings(dir: string): Promise<RecordingInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: RecordingInfo[] = [];
  for (const name of names.sort()) {
    if (!isSafeName(name) || !isAudioFile(name)) continue;
    const info = await stat(resolve(dir, name));
    if (!info.isFile()) continue;
    const base = baseOf(name);
    out.push({ name, base, size: info.size, hasLabels: await exists(resolve(dir, `${base}${LABELS_SUFFIX}`)) });
  }
  return out;
}

async function handle(req: IncomingMessage, res: ServerResponse, recordingsDir: string, resultsDir: string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter((p) => p.length > 0);
  const [resource, rawName, ...rest] = parts;
  const method = req.method ?? "GET";
  if (rest.length > 0) throw new HttpError(404, "not found");

  if (resource === "recordings" && method === "GET") {
    const dir = await readDir(recordingsDir, url);
    if (rawName === undefined) return send(res, 200, await listRecordings(dir));
    const name = decodeSegment(rawName);
    const full = safePath(dir, name);
    if (!isAudioFile(name)) throw new HttpError(400, "not an audio file");
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, "no such recording");
    res.statusCode = 200;
    res.setHeader("Content-Type", audioContentType(name));
    res.setHeader("Content-Length", String(info.size));
    res.setHeader("Cache-Control", "no-store");
    // pipeline destroys both ends on error (EBUSY etc.), so no crash and no leaked file descriptor.
    pipeline(createReadStream(full), res, (err) => {
      if (err) res.destroy();
    });
    return;
  }

  if (resource === "labels" && rawName !== undefined) {
    const base = decodeSegment(rawName);
    if (method === "POST" && url.searchParams.has("dir")) throw new HttpError(400, "labels can only be written at the top level");
    const full = safePath(method === "GET" ? await readDir(recordingsDir, url) : recordingsDir, `${base}${LABELS_SUFFIX}`);
    if (method === "GET") {
      const text = await readFile(full, "utf8").catch(() => null);
      if (text === null) throw new HttpError(404, "no labels");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(text);
      return;
    }
    if (method === "POST") {
      const body = await readBody(req, MAX_LABELS_BYTES);
      let labels;
      try {
        labels = parseLabels(JSON.parse(body));
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      const overwrite = url.searchParams.get("overwrite") === "1";
      const data = JSON.stringify(labels, null, 2) + "\n";
      if (!overwrite) {
        try {
          await writeFile(full, data, { encoding: "utf8", flag: "wx" }); // never replaces an existing file
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            throw new HttpError(409, `${base}${LABELS_SUFFIX} already exists (use ?overwrite=1)`);
          }
          throw err;
        }
      } else {
        // Keep the latest previous version, then replace atomically (temp file + rename).
        if (await exists(full)) await copyFile(full, `${full}.bak`);
        const tmp = `${full}.${process.pid}.tmp`;
        await writeFile(tmp, data, "utf8");
        await rename(tmp, full);
      }
      return send(res, 200, { written: `${base}${LABELS_SUFFIX}` });
    }
  }

  if (resource === "results" && rawName !== undefined && method === "POST") {
    const name = decodeSegment(rawName);
    if (!name.toLowerCase().endsWith(".json")) throw new HttpError(400, "result name must end with .json");
    safePath(resultsDir, name);
    const body = await readBody(req, MAX_RESULTS_BYTES);
    try {
      JSON.parse(body);
    } catch {
      throw new HttpError(400, "body is not valid JSON");
    }
    await mkdir(resultsDir, { recursive: true });
    for (let attempt = 1; attempt < 10000; attempt++) {
      const candidate = suffixedName(name, attempt);
      try {
        // 'wx' fails when the file exists: results are append-only.
        await writeFile(safePath(resultsDir, candidate), body, { encoding: "utf8", flag: "wx" });
        return send(res, 200, { written: candidate });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new HttpError(500, "could not find a free result name");
  }

  throw new HttpError(404, "not found");
}

function applyBaseHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

export function devHarness(): Plugin {
  let recordingsDir = "";
  let resultsDir = "";
  return {
    name: "spike-dev-harness",
    apply: "serve",
    configResolved(config) {
      recordingsDir = resolve(config.root, "recordings");
      resultsDir = resolve(config.root, "results");
    },
    configureServer(server) {
      const host = server.config.server.host;
      if (!isLoopbackBindHost(host)) {
        throw new Error(
          `dev harness refused: server.host is ${JSON.stringify(host)}. The /__dev endpoints serve your recordings and write files; ` +
            "never run the dev server with --host or a non-loopback server.host.",
        );
      }
      server.middlewares.use("/__dev", (req, res) => {
        applyBaseHeaders(res);
        const rejected = checkRequest(req.method ?? "GET", {
          host: req.headers.host,
          origin: req.headers.origin,
          secFetchSite: req.headers["sec-fetch-site"] as string | undefined,
          contentType: req.headers["content-type"],
        });
        if (rejected) return send(res, rejected.status, rejected.message);
        handle(req, res, recordingsDir, resultsDir).catch((err: unknown) => {
          const known = err instanceof HttpError;
          if (!known) console.error("[dev-harness]", err);
          if (res.headersSent) return void res.end();
          if (known && err.status === 413) res.setHeader("Connection", "close"); // the unread body must not be reused as a keep-alive stream
          send(res, known ? err.status : 500, known && err.status < 500 ? err.message : "internal error");
        });
      });
    },
  };
}
