// Print a Claude run's numbers as GITHUB_OUTPUT lines (cost=, turns=, denied=). Numbers only:
// the execution file holds the whole transcript, which never goes to the summary.
// CLI: node .github/bug-finder/cost.mjs <execution_file>

import { readFileSync } from "node:fs";

try {
  const messages = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const r = messages.filter((m) => m.type === "result").pop() ?? {};
  console.log(`cost=${(r.total_cost_usd ?? 0).toFixed(2)}`);
  console.log(`turns=${Number(r.num_turns) || 0}`);
  console.log(`denied=${(r.permission_denials ?? []).length}`);
} catch {
  console.log("cost=0\nturns=0\ndenied=0");
}
