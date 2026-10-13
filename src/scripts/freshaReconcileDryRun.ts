/**
 * Fresha → M_AI reconciliation, DRY RUN. Reads three JSON files and prints the plan:
 *
 *   tsx src/scripts/freshaReconcileDryRun.ts \
 *     --target target.json   { clientId, siteId, freshaLocationId, days: ["2026-10-12"] }
 *     --fresha fresha.json   FreshaSnapshot (an export from Fresha, prepared by a person)
 *     --mai mai.json         MaiSnapshot (a read-only export of ONE site)
 *     --mapping mapping.json ReconcileMapping (ids confirmed by a person)
 *
 * It opens no database connection, calls no external service and writes nothing but
 * stdout. Exit code 2 when the inputs fail the isolation/identity checks, 0 otherwise.
 * See src/scheduling/reconcile/freshaPlan.ts for the rules.
 */
import { readFileSync } from "node:fs";
import { planFreshaReconciliation } from "../scheduling/reconcile/freshaPlan.js";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) {
    console.error(`missing --${name} <file.json>`);
    process.exit(64);
  }
  return v;
}

const read = (name: string) => JSON.parse(readFileSync(arg(name), "utf8"));

const plan = planFreshaReconciliation({
  target: read("target"),
  fresha: read("fresha"),
  mai: read("mai"),
  mapping: read("mapping"),
});

process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
process.exit(plan.errors.length > 0 ? 2 : 0);
