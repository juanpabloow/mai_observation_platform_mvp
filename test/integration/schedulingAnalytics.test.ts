import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient, seedAppointment } from './fixtures.js';
import { zonedPartsToUtc, localDayRangeToUtc, utcToZonedParts } from '../../src/scheduling/timezone.js';
import { listAppointments } from '../../src/db/repositories/scheduling/appointments.js';
import { getStaffForClient } from '../../src/db/repositories/scheduling/staff.js';
import {
  getAppointmentMetrics,
  getAppointmentsByDay,
  getAppointmentsByStaff,
  getAppointmentsByService,
} from '../../src/db/repositories/scheduling/analytics.js';

/**
 * Scheduling analytics (read-only aggregations) — spec F #1–#11, #15. All money/
 * counts come from SQL FILTER/GROUP BY, never from rows loaded into JS. Every query
 * is anchored to (tenant, client, site) + a half-open [from, to) UTC window derived
 * from the site's LOCAL dates. Bogota is UTC-5; 2026-08-03 is a Monday there.
 */

const TZ = 'America/Bogota';
const tenants: string[] = [];
async function scenario() {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  return s;
}
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

/** Local wall-clock (Bogota) → UTC instant. */
const at = (y: number, m: number, d: number, h: number) => zonedPartsToUtc(y, m, d, h, 0, TZ);

/** Seed the canonical Monday(2026-08-03)/Tuesday dataset for client A's site. */
async function seedWeek(s: Awaited<ReturnType<typeof scenario>>) {
  const base = { clientId: s.clientId, siteId: s.siteId };
  // Monday 2026-08-03
  await seedAppointment(s.tenantId, { ...base, staffId: s.staffA, serviceId: s.serviceHaircut, serviceName: 'Haircut', startAt: at(2026, 8, 3, 10), status: 'completed', price: 30 });
  await seedAppointment(s.tenantId, { ...base, staffId: s.staffA, serviceId: s.serviceHaircut, serviceName: 'Haircut', startAt: at(2026, 8, 3, 11), status: 'completed', price: 30 });
  await seedAppointment(s.tenantId, { ...base, staffId: s.staffA, serviceId: s.serviceHaircut, serviceName: 'Haircut', startAt: at(2026, 8, 3, 12), status: 'cancelled', price: 30 });
  await seedAppointment(s.tenantId, { ...base, staffId: s.staffB, serviceId: s.serviceBeard, serviceName: 'Beard trim', startAt: at(2026, 8, 3, 10), status: 'no_show', price: 15 });
  await seedAppointment(s.tenantId, { ...base, staffId: s.staffB, serviceId: s.serviceBeard, serviceName: 'Beard trim', startAt: at(2026, 8, 3, 11), status: 'scheduled', price: 15 });
  // Tuesday 2026-08-04 — one exactly at LOCAL MIDNIGHT (the [from,to) boundary) + one later.
  await seedAppointment(s.tenantId, { ...base, staffId: s.staffA, serviceId: s.serviceHaircut, serviceName: 'Haircut', startAt: zonedPartsToUtc(2026, 8, 4, 0, 0, TZ), status: 'scheduled', price: 30 });
  await seedAppointment(s.tenantId, { ...base, staffId: s.staffA, serviceId: s.serviceHaircut, serviceName: 'Haircut', startAt: at(2026, 8, 4, 10), status: 'confirmed', price: 30 });
}

test('2026-08-03 is a Monday in the site timezone', () => {
  assert.equal(utcToZonedParts(at(2026, 8, 3, 12), TZ).weekday, 'mon');
});

test('#5 #8 metrics: status distribution + honest money (cancelled/no_show excluded from value)', async () => {
  const s = await scenario();
  await seedWeek(s);
  const { from, to } = localDayRangeToUtc('2026-08-03', '2026-08-03', TZ); // Monday only
  const m = await getAppointmentMetrics(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from, to });
  assert.equal(m.total, 5, 'only Monday appts (Tue midnight boundary + Tue 10:00 excluded)');
  assert.equal(m.completed, 2);
  assert.equal(m.cancelled, 1);
  assert.equal(m.no_show, 1);
  assert.equal(m.scheduled, 1);
  assert.equal(m.confirmed, 0);
  assert.equal(m.completed_value, '60.00', 'only the 2 completed × 30 — cancelled/no_show NOT counted');
  assert.equal(m.scheduled_value, '15.00', 'active value = scheduled+confirmed (one scheduled × 15)');
  assert.equal(Math.round(m.completion_rate * 100), 40);
  assert.equal(Math.round(m.cancellation_rate * 100), 20);
  assert.equal(Math.round(m.no_show_rate * 100), 20);
});

test('#2 #4 half-open [from, to): the instant exactly at `to` is excluded, then included when the window grows', async () => {
  const s = await scenario();
  await seedWeek(s);
  const mon = localDayRangeToUtc('2026-08-03', '2026-08-03', TZ);
  const monMetrics = await getAppointmentMetrics(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from: mon.from, to: mon.to });
  assert.equal(monMetrics.total, 5, 'Tue 00:00 (== to) excluded');
  const monTue = localDayRangeToUtc('2026-08-03', '2026-08-04', TZ);
  const bothMetrics = await getAppointmentMetrics(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from: monTue.from, to: monTue.to });
  assert.equal(bothMetrics.total, 7, 'widening to include Tuesday adds the boundary + the 10:00 appt');
});

