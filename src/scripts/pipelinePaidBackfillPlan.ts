/**
 * JP-6 — bring every recorded payment's opportunity to `paid`, DRY-RUN BY DEFAULT.
 *
 * Heals the pre-JP-6 gap: payments were recorded but the sale never advanced (no opportunity on the
 * appointment, or the opportunity stuck before `attended`). Runs the same engine heal the live hook
 * now uses, so a dry run and the live path agree. Idempotent.
 *
 * Usage (worker console; read-only unless --apply):
 *   npm run pipeline:backfill-paid                # DRY RUN — prints what WOULD change, writes nothing
 *   npm run pipeline:backfill-paid -- --apply     # writes (idempotent)
 *   npm run pipeline:backfill-paid -- --tenant=<uuid> [--apply]
 */
import { backfillPaidOpportunities } from '../pipeline/backfillPaid.js';
import { pool } from '../db/client.js';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
}

async function main(): Promise<void> {
  const apply = arg('apply') !== undefined;
  const tenantId = arg('tenant') || undefined;

  const s = await backfillPaidOpportunities({ apply, tenantId });
  const verb = apply ? 'DONE' : 'to do (DRY RUN — nothing written)';

  console.log('=== JP-6 payments → paid backfill ===');
  console.log(tenantId ? `scope: tenant ${tenantId}` : 'scope: ALL tenants');
  console.log(`recorded payments scanned:     ${s.paymentsScanned}`);
  console.log(`already at paid:               ${s.alreadyPaid}`);
  console.log(`opportunities advanced ${verb}: ${s.advancedToPaid}`);
  console.log(`opportunities created ${verb}:  ${s.opportunitiesCreated}`);
  console.log(`skipped (guest, no contact):   ${s.skippedNoContact}`);
  if (s.failed) console.log(`FAILED (counted, not thrown):  ${s.failed}`);
  if (!apply) console.log('\nRe-run with --apply to write.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
