import { pool, query } from '../db/client.js';
import { LEGACY_CAPABILITIES } from '../db/repositories/handoffTokens.js';

/**
 * C-5 backfill: grant every EXISTING machine token exactly the authority it effectively
 * had before this phase — { handoff, scheduling.read, scheduling.write } — so no running
 * workflow changes behavior. Deliberately does NOT grant crm.read / crm.write: the CRM
 * API is new; legacy tokens must not silently gain access to it (the safe default).
 *
 * ZERO-BREAKAGE: the migration ADDs the capabilities column with this exact triple as
 * the add-time default, so existing tokens already carry it the instant the migration
 * runs (no denial window). This script is the IDEMPOTENT confirm: it only touches tokens
 * whose capabilities are still EMPTY (never clobbering a token an admin has since
 * narrowed), so a second run — and a run after the migration already seeded them — sets
 * nothing new. It prints per-tenant counts either way.
 *
 * Run: npm run backfill:token-capabilities
 */
export interface BackfillLine {
  tenantId: string;
  total: number;
  withLegacyTriple: number;
  updated: number;
}
export interface BackfillResult {
  perTenant: BackfillLine[];
  totalTokens: number;
  totalUpdated: number;
}

/** The idempotent backfill core (exported so an integration test can assert it): set the
 *  legacy triple ONLY on tokens that still have NO capabilities. Never clobbers a
 *  configured/narrowed token. Returns per-tenant + total counts. */
export async function runBackfill(): Promise<BackfillResult> {
  const tenants = (
    await query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM handoff_tokens ORDER BY tenant_id`)
  ).rows;

  const perTenant: BackfillLine[] = [];
  let totalTokens = 0;
  let totalUpdated = 0;

  for (const t of tenants) {
    const updated = await query<{ id: string }>(
      `UPDATE handoff_tokens SET capabilities = $2::text[]
        WHERE tenant_id = $1 AND cardinality(capabilities) = 0
        RETURNING id`,
      [t.tenant_id, LEGACY_CAPABILITIES],
    );
    const counts = (
      await query<{ total: number; legacy: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE capabilities @> $2::text[] AND capabilities <@ $2::text[])::int AS legacy
           FROM handoff_tokens WHERE tenant_id = $1`,
        [t.tenant_id, LEGACY_CAPABILITIES],
      )
    ).rows[0];
    const n = updated.rowCount ?? 0;
    totalTokens += counts.total;
    totalUpdated += n;
    perTenant.push({ tenantId: t.tenant_id, total: counts.total, withLegacyTriple: counts.legacy, updated: n });
  }
  return { perTenant, totalTokens, totalUpdated };
}

async function main(): Promise<void> {
  const r = await runBackfill();
  console.log('=== C-5 token-capability backfill ===');
  console.log(`legacy grant = { ${LEGACY_CAPABILITIES.join(', ')} }  (NO crm.*)`);
  console.log(
    r.perTenant
      .map((l) => `  tenant ${l.tenantId.slice(0, 8)}…  tokens=${l.total}  with-legacy-triple=${l.withLegacyTriple}  updated-this-run=${l.updated}`)
      .join('\n') || '  (no tokens)',
  );
  console.log(`TOTAL tokens=${r.totalTokens}  updated-this-run=${r.totalUpdated}`);
  console.log('Idempotent: only capability-less tokens are set; re-running sets nothing new.');
}

// Only run as a script (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err);
      await pool.end();
      process.exit(1);
    });
}
