import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { loadAvailability } from '../../src/db/repositories/scheduling/availabilityData.js';
import { createException, deleteException } from '../../src/db/repositories/scheduling/exceptions.js';
import { listActiveAppointmentsOverlapping } from '../../src/db/repositories/scheduling/appointments.js';
import { createAppointment } from '../../src/scheduling/booking.js';
import { localWallClockToUtc, utcToZonedParts } from '../../src/scheduling/timezone.js';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient } from './fixtures.js';

after(closeDb);

const TZ = 'America/Bogota';

/** Local start-minute-of-day of every slot for a staff member on a given local date. */
async function slotMinutes(
  tenantId: string,
  siteId: string,
  serviceId: string,
  staffId: string,
  date: string, // YYYY-MM-DD local
): Promise<number[]> {
  const from = localWallClockToUtc(`${date}T00:00`, TZ);
  const [y, m, d] = date.split('-').map(Number);
  const to = localWallClockToUtc(`${y}-${String(m).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}T00:00`, TZ);
  const avail = await loadAvailability({ tenantId, siteId, serviceId, staffId, from, to, now: from });
  if (!avail) return [];
  return avail.slots.map((s) => {
    const p = utcToZonedParts(s.start_at, TZ);
    return p.hour * 60 + p.minute;
  });
}

