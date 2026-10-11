// Shared helpers for the weekly bug finder (.github/workflows/bug-finder.yml).
// No dependencies. Everything here is deterministic: Claude writes drafts, this code decides
// what they are called, whether they are new, and what goes around them.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

/** Kinds Claude may report: each is a CLAUDE.md rule. */
export const RULE_KINDS = ["privacy", "forbidden-file", "chunk-size", "ruling-wording", "notice-missing"];
export const SEVERITIES = ["important", "nit"];

export const LABEL = "auto-found";
export const FALSE_POSITIVE = "false-positive";
const SKIP_LABELS = new Set([FALSE_POSITIVE, "wontfix"]);
const MARKER_RE = /<!-- bug-finder:([0-9a-f]{12}) -->/g;

/**
 * Same problem -> same fingerprint every week. Hashes (kind, file, key) and never the wording:
 * key is the introducing commit (7 hex) for rule kinds, the GHSA id for audit findings. So closing
 * one false positive does not silence later findings of that kind in that file.
 */
export function fingerprint({ kind, file, key }) {
  return createHash("sha1").update([kind, file, key].join("|")).digest("hex").slice(0, 12);
}

/** Parse a draft: a `---` front-matter block of `key: value` lines, then the Markdown body. */
export function parseDraft(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("draft has no front matter");
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    if (kv[1] in meta) throw new Error(`duplicate front-matter key "${kv[1]}"`);
    meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

/**
 * Problems with a parsed draft (empty array = valid). `ctx` checks the claim against git, not
 * against Claude: fileExists(f), changed(f) = touched by the new commits, inRange(sha) = one of them.
 */
export function validateDraft({ meta, body }, ctx) {
  const problems = [];
  if (!RULE_KINDS.includes(meta.kind)) problems.push(`unknown kind "${meta.kind}"`);
  if (!SEVERITIES.includes(meta.severity)) problems.push(`unknown severity "${meta.severity}"`);
  if (!meta.title) problems.push("no title");
  if (!meta.file || meta.file.startsWith("/") || meta.file.split(/[\\/]/).includes("..")) problems.push(`bad file "${meta.file}"`);
  else if (!ctx.fileExists(meta.file)) problems.push(`file not in repo: ${meta.file}`);
  else if (!ctx.changed(meta.file)) problems.push(`file not changed by the new commits: ${meta.file}`);
  if (meta.line !== undefined && !/^\d+$/.test(meta.line)) problems.push(`bad line "${meta.line}"`);
  if (!/^[0-9a-f]{7,40}$/.test(meta.commit ?? "")) problems.push(`bad commit "${meta.commit}"`);
  else if (!ctx.inRange(meta.commit)) problems.push(`commit not in the reviewed range: ${meta.commit}`);
  if (!body) problems.push("empty body");
  return problems;
}

/**
 * Make Claude/tool text inert before posting, so what GitHub renders is what the guard checked:
 * - no raw HTML and no character references (`&` escaped first, then `<`), so nothing can hide the
 *   footer or forge the marker;
 * - no fenced code blocks (fence openers are escaped): mermaid, geojson and similar blocks decode
 *   their own escapes into characters, and an unclosed fence would swallow the footer;
 * - no images (`![` escaped): a picture can show text the guard never saw;
 * - no @-pings, and no owner/repo#N or issue/PR URLs, which add "mentioned this" events elsewhere.
 * Inline code stays, but `&` and `<` inside it show escaped: an accepted cost.
 */
export function sanitize(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/^([ \t>]*)(`{3,}|~{3,})/gm, "$1\\$2")
    .replace(/!\[/g, "!\\[")
    .replace(/(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]*)/g, "$1`@$2`")
    .replace(/(^|[^\w`/])([\w.-]+\/[\w.-]+#\d+)/g, "$1`$2`")
    .replace(/(^|[^`])(https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+\S*)/g, "$1`$2`");
}

export function footer(fp) {
  return [
    "",
    "---",
    "_Found automatically by the weekly bug finder (`.github/workflows/bug-finder.yml`). It may be wrong: if it is, close this issue with the label `false-positive`._",
    `<!-- bug-finder:${fp} -->`,
  ].join("\n");
}

/** Final title and body for an item { kind, file, key, title, body }. */
export function render(item) {
  const fp = fingerprint(item);
  // Titles are plain text on GitHub (no Markdown, no entities): drop the characters instead.
  const title = item.title.replace(/[<>&]/g, "").replace(/@(?=\w)/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  const body = sanitize(item.body).slice(0, 60000) + "\n" + footer(fp);
  return { fp, title, body };
}

/** The footer's marker: the last one in the body (anything earlier is not ours). */
export function markerOf(body) {
  const all = [...(body ?? "").matchAll(MARKER_RE)];
  return all.length ? all[all.length - 1][1] : null;
}

/**
 * What to do with fingerprint `fp`, given existing auto-found issues (any state):
 *   { action: "create" } | { action: "comment", number } | { action: "skip", number }
 *   | { action: "reopen-as-new", number }  (closed as completed: it came back)
 */
export function decide(fp, issues) {
  const matches = issues.filter((i) => markerOf(i.body) === fp);
  const open = matches.find((i) => i.state === "OPEN");
  if (open) return { action: "comment", number: open.number };
  const skipped = matches.find((i) => ["NOT_PLANNED", "DUPLICATE"].includes(i.stateReason) || (i.labels ?? []).some((l) => SKIP_LABELS.has(l.name)));
  if (skipped) return { action: "skip", number: skipped.number };
  if (matches.length > 0) return { action: "reopen-as-new", number: Math.max(...matches.map((i) => i.number)) };
  return { action: "create" };
}

/** gh runner: argument array only, never a shell string. Injected in tests. */
export function ghRunner(args, input) {
  return execFileSync("gh", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
}

/** git runner, same rules. `cwd` matters: pathspecs like `.` are relative to it. */
export function gitRunner(args, cwd) {
  return execFileSync("git", args, { encoding: "utf8", cwd, maxBuffer: 64 * 1024 * 1024 });
}
