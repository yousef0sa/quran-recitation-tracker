// Fail-closed check for text the bug finder is about to make public (artifacts, issues, summaries),
// run on the text as it would render (character references decoded, NFKC):
//  1. Quranic text: quran-guard in strict (UI) mode, with the corpus verified and actually loaded.
//  2. Any Arabic-script character at all.
//  3. Secrets: known token prefixes, plus the exact values passed as GUARD_SECRET_* env vars
//     (verbatim only: an encoded token, e.g. base64, is not recognised).
// Prints file + rule only, never the matched text.
//
// CLI: node .github/bug-finder/guard.mjs <file-or-dir>...   (exit 0 = all clean, 1 = blocked/error)

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Below this many indexed words the corpus is not the real one: refuse to vouch for anything. */
export const MIN_CORPUS_WORDS = 70000;
/** A UI path, so quran-guard applies its strict rule. */
const PROBE_PATH = "spike/src/bug-finder-draft.txt";
const SECRET_RE = /sk-ant-|gh[opsur]_[A-Za-z0-9]|github_pat_|-----BEGIN [A-Z ]*PRIVATE KEY/;
// Posted text never needs Arabic: drafts point at it by file:line. Blocking every Arabic-script
// character also closes quran-guard's documented gap (single words, undiacritised 2-word runs).
// Checked on the text as GitHub would render it: character references decoded, then NFKC (which
// folds presentation forms and the Arabic Mathematical letters back to ordinary letters).
const ARABIC_RE = /\p{Script_Extensions=Arabic}/u;

/**
 * What a reader could see: numeric character references decoded (repeatedly, with or without the
 * `&`, since Mermaid decodes `#1234;`), `\uXXXX` escapes decoded (geojson and similar), then NFKC.
 * sanitize() already stops these from rendering; this is the second line of defence.
 */
export function asRendered(text) {
  let t = text;
  for (let i = 0; i < 3; i++) {
    const next = t
      // With `&` the `;` is optional (HTML); without it (Mermaid) it is required, so "PR #1600" is text.
      .replace(/&#x([0-9a-f]{1,6});?|#x([0-9a-f]{1,6});/gi, (m, a, b) => safeChar(parseInt(a ?? b, 16), m))
      .replace(/&#(\d{1,7});?|#(\d{1,7});/g, (m, a, b) => safeChar(parseInt(a ?? b, 10), m))
      .replace(/\\u\{?([0-9a-f]{4,6})\}?/gi, (m, h) => safeChar(parseInt(h, 16), m));
    if (next === t) break;
    t = next;
  }
  return t.normalize("NFKC");
}

function safeChar(cp, fallback) {
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : fallback;
}
const TEXT_FILE_RE = /\.(md|json|txt|log)$/;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every configured source must match its SHA-256 in spike/scripts/assets.json. */
function verifySources(sources, root) {
  const manifest = JSON.parse(readFileSync(join(root, "spike", "scripts", "assets.json"), "utf8"));
  for (const src of sources) {
    const asset = manifest.assets.find((a) => `spike/${a.dest}` === src.display);
    if (!asset?.sha256) throw new Error(`no SHA-256 in assets.json for ${src.display}`);
    if (!existsSync(src.abs)) throw new Error(`corpus missing: ${src.display} (run npm run fetch-assets)`);
    if (sha256(src.abs) !== asset.sha256) throw new Error(`corpus SHA-256 mismatch: ${src.display}`);
  }
}

export function secretValues(env = process.env) {
  return Object.entries(env)
    .filter(([k, v]) => k.startsWith("GUARD_SECRET_") && typeof v === "string" && v.length >= 8)
    .map(([, v]) => v);
}

/** Build a checker. Throws if the corpus cannot be verified and loaded. */
export async function loadGuard({ root = REPO_ROOT, env = process.env } = {}) {
  const hook = await import(pathToFileURL(join(root, ".claude", "hooks", "quran-guard.mjs")).href);
  const config = hook.loadConfig();
  const sources = hook.resolveSources(config, root);
  if (!env.QURAN_GUARD_SOURCE) verifySources(sources, root);
  // Fresh cache dir: never trust a cache file someone else could have left in the shared tmpdir.
  const cacheDir = mkdtempSync(join(tmpdir(), "bug-finder-guard-"));
  const { index, errors } = hook.loadIndex(sources, cacheDir, { useMemo: false });
  if (!index) throw new Error(`Quran source not loaded: ${errors.join("; ")}`);
  if (index.n < MIN_CORPUS_WORDS) throw new Error(`Quran source too small (${index.n} words)`);
  const secrets = secretValues(env);

  /** Returns a list of reasons; empty = clean. */
  return function check(raw) {
    const reasons = [];
    const text = asRendered(raw);
    if (SECRET_RE.test(raw) || SECRET_RE.test(text)) reasons.push("secret: token-like string");
    if (secrets.some((s) => raw.includes(s) || text.includes(s))) reasons.push("secret: matches a GUARD_SECRET value");
    if (ARABIC_RE.test(text)) reasons.push("arabic: Arabic-script text (refer to it by file:line instead)");
    const payload = { tool_name: "Write", tool_input: { file_path: PROBE_PATH, content: text }, cwd: root };
    const r = hook.evaluate(payload, { root, config, sources, cacheDir });
    if (r.code !== 0 || r.stderr) reasons.push(`quran-guard: blocked (${(r.findings ?? []).map((f) => `rule ${f.rule} line ${f.line}`).join(", ") || "see rules"})`);
    return reasons;
  };
}

/** Every file under `path` (or `path` itself). Directories are walked, never skipped. */
function* allFiles(path) {
  if (statSync(path).isFile()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(path, { recursive: true })) {
    const full = join(path, entry);
    if (!statSync(full).isDirectory()) yield full;
  }
}

async function main(paths) {
  if (paths.length === 0) {
    console.error("usage: guard.mjs <file-or-dir>...");
    return 1;
  }
  let check;
  try {
    check = await loadGuard();
  } catch (err) {
    console.error(`guard: ${err.message}`);
    return 1;
  }
  let blocked = 0;
  let files = 0;
  for (const p of paths) {
    if (!existsSync(p)) {
      console.error(`guard: path not found: ${p}`);
      return 1;
    }
    for (const file of allFiles(p)) {
      files++;
      // Fail closed: anything that is not a plain text file is not checked, so it may not ship.
      const reasons = TEXT_FILE_RE.test(file) && statSync(file).isFile() ? check(readFileSync(file, "utf8")) : ["not a regular .md/.json/.txt/.log file"];
      if (reasons.length) {
        blocked++;
        console.error(`guard: BLOCKED ${file}: ${reasons.join("; ")}`);
      }
    }
  }
  console.log(`guard: ${files} file(s) checked, ${blocked} blocked`);
  return blocked ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
