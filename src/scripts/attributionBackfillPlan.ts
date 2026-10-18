/**
 * AT-1 §4 — attribution backfill, DRY-RUN BY DEFAULT (same pattern as identity:contain).
 *
 * Processes every stored inbound user message that carried referral_* keys (registering the ad
 * + writing the touch where one is missing) and classifies every not-yet-classified contact's
 * origin from FACTS (first-message referral → meta_ad/meta_post; booking page → booking_page;
 * no referral at/after the client's tracking_started_at → organic_whatsapp; otherwise unknown).
 * Idempotent: a second run is a no-op. Test ads (external_id starting "TEST-") are counted
 * SEPARATELY and never counted in a metric by default.
 *
 * Usage (worker console; read-only unless --apply):
 *   npm run attribution:backfill                 # DRY RUN — prints what WOULD change, writes nothing
 *   npm run attribution:backfill -- --apply      # writes (idempotent)
 *   npm run attribution:backfill -- --tenant=<uuid> [--apply]
 */
import { backfillAttribution } from '../attribution/backfill.js';
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

  const s = await backfillAttribution({ tenantId, apply });
  const verb = apply ? 'written' : 'to write';

  console.log('=== AT-1 attribution backfill ===');
  console.log(tenantId ? `scope: tenant ${tenantId}` : 'scope: ALL tenants');
  console.log(`referral messages with a linked contact: ${s.referralMessagesLinked}`);
  console.log(`  touches ${verb}:            ${s.touchesWritten}`);
  console.log(`  touches already present:   ${s.touchesAlreadyPresent}`);
  console.log(`  invalid referrals (no touch): ${s.invalidReferrals}`);
  console.log(`  referral msgs with NO contact (skipped): ${s.referralMessagesNoContact}`);

  console.log(`\ncontacts origin ${apply ? 'set' : 'to set'}: ${s.originsSet}`);
  for (const [k, v] of Object.entries(s.byOrigin).sort()) console.log(`    ${k.padEnd(18)} ${v}`);

  if (s.byAd.length) {
    console.log(`\nper ad (new touches ${verb}; TEST ads flagged):`);
    for (const a of s.byAd.sort((x, y) => y.touches - x.touches)) {
      console.log(`    ${a.external_id} [${a.source_type}]${a.is_test ? ' (TEST)' : ''}: ${a.touches}`);
    }
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to write the above.');
    if (s.touchesWritten === 0 && s.originsSet === 0) console.log('Nothing to backfill.');
  } else {
    console.log('\nAPPLIED.');
  }
}

main()
  .catch((err) => {
    console.error('attribution:backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
