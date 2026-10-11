#!/usr/bin/env node
// quran-guard: strict Claude Code PreToolUse hook (Node ESM, no dependencies).
//
// Owner's rule:
//  (1) Quranic text shown to readers (site / phone app) is never typed by Claude or a subagent;
//      it is loaded at runtime from an authoritative source file.
//  (2) In dev files (tests, docs, research, scripts) a verse may appear as a quoted reference,
//      but it must match the source exactly.
//
// Contract: reads the PreToolUse JSON on stdin; inspects the new text of Write / Edit / MultiEdit /
// NotebookEdit / Bash; exit 0 = allow, exit 2 = block (reason on stderr, Arabic + English, positions
// only: the matched Quran text is never echoed). Any other tool: exit 0.
//
// Env overrides (used by the tests): QURAN_GUARD_SOURCE (one source path, replaces config sources),
// QURAN_GUARD_CONFIG, QURAN_GUARD_CACHE_DIR, CLAUDE_PROJECT_DIR.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const CODE_VERSION = 3; // bump when index layout / normalisation changes (invalidates caches)

// ---------------------------------------------------------------------------------------------
// Normalisation and tokenisation
// ---------------------------------------------------------------------------------------------

const MARK_CLASS = "\\u064B-\\u065F\\u0670\\u06D6-\\u06ED";
const MARK_RE = new RegExp(`[${MARK_CLASS}]`, "g");
const MARK_TEST_RE = new RegExp(`[${MARK_CLASS}]`);
const UTHMANI_RE = /[ٰٱۖ-ۭ]/;
const UTHMANI_RE_G = /[ٰٱۖ-ۭ]/g;
const ALEF_RE = /[ٱأإآ]/g;
const IGNORABLE_CLASS = "\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF\\u061C";
const IGNORABLE_RE = new RegExp(`[${IGNORABLE_CLASS}]`, "g");
// Arabic letters, plus presentation forms (expanded with NFKC below) so they cannot be used to evade.
const LETTER_CLASS =
  "\\u0620-\\u064A\\u066E\\u066F\\u0671-\\u06D3\\u06D5\\u06EE\\u06EF\\u06FA-\\u06FF\\uFB50-\\uFD3D\\uFD40-\\uFDFF\\uFE70-\\uFEFE";
const TOKEN_RE = new RegExp(`[${LETTER_CLASS}${MARK_CLASS}\\u0640${IGNORABLE_CLASS}]+`, "g");
const HAS_ARABIC_RE = new RegExp(`[${LETTER_CLASS}${MARK_CLASS}]`);
const PRESENTATION_RE = /[ﭐ-ﴽ﵀-﷿ﹰ-﻾]/g;

/** normalize(): NFC, no tatweel, no harakat / Quranic marks, alef forms -> U+0627. */
export function normalize(text, superscriptAlefToAlef = false) {
  let t = text.normalize("NFC").replace(/ـ/g, "");
  if (superscriptAlefToAlef) t = t.replace(/ٰ/g, "ا");
  return t.replace(ALEF_RE, "ا").replace(MARK_RE, "");
}

/** Diacritised comparison form: NFC with tatweel removed. */
export function diacritized(text) {
  return text.normalize("NFC").replace(/ـ/g, "");
}

export function countMarks(text) {
  const m = text.match(MARK_RE);
  return m ? m.length : 0;
}

/**
 * Arabic letter-run tokens of `text`: { diac, k1, k2, marks, offset }.
 * k1 = normalised (superscript alef stripped), k2 = superscript alef kept as alef.
 */
export function tokenize(text) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const expanded = match[0].replace(PRESENTATION_RE, (c) => c.normalize("NFKC")).replace(IGNORABLE_RE, "");
    for (const part of expanded.split(/\s+/)) {
      if (!part) continue;
      const diac = diacritized(part);
      const k1 = normalize(diac, false);
      if (!k1) continue;
      tokens.push({ diac, k1, k2: normalize(diac, true), marks: countMarks(diac), offset: match.index });
    }
  }
  return tokens;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ---------------------------------------------------------------------------------------------
