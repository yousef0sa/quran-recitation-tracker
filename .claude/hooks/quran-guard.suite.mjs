// node --test .claude/hooks/quran-guard.test.mjs   (that entry file loads this suite when the corpus exists)
// Every Quran string used here is BUILT AT TEST TIME from the corpus file. Nothing Quranic is typed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate, loadIndex, tokenize, classifyPath, globToRegExp } from "./quran-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const HOOK = join(HERE, "quran-guard.mjs");
const CONFIG = JSON.parse(readFileSync(join(HERE, "quran-guard.config.json"), "utf8"));
const CORPUS_PATH = join(ROOT, CONFIG.sources[0].path);
const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));

// ---- corpus helpers (the only source of Quran text in this file) ----------------------------
const ayahWords = (s, a) => corpus.surahs[s - 1].ayahs[a - 1].w.map((w) => w[2]);
const surahWords = (s) => corpus.surahs[s - 1].ayahs.flatMap((a) => a.w.map((w) => w[2]));
const allWords = () => corpus.surahs.flatMap((s) => s.ayahs.flatMap((a) => a.w.map((w) => w[2])));
const MARKS = /[ً-ٰٟۖ-ۭ]/g;
const UTHMANI = /[ٰٱۖ-ۭ]/;
const plain = (w) => w.replace(/ـ/g, "").normalize("NFC").replace(/[ٱأإآ]/g, "ا").replace(MARKS, "");
const markCount = (w) => (w.match(MARKS) ?? []).length;

const { index } = loadIndex(
  [{ abs: CORPUS_PATH, display: CONFIG.sources[0].path, adapter: CONFIG.sources[0].adapter }],
  tmpdir(),
);
assert.ok(index, "corpus must load for these tests (run npm run fetch-assets)");
const quranKeys = index.byKey;

// ---- payload builders ------------------------------------------------------------------------
const UI_PATH = join(ROOT, "spike", "src", "probe.ts");
const DEV_MD = join(ROOT, ".claude", "PRPs", "probe.md");
const DEV_TEST = join(ROOT, "spike", "src", "probe.test.ts");
const write = (file_path, content) => ({ tool_name: "Write", tool_input: { file_path, content }, cwd: ROOT });
const edit = (file_path, new_string) => ({ tool_name: "Edit", tool_input: { file_path, old_string: "x", new_string }, cwd: ROOT });
const bash = (command) => ({ tool_name: "Bash", tool_input: { command }, cwd: ROOT });
const run = (payload, env = {}) => evaluate(payload, { cacheDir: tmpdir(), ...env });

function assertNoQuranEcho(stderr, inputText) {
  // The reason may contain Arabic of its own, but none of it may be a Quran word, and none of the
  // offending text may appear in it.
  for (const tok of tokenize(stderr)) assert.ok(!quranKeys.has(tok.k1), "reason contains a Quran word");
  for (const tok of tokenize(inputText)) {
    if (tok.diac.length >= 3) assert.ok(!stderr.includes(tok.diac), "reason echoes input text");
  }
}

// ---- material found in the corpus at test time -----------------------------------------------
const run3Diacritized = ayahWords(1, 1).slice(0, 3).join(" ");
const run3OtherSurah = surahWords(112).slice(0, 3).join(" ");
const run3Plain = ayahWords(2, 255).slice(0, 3).map(plain).join(" ");

function findPairForRuleC() {
  const words = allWords();
  for (let i = 0; i + 2 < words.length; i++) {
    const [a, b] = [words[i], words[i + 1]];
    if (!UTHMANI.test(a) && !UTHMANI.test(b) && markCount(a) >= 1 && markCount(b) >= 1 && markCount(a) < 2 && markCount(b) < 2) {
      return [a, b];
    }
  }
  throw new Error("no suitable pair in corpus");
}
function findHeavyWord() {
  const w = allWords().find((x) => !UTHMANI.test(x) && markCount(x) >= 2 && x.normalize("NFC") === x);
  if (!w) throw new Error("no heavy word");
  return w;
}
const pairC = findPairForRuleC();
const heavyWord = findHeavyWord();

