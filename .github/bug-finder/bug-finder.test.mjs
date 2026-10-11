// Tests for the weekly bug finder scripts. Run from the repo root:
//   node --test ".github/bug-finder/*.test.mjs"
// The guard tests need the corpus (npm run fetch-assets in spike/). Locally they skip without it;
// in CI (CI=true) a missing corpus is a failure, so the guard is never silently untested.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditFindings } from "./audit.mjs";
import { loadGuard, REPO_ROOT } from "./guard.mjs";
import { decide, fingerprint, markerOf, parseDraft, render, sanitize, validateDraft } from "./lib.mjs";
import { MAX_CREATES, publish, rangeContext, readDrafts } from "./report.mjs";

const CORPUS = join(REPO_ROOT, "spike", "public", "data", "zipformer_quran.json");
const HAVE_CORPUS = existsSync(CORPUS);
if (!HAVE_CORPUS && process.env.CI) throw new Error("corpus missing in CI: run npm run fetch-assets before these tests");

const issue = (number, state, fp, labels = [], stateReason = null) => ({ number, state, stateReason, labels: labels.map((name) => ({ name })), body: `x\n<!-- bug-finder:${fp} -->` });
const clean = () => [];
const ctxAll = { fileExists: () => true, changed: () => true, inRange: () => true };
const DRAFT = "---\nkind: privacy\nfile: spike/src/a.ts\nline: 12\ncommit: abc1234\nseverity: important\ntitle: Sends audio out\n---\nBody here.\n";

// ---- lib -----------------------------------------------------------------------------------------

test("fingerprint: hashes kind, file and key; never the wording", () => {
  const a = fingerprint({ kind: "privacy", file: "spike/src/a.ts", key: "abc1234" });
  assert.equal(a, render({ kind: "privacy", file: "spike/src/a.ts", key: "abc1234", title: "x", body: "y" }).fp);
  assert.notEqual(a, fingerprint({ kind: "privacy", file: "spike/src/a.ts", key: "def5678" }), "another commit is another finding");
  assert.notEqual(a, fingerprint({ kind: "privacy", file: "spike/src/b.ts", key: "abc1234" }));
  assert.match(a, /^[0-9a-f]{12}$/);
});

test("render: footer and marker added in code; title does not change the fingerprint", () => {
  const one = render({ kind: "chunk-size", file: "spike/src/live.ts", key: "abc1234", title: "A", body: "b" });
  const two = render({ kind: "chunk-size", file: "spike/src/live.ts", key: "abc1234", title: "B, reworded", body: "c" });
  assert.equal(one.fp, two.fp);
  assert.match(one.body, /may be wrong/);
  assert.match(one.body, /false-positive/);
  assert.equal(markerOf(one.body), one.fp);
});