// Source adapters. To add the KFGQPC file later (Phase 2): register an adapter here that yields
// { surah, ayah, word, text } for every word, then list it in quran-guard.config.json "sources".
// ---------------------------------------------------------------------------------------------

export const ADAPTERS = {
  // tilawa zipformer_quran.json (v=2): surahs[i] = { n, ayahs: [{ n, w: [[glyphs, phonemes, plainUthmani], ...] }] }
  "tilawa-corpus-v2": function* (json) {
    const surahs = json?.surahs;
    if (!Array.isArray(surahs) || surahs.length !== 114) throw new Error("expected 114 surahs");
    for (let si = 0; si < surahs.length; si++) {
      const s = surahs[si];
      const surah = Number.isInteger(s?.n) ? s.n : si + 1;
      if (!Array.isArray(s?.ayahs)) throw new Error(`surah ${surah}: no ayahs`);
      for (let ai = 0; ai < s.ayahs.length; ai++) {
        const a = s.ayahs[ai];
        const ayah = Number.isInteger(a?.n) ? a.n : ai + 1;
        if (!Array.isArray(a?.w)) throw new Error(`${surah}:${ayah}: no words`);
        for (let wi = 0; wi < a.w.length; wi++) {
          const text = a.w[wi]?.[2];
          if (typeof text !== "string") throw new Error(`${surah}:${ayah} word ${wi + 1}: no plain Uthmani text`);
          yield { surah, ayah, word: wi + 1, text };
        }
      }
    }
  },
};

function buildSourceData(json, adapterName) {
  const adapter = ADAPTERS[adapterName];
  if (!adapter) throw new Error(`unknown adapter "${adapterName}"`);
  const data = { k1: [], k2: [], diac: [], surah: [], ayah: [], word: [] };
  for (const { surah, ayah, word, text } of adapter(json)) {
    const tokens = tokenize(text);
    if (tokens.length === 0) continue;
    const diac = tokens.map((t) => t.diac).join("");
    const k1 = tokens.map((t) => t.k1).join("");
    const k2 = tokens.map((t) => t.k2).join("");
    data.k1.push(k1);
    data.k2.push(k2 === k1 ? "" : k2);
    data.diac.push(diac);
    data.surah.push(surah);
    data.ayah.push(ayah);
    data.word.push(word);
  }
  return data;
}

function cachePathFor(source, cacheDir) {
  const key = createHash("sha1")
    .update(JSON.stringify([CODE_VERSION, source.abs, source.size, source.mtimeMs, source.adapter]))
    .digest("hex")
    .slice(0, 20);
  return join(cacheDir, `quran-guard-${key}.json`);
}

function loadSourceData(source, cacheDir) {
  const cachePath = cachePathFor(source, cacheDir);
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    if (cached.version === CODE_VERSION && Array.isArray(cached.k1)) return { data: cached, cache: "warm" };
  } catch {
    // no usable cache: build below
  }
  const data = buildSourceData(JSON.parse(readFileSync(source.abs, "utf8")), source.adapter);
  try {
    mkdirSync(cacheDir, { recursive: true });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: CODE_VERSION, ...data }));
    renameSync(tmp, cachePath);
  } catch {
    // cache is best effort
  }
  return { data, cache: "cold" };
}

/**
 * Load all sources that exist. Returns { index | null, errors[], cache }.
 * index: parallel arrays over every source word + byKey: normalised key -> positions.
 */
const memo = new Map(); // in-process only (the CLI makes one call per process; tests make many)