test('time off: partial staff block removes exactly the overlapping slots, only for that staff; weekly hours untouched', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    const DATE = '2026-11-02'; // Monday — the seed site opens Mon–Sat 09:00–18:00
    const baseA = await slotMinutes(s.tenantId, s.siteId, s.serviceHaircut, s.staffA, DATE);
    const baseB = await slotMinutes(s.tenantId, s.siteId, s.serviceHaircut, s.staffB, DATE);
    assert.ok(baseA.length > 0 && baseB.length > 0, 'both staff have baseline slots on an open day');

    const hoursBefore = (await query<{ working_hours: unknown }>(
      `SELECT working_hours FROM staff WHERE id = $1`,
      [s.staffA],
    )).rows[0].working_hours;

    // Block Ana 14:00–16:00 local.
    const block = await createException({
      tenantId: s.tenantId,
      siteId: s.siteId,
      staffId: s.staffA,
      startsAt: localWallClockToUtc(`${DATE}T14:00`, TZ),
      endsAt: localWallClockToUtc(`${DATE}T16:00`, TZ),
      reason: 'Vacaciones',
    });

    const afterA = await slotMinutes(s.tenantId, s.siteId, s.serviceHaircut, s.staffA, DATE);
    const afterB = await slotMinutes(s.tenantId, s.siteId, s.serviceHaircut, s.staffB, DATE);

    // A 60-min haircut overlaps [14:00,16:00) iff it starts in (13:00, 16:00).
    const overlaps = (start: number) => start < 16 * 60 && start + 60 > 14 * 60;
    assert.ok(baseA.some(overlaps), 'baseline had slots overlapping the block window');
    assert.ok(!afterA.some(overlaps), 'blocked window has no bookable slots for Ana');
    // Slots outside the window are untouched for Ana…
    assert.deepEqual(afterA, baseA.filter((m) => !overlaps(m)), 'only the overlapping slots were removed');
    // …and Beto is entirely unaffected.
    assert.deepEqual(afterB, baseB, "another staff member's availability is unchanged");

    // The weekly schedule was never edited.
    const hoursAfter = (await query<{ working_hours: unknown }>(
      `SELECT working_hours FROM staff WHERE id = $1`,
      [s.staffA],
    )).rows[0].working_hours;
    assert.deepEqual(hoursAfter, hoursBefore, 'working_hours row is byte-identical before and after');

    // After deleting the block, availability returns to normal with no other action.
    assert.equal(await deleteException(s.tenantId, block.id), true);
    const restored = await slotMinutes(s.tenantId, s.siteId, s.serviceHaircut, s.staffA, DATE);
    assert.deepEqual(restored, baseA, 'deleting the block restores availability immediately');

    // The engine never carries the reason into availability (the bot can't learn why).
    const availJson = JSON.stringify(
      await loadAvailability({
        tenantId: s.tenantId,
        siteId: s.siteId,
        serviceId: s.serviceHaircut,
        staffId: s.staffA,
        from: localWallClockToUtc(`${DATE}T00:00`, TZ),
        to: localWallClockToUtc(`2026-11-03T00:00`, TZ),
        now: localWallClockToUtc(`${DATE}T00:00`, TZ),
      }),
    );
    assert.ok(!availJson.includes('Vacaciones'), 'the reason is never exposed in availability');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('time off: full-day staff block clears the day for that staff; a site closure clears every staff', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    const FULL = '2026-11-03'; // Tuesday
    const CLOSED = '2026-11-04'; // Wednesday

    // Full-day block for Ana only.
    await createException({
      tenantId: s.tenantId,
      siteId: s.siteId,
      staffId: s.staffA,
      startsAt: localWallClockToUtc(`${FULL}T00:00`, TZ),
      endsAt: localWallClockToUtc(`2026-11-04T00:00`, TZ),
      reason: null,
    });
    assert.deepEqual(await slotMinutes(s.tenantId, s.siteId, s.serviceHaircut, s.staffA, FULL), [], 'Ana is fully blocked');
    assert.ok((await slotMinutes(s.tenantId, s.siteId, s.serviceHaircut, s.staffB, FULL)).length > 0, 'Beto still works');

    // Site closure (staff_id NULL) blocks everyone.
    await createException({
      tenantId: s.tenantId,
      siteId: s.siteId,
      staffId: null,
      startsAt: localWallClockToUtc(`${CLOSED}T00:00`, TZ),
      endsAt: localWallClockToUtc(`2026-11-05T00:00`, TZ),
      reason: 'Festivo',
    });
    assert.deepEqual(await slotMinutes(s.tenantId, s.siteId, s.serviceHaircut, s.staffA, CLOSED), [], 'closure blocks Ana');
    assert.deepEqual(await slotMinutes(s.tenantId, s.siteId, s.serviceHaircut, s.staffB, CLOSED), [], 'closure blocks Beto');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('time off: every write path refuses a slot inside a block (engine chokepoint → unavailable)', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    const DATE = '2026-11-02';
    await createException({
      tenantId: s.tenantId,
      siteId: s.siteId,
      staffId: s.staffA,
      startsAt: localWallClockToUtc(`${DATE}T14:00`, TZ),
      endsAt: localWallClockToUtc(`${DATE}T16:00`, TZ),
      reason: null,
    });
    const common = {
      tenantId: s.tenantId,
      siteId: s.siteId,
      serviceId: s.serviceHaircut,
      staffId: s.staffA,
      origin: 'internal' as const,
      createdByType: 'agent' as const,
      scopeClientId: s.clientId,
      now: localWallClockToUtc(`${DATE}T00:00`, TZ),
    };
    // Inside the block → the same error a taken slot returns, so the bot just re-offers.
    const blocked = await createAppointment({ ...common, startAt: localWallClockToUtc(`${DATE}T14:30`, TZ) });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.ok === false && blocked.error, 'unavailable', 'booking inside a block is unavailable');
    // Outside the block → books fine.
    const okRes = await createAppointment({ ...common, startAt: localWallClockToUtc(`${DATE}T09:00`, TZ) });
    assert.equal(okRes.ok, true, 'a slot outside the block still books');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('time off: the conflict query finds overlapping active appointments (staff block and site closure)', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    const DATE = '2026-11-02';
    const appt = await createAppointment({
      tenantId: s.tenantId,
      siteId: s.siteId,
      serviceId: s.serviceHaircut,
      staffId: s.staffA,
      startAt: localWallClockToUtc(`${DATE}T10:00`, TZ),
      origin: 'internal',
      createdByType: 'agent',
      scopeClientId: s.clientId,
      now: localWallClockToUtc(`${DATE}T00:00`, TZ),
    });
    assert.equal(appt.ok, true);

    const from = localWallClockToUtc(`${DATE}T09:30`, TZ);
    const to = localWallClockToUtc(`${DATE}T11:00`, TZ);
    // Staff-scoped block → finds Ana's appointment.
    const staffConf = await listActiveAppointmentsOverlapping(s.tenantId, { clientId: s.clientId, siteId: s.siteId, staffId: s.staffA, from, to });
    assert.equal(staffConf.length, 1);
    assert.equal(staffConf[0].staff_id, s.staffA);
    // Site closure (no staffId) → also finds it.
    const siteConf = await listActiveAppointmentsOverlapping(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from, to });
    assert.equal(siteConf.length, 1);
    // A different staff's block does NOT list Ana's appointment.
    const betoConf = await listActiveAppointmentsOverlapping(s.tenantId, { clientId: s.clientId, siteId: s.siteId, staffId: s.staffB, from, to });
    assert.deepEqual(betoConf, []);
    // A non-overlapping window → nothing.
    const away = await listActiveAppointmentsOverlapping(s.tenantId, {
      clientId: s.clientId,
      siteId: s.siteId,
      staffId: s.staffA,
      from: localWallClockToUtc(`${DATE}T15:00`, TZ),
      to: localWallClockToUtc(`${DATE}T16:00`, TZ),
    });
    assert.deepEqual(away, []);
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('time off: local wall-clock anchors to the site tz, crosses the UTC date, and respects DST', async () => {
  // Bogota (UTC-5, no DST): 18:00 local = 23:00Z same day; 20:00 local = 01:00Z the NEXT UTC day.
  assert.equal(localWallClockToUtc('2026-11-02T18:00', 'America/Bogota').toISOString(), '2026-11-02T23:00:00.000Z');
  assert.equal(localWallClockToUtc('2026-11-02T20:00', 'America/Bogota').toISOString(), '2026-11-03T01:00:00.000Z');
  // DST: the SAME local wall-clock maps to different UTC instants across the year in a DST zone.
  assert.equal(localWallClockToUtc('2026-07-01T12:00', 'America/New_York').toISOString(), '2026-07-01T16:00:00.000Z'); // EDT (UTC-4)
  assert.equal(localWallClockToUtc('2026-01-01T12:00', 'America/New_York').toISOString(), '2026-01-01T17:00:00.000Z'); // EST (UTC-5)
});

test('time off: a block on client A never affects client B availability (isolation)', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    const b = await seedSiteForClient(s.tenantId, s.otherClientId);
    const DATE = '2026-11-02';
    const baseB = await slotMinutes(s.tenantId, b.siteId, b.serviceId, b.staffId, DATE);
    assert.ok(baseB.length > 0, 'client B has baseline slots');
    // A full-day SITE closure on client A's site.
    await createException({
      tenantId: s.tenantId,
      siteId: s.siteId,
      staffId: null,
      startsAt: localWallClockToUtc(`${DATE}T00:00`, TZ),
      endsAt: localWallClockToUtc(`2026-11-03T00:00`, TZ),
      reason: null,
    });
    const afterB = await slotMinutes(s.tenantId, b.siteId, b.serviceId, b.staffId, DATE);
    assert.deepEqual(afterB, baseB, "client A's closure does not touch client B");
  } finally {
    await cleanupTenant(s.tenantId);
  }
});