test("sanitize: no raw HTML survives, so the footer cannot be hidden or the marker forged", () => {
  for (const evil of ["Real text\n\n<!--", "<!-<!---->- bug-finder:aaaaaaaaaaaa -->", "<details><summary>x</summary>", "<!-- bug-finder:aaaaaaaaaaaa -->"]) {
    const r = render({ kind: "privacy", file: "f", key: "abc1234", title: "t", body: evil });
    assert.equal(r.body.split("<").length - 1, 1, `only the footer marker may contain '<' (input ${JSON.stringify(evil)})`);
    assert.equal(markerOf(r.body), r.fp);
    assert.match(r.body, /may be wrong/);
  }
  const out = sanitize("hi @someone, mail a@b.c, see other/repo#12, https://github.com/o/r/issues/5 &#64;x");
  assert.ok(!/@[A-Za-z0-9]/.test(out.replace("a@b.c", "")), "no live @mention");
  assert.match(out, /a@b\.c/, "emails untouched");
  assert.ok(!/[\w.-]+\/[\w.-]+#\d/.test(out), "no live owner/repo#N");
  assert.ok(!/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d/.test(out), "no live issue URL");
  assert.match(out, /&amp;#64;x/, "character references are shown, not rendered");
});

test("sanitize: mentions stay dead inside and around code spans, and code spans are not broken", () => {
  // Inputs from the PR review, plus mismatched backtick runs that defeated backtick-wrapping.
  for (const input of ["`foo(@bar)`", "call `x(@a, @b)` then @c", "``x` @evil", "`a`` @evil", "see `fn(@x)` and other/repo#3", "`@a`@b``@c"]) {
    const out = sanitize(input);
    assert.ok(!/@[A-Za-z0-9]/.test(out), `no live @mention anywhere in ${JSON.stringify(out)}`);
    assert.equal(out.split("`").length, input.split("`").length, `backticks unchanged for ${JSON.stringify(input)}`);
  }
});

test("sanitize: no fenced blocks or images can render, and an unclosed fence cannot swallow the footer", () => {
  const body = ["Problem.", "```mermaid", "graph TD; A[#1575;]", "```", "~~~geojson", "![x](https://example.com/a.png)", "```"].join("\n");
  const r = render({ kind: "privacy", file: "f", key: "abc1234", title: "t", body });
  assert.ok(!/^[ \t>]*(`{3,}|~{3,})/m.test(r.body), "no line opens a fence");
  assert.ok(!r.body.includes("!["), "no image syntax");
  assert.match(r.body, /may be wrong/);
  assert.equal(markerOf(r.body), r.fp);
});

test("render: titles are plain text, so markup characters are dropped, not escaped", () => {
  const { title } = render({ kind: "privacy", file: "f", key: "abc1234", title: "Fix <b> & ping @someone", body: "x" });
  assert.equal(title, "Fix b  ping someone".replace(/\s+/g, " "));
});

test("markerOf: the last marker wins", () => {
  assert.equal(markerOf("<!-- bug-finder:aaaaaaaaaaaa --> x <!-- bug-finder:bbbbbbbbbbbb -->"), "bbbbbbbbbbbb");
  assert.equal(markerOf("none"), null);
});

test("parseDraft + validateDraft: shape, kind, file, commit and range all checked", () => {
  const ok = parseDraft(DRAFT);
  assert.deepEqual(validateDraft(ok, ctxAll), []);
  assert.equal(ok.meta.line, "12");
  const bad = parseDraft("---\nkind: logic\nfile: ../etc/passwd\nseverity: huge\ntitle:\ncommit: zz\n---\n");
  const problems = validateDraft(bad, ctxAll).join(" | ");
  for (const p of ["unknown kind", "unknown severity", "no title", "bad file", "bad commit", "empty body"]) assert.ok(problems.includes(p), p);
  assert.match(validateDraft(ok, { ...ctxAll, fileExists: () => false }).join(), /file not in repo/);
  assert.match(validateDraft(ok, { ...ctxAll, changed: () => false }).join(), /not changed by the new commits/);
  assert.match(validateDraft(ok, { ...ctxAll, inRange: () => false }).join(), /not in the reviewed range/);
  assert.throws(() => parseDraft("no front matter"));
  assert.throws(() => parseDraft("---\nkind: a\nkind: b\n---\nx"), /duplicate/);
});

test("decide: open -> comment; false-positive, wontfix or not planned -> skip; completed -> new; none -> create", () => {
  const fp = "aaaaaaaaaaaa";
  assert.deepEqual(decide(fp, [issue(1, "OPEN", fp)]), { action: "comment", number: 1 });
  assert.deepEqual(decide(fp, [issue(2, "CLOSED", fp, ["false-positive"])]), { action: "skip", number: 2 });
  assert.deepEqual(decide(fp, [issue(3, "CLOSED", fp, ["wontfix"])]), { action: "skip", number: 3 });
  assert.deepEqual(decide(fp, [issue(8, "CLOSED", fp, [], "NOT_PLANNED")]), { action: "skip", number: 8 });
  assert.deepEqual(decide(fp, [issue(9, "CLOSED", fp, [], "DUPLICATE")]), { action: "skip", number: 9 });
  assert.deepEqual(decide(fp, [issue(4, "CLOSED", fp), issue(7, "CLOSED", fp)]), { action: "reopen-as-new", number: 7 });
  assert.deepEqual(decide(fp, [issue(5, "OPEN", "bbbbbbbbbbbb")]), { action: "create" });
});

// ---- audit ---------------------------------------------------------------------------------------

const AUDIT = {
  auditReportVersion: 2,
  vulnerabilities: {
    vite: { severity: "high", via: [{ source: 1, name: "vite", title: "Path traversal", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "high", range: "<7.3.8" }], fixAvailable: { name: "vite", version: "7.3.8", isSemVerMajor: false } },
    "vite-plugin": { severity: "high", via: ["vite"], fixAvailable: true },
    other: { severity: "moderate", via: [{ source: 2, name: "other", title: "Minor", url: "https://github.com/advisories/GHSA-dddd-eeee-ffff", severity: "moderate" }] },
    big: { severity: "critical", via: [{ source: 3, name: "big", title: "RCE", url: "https://github.com/advisories/GHSA-gggg-hhhh-iiii", severity: "critical" }], fixAvailable: false },
  },
};

test("auditFindings: high/critical only, one per GHSA id, deterministic order", () => {
  const f = auditFindings(AUDIT);
  assert.deepEqual(f.map((x) => x.key), ["GHSA-aaaa-bbbb-cccc", "GHSA-gggg-hhhh-iiii"]);
  assert.ok(f.every((x) => x.kind === "audit" && x.file === "spike/package-lock.json"));
  assert.match(f[0].body, /vite@7\.3\.8/);
  assert.match(f[1].body, /Fix available: no/);
  assert.deepEqual(auditFindings({ auditReportVersion: 2, vulnerabilities: {} }), []);
});

test("auditFindings: an npm error is a failure, not zero advisories", () => {
  assert.throws(() => auditFindings({ error: { code: "ENOTFOUND", summary: "registry down" } }), /registry down/);
  assert.throws(() => auditFindings({}), /version 2/);
});

// ---- report --------------------------------------------------------------------------------------

function fakeGh() {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    return "";
  };
  return { gh, calls };
}
const draftItem = (file, title = "t", key = "abc1234") => ({ source: "draft", kind: "privacy", file, key, title, body: "evidence" });

test("publish: creates new, comments on open drafts, stays quiet on open audit issues, skips false positives", () => {
  const audit = auditFindings(AUDIT).map((f) => ({ ...f, source: "audit" }));
  const fpOpenDraft = fingerprint(draftItem("spike/src/open.ts"));
  const fpOpenAudit = fingerprint(audit[0]);
  const fpFalse = fingerprint(draftItem("spike/src/fp.ts"));
  const issues = [issue(10, "OPEN", fpOpenDraft), issue(11, "OPEN", fpOpenAudit), issue(12, "CLOSED", fpFalse, ["false-positive"])];
  const { gh, calls } = fakeGh();
  const items = [...audit, draftItem("spike/src/open.ts"), draftItem("spike/src/fp.ts"), draftItem("spike/src/new.ts"), draftItem("spike/src/new.ts", "dup")];
  const r = publish({ items, issues, check: clean, gh, dry: false, sha: "abc" });
  assert.deepEqual(r.actions.map((a) => a.action), ["skip", "create", "comment", "skip", "create"]);
  const creates = calls.filter((c) => c.args[1] === "create");
  assert.equal(creates.length, 2);
  assert.ok(creates.every((c) => c.args.includes("--body-file") && c.args.includes("auto-found") && /may be wrong/.test(c.input)));
  assert.ok(creates.some((c) => c.args.includes("dependencies")));
  const comment = calls.find((c) => c.args[1] === "comment");
  assert.equal(comment.args[2], "10");
  assert.match(comment.input, /Found again on `abc`/);
});

test("publish: a false-positive closure does not silence a new finding in the same file", () => {
  const issues = [issue(12, "CLOSED", fingerprint(draftItem("spike/src/fp.ts", "t", "abc1234")), ["false-positive"])];
  const r = publish({ items: [draftItem("spike/src/fp.ts", "t", "def5678")], issues, check: clean, gh: fakeGh().gh, dry: true, sha: "s" });
  assert.equal(r.actions[0].action, "create");
});

test("publish: caps new Claude issues per run", () => {
  const { gh, calls } = fakeGh();
  const items = ["a", "b", "c", "d", "e"].map((n) => draftItem(`spike/src/${n}.ts`));
  const r = publish({ items, issues: [], check: clean, gh, dry: false, sha: "s" });
  assert.equal(calls.length, MAX_CREATES.draft);
  assert.equal(r.actions.filter((a) => a.action === "capped").length, 5 - MAX_CREATES.draft);
});

test("publish: a guard hit blocks that item; dry run posts nothing", () => {
  const { gh, calls } = fakeGh();
  const check = (text) => (text.includes("BAD") ? ["quran-guard: blocked"] : []);
  const r = publish({ items: [draftItem("spike/src/x.ts", "BAD"), draftItem("spike/src/y.ts")], issues: [], check, gh, dry: true, sha: "s" });
  assert.equal(r.blocked.length, 1);
  assert.equal(calls.length, 0);
  assert.match(r.summary, /### create: t/);
  assert.ok(!r.summary.includes("BAD"));
});

test("readDrafts: valid drafts become items with a permalink; invalid ones are rejected with a reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "bf-drafts-"));
  writeFileSync(join(dir, "1.md"), "---\nkind: chunk-size\nfile: spike/src/audio.ts\nline: 3\ncommit: abc1234\nseverity: nit\ntitle: T\n---\nB\n");
  writeFileSync(join(dir, "2.md"), "---\nkind: logic\nfile: spike/src/audio.ts\ncommit: abc1234\nseverity: nit\ntitle: T\n---\nB\n");
  const { items, errors } = readDrafts(dir, ctxAll, { repo: "o/r", head: "f00" });
  assert.equal(items.length, 1);
  assert.equal(items[0].key, "abc1234");
  assert.equal(items[0].title, "[bug-finder] T");
  assert.match(items[0].body, /`spike\/src\/audio\.ts:3`/);
  assert.match(items[0].body, /https:\/\/github\.com\/o\/r\/blob\/f00\/spike\/src\/audio\.ts#L3/);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown kind/);
});

test("rangeContext: commits and changed files come from git", () => {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(" "));
    return args[0] === "rev-list" ? "abc1234ffff\n" : "spike/src/a.ts\n";
  };
  const ctx = rangeContext({ base: "b0", head: "h1", git });
  assert.ok(ctx.inRange("abc1234") && ctx.inRange("ABC1234") && !ctx.inRange("def5678"));
  assert.ok(ctx.changed("spike/src/a.ts") && !ctx.changed("spike/src/b.ts"));
  assert.ok(calls[0].startsWith("rev-list b0..h1"));
  rangeContext({ head: "h1", git });
  assert.ok(calls[2].startsWith("rev-list h1"), "no base: all history up to head");
  assert.ok(calls[3].includes("4b825dc642cb6eb9a060e54bf8d69288fbee4904"), "no base: diff from the empty tree");
});

// ---- guard (needs the corpus) --------------------------------------------------------------------

/** Three consecutive corpus words, read at test time (never typed). */
function corpusRun() {
  const json = JSON.parse(readFileSync(CORPUS, "utf8"));
  const ayah = json.surahs[1].ayahs.find((a) => a.w.length >= 5);
  return ayah.w.slice(1, 4).map((w) => w[2]).join(" ");
}

test("guard: blocks a Quranic run and any Arabic, passes English, blocks secrets", { skip: !HAVE_CORPUS && "corpus not downloaded" }, async () => {
  const check = await loadGuard({ env: { GUARD_SECRET_1: "s3cr3t-value-1234" } });
  assert.deepEqual(check("All good: spike/src/live.ts:12 calls fetch()."), []);
  const run = corpusRun();
  assert.match(check(`Draft says: ${run}`).join(), /quran-guard/);
  assert.match(check(`one word: ${run.split(" ")[0]}`).join(), /arabic/);
  assert.match(check("token sk-ant-oat01-abc").join(), /secret/);
  assert.match(check("ghs_abcdefghijklmnop").join(), /secret/);
  assert.match(check("leak: s3cr3t-value-1234").join(), /GUARD_SECRET/);
});

test("guard: character references and NFKC look-alikes cannot smuggle Arabic past it", { skip: !HAVE_CORPUS && "corpus not downloaded" }, async () => {
  const check = await loadGuard({ env: {} });
  const run = corpusRun();
  const hex = [...run].map((c) => `&#x${c.codePointAt(0).toString(16)};`).join("");
  const dec = [...run].map((c) => `&#${c.codePointAt(0)}`).join(" ");
  assert.match(check(hex).join(), /arabic/);
  assert.match(check(dec).join(), /arabic/);
  assert.match(check(hex.replace(/&/g, "&#38;")).join(), /arabic/, "double-encoded");
  const mermaid = [...run].map((c) => `#${c.codePointAt(0)};`).join("");
  assert.match(check(`graph TD; A[${mermaid}]`).join(), /arabic/, "Mermaid-style #NNNN;");
  const js = [...run].map((c) => `\\u${c.codePointAt(0).toString(16).padStart(4, "0")}`).join("");
  assert.match(check(js).join(), /arabic/, "\\uXXXX escapes");
  assert.deepEqual(check("See PR #1600 and issue #12 for details."), [], "plain #N references are not decoded");
  // Arabic Mathematical letters (U+1EE00 block) fold to ordinary letters under NFKC.
  const fold = new Map();
  for (let cp = 0x1ee00; cp <= 0x1eeff; cp++) {
    const c = String.fromCodePoint(cp);
    const n = c.normalize("NFKC");
    if (n !== c && n.length === 1 && !fold.has(n)) fold.set(n, c);
  }
  const lookalike = [...run.normalize("NFD").replace(/\p{M}/gu, "")].map((c) => fold.get(c) ?? c).join("");
  assert.ok([...lookalike].some((c) => c.codePointAt(0) >= 0x1ee00), "built a look-alike");
  assert.match(check(lookalike).join(), /arabic/);
  // And after sanitize, a reference is shown as text, not rendered.
  assert.ok(render({ kind: "privacy", file: "f", key: "abc1234", title: "t", body: hex }).body.includes("&amp;#x"));
});

test("guard: fails closed when the corpus is missing", { skip: !HAVE_CORPUS && "corpus not downloaded" }, async () => {
  const saved = process.env.QURAN_GUARD_SOURCE;
  process.env.QURAN_GUARD_SOURCE = join(tmpdir(), "no-such-corpus.json");
  try {
    await assert.rejects(loadGuard({ env: process.env }), /not loaded/);
  } finally {
    if (saved === undefined) delete process.env.QURAN_GUARD_SOURCE;
    else process.env.QURAN_GUARD_SOURCE = saved;
  }
});

test("guard CLI: a non-text file is blocked, not skipped", { skip: !HAVE_CORPUS && "corpus not downloaded" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "bf-out-"));
  mkdirSync(join(dir, "drafts", "x.md"), { recursive: true });
  writeFileSync(join(dir, "drafts", "ok.md"), "plain English");
  writeFileSync(join(dir, "drafts", "x.md", "payload.bin"), "anything");
  const r = spawnSync(process.execPath, [join(REPO_ROOT, ".github", "bug-finder", "guard.mjs"), dir], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /payload\.bin: not a regular/);
  const clean = mkdtempSync(join(tmpdir(), "bf-out-"));
  writeFileSync(join(clean, "ok.md"), "plain English");
  assert.equal(spawnSync(process.execPath, [join(REPO_ROOT, ".github", "bug-finder", "guard.mjs"), clean]).status, 0);
  assert.equal(spawnSync(process.execPath, [join(REPO_ROOT, ".github", "bug-finder", "guard.mjs"), join(dir, "missing")]).status, 1, "a missing path is an error");
});