function changeOneHaraka(text) {
  const swaps = { "َ": "ِ", "ِ": "ُ", "ُ": "َ" };
  const i = [...text].findIndex((ch) => swaps[ch]);
  assert.ok(i >= 0, "no haraka to change");
  const chars = [...text];
  chars[i] = swaps[chars[i]];
  return chars.join("");
}

// =============================================================================================
test("path classes: dev wins over ui, everything else is dev", () => {
  const cls = (p) => classifyPath(p, CONFIG);
  assert.equal(cls("spike/src/live.ts"), "ui");
  assert.equal(cls("spike/src/live.test.ts"), "dev");
  assert.equal(cls("spike/index.html"), "ui");
  assert.equal(cls("spike/README.md"), "dev");
  assert.equal(cls(".claude/hooks/x.html"), "dev");
  assert.equal(cls("spike/scripts/x.html"), "dev");
  assert.equal(cls("mobile/app/src/res/values/strings.xml"), "ui");
  assert.equal(cls("mobile/a.arb"), "ui");
  assert.equal(cls("random/thing.txt"), "dev");
  assert.ok(globToRegExp("**/*.test.*").test("a/b/c.test.ts"));
  assert.ok(globToRegExp("spike/*.html").test("spike/a.html"));
  assert.ok(!globToRegExp("spike/*.html").test("spike/x/a.html"));
});

test("UI: 3-word run from 1:1 is blocked (Write), position reported, text not echoed", () => {
  const text = `export const x = "${run3Diacritized}";`;
  const r = run(write(UI_PATH, text));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /rule b/);
  assert.match(r.stderr, /1:1 word 1/);
  assertNoQuranEcho(r.stderr, text);
});

test("UI: plain (imla'i-style) 3-word run is blocked by rule b alone", () => {
  const r = run(write(UI_PATH, `const t = "${run3Plain}";`));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /rule b/);
  assert.doesNotMatch(r.stderr, /rule a/);
  assert.match(r.stderr, /2:255 word 1/);
});

test("UI: 3-word run from another surah is blocked", () => {
  const r = run(write(UI_PATH, `<p>${run3OtherSurah}</p>`));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /112:1 word 1/);
});

test("UI: a run split across separate string literals is still a run", () => {
  const parts = ayahWords(2, 255).slice(0, 3).map(plain);
  const r = run(write(UI_PATH, `const a = ["${parts[0]}", "${parts[1]}", "${parts[2]}"];`));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /rule b/);
});

test("UI: Edit and MultiEdit are blocked", () => {
  const e = run(edit(UI_PATH, `x = "${run3Plain}"`));
  assert.equal(e.code, 2);
  const m = run({
    tool_name: "MultiEdit",
    tool_input: { file_path: UI_PATH, edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: run3OtherSurah }] },
    cwd: ROOT,
  });
  assert.equal(m.code, 2);
  const ok = run({ tool_name: "MultiEdit", tool_input: { file_path: UI_PATH, edits: [{ old_string: "a", new_string: "b" }] }, cwd: ROOT });
  assert.equal(ok.code, 0);
});

test("UI: NotebookEdit new_source is inspected", () => {
  const r = run({ tool_name: "NotebookEdit", tool_input: { notebook_path: join(ROOT, "research", "n.ipynb"), new_source: run3Plain }, cwd: ROOT });
  // .ipynb is not in uiGlobs, so it is a dev path and an unquoted run is allowed; a quoted bad one is not.
  assert.equal(r.code, 0);
  const quoted = run({ tool_name: "NotebookEdit", tool_input: { notebook_path: join(ROOT, "research", "n.ipynb"), new_source: `"${[...ayahWords(2, 255).slice(0, 2).map(plain), plain(ayahWords(114, 1)[0])].join(" ")}"` }, cwd: ROOT });
  assert.equal(quoted.code, 2);
});

test("Bash: echo of a run is blocked, any target", () => {
  const text = `echo "${run3Plain}" > notes.txt`;
  const r = run(bash(text));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Use Write\/Edit for dev docs; UI Quran text must be loaded from the source/);
  assertNoQuranEcho(r.stderr, text);
  assert.equal(run(bash(`cat <<'EOF' > docs/x.md\n${run3Diacritized}\nEOF`)).code, 2);
});

