import { pool } from '../db/client.js';
import { backfillOccupancy } from '../occupancy/backfill.js';

/**
 * JP-8 §1 — backfill the staff-occupancy rollup for all existing history + the next 30 days.
 * DRY RUN by default (prints the plan, writes nothing). Re-run with --apply to write. Idempotent.
 *
 *   npm run occupancy:backfill                         # dry run, all clients
 *   npm run occupancy:backfill -- --apply              # write
 *   npm run occupancy:backfill -- --tenant=<uuid> [--client=<uuid>] [--apply]
 */
function arg(name: string): string | undefined {
  const pfx = `--${name}`;
  const hit = process.argv.find((a) => a === pfx || a.startsWith(`${pfx}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
}

async function main(): Promise<void> {
  const apply = arg('apply') !== undefined;
  const tenantId = arg('tenant') || undefined;
  const clientId = arg('client') || undefined;

  const s = await backfillOccupancy({ apply, tenantId, clientId });
  const verb = apply ? 'DONE' : 'to do (DRY RUN — nothing written)';
  console.log(`\nOccupancy backfill — ${verb}`);
  if (tenantId) console.log(`  tenant:         ${tenantId}`);
  if (clientId) console.log(`  client:         ${clientId}`);
  console.log(`  professionals:  ${s.professionals}`);
  console.log(`  days planned:   ${s.daysPlanned}`);
  console.log(`  days computed:  ${s.daysComputed}`);
  if (!apply) console.log('\nRe-run with --apply to write.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
