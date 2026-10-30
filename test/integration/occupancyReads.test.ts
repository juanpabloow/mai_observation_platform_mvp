import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';
import { utcToZonedParts, zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { recomputeStaffDays } from '../../src/occupancy/compute.js';
import { buildOccupancyHeatmap } from '../../src/occupancy/heatmap.js';
import {
  freeMinutesByStaff,
  occupancySeriesByStaff,
  occupancyTotalsByStaff,
} from '../../src/db/repositories/scheduling/occupancyReads.js';

/** JP-8 §2 — the read queries (day/week/month totals, free hours, trend series) and the on-demand
 *  weekday×hour heatmap. */
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
function weekdayMon0(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const wk = utcToZonedParts(zonedPartsToUtc(y, m, d, 12, 0, TZ), TZ).weekday;
  return { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 }[wk]!;
}
/** The Monday of a given local day's ISO week. */
function mondayOf(day: string): string {
  return shiftDay(day, -weekdayMon0(day));
}
const localAt = (day: string, h: number, min = 0): Date => {
  const [y, m, d] = day.split('-').map(Number);
  return zonedPartsToUtc(y, m, d, h, min, TZ);
};
async function seedAppt(s: Awaited<ReturnType<typeof seedScenario>>, staffId: string, startAt: Date, durationMin: number, status: string): Promise<void> {
  const end = new Date(startAt.getTime() + durationMin * 60000);
  await query(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id,
        start_at, service_end_at, blocked_from, blocked_until,
        service_name_snapshot, duration_min_snapshot, price_snapshot, buffer_before_min_snapshot, buffer_after_min_snapshot,
        status, origin, created_by_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$7,'Haircut',$8,'50000',0,0,$9,'internal','system')`,
    [s.tenantId, s.clientId, s.siteId, staffId, s.serviceHaircut, startAt, end, durationMin, status],
  );
}

test('totals, free hours, trend series, and the weekday×hour heatmap', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  // Two consecutive OPEN days (Tue+Wed) inside one ISO week so the week aggregation sums both.
  // Start from a Tuesday.
  let tue = '2026-06-02';
  for (let i = 0; i < 7; i++) { if (weekdayMon0(tue) === 1) break; tue = shiftDay(tue, 1); }
  const wed = shiftDay(tue, 1);

  // staffA: day 1 a 60-min completed at 10:00; day 2 a 120-min completed at 09:00.
  await seedAppt(s, s.staffA, localAt(tue, 10), 60, 'completed');
  await seedAppt(s, s.staffA, localAt(wed, 9), 120, 'completed');
  await recomputeStaffDays(s.tenantId, s.clientId, s.siteId, s.staffA, [tue, wed]);

  // Day totals (just Tuesday): 540 available, 60 booked.
  const dayTotals = await occupancyTotalsByStaff(s.tenantId, s.clientId, tue, tue);
  const dA = dayTotals.find((x) => x.staff_id === s.staffA)!;
  assert.equal(dA.available_min, 540);
  assert.equal(dA.booked_min, 60);

  // Week totals (the ISO week containing both): 1080 available, 180 booked.
  const wkFrom = mondayOf(tue);
  const wkTo = shiftDay(wkFrom, 6);
  const weekTotals = await occupancyTotalsByStaff(s.tenantId, s.clientId, wkFrom, wkTo);
  const wA = weekTotals.find((x) => x.staff_id === s.staffA)!;
  assert.equal(wA.available_min, 1080, 'two open days summed');
  assert.equal(wA.booked_min, 180);
  assert.equal(wA.attended_min, 180);

  // Free hours across those two days = available − booked = 1080 − 180 = 900.
  const free = await freeMinutesByStaff(s.tenantId, s.clientId, tue, wed);
  assert.equal(free.find((x) => x.staff_id === s.staffA)!.free_min, 900);

  // Weekly trend series: one bucket (the Monday), summing both days.
  const series = await occupancySeriesByStaff(s.tenantId, s.clientId, wkFrom, wkTo, 'week');
  const sA = series.filter((x) => x.staff_id === s.staffA);
  assert.equal(sA.length, 1, 'one weekly bucket');
  assert.equal(sA[0].bucket, wkFrom, 'bucket starts on Monday');
  assert.equal(sA[0].booked_min, 180);

  // Heatmap over the two days for staffA: the Tue 10:00 cell is fully booked (60/60 = 100%).
  const hm = await buildOccupancyHeatmap({ tenantId: s.tenantId, clientId: s.clientId, siteId: s.siteId, staffIds: [s.staffA], fromDay: tue, toDay: wed });
  const tueCell = hm.grid[weekdayMon0(tue)][10];
  assert.equal(tueCell.bookedMin, 60, 'the 10:00 Tuesday hour is fully booked');
  assert.equal(tueCell.availableMin, 60, 'that hour is entirely within the 9–18 shift');
  // A closed hour (08:00) has no capacity.
  assert.equal(hm.grid[weekdayMon0(tue)][8].availableMin, 0, 'before opening = no capacity');
  // Wed 09:00 and 10:00 are booked by the 120-min appointment.
  assert.equal(hm.grid[weekdayMon0(wed)][9].bookedMin, 60);
  assert.equal(hm.grid[weekdayMon0(wed)][10].bookedMin, 60);
});

test('month aggregation: two days in the same calendar month sum into one month bucket', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  // Two open days in the same month but different ISO weeks (≥8 days apart).
  let d1 = '2026-09-01';
  for (let i = 0; i < 7; i++) { if (weekdayMon0(d1) !== 6) break; d1 = shiftDay(d1, 1); } // skip Sunday
  const d2 = shiftDay(d1, 9); // same month (Sep), a later week
  await seedAppt(s, s.staffA, localAt(d1, 10), 60, 'completed');
  await seedAppt(s, s.staffA, localAt(d2, 10), 60, 'completed');
  await recomputeStaffDays(s.tenantId, s.clientId, s.siteId, s.staffA, [d1, d2]);

  const [y, m] = d1.split('-').map(Number);
  const first = `${y}-${pad(m)}-01`;
  const last = dayStr(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
  const totals = await occupancyTotalsByStaff(s.tenantId, s.clientId, first, last);
  assert.equal(totals.find((x) => x.staff_id === s.staffA)!.booked_min, 120, 'the whole month sums both days');

  const series = await occupancySeriesByStaff(s.tenantId, s.clientId, first, last, 'month');
  const sa = series.filter((x) => x.staff_id === s.staffA);
  assert.equal(sa.length, 1, 'one month bucket');
  assert.equal(sa[0].bucket, first, 'the bucket is the first of the month');
  assert.equal(sa[0].booked_min, 120);
});
