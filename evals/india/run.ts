/** CLI: `npx tsx evals/india/run.ts [case-id…] [--json]`. Exits 1 on any failure. */
import { runIndiaEvals } from "./harness";

const args = process.argv.slice(2);
const json = args.includes("--json");
const results = runIndiaEvals(args.filter((a) => !a.startsWith("--")));
if (json) console.log(JSON.stringify(results, null, 2));
else for (const r of results) {
  console.log(`${r.status === "pass" ? "PASS" : "FAIL"}  ${r.id} — ${r.title}`);
  for (const ch of r.checks.filter((x) => !x.ok)) console.log(`      ✗ ${ch.name}${ch.actual !== undefined ? ` (actual: ${ch.actual})` : ""}`);
}
process.exitCode = results.every((r) => r.status === "pass") ? 0 : 1;
