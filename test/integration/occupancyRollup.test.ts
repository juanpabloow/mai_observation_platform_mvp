import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';
import { utcToZonedParts, zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { recomputeStaffDays } from '../../src/occupancy/compute.js';
import { runOccupancyRollupOnce } from '../../src/occupancy/rollup.js';
import {
  dirtyCount,
  markDirtyExceptionRange,
  markDirtyForAppointment,
  type StaffDayOccupancyRow,
} from '../../src/db/repositories/scheduling/occupancy.js';

/**
 * JP-8 §1 — the rollup: capacity from the SAME engine (inherit / own hours / breaks / time off),
 * the status mapping, the fuera-de-horario clip, service-only occupied minutes, commission-free
 * collected money, and the dirty-mark → drain → recompute loop (idempotent, convergent).
 */
const TZ = 'America/Bogota';
const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const pad = (n: number) => String(n).padStart(2, '0');
const dayStr = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const u = new Date(Date.UTC(y, m - 1, d + delta, 12));
  return dayStr(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate());
}
/** A local day whose Bogotá weekday is Monday–Saturday (the site is closed on Sunday). */
function anOpenDay(): string {
  let day = '2026-06-01';
  for (let i = 0; i < 7; i++) {
    const [y, m, d] = day.split('-').map(Number);
    const wk = utcToZonedParts(zonedPartsToUtc(y, m, d, 12, 0, TZ), TZ).weekday;
    if (wk !== 'sun') return day;
    day = shiftDay(day, 1);
  }
  return day;
}
const localAt = (day: string, h: number, min = 0): Date => {
  const [y, m, d] = day.split('-').map(Number);
  return zonedPartsToUtc(y, m, d, h, min, TZ);
};

