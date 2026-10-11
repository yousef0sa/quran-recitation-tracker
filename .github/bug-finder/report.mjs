// Turn verified drafts (Claude) and npm audit advisories (tool) into GitHub issues, without Claude.
// Every title and body is rendered here, guarded (Quran text, Arabic, secrets; fail-closed), deduped
// against all auto-found issues by fingerprint, and capped. Drafts are checked against git: the
// file must be changed, and the commit must be in the reviewed range.
//
// CLI: node .github/bug-finder/report.mjs [--drafts DIR --head SHA [--base SHA]] [--audit FILE] [--dry]
//   no --base: the range is all of history up to --head.
//   --dry prints what would be posted (Markdown, for the step summary) and posts nothing.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { auditFindings } from "./audit.mjs";
import { loadGuard, REPO_ROOT } from "./guard.mjs";
import { decide, FALSE_POSITIVE, ghRunner, gitRunner, LABEL, parseDraft, render, validateDraft } from "./lib.mjs";

/** New issues per run, per source. Claude drafts are capped harder than registry facts. */
export const MAX_CREATES = { draft: 3, audit: 5 };
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Commits and changed files of the reviewed range, from git. */
export function rangeContext({ base, head, git = gitRunner, root = REPO_ROOT }) {
  const lines = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const commits = lines(git(["rev-list", base ? `${base}..${head}` : head, "--", ".", ":!.claude"], root));
  const changed = new Set(lines(git(["diff", "--name-only", base || EMPTY_TREE, head, "--", ".", ":!.claude"], root)));
  return {
    fileExists: (f) => existsSync(join(root, f)),
    changed: (f) => changed.has(f),
    inRange: (sha) => commits.some((c) => c.startsWith(sha.toLowerCase())),
  };
}

/** Read drafts from DIR; invalid drafts are returned as errors, not posted. */
export function readDrafts(dir, ctx, { repo, head } = {}) {
  const items = [];
  const errors = [];
  if (!dir || !existsSync(dir)) return { items, errors };
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    try {
      const draft = parseDraft(readFileSync(join(dir, name), "utf8"));
      const problems = validateDraft(draft, ctx);
      if (problems.length) {
        errors.push(`${name}: ${problems.join("; ")}`);
        continue;
      }
      const { kind, file, line, severity, title, commit } = draft.meta;
      const where = line ? `${file}:${line}` : file;
      const link = repo && head ? ` ([view](https://github.com/${repo}/blob/${head}/${file}${line ? `#L${line}` : ""}))` : "";
      items.push({
        source: "draft",
        kind,
        file,
        key: commit.toLowerCase().slice(0, 7),
        title: `[bug-finder] ${title}`,
        body: `**${severity}** · ${kind} · \`${where}\`${link} · introduced in ${commit.slice(0, 7)}\n\n${draft.body}`,
      });
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  return { items, errors };
}

/**
 * Plan and (unless dry) perform the actions. Pure apart from `gh` and `check`.
 * Returns { actions: [{ action, fp, title, number? }], blocked: [reasons], summary: Markdown }.
 */
export function publish({ items, issues, check, gh, dry, sha }) {
  const seen = new Set();
  const creates = { draft: 0, audit: 0 };
  const actions = [];
  const blocked = [];
  const summary = [];
  for (const item of items) {
    const { fp, title, body } = render(item);
    if (seen.has(fp)) continue;
    seen.add(fp);
    const reasons = check(`${title}\n${body}`);
    if (reasons.length) {
      blocked.push(`${item.kind} ${item.file}: ${reasons.join("; ")}`);
      continue;
    }
    let plan = decide(fp, issues);
    // Registry advisories stay quiet while their issue is open: no weekly "found again" noise.
    if (plan.action === "comment" && item.source === "audit") plan = { action: "skip", number: plan.number };
    if ((plan.action === "create" || plan.action === "reopen-as-new") && creates[item.source] >= MAX_CREATES[item.source]) {
      plan = { action: "capped" };
    }
    if (plan.action === "create" || plan.action === "reopen-as-new") creates[item.source]++;
    actions.push({ ...plan, fp, title });

    const labels = ["--label", LABEL, "--label", item.source === "audit" ? "dependencies" : "bug"];
    const fullBody = plan.action === "reopen-as-new" ? `Came back after #${plan.number} was closed.\n\n${body}` : body;
    if (dry) {
      summary.push(`### ${plan.action}${plan.number ? ` (#${plan.number})` : ""}: ${title}`, "", fullBody, "");
      continue;
    }
    if (plan.action === "create" || plan.action === "reopen-as-new") {
      gh(["issue", "create", "--title", title, "--body-file", "-", ...labels], fullBody);
    } else if (plan.action === "comment") {
      gh(["issue", "comment", String(plan.number), "--body-file", "-"], `Found again on \`${sha}\`.\n\n${body}`);
    }
  }
  return { actions, blocked, summary: summary.join("\n") };
}

/** Create missing labels. Only our own two are (re)styled; existing repo labels are left alone. */
export function ensureLabels(gh) {
  const existing = new Set(JSON.parse(gh(["label", "list", "--limit", "500", "--json", "name"])).map((l) => l.name));
  const ours = [
    [LABEL, "5319e7", "Opened by the weekly bug finder"],
    [FALSE_POSITIVE, "c5def5", "Bug finder was wrong (counts towards its false-positive rate)"],
  ];
  for (const [name, color, description] of ours) gh(["label", "create", name, "--force", "--color", color, "--description", description]);
  for (const name of ["bug", "dependencies"]) if (!existing.has(name)) gh(["label", "create", name]);
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      drafts: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      audit: { type: "string" },
      dry: { type: "boolean", default: false },
    },
  });
  if (values.drafts && !values.head) throw new Error("--drafts needs --head");
  const check = await loadGuard(); // throws (exit 1) if the corpus cannot be verified
  const ctx = values.drafts ? rangeContext({ base: values.base, head: values.head }) : null;
  const { items: drafts, errors } = readDrafts(values.drafts, ctx, { repo: process.env.GITHUB_REPOSITORY, head: values.head });
  const audit = values.audit ? auditFindings(JSON.parse(readFileSync(values.audit, "utf8"))).map((f) => ({ ...f, source: "audit" })) : [];
  // A rejected draft is the deterministic check doing its job: warn, do not fail the run.
  for (const e of errors) console.log(`::warning::bug-finder draft rejected: ${e.replace(/[\r\n]/g, " ")}`);

  const gh = ghRunner;
  const issues = JSON.parse(gh(["issue", "list", "--label", LABEL, "--state", "all", "--limit", "1000", "--json", "number,state,stateReason,labels,body"]));
  if (!values.dry) ensureLabels(gh);
  const result = publish({ items: [...audit, ...drafts], issues, check, gh, dry: values.dry, sha: values.head ?? process.env.GITHUB_SHA ?? "HEAD" });

  for (const b of result.blocked) console.error(`report: BLOCKED by guard: ${b}`);
  for (const a of result.actions) console.error(`report: ${a.action}${a.number ? ` #${a.number}` : ""} [${a.fp}] ${a.title}`);
  if (values.dry && result.summary) process.stdout.write(`${result.summary}\n`);
  return result.blocked.length ? 1 : 0; // a guard block is fatal: never post around it silently
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
