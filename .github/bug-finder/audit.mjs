// npm audit --json (v2) -> one finding per high/critical advisory, keyed by GHSA id.
// Deterministic: no Claude. The advisory is a fact from the registry, so it is filed as is.

const SERIOUS = new Set(["high", "critical"]);
const LOCKFILE = "spike/package-lock.json";

/** Returns [{ kind: "audit", file, key, title, body }]; throws if npm reported an error. */
export function auditFindings(report) {
  if (report?.error) throw new Error(`npm audit failed: ${report.error.summary ?? report.error.code ?? "unknown error"}`);
  if (report?.auditReportVersion !== 2) throw new Error("expected npm audit report version 2");
  const byId = new Map();
  for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || !SERIOUS.has(via.severity)) continue;
      const id = /GHSA-[\w-]+/.exec(via.url ?? "")?.[0] ?? `npm-${via.source}`;
      const entry = byId.get(id) ?? { id, advisory: via, packages: new Set(), fix: vuln.fixAvailable };
      entry.packages.add(pkg);
      byId.set(id, entry);
    }
  }
  return [...byId.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, advisory, packages, fix }) => ({
      kind: "audit",
      file: LOCKFILE,
      key: id,
      title: `npm audit (${advisory.severity}): ${advisory.name}: ${advisory.title ?? id}`,
      body: [
        `**${advisory.severity}** advisory [${id}](${advisory.url ?? "https://github.com/advisories"}) in \`${advisory.name}\` (${advisory.range ?? "range unknown"}).`,
        "",
        `Affected packages in \`${LOCKFILE}\`: ${[...packages].map((p) => `\`${p}\``).join(", ")}.`,
        "",
        `Fix available: ${fix === false ? "no" : fix === true ? "yes (`npm audit fix`)" : fix?.name ? `yes, \`${fix.name}@${fix.version}\`${fix.isSemVerMajor ? " (major version)" : ""}` : "unknown"}.`,
        "",
        "Evidence: `cd spike && npm audit --audit-level=high`",
      ].join("\n"),
    }));
}