test('#3 by-day grouping uses the site-local date (Monday bucket = 5)', async () => {
  const s = await scenario();
  await seedWeek(s);
  const { from, to } = localDayRangeToUtc('2026-08-03', '2026-08-04', TZ);
  const days = await getAppointmentsByDay(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from, to }, TZ);
  const mon = days.find((d) => d.day === '2026-08-03');
  const tue = days.find((d) => d.day === '2026-08-04');
  assert.ok(mon && tue, 'both local days present');
  assert.equal(mon.total, 5, 'Monday local bucket');
  assert.equal(tue.total, 2, 'Tuesday local bucket');
});

test('#1 filter by barber (analytics staffId + listAppointments staffId agree)', async () => {
  const s = await scenario();
  await seedWeek(s);
  const { from, to } = localDayRangeToUtc('2026-08-03', '2026-08-03', TZ);
  const m = await getAppointmentMetrics(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from, to, staffId: s.staffA });
  assert.equal(m.total, 3, 'staffA on Monday: 2 completed + 1 cancelled');
  const list = await listAppointments(s.tenantId, { clientId: s.clientId, siteId: s.siteId, staffId: s.staffA, from, to });
  assert.equal(list.length, 3);
  assert.ok(list.every((a) => a.staff_id === s.staffA));
});

test('#6 aggregation by barber', async () => {
  const s = await scenario();
  await seedWeek(s);
  const { from, to } = localDayRangeToUtc('2026-08-03', '2026-08-03', TZ);
  const rows = await getAppointmentsByStaff(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from, to });
  const a = rows.find((r) => r.staff_id === s.staffA);
  const b = rows.find((r) => r.staff_id === s.staffB);
  assert.equal(a?.total, 3);
  assert.equal(a?.completed, 2);
  assert.equal(a?.staff_name, 'Ana');
  assert.equal(b?.total, 2);
  assert.equal(b?.no_show, 1);
});

test('#7 aggregation by service (uses the snapshot name)', async () => {
  const s = await scenario();
  await seedWeek(s);
  const { from, to } = localDayRangeToUtc('2026-08-03', '2026-08-03', TZ);
  const rows = await getAppointmentsByService(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from, to });
  const hair = rows.find((r) => r.service_name === 'Haircut');
  const beard = rows.find((r) => r.service_name === 'Beard trim');
  assert.equal(hair?.total, 3);
  assert.equal(hair?.completed, 2);
  assert.equal(beard?.total, 2);
});

test('#10 a site of ANOTHER client reveals nothing (client+site both filtered)', async () => {
  const s = await scenario();
  await seedWeek(s);
  const other = await seedSiteForClient(s.tenantId, s.otherClientId);
  await seedAppointment(s.tenantId, {
    clientId: s.otherClientId, siteId: other.siteId, staffId: other.staffId, serviceId: other.serviceId,
    startAt: at(2026, 8, 3, 10), status: 'completed', price: 999,
  });
  const { from, to } = localDayRangeToUtc('2026-08-03', '2026-08-03', TZ);
  // Client A's own site is unaffected by the other client's appointment.
  const mine = await getAppointmentMetrics(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from, to });
  assert.equal(mine.total, 5);
  assert.equal(mine.completed_value, '60.00', 'the other client\'s 999 never leaks in');
  // Asking for client A but the OTHER client's site → 0 rows (site not in client A).
  const foreign = await getAppointmentMetrics(s.tenantId, { clientId: s.clientId, siteId: other.siteId, from, to });
  assert.equal(foreign.total, 0);
});

test('#9 staff of another client → getStaffForClient returns null (would 404)', async () => {
  const s = await scenario();
  const other = await seedSiteForClient(s.tenantId, s.otherClientId);
  assert.equal(await getStaffForClient(s.tenantId, s.clientId, other.staffId), null, 'foreign-client staff hidden');
  const ok = await getStaffForClient(s.tenantId, s.clientId, s.staffA);
  assert.ok(ok && ok.site_client_id === s.clientId, 'own-client staff resolves with its site');
});

test('#11 cross-tenant isolation: another tenant with the same local day never bleeds in', async () => {
  const s = await scenario();
  await seedWeek(s);
  const other = await scenario(); // a whole separate tenant
  await seedWeek(other);
  const { from, to } = localDayRangeToUtc('2026-08-03', '2026-08-03', TZ);
  const m = await getAppointmentMetrics(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from, to });
  assert.equal(m.total, 5, 'tenant filter keeps the other tenant out');
});

test('#15 analytics + list work with contact_id = null (no CRM dependency)', async () => {
  const s = await scenario();
  await seedWeek(s); // every seeded appointment has contact_id = null
  const { from, to } = localDayRangeToUtc('2026-08-03', '2026-08-03', TZ);
  const list = await listAppointments(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from, to });
  assert.ok(list.length === 5 && list.every((a) => a.contact_id === null), 'rows present, all walk-in style');
  const m = await getAppointmentMetrics(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from, to });
  assert.equal(m.total, 5);
});