test("Bash: ordinary commands pass", () => {
  assert.equal(run(bash("npm test && git status --short")).code, 0);
  assert.equal(run(bash(`git commit -m "إضافة حارس"`)).code, 0);
});

test("rule a: an Uthmani mark alone is blocked in UI", () => {
  for (const mark of ["ٰ", "ٱ", "ۖ", "ۭ"]) {
    const r = run(write(UI_PATH, `const m = "${mark}";`));
    assert.equal(r.code, 2, `U+${mark.codePointAt(0).toString(16)}`);
    assert.match(r.stderr, /rule a/);
  }
});

test("rule c: a diacritised 2-word source run is blocked in UI; plain 2-word run is allowed", () => {
  const r = run(write(UI_PATH, `const t = "${pairC.join(" ")}";`));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /rule c/);
  assert.equal(run(write(UI_PATH, `const t = "${pairC.map(plain).join(" ")}";`)).code, 0);
});

test("rule d: a single heavily diacritised source word is blocked in UI; one haraka is allowed", () => {
  const r = run(write(UI_PATH, `const t = "${heavyWord}";`));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /rule d/);
  // Keep the first mark, drop the rest (a non-global copy of MARKS: no lastIndex state).
  const isMark = new RegExp(MARKS.source);
  let kept = 0;
  const oneMark = [...heavyWord].filter((ch) => !isMark.test(ch) || kept++ === 0).join("");
  assert.equal(markCount(oneMark), 1, "the variant must keep exactly one mark, or rule d's one-mark path is untested");
  assert.equal(run(write(UI_PATH, `const t = "${oneMark}";`)).code, 0);
});

test("UI: non-Quran Arabic, Latin text and empty content pass", () => {
  assert.equal(run(write(UI_PATH, `const s = "تنزيل السجل";`)).code, 0);
  assert.equal(run(write(UI_PATH, `const s = "Hello world";`)).code, 0);
  assert.equal(run(write(UI_PATH, "")).code, 0);
  assert.equal(run({ tool_name: "Read", tool_input: { file_path: UI_PATH }, cwd: ROOT }).code, 0);
  assert.equal(run({ tool_name: "Write", tool_input: {}, cwd: ROOT }).code, 0);
});

test("UI: evasion by zero-width characters or presentation forms is still caught", () => {
  const spaced = ayahWords(2, 255).slice(0, 3).map(plain).map((w) => [...w].join("‍")).join(" ");
  assert.equal(run(write(UI_PATH, spaced)).code, 2);
  const tatweel = ayahWords(2, 255).slice(0, 3).map(plain).map((w) => `${w[0]}ـ${w.slice(1)}`).join(" ");
  assert.equal(run(write(UI_PATH, tatweel)).code, 2);
});

// ---- dev rule -----------------------------------------------------------------------------------
const quoteWords = ayahWords(1, 2);
const exactQuote = quoteWords.join(" ");

test("DEV: a correct quote inside « » is allowed (diacritised and plain)", () => {
  assert.equal(run(write(DEV_MD, `As in «${exactQuote}» (1:2)`)).code, 0);
  assert.equal(run(write(DEV_MD, `plain: «${quoteWords.map(plain).join(" ")}»`)).code, 0);
  assert.equal(run(write(DEV_TEST, `const q = "${quoteWords.slice(1, 3).join(" ")}";`)).code, 0);
});

test("DEV: a quote that crosses an ayah boundary is allowed when contiguous", () => {
  const cross = [...ayahWords(1, 2).slice(-2), ...ayahWords(1, 3)].join(" ");
  assert.equal(run(write(DEV_MD, `«${cross}»`)).code, 0);
});

test("DEV: a quote with one word swapped for another corpus word is blocked, closest position given", () => {
  const swapped = [...quoteWords];
  swapped[1] = ayahWords(114, 1)[0];
  assert.notEqual(plain(swapped[1]), plain(quoteWords[1]));
  const text = `«${swapped.join(" ")}»`;
  const r = run(write(DEV_MD, text));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /the quote does not match the source/);
  assert.match(r.stderr, /closest source \d+:\d+ word \d+/);
  assertNoQuranEcho(r.stderr, text);
});

