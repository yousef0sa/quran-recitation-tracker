// Downloads the NPL-1.2 model/corpus files (and their licences) into gitignored
// folders under spike/public/, verifying size and SHA-256 against assets.json.
// A missing sha256/size is pinned into assets.json on first fetch (review the diff).
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "scripts", "assets.json");
const ALLOWED_PREFIXES = ["public/models/", "public/data/"];

function fail(message) {
  console.error(`[fetch-assets] ERROR: ${message}`);
  process.exit(1);
}

async function hashFile(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

const MAX_REDIRECTS = 5;

function requireHttps(url, what) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`${what}: invalid URL ${url}`);
  }
  if (parsed.protocol !== "https:") fail(`${what}: only https URLs are allowed (got ${parsed.protocol}//${parsed.host})`);
  return parsed.href;
}

// Redirects are followed by hand so that every hop can be checked to stay on https.
async function fetchHttps(url) {
  let current = requireHttps(url, "asset URL");
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) fail(`redirect without Location from ${current}`);
      await res.body?.cancel();
      current = requireHttps(new URL(location, current).href, "redirect target");
      continue;
    }
    return res;
  }
  fail(`too many redirects for ${url}`);
}

// `maxBytes` (the pinned size, when known) aborts the download as soon as it is exceeded.
async function download(url, tmpPath, maxBytes) {
  const res = await fetchHttps(url);
  if (!res.ok || !res.body) fail(`download failed (${res.status}) for ${url}`);
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (maxBytes !== undefined && size > maxBytes) {
        cb(new Error(`download exceeds the pinned size of ${maxBytes} bytes`));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(tmpPath));
  } catch (err) {
    await rm(tmpPath, { force: true });
    fail(`${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { size, sha256: hash.digest("hex") };
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
let pinned = false;
let downloaded = 0;

for (const asset of manifest.assets) {
  if (!ALLOWED_PREFIXES.some((p) => asset.dest.startsWith(p))) {
    fail(`${asset.id}: dest ${asset.dest} is outside the gitignored asset folders`);
  }
  requireHttps(asset.url, asset.id);
  const dest = resolve(root, asset.dest);
  if (relative(root, dest).split(sep).join("/") !== asset.dest) fail(`${asset.id}: bad dest path`);
  await mkdir(dirname(dest), { recursive: true });

  let actual = null;
  if (existsSync(dest)) {
    const size = (await stat(dest)).size;
    const sha256 = await hashFile(dest);
    const sizeOk = asset.size === undefined || asset.size === size;
    const hashOk = asset.sha256 === undefined || asset.sha256 === sha256;
    if (sizeOk && hashOk) actual = { size, sha256 };
    else console.log(`[fetch-assets] ${asset.id}: existing file does not match, re-downloading`);
  }

  if (actual) {
    console.log(`[fetch-assets] ${asset.id}: present, verified`);
  } else {
    const tmp = `${dest}.part`;
    console.log(`[fetch-assets] ${asset.id}: downloading ${asset.url}`);
    actual = await download(asset.url, tmp, asset.size);
    if (asset.size !== undefined && asset.size !== actual.size) {
      await rm(tmp, { force: true });
      fail(`${asset.id}: size mismatch, expected ${asset.size} got ${actual.size}`);
    }
    if (asset.sha256 !== undefined && asset.sha256 !== actual.sha256) {
      await rm(tmp, { force: true });
      fail(`${asset.id}: SHA-256 mismatch, expected ${asset.sha256} got ${actual.sha256}`);
    }
    await rename(tmp, dest);
    downloaded++;
  }

  if (asset.size === undefined) {
    asset.size = actual.size;
    pinned = true;
    console.log(`[fetch-assets] ${asset.id}: pinned size on first fetch = ${actual.size}`);
  }
  if (asset.sha256 === undefined) {
    asset.sha256 = actual.sha256;
    pinned = true;
    console.log(`[fetch-assets] ${asset.id}: pinned sha256 on first fetch = ${actual.sha256}`);
  }
}

if (pinned) {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log("[fetch-assets] assets.json updated with pinned values (review the diff)");
}
console.log(`[fetch-assets] done, ${downloaded} file(s) downloaded`);
