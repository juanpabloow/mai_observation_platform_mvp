import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';
import { utcToZonedParts, zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { backfillOccupancy } from '../../src/occupancy/backfill.js';

/** JP-8 §5 — the backfill: dry-run reports the same plan it would apply and writes nothing; apply
 *  writes the rollup; a second apply is a no-op (idempotent, identical rows). */
const TZ = 'America/Bogota';
const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const pad = (n: number) => String(n).padStart(2, '0');
const dayAt = (day: string, h: number): Date => { const [y, m, d] = day.split('-').map(Number); return zonedPartsToUtc(y, m, d, h, 0, TZ); };
/** A recent OPEN local day (Mon–Sat), within the backfill's past window. */
function recentOpenDay(): string {
  const t = utcToZonedParts(new Date(), TZ);
  let day = `${t.year}-${pad(t.month)}-${pad(t.day)}`;
  for (let i = 0; i < 7; i++) {
    if (utcToZonedParts(dayAt(day, 12), TZ).weekday !== 'sun') return day;
    const [y, m, d] = day.split('-').map(Number);
    const u = new Date(Date.UTC(y, m - 1, d - 1, 12));
    day = `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}`;
  }
  return day;
}

test('dry-run reports the plan + writes nothing; apply writes; second apply is a no-op', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const day = recentOpenDay();
  const end = new Date(dayAt(day, 10).getTime() + 60 * 60000);
  await query(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id, start_at, service_end_at, blocked_from, blocked_until, service_name_snapshot, duration_min_snapshot, price_snapshot, buffer_before_min_snapshot, buffer_after_min_snapshot, status, origin, created_by_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$7,'Haircut',60,'50000',0,0,'completed','internal','system')`,
    [s.tenantId, s.clientId, s.siteId, s.staffA, s.serviceHaircut, dayAt(day, 10), end],
  );

  const scope = { tenantId: s.tenantId, clientId: s.clientId };
  const dry = await backfillOccupancy({ apply: false, ...scope });
  assert.ok(dry.professionals >= 2, 'both bookable professionals of the client');
  assert.ok(dry.daysPlanned > 0, 'a plan was produced');
  assert.equal(dry.daysComputed, 0, 'dry run computes nothing');
  const countAfterDry = await query<{ n: string }>(`SELECT count(*)::text AS n FROM staff_day_occupancy WHERE tenant_id=$1`, [s.tenantId]);
  assert.equal(Number(countAfterDry.rows[0].n), 0, 'dry run wrote nothing');

  const applied = await backfillOccupancy({ apply: true, ...scope });
  assert.equal(applied.daysPlanned, dry.daysPlanned, 'apply covers exactly the plan the dry-run reported');
  assert.equal(applied.daysComputed, applied.daysPlanned, 'apply computed every planned day');
  const rows1 = await query(`SELECT staff_id, to_char(day,'YYYY-MM-DD') AS day, available_min, booked_min, attended_min, collected_amount::text AS collected FROM staff_day_occupancy WHERE tenant_id=$1 ORDER BY staff_id, day`, [s.tenantId]);
  assert.ok(rows1.rows.length > 0, 'apply wrote rollup rows');
  const dayRow = rows1.rows.find((r: Record<string, unknown>) => r.staff_id === s.staffA && r.day === day) as { booked_min: number } | undefined;
  assert.equal(dayRow?.booked_min, 60, 'the seeded appointment day is booked');

  const again = await backfillOccupancy({ apply: true, ...scope });
  assert.equal(again.daysPlanned, applied.daysPlanned, 'the plan is stable');
  const rows2 = await query(`SELECT staff_id, to_char(day,'YYYY-MM-DD') AS day, available_min, booked_min, attended_min, collected_amount::text AS collected FROM staff_day_occupancy WHERE tenant_id=$1 ORDER BY staff_id, day`, [s.tenantId]);
  assert.deepEqual(rows2.rows, rows1.rows, 'a second apply changes nothing (idempotent)');
});