test("DEV: a quote with one haraka changed is blocked", () => {
  const text = `«${changeOneHaraka(exactQuote)}»`;
  const r = run(write(DEV_MD, text));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /diacritics differ/);
  assert.match(r.stderr, /1:2 word 1/);
  assertNoQuranEcho(r.stderr, text);
});

/** Brute force (independent of the hook): does this plain word sequence occur contiguously in one surah? */
function occursInCorpus(words) {
  const target = words.map(plain);
  return corpus.surahs.some((s) => {
    const flat = s.ayahs.flatMap((a) => a.w.map((w) => plain(w[2])));
    for (let i = 0; i + target.length <= flat.length; i++) if (target.every((t, k) => flat[i + k] === t)) return true;
    return false;
  });
}

test("DEV: partially diacritised or reordered or truncated-with-gap quotes are blocked", () => {
  const w = [...quoteWords];
  w[1] = plain(w[1]);
  assert.equal(run(write(DEV_MD, `«${w.join(" ")}»`)).code, 2, "partial diacritics");

  // Reorder / gap candidates that the corpus really does not contain (verified by brute force).
  const candidates = [
    [quoteWords[1], quoteWords[0], quoteWords[2], quoteWords[3]], // reordered, still holds the pair 3-4
    [quoteWords[0], quoteWords[2], quoteWords[3]], // gap after word 1, pair 3-4 intact
    [quoteWords[0], quoteWords[1], quoteWords[3]], // gap before the last word, pair 1-2 intact
  ].filter((c) => !occursInCorpus(c));
  assert.ok(candidates.length >= 2, "need at least two non-occurring candidates");
  // A quote with no Quran 2-gram at all is not treated as a verse quote (spec: needs one source pair).
  const unrelated = [ayahWords(114, 1)[0], ayahWords(1, 7).at(-1), ayahWords(112, 1)[0]];
  assert.ok(!occursInCorpus(unrelated.slice(0, 2)) && !occursInCorpus(unrelated.slice(1)));
  assert.equal(run(write(DEV_MD, `«${unrelated.join(" ")}»`)).code, 0);
  for (const c of candidates) assert.equal(run(write(DEV_MD, `«${c.join(" ")}»`)).code, 2);
});

test("DEV: a reordering that does occur in the corpus is accepted (the rule is contiguity, not intent)", () => {
  const pair = [quoteWords[1], quoteWords[0]];
  if (occursInCorpus(pair)) assert.equal(run(write(DEV_MD, `«${pair.join(" ")}»`)).code, 0);
});

test("DEV: every delimiter kind is checked", () => {
  const bad = [...quoteWords];
  bad[2] = ayahWords(114, 1)[1];
  const t = bad.join(" ");
  for (const [open, close] of [["«", "»"], ["﴿", "﴾"], ["﴾", "﴿"], ['"', '"'], ["'", "'"], ["`", "`"]]) {
    const r = run(write(DEV_MD, `see ${open}${t}${close} here`));
    assert.equal(r.code, 2, `delimiter ${open}${close}`);
    const ok = run(write(DEV_MD, `see ${open}${exactQuote}${close} here`));
    assert.equal(ok.code, 0, `delimiter ${open}${close} (correct)`);
  }
});

test("DEV: position references, unquoted prose, one-word quotes and non-Arabic text are allowed", () => {
  assert.equal(run(write(DEV_MD, "See 1:6 word 1, surah 1 ayah 6, and 2:255 word 3.")).code, 0);
  assert.equal(run(write(DEV_MD, `unquoted ${[...quoteWords].reverse().join(" ")} stays unchecked`)).code, 0);
  assert.equal(run(write(DEV_MD, `«${quoteWords[0]}»`)).code, 0);
  assert.equal(run(write(DEV_MD, "# Heading\n\nNothing Arabic here, only `code` and \"quotes\".")).code, 0);
  assert.equal(run(write(DEV_MD, "«ابت ثج»")).code, 0);
});

test("DEV: apostrophes in English prose do not form Arabic segments", () => {
  assert.equal(run(write(DEV_MD, `don't ${quoteWords.join(" ")} isn't checked`)).code, 0);
});

test("DEV: Bash heredoc to a doc is blocked even if the quote is correct (Bash always uses the UI rule)", () => {
  assert.equal(run(bash(`cat > docs/x.md <<'EOF'\n«${exactQuote}»\nEOF`)).code, 2);
});