export function loadIndex(sources, cacheDir, { useMemo = true } = {}) {
  const errors = [];
  const parts = [];
  let cache = "warm";
  const stats = sources.map((src) => {
    try {
      return statSync(src.abs);
    } catch {
      return null;
    }
  });
  const memoKey = JSON.stringify([CODE_VERSION, cacheDir, sources.map((s, i) => [s.abs, s.adapter, stats[i]?.size, stats[i]?.mtimeMs])]);
  if (useMemo && memo.has(memoKey)) return { ...memo.get(memoKey), cache: "memo" };
  sources.forEach((src, srcIndex) => {
    const st = stats[srcIndex];
    if (!st) {
      errors.push(`source not found: ${src.display}`);
      return;
    }
    try {
      const loaded = loadSourceData({ ...src, size: st.size, mtimeMs: st.mtimeMs }, cacheDir);
      if (loaded.cache === "cold") cache = "cold";
      parts.push({ srcIndex, data: loaded.data });
    } catch (err) {
      errors.push(`source unreadable: ${src.display} (${err instanceof Error ? err.message : String(err)})`);
    }
  });
  if (parts.length === 0) return { index: null, errors, cache };

  let index;
  if (parts.length === 1 && parts[0].srcIndex === 0) {
    // Single source (the normal case): reuse the cached arrays; the group id is just the surah.
    const d = parts[0].data;
    index = { k1: d.k1, k2: d.k2, diac: d.diac, surah: d.surah, ayah: d.ayah, word: d.word, grp: d.surah, byKey: new Map(), n: 0 };
  } else {
    index = { k1: [], k2: [], diac: [], surah: [], ayah: [], word: [], grp: [], byKey: new Map(), n: 0 };
    for (const { srcIndex, data } of parts) {
      for (let i = 0; i < data.k1.length; i++) {
        index.k1.push(data.k1[i]);
        index.k2.push(data.k2[i]);
        index.diac.push(data.diac[i]);
        index.surah.push(data.surah[i]);
        index.ayah.push(data.ayah[i]);
        index.word.push(data.word[i]);
        index.grp.push(srcIndex * 1000 + data.surah[i]);
      }
    }
  }
  index.n = index.k1.length;
  const add = (key, p) => {
    const list = index.byKey.get(key);
    if (list) list.push(p);
    else index.byKey.set(key, [p]);
  };
  for (let p = 0; p < index.n; p++) {
    add(index.k1[p], p);
    if (index.k2[p]) add(index.k2[p], p);
  }
  const out = { index, errors, cache };
  if (useMemo) memo.set(memoKey, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Matching against the index
// ---------------------------------------------------------------------------------------------

const EMPTY = [];

function matchAt(index, p, key) {
  return p >= 0 && p < index.n && (index.k1[p] === key || index.k2[p] === key);
}

/** How many tokens from tokens[i] match consecutively from source position p (same surah, same source). */
function matchLen(index, tokens, i, p) {
  let len = 0;
  while (
    i + len < tokens.length &&
    p + len < index.n &&
    index.grp[p + len] === index.grp[p] &&
    matchAt(index, p + len, tokens[i + len].k1)
  ) {
    len++;
  }
  return len;
}

function positionsOf(index, key) {
  return index.byKey.get(key) ?? EMPTY;
}

/** Start positions where tokens[i], tokens[i+1] are consecutive source words. */
function pairHits(index, tokens, i) {
  const a = positionsOf(index, tokens[i].k1);
  const b = positionsOf(index, tokens[i + 1].k1);
  const hits = [];
  if (a.length === 0 || b.length === 0) return hits;
  if (a.length <= b.length) {
    for (const p of a) if (matchAt(index, p + 1, tokens[i + 1].k1) && index.grp[p + 1] === index.grp[p]) hits.push(p);
  } else {
    for (const q of b) {
      const p = q - 1;
      if (p >= 0 && matchAt(index, p, tokens[i].k1) && index.grp[p] === index.grp[q]) hits.push(p);
    }
  }
  return hits;
}

function longestRunAt(index, tokens, i, hits) {
  let best = { p: hits[0], len: 2 };
  for (const p of hits) {
    const len = matchLen(index, tokens, i, p);
    if (len > best.len) best = { p, len };
  }
  return best;
}

function posLabel(index, p) {
  return `${index.surah[p]}:${index.ayah[p]} word ${index.word[p]}`;
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

const MAX_FINDINGS = 6;

/** UI rule (a)-(d). Returns findings [{ rule, line, pos?, run? }]. */
export function uiFindings(text, index) {
  const findings = [];
  const starts = lineStarts(text);

  const uthmani = text.search(UTHMANI_RE);
  if (uthmani >= 0) {
    const count = (text.match(UTHMANI_RE_G) ?? []).length;
    findings.push({ rule: "a", line: lineOf(starts, uthmani), count });
  }

  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length && findings.length < MAX_FINDINGS; i++) {
    const tok = tokens[i];
    if (i + 1 < tokens.length) {
      const hits = pairHits(index, tokens, i);
      if (hits.length > 0) {
        const best = longestRunAt(index, tokens, i, hits);
        if (best.len >= 3) {
          findings.push({ rule: "b", line: lineOf(starts, tok.offset), pos: posLabel(index, best.p), run: best.len });
          i += best.len - 1;
          continue;
        }
        if (tok.marks > 0 || tokens[i + 1].marks > 0) {
          findings.push({ rule: "c", line: lineOf(starts, tok.offset), pos: posLabel(index, best.p), run: 2 });
          i += 1;
          continue;
        }
      }
    }
    if (tok.marks >= 2 && index.byKey.has(tok.k1)) {
      findings.push({ rule: "d", line: lineOf(starts, tok.offset), pos: posLabel(index, positionsOf(index, tok.k1)[0]), run: 1 });
    }
  }
  return findings;
}

/** Fail-closed UI rule when no source could be loaded. */
export function failClosedFindings(text) {
  const findings = [];
  const starts = lineStarts(text);
  const uthmani = text.search(UTHMANI_RE);
  if (uthmani >= 0) findings.push({ rule: "a", line: lineOf(starts, uthmani), count: (text.match(UTHMANI_RE_G) ?? []).length });
  for (const tok of tokenize(text)) {
    if (tok.marks >= 2) {
      findings.push({ rule: "h", line: lineOf(starts, tok.offset) });
      break;
    }
  }
  return findings;
}

const SEGMENT_PATTERNS = [
  /[«»]([^«»]*)[«»]/g, // « »
  /[﴾﴿]([^﴾﴿]*)[﴾﴿]/g, // ﴾ ﴿
  /"([^"\n]*)"/g,
  /(?<![\p{L}\p{N}])'([^'\n]*)'(?![\p{L}\p{N}])/gu,
  /`([^`\n]*)`/g,
];

function* segmentsOf(text) {
  for (const pattern of SEGMENT_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      yield { text: m[1], offset: m.index };
      if (m[0].length === 0) pattern.lastIndex++;
    }
  }
}

function bestPartial(index, tokens) {
  const limit = Math.min(tokens.length, 400);
  let best = { p: -1, len: 0 };
  for (let i = 0; i < limit; i++) {
    const positions = positionsOf(index, tokens[i].k1);
    if (positions.length > 5000) continue;
    for (const p of positions) {
      const len = matchLen(index, tokens, i, p);
      if (len > best.len) best = { p, len };
    }
  }
  return best;
}

/** DEV rule: every quoted segment that looks like Quran must match the source exactly. */
export function devFindings(text, index) {
  const findings = [];
  const starts = lineStarts(text);
  for (const segment of segmentsOf(text)) {
    if (findings.length >= MAX_FINDINGS) break;
    const tokens = tokenize(segment.text);
    if (tokens.length < 2) continue;
    let looksQuranic = false;
    for (let i = 0; i + 1 < tokens.length && !looksQuranic; i++) looksQuranic = pairHits(index, tokens, i).length > 0;
    if (!looksQuranic) continue;
    const line = lineOf(starts, segment.offset);

    const candidates = [];
    for (const p of positionsOf(index, tokens[0].k1)) if (matchLen(index, tokens, 0, p) === tokens.length) candidates.push(p);
    if (candidates.length === 0) {
      const best = bestPartial(index, tokens);
      findings.push({
        rule: "words",
        line,
        pos: best.p >= 0 ? posLabel(index, best.p) : null,
        matched: best.len,
        total: tokens.length,
      });
      continue;
    }
    if (tokens.some((t) => t.marks > 0)) {
      const exact = candidates.some((p) => tokens.every((t, i) => t.diac === index.diac[p + i]));
      if (!exact) findings.push({ rule: "marks", line, pos: posLabel(index, candidates[0]), total: tokens.length });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Config, path classes
// ---------------------------------------------------------------------------------------------

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) {
      re += "(?:[^/]+/)*";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      re += "[^/]*";
      i++;
    } else if (glob[i] === "?") {
      re += "[^/]";
      i++;
    } else {
      re += glob[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

export function classifyPath(relPath, config) {
  const matches = (globs) => (globs ?? []).some((g) => globToRegExp(g).test(relPath));
  if (matches(config.devGlobs)) return "dev";
  if (matches(config.uiGlobs)) return "ui";
  return "dev";
}

export function resolveRoot() {
  return process.env.CLAUDE_PROJECT_DIR ? resolve(process.env.CLAUDE_PROJECT_DIR) : resolve(HOOK_DIR, "..", "..");
}

export function loadConfig() {
  const path = process.env.QURAN_GUARD_CONFIG ? resolve(process.env.QURAN_GUARD_CONFIG) : join(HOOK_DIR, "quran-guard.config.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

export function resolveSources(config, root) {
  const entries = process.env.QURAN_GUARD_SOURCE
    ? [{ path: process.env.QURAN_GUARD_SOURCE, adapter: "tilawa-corpus-v2" }]
    : (config.sources ?? []).map((s) => (typeof s === "string" ? { path: s, adapter: "tilawa-corpus-v2" } : s));
  return entries.map((s) => ({
    abs: resolve(root, s.path),
    display: s.path,
    adapter: s.adapter ?? "tilawa-corpus-v2",
  }));
}

// ---------------------------------------------------------------------------------------------
// Hook payload handling
// ---------------------------------------------------------------------------------------------

/** Texts to inspect for a PreToolUse payload, and where they are going. Null: tool not inspected. */
export function extractTexts(payload) {
  const input = payload?.tool_input ?? {};
  switch (payload?.tool_name) {
    case "Write":
      return { kind: "file", path: input.file_path, texts: [input.content] };
    case "Edit":
      return { kind: "file", path: input.file_path, texts: [input.new_string] };
    case "MultiEdit":
      return { kind: "file", path: input.file_path, texts: (input.edits ?? []).map((e) => e?.new_string) };
    case "NotebookEdit":
      return { kind: "file", path: input.notebook_path, texts: [input.new_source] };
    case "Bash":
      return { kind: "bash", path: null, texts: [input.command] };
    default:
      return null;
  }
}

function relativeToRoot(filePath, root, cwd) {
  if (typeof filePath !== "string" || !filePath) return null;
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd || root, filePath);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

const BANNER = "quran-guard: محظور / BLOCKED";

const AR = {
  ui: "ممنوع كتابة نص قرآني بملفات الواجهة، المطلوب تحميله وقت التشغيل عبر الملف المصدر المعتمد",
  bash: "استعمل Write و Edit لملفات التوثيق، ونص الواجهة القرآني تحميله عبر الملف المصدر",
  dev: "الاقتباس مخالف المصدر، صحح الموضع بالرجوع للملف المصدر",
  failClosed: "تعذر تحميل المصدر القرآني، نفذ npm run fetch-assets وكرر المحاولة",
  internal: "عطل داخلي بالحارس، تم المنع احتياطا",
};

function describeFinding(f) {
  switch (f.rule) {
    case "a":
      return `rule a (Uthmani marks present, ${f.count} chars) at line ${f.line}`;
    case "b":
      return `rule b (${f.run}+ consecutive source words) at line ${f.line}, source ${f.pos}`;
    case "c":
      return `rule c (diacritised 2-word run) at line ${f.line}, source ${f.pos}`;
    case "d":
      return `rule d (heavily diacritised source word) at line ${f.line}, source ${f.pos}`;
    case "h":
      return `fail-closed: a word with 2+ harakat at line ${f.line}`;
    case "words":
      return `the quote does not match the source: line ${f.line}, closest source ${f.pos ?? "none"} (${f.matched} of ${f.total} words match)`;
    case "marks":
      return `the quote does not match the source: line ${f.line}, same words as ${f.pos} but the diacritics differ (${f.total} words)`;
    default:
      return `rule ${f.rule} at line ${f.line}`;
  }
}

function blockMessage(kind, findings, extra = "") {
  const head = {
    ui: "Quranic text must not be typed into UI files; load it at runtime from the authoritative source file.",
    bash: "Use Write/Edit for dev docs; UI Quran text must be loaded from the source.",
    dev: "The quote does not match the source. Fix the quote from the source file or reference it by surah:ayah word N.",
    "fail-closed": "The Quran source could not be loaded, so UI text with Uthmani marks or heavy diacritics is refused. Run `npm run fetch-assets`.",
    internal: "Internal guard error on a UI path; blocking to stay safe.",
  }[kind];
  const arabic = { ui: AR.ui, bash: AR.bash, dev: AR.dev, "fail-closed": AR.failClosed, internal: AR.internal }[kind];
  const lines = [BANNER, arabic, head, ...findings.map((f) => `- ${describeFinding(f)}`)];
  if (extra) lines.push(extra);
  return lines.join("\n") + "\n";
}

/**
 * Evaluate one PreToolUse payload. Returns { code, stderr, kind, pathClass, ms, cache }.
 * `env` lets tests inject root / config / sources / cache dir without touching process.env.
 */
export function evaluate(payload, env = {}) {
  const started = performance.now();
  const result = (code, stderr = "", extra = {}) => ({ code, stderr, ms: performance.now() - started, ...extra });

  const extracted = extractTexts(payload);
  if (!extracted) return result(0, "", { pathClass: "n/a" });
  const texts = extracted.texts.filter((t) => typeof t === "string" && t.length > 0);
  if (texts.length === 0) return result(0, "", { pathClass: "n/a" });

  const root = env.root ?? resolveRoot();
  const config = env.config ?? loadConfig();
  let pathClass = "bash";
  if (extracted.kind === "file") {
    const rel = relativeToRoot(extracted.path, root, payload.cwd);
    pathClass = rel === null ? "dev" : classifyPath(rel, config);
  }
  const strict = pathClass === "ui" || pathClass === "bash";

  // Cheap exit: nothing Arabic anywhere means nothing to check.
  if (!texts.some((t) => HAS_ARABIC_RE.test(t))) return result(0, "", { pathClass });

  try {
    const sources = env.sources ?? resolveSources(config, root);
    const cacheDir = env.cacheDir ?? process.env.QURAN_GUARD_CACHE_DIR ?? tmpdir();
    const { index, errors, cache } = loadIndex(sources, cacheDir, { useMemo: env.useMemo !== false });

    if (!index) {
      const detail = errors.join("; ");
      if (strict) {
        const findings = texts.flatMap((t) => failClosedFindings(t));
        if (findings.length > 0) return result(2, blockMessage("fail-closed", findings, detail), { pathClass, cache });
        return result(0, `quran-guard: warning, Quran source unavailable (${detail}); only coarse checks ran.\n`, { pathClass, cache });
      }
      return result(0, `quran-guard: warning, Quran source unavailable (${detail}); dev text not verified. Run \`npm run fetch-assets\`.\n`, {
        pathClass,
        cache,
      });
    }

    const findings = [];
    for (const text of texts) {
      findings.push(...(strict ? uiFindings(text, index) : devFindings(text, index)));
      if (findings.length >= MAX_FINDINGS) break;
    }
    if (findings.length === 0) return result(0, "", { pathClass, cache });
    const kind = pathClass === "bash" ? "bash" : pathClass === "ui" ? "ui" : "dev";
    return result(2, blockMessage(kind, findings.slice(0, MAX_FINDINGS)), { pathClass, cache, findings });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (strict) return result(2, blockMessage("internal", [], `error: ${why}`), { pathClass });
    return result(0, `quran-guard: warning, internal error on a dev path (${why}); not verified.\n`, { pathClass });
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch (err) {
    process.stderr.write(`${BANNER}\n${AR.internal}\nCould not parse the hook input as JSON; blocking to stay safe.\n`, () => process.exit(2));
    return;
  }
  let outcome;
  try {
    outcome = evaluate(payload);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    outcome = { code: 2, stderr: blockMessage("internal", [], `error: ${why}`) };
  }
  if (outcome.stderr) process.stderr.write(outcome.stderr, () => process.exit(outcome.code));
  else process.exit(outcome.code);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