async function seedAppt(
  s: Awaited<ReturnType<typeof seedScenario>>,
  o: { staffId: string; startAt: Date; durationMin: number; status: string },
): Promise<string> {
  const end = new Date(o.startAt.getTime() + o.durationMin * 60000);
  const r = await query<{ id: string }>(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id,
        start_at, service_end_at, blocked_from, blocked_until,
        service_name_snapshot, duration_min_snapshot, price_snapshot, buffer_before_min_snapshot, buffer_after_min_snapshot,
        status, origin, created_by_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$7,'Haircut',$8,'50000',10,10,$9,'internal','system') RETURNING id`,
    [s.tenantId, s.clientId, s.siteId, o.staffId, s.serviceHaircut, o.startAt, end, o.durationMin, o.status],
  );
  return r.rows[0].id;
}
/** A recorded payment with ONE service line (line_total + a commission snapshot that must be ignored). */
async function seedPayment(s: Awaited<ReturnType<typeof seedScenario>>, appointmentId: string, staffId: string, lineTotal: string, commission: string): Promise<void> {
  const p = await query<{ id: string }>(
    `INSERT INTO payments (tenant_id, client_id, appointment_id, method_key, total, recorded_by) VALUES ($1,$2,$3,'efectivo',$4,'seed') RETURNING id`,
    [s.tenantId, s.clientId, appointmentId, lineTotal],
  );
  await query(
    `INSERT INTO payment_lines (tenant_id, client_id, payment_id, kind, service_id, staff_id, description, quantity, unit_list_price, unit_charged, line_total, commission_pct, commission_amount)
     VALUES ($1,$2,$3,'service',$4,$5,'Haircut',1,$6,$6,$6,20,$7)`,
    [s.tenantId, s.clientId, p.rows[0].id, s.serviceHaircut, staffId, lineTotal, commission],
  );
}
const rowOf = async (s: Awaited<ReturnType<typeof seedScenario>>, staffId: string, day: string): Promise<StaffDayOccupancyRow | null> => {
  const r = await query<StaffDayOccupancyRow>(
    `SELECT tenant_id, client_id, site_id, staff_id, to_char(day,'YYYY-MM-DD') AS day, available_min, booked_min, attended_min, no_show_min, outside_hours_min, collected_amount::text AS collected_amount
       FROM staff_day_occupancy WHERE tenant_id=$1 AND staff_id=$2 AND day=$3`,
    [s.tenantId, staffId, day],
  );
  return r.rows[0] ?? null;
};

test('recompute: inherited 9–18 capacity, status mapping, outside-hours clip, commission-free money', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const day = anOpenDay();
  // completed 10:00–11:00 (60), no_show 12:00–12:30 (30), scheduled 17:30–18:30 (straddles close, 60),
  // cancelled 14:00–15:00 (ignored). Buffers are 10/10 but must NOT count.
  const done = await seedAppt(s, { staffId: s.staffA, startAt: localAt(day, 10), durationMin: 60, status: 'completed' });
  await seedAppt(s, { staffId: s.staffA, startAt: localAt(day, 12), durationMin: 30, status: 'no_show' });
  await seedAppt(s, { staffId: s.staffA, startAt: localAt(day, 17, 30), durationMin: 60, status: 'scheduled' });
  await seedAppt(s, { staffId: s.staffA, startAt: localAt(day, 14), durationMin: 60, status: 'cancelled' });
  await seedPayment(s, done, s.staffA, '50000', '10000'); // collected 50000; commission 10000 must be excluded

  await recomputeStaffDays(s.tenantId, s.clientId, s.siteId, s.staffA, [day]);
  const row = await rowOf(s, s.staffA, day);
  assert.ok(row, 'a row was written');
  assert.equal(row!.available_min, 540, '9h inherited from the site = 540');
  assert.equal(row!.booked_min, 60 + 30 + 30, 'reservada: 60 + 30 + 30-in (last 30 clipped off), cancelled excluded');
  assert.equal(row!.attended_min, 60, 'atendida = the completed one');
  assert.equal(row!.no_show_min, 30);
  assert.equal(row!.outside_hours_min, 30, 'the 30 min after 18:00 is fuera de horario');
  assert.equal(Number(row!.collected_amount), 50000, 'collected = service line_total, NEVER minus/plus commission');
});

test('recompute: breaks and time off reduce capacity exactly like the engine; own hours override inherit', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const day = anOpenDay();

  // A usual 1h lunch break (schedule_series kind=break) on this weekday for staffA.
  const wk = utcToZonedParts(localAt(day, 12), TZ).weekday;
  const WD: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  await query(
    `INSERT INTO schedule_series (tenant_id, client_id, site_id, staff_id, kind, weekdays, start_min, end_min)
     VALUES ($1,$2,$3,$4,'break', ARRAY[$5]::smallint[], 720, 780)`,
    [s.tenantId, s.clientId, s.siteId, s.staffA, WD[wk]],
  );
  // A 2h time off (schedule_exceptions) 15:00–17:00 for staffA.
  await query(
    `INSERT INTO schedule_exceptions (tenant_id, site_id, staff_id, starts_at, ends_at, type) VALUES ($1,$2,$3,$4,$5,'blocked')`,
    [s.tenantId, s.siteId, s.staffA, localAt(day, 15), localAt(day, 17)],
  );
  await recomputeStaffDays(s.tenantId, s.clientId, s.siteId, s.staffA, [day]);
  // 540 − 60 (lunch) − 120 (time off) = 360.
  assert.equal((await rowOf(s, s.staffA, day))!.available_min, 360, 'break + time off subtracted from capacity');

  // staffB gets OWN hours 09:00–13:00 only (overrides the inherited 9–18) → 240.
  await query(`UPDATE staff SET working_hours = $3::jsonb WHERE tenant_id=$1 AND id=$2`, [
    s.tenantId,
    s.staffB,
    JSON.stringify({ mon: [{ start: '09:00', end: '13:00' }], tue: [{ start: '09:00', end: '13:00' }], wed: [{ start: '09:00', end: '13:00' }], thu: [{ start: '09:00', end: '13:00' }], fri: [{ start: '09:00', end: '13:00' }], sat: [{ start: '09:00', end: '13:00' }] }),
  ]);
  await recomputeStaffDays(s.tenantId, s.clientId, s.siteId, s.staffB, [day]);
  assert.equal((await rowOf(s, s.staffB, day))!.available_min, 240, 'own hours override inherited site hours');
});

test('dirty → drain → recompute converges and is idempotent; an empty day stores no row', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const day = anOpenDay();
  await seedAppt(s, { staffId: s.staffA, startAt: localAt(day, 9), durationMin: 60, status: 'confirmed' });

  await markDirtyForAppointment(s.tenantId, s.clientId, s.siteId, s.staffA, localAt(day, 9));
  const before = await dirtyCount();
  assert.ok(before >= 1, 'the write enqueued a dirty day');
  const r1 = await runOccupancyRollupOnce();
  assert.ok(r1.recomputed >= 1, 'the drain recomputed it');
  assert.equal(await dirtyCount(), 0, 'the queue drained');
  const row1 = await rowOf(s, s.staffA, day);
  assert.equal(row1!.booked_min, 60);

  // Idempotent: a second recompute of the same day yields identical numbers.
  await recomputeStaffDays(s.tenantId, s.clientId, s.siteId, s.staffA, [day]);
  const row2 = await rowOf(s, s.staffA, day);
  assert.deepEqual({ ...row1 }, { ...row2 }, 'recompute is idempotent (same row)');

  // An empty future day (capacity but recompute with no appts → still a row; a SUNDAY → no row).
  let sunday = day;
  for (let i = 0; i < 7; i++) {
    const [y, m, d] = sunday.split('-').map(Number);
    if (utcToZonedParts(zonedPartsToUtc(y, m, d, 12, 0, TZ), TZ).weekday === 'sun') break;
    sunday = shiftDay(sunday, 1);
  }
  await recomputeStaffDays(s.tenantId, s.clientId, s.siteId, s.staffA, [sunday]);
  assert.equal(await rowOf(s, s.staffA, sunday), null, 'a fully-closed day (0 capacity, no appts) stores no row');
});

test('markDirtyExceptionRange enqueues each local day a time off spans (site-wide hits every bookable pro)', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const d0 = anOpenDay();
  const d1 = shiftDay(d0, 1);
  // A site-wide closure spanning two local days → both staffA and staffB, both days = 4 rows.
  await markDirtyExceptionRange(s.tenantId, s.siteId, null, localAt(d0, 0), localAt(shiftDay(d1, 1), 0));
  const r = await query<{ staff_id: string; day: string }>(
    `SELECT staff_id, to_char(day,'YYYY-MM-DD') AS day FROM occupancy_dirty_days WHERE tenant_id=$1 ORDER BY day`,
    [s.tenantId],
  );
  const days = [...new Set(r.rows.map((x) => x.day))];
  const staff = new Set(r.rows.map((x) => x.staff_id));
  assert.deepEqual(days, [d0, d1], 'both spanned local days enqueued');
  assert.ok(staff.has(s.staffA) && staff.has(s.staffB), 'a site-wide closure marks every bookable professional');
});