// ---- fail-closed --------------------------------------------------------------------------------
const MISSING = [{ abs: join(tmpdir(), "quran-guard-missing-source.json"), display: "spike/public/data/zipformer_quran.json", adapter: "tilawa-corpus-v2" }];

test("fail-closed: UI blocks Uthmani marks and 2+ harakat when the source is missing", () => {
  const a = run(write(UI_PATH, `const m = "ٱ";`), { sources: MISSING });
  assert.equal(a.code, 2);
  assert.match(a.stderr, /npm run fetch-assets/);
  const h = run(write(UI_PATH, `const m = "${heavyWord}";`), { sources: MISSING });
  assert.equal(h.code, 2);
  assert.match(h.stderr, /npm run fetch-assets/);
  assert.equal(run(bash(`echo "${heavyWord}"`), { sources: MISSING }).code, 2);
  for (const tok of tokenize(a.stderr)) assert.ok(!quranKeys.has(tok.k1));
});

test("fail-closed: a plain run cannot be recognised, UI allows it with a warning; harmless text passes", () => {
  const r = run(write(UI_PATH, `const t = "${run3Plain}";`), { sources: MISSING });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /warning/);
  assert.equal(run(write(UI_PATH, `const s = "تنزيل السجل";`), { sources: MISSING }).code, 0);
});

test("fail-closed: dev paths are allowed with a stderr warning", () => {
  const r = run(write(DEV_MD, `«${exactQuote}»`), { sources: MISSING });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /warning/);
  assert.match(r.stderr, /fetch-assets/);
});

test("fail-closed through the CLI with QURAN_GUARD_SOURCE pointing at a missing file", () => {
  const r = cli(write(UI_PATH, `const m = "ٱ";`), { QURAN_GUARD_SOURCE: join(tmpdir(), "nope-quran.json") });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /fetch-assets/);
  const dev = cli(write(DEV_MD, "x"), { QURAN_GUARD_SOURCE: join(tmpdir(), "nope-quran.json") });
  assert.equal(dev.status, 0);
});

test("a corrupt source falls back to fail-closed instead of crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "qg-corrupt-"));
  const bad = join(dir, "bad.json");
  writeFileSyncCompat(bad, "{not json");
  const r = run(write(UI_PATH, `const m = "ٱ";`), { sources: [{ abs: bad, display: "bad.json", adapter: "tilawa-corpus-v2" }] });
  assert.equal(r.code, 2);
});

// ---- CLI contract -------------------------------------------------------------------------------
function cli(payload, env = {}, cacheDir = null) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...(cacheDir ? { QURAN_GUARD_CACHE_DIR: cacheDir } : {}), ...env },
  });
}
import { writeFileSync as writeFileSyncCompat } from "node:fs";

test("CLI: exit codes and stderr", () => {
  const blocked = cli(write(UI_PATH, run3Plain));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /BLOCKED/);
  assertNoQuranEcho(blocked.stderr, run3Plain);
  assert.equal(cli(write(UI_PATH, "hello")).status, 0);
  assert.equal(cli({ tool_name: "Read", tool_input: { file_path: "x" } }).status, 0);
  assert.equal(cli("{ this is not json").status, 2);
  assert.equal(cli(bash(`echo "${run3Plain}"`)).status, 2);
});

test("CLI: relative file_path resolves against cwd and project root", () => {
  const rel = { tool_name: "Write", tool_input: { file_path: "spike/src/probe.ts", content: run3Plain }, cwd: ROOT };
  assert.equal(cli(rel).status, 2);
  const outside = { tool_name: "Write", tool_input: { file_path: join(tmpdir(), "notes.txt"), content: run3Plain }, cwd: ROOT };
  assert.equal(cli(outside).status, 0); // outside the project: dev class, unquoted text is not checked
});

// ---- regression: the existing project must not trip the guard -------------------------------------
function walk(dir, filter) {
  if (!existsSync(dir)) return []; // .claude/PRPs is local-only: absent in CI
  const out = [];
  for (const entry of readdirSync(dir, { recursive: true })) {
    const full = join(dir, entry);
    if (statSync(full).isFile() && filter(full)) out.push(full);
  }
  return out;
}

