/**
 * PL-1 §3 — sales-pipeline backfill, DRY-RUN BY DEFAULT (same pattern as attribution:backfill).
 *
 * Builds opportunities for contacts that have none yet, by replaying each contact's history
 * (ad touches, first organic message, appointments + their statuses) from the client's
 * attribution_settings.tracking_started_at onward through the §2 rules, including auto-lost.
 * Idempotent: a second run (and any sale live §2 already created) is left untouched.
 *
 * Usage (worker console; read-only unless --apply):
 *   npm run pipeline:backfill                 # DRY RUN — prints what WOULD be created, writes nothing
 *   npm run pipeline:backfill -- --apply      # writes (idempotent)
 *   npm run pipeline:backfill -- --tenant=<uuid> [--apply]
 */
import { backfillPipeline } from '../pipeline/backfill.js';
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

  const s = await backfillPipeline({ apply, tenantId });
  const verb = apply ? 'CREATED' : 'to create (DRY RUN — nothing written)';

  console.log('=== PL-1 sales-pipeline backfill ===');
  console.log(tenantId ? `scope: tenant ${tenantId}` : 'scope: ALL tenants');
  console.log(`clients processed:     ${s.clientsProcessed}`);
  console.log(`contacts scanned:      ${s.contactsScanned}`);
  console.log(`opportunities ${verb}: ${s.opportunitiesCreated}`);
  console.log(`  of which auto-lost (no_respondio): ${s.autoLost}`);
  console.log('by stage:  ' + JSON.stringify(s.byStage));
  console.log('by status: ' + JSON.stringify(s.byStatus));
  console.log('by origin: ' + JSON.stringify(s.byOrigin));
  console.log('by ad (driving origin touch; test ads flagged):');
  if (s.byAd.length === 0) console.log('  (none)');
  for (const a of s.byAd) console.log(`  ${a.isTest ? '[TEST] ' : ''}${a.adExternalId}: ${a.count}`);
  if (!apply) console.log('\nRe-run with  --apply  to write. Idempotent: a second --apply is a no-op.');
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    return pool.end().finally(() => process.exit(1));
  });