function describeFailure(file, content, r) {
  const lines = (r.findings ?? []).map((f) => `${relative(ROOT, file)}:${f.line} rule ${f.rule}${f.pos ? ` (source ${f.pos})` : ""}`);
  return lines.length ? lines.join("\n") : `${relative(ROOT, file)}: exit ${r.code} ${r.stderr}`;
}

test("regression: existing UI files (spike/src, spike/*.html, audio-processor.js) pass the UI rule", () => {
  const files = [
    ...walk(join(ROOT, "spike", "src"), () => true),
    ...readdirSync(join(ROOT, "spike")).filter((f) => f.endsWith(".html")).map((f) => join(ROOT, "spike", f)),
    join(ROOT, "spike", "public", "audio-processor.js"),
  ];
  assert.ok(files.length > 20, `expected many files, got ${files.length}`);
  const withArabic = files.filter((f) => /[؀-ۿ]/.test(readFileSync(f, "utf8"))).length;
  assert.ok(withArabic >= 5, `regression should cover files with Arabic (got ${withArabic})`);
  console.log(`# quran-guard regression: ${files.length} UI-side files, ${withArabic} contain Arabic`);
  const failures = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    // Forced UI class: even test files are fed through the UI rule via a synthetic UI path.
    const r = run(write(UI_PATH, content));
    if (r.code !== 0) failures.push(describeFailure(file, content, r));
    // And with their real path (dev files get the dev rule).
    const real = run(write(file, content));
    if (real.code !== 0) failures.push(describeFailure(file, content, real));
  }
  assert.deepEqual(failures, [], `false positives:\n${failures.join("\n")}`);
});

test("regression: existing dev docs (spike/*.md, .claude/PRPs/**/*.md, hook files) pass the dev rule", () => {
  const files = [
    ...readdirSync(join(ROOT, "spike")).filter((f) => f.endsWith(".md")).map((f) => join(ROOT, "spike", f)),
    ...walk(join(ROOT, ".claude", "PRPs"), (f) => f.endsWith(".md")),
    ...walk(HERE, (f) => /\.(mjs|json)$/.test(f)),
    ...walk(join(ROOT, "spike", "scripts"), () => true),
  ];
  assert.ok(files.length >= 5);
  const withArabic = files.filter((f) => /[؀-ۿ]/.test(readFileSync(f, "utf8"))).length;
  console.log(`# quran-guard regression: ${files.length} dev files, ${withArabic} contain Arabic`);
  const failures = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const r = run(write(DEV_MD, content));
    if (r.code !== 0) failures.push(describeFailure(file, content, r));
  }
  assert.deepEqual(failures, [], `false positives:\n${failures.join("\n")}`);
});

// ---- timing ---------------------------------------------------------------------------------------
test("timing: cold (cache miss) and warm (cache hit) per call, CLI wall time", (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "qg-cache-"));
  const payload = write(UI_PATH, run3Plain);
  const ms = (fn) => {
    const s = performance.now();
    const r = fn();
    return [performance.now() - s, r];
  };
  const [cold, rc] = ms(() => cli(payload, {}, cacheDir));
  assert.equal(rc.status, 2);
  const warms = [];
  for (let i = 0; i < 7; i++) {
    const [w, r] = ms(() => cli(payload, {}, cacheDir));
    assert.equal(r.status, 2);
    warms.push(w);
  }
  warms.sort((a, b) => a - b);
  const baseline = ms(() => spawnSync(process.execPath, ["-e", ""]))[0];
  const report = `cold ${cold.toFixed(0)} ms, warm median ${warms[3].toFixed(0)} ms (min ${warms[0].toFixed(0)}, max ${warms[6].toFixed(0)}), bare node start ${baseline.toFixed(0)} ms`;
  t.diagnostic(report);
  console.log(`# quran-guard timing: ${report}`);
  assert.ok(warms[3] < 3000, "warm call should be well under 3 s");
  // A non-Arabic payload must not even load the index.
  const [cheap] = ms(() => cli(write(UI_PATH, "const a = 1;"), {}, cacheDir));
  console.log(`# quran-guard timing: non-Arabic payload ${cheap.toFixed(0)} ms`);
});
