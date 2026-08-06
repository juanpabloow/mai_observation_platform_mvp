import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { createAppointment, transitionStatus } from '../../src/scheduling/booking.js';
import { loadAvailability } from '../../src/db/repositories/scheduling/availabilityData.js';
import {
  listAppointments,
  listAppointmentsForContact,
  countUpcomingAppointmentsForResource,
} from '../../src/db/repositories/scheduling/appointments.js';
import { deactivateStaff, reactivateStaff } from '../../src/db/repositories/scheduling/staff.js';
import { deactivateService, reactivateService } from '../../src/db/repositories/scheduling/services.js';
import { deactivateSite, reactivateSite } from '../../src/db/repositories/scheduling/sites.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

/**
 * Deactivation is a FORWARD-LOOKING switch, never a retroactive erasure (the token-revoke
 * principle). This proves it end-to-end at the data layer:
 *  - a deactivated staff/service/site is dropped from AVAILABILITY and refuses NEW bookings;
 *  - its EXISTING appointments stay fully visible (agenda list, contact record, machine API
 *    read all use listAppointments, which never filters on active) with names still resolving;
 *  - reactivation restores availability + new bookings with no migration — round-tripped twice;
 *  - the deactivation guard counts FUTURE appointments without mutating anything.
 */

const TZ = 'America/Bogota';
const NOW = zonedPartsToUtc(2026, 8, 1, 0, 0, TZ);
const wed = (h: number): Date => zonedPartsToUtc(2026, 8, 5, h, 0, TZ); // future Wednesday, 9–18 open
const DAY_FROM = zonedPartsToUtc(2026, 8, 5, 0, 0, TZ);
const DAY_TO = zonedPartsToUtc(2026, 8, 6, 0, 0, TZ);

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

async function scenarioWithAppt() {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true });
  tenants.push(s.tenantId);
  const r = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(10), channel: 'whatsapp', channelUserId: '+573001110001', customerName: 'Ana Cliente',
    customerPhone: '+573001110001', origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId,
    idempotencyKey: null, now: NOW,
  });
  assert.ok(r.ok, 'seed booking succeeds');
  if (!r.ok) throw new Error('unreachable');
  return { s, appt: r.value, contactId: r.value.contact_id! };
}

/** Slot count for the haircut service on the test day (optionally pinned to one staff). */
async function slotCount(s: { tenantId: string; siteId: string; serviceHaircut: string }, staffId?: string): Promise<number> {
  const av = await loadAvailability({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut,
    staffId: staffId ?? null, from: DAY_FROM, to: DAY_TO, now: NOW,
  });
  return av?.slots.length ?? 0;
}

async function bookAt(s: { tenantId: string; siteId: string; serviceHaircut: string; clientId: string }, staffId: string, hour: number) {
  return createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId,
    startAt: wed(hour), origin: 'internal', createdByType: 'agent', scopeClientId: s.clientId,
    idempotencyKey: null, now: NOW,
  });
}

test('STAFF: deactivate hides from availability + refuses new bookings, keeps history visible; reactivate restores (×2)', async () => {
  const { s, appt, contactId } = await scenarioWithAppt();
  assert.ok((await slotCount(s, s.staffA)) > 0, 'baseline: staff A has slots');

  for (let round = 0; round < 2; round++) {
    // Deactivate.
    assert.equal(await deactivateStaff(s.tenantId, s.staffA), true, `round ${round}: deactivated`);

    // History stays visible everywhere that reads listAppointments, with the name resolving.
    const agenda = await listAppointments(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from: DAY_FROM, to: DAY_TO });
    const row = agenda.find((a) => a.id === appt.id);
    assert.ok(row, 'existing appointment still in the agenda day list');
    assert.equal(row!.staff_name, 'Ana', 'staff name still resolves (not "unknown")');
    assert.equal((await listAppointmentsForContact(s.tenantId, contactId, s.clientId)).length, 1, 'still on the contact record');

    // Availability gone; a new booking for the inactive staff is refused with a clear error.
    assert.equal(await slotCount(s, s.staffA), 0, 'no slots for inactive staff');
    const refused = await bookAt(s, s.staffA, 14);
    assert.equal(refused.ok, false, 'new booking refused');
    if (!refused.ok) assert.ok(['no_staff', 'unavailable'].includes(refused.error), `clear error (${refused.error})`);

    // Reactivate → availability + new bookings work again.
    assert.equal(await reactivateStaff(s.tenantId, s.staffA), true, `round ${round}: reactivated`);
    assert.ok((await slotCount(s, s.staffA)) > 0, 'slots return after reactivation');
    const ok = await bookAt(s, s.staffA, 15 + round); // distinct hour per round to avoid overlap
    assert.equal(ok.ok, true, 'new booking succeeds after reactivation');
  }
});

test('SERVICE: deactivate removes availability + refuses booking, keeps history; reactivate restores (×2)', async () => {
  const { s, appt } = await scenarioWithAppt();
  assert.ok((await slotCount(s)) > 0, 'baseline: service bookable');

  for (let round = 0; round < 2; round++) {
    assert.equal(await deactivateService(s.tenantId, s.clientId, s.serviceHaircut), true);
    assert.equal(await slotCount(s), 0, 'inactive service offers no slots');
    const refused = await bookAt(s, s.staffA, 14);
    assert.equal(refused.ok, false, 'booking an inactive service is refused');
    // The appointment (with its snapshotted service name) is untouched and still listed.
    const agenda = await listAppointments(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from: DAY_FROM, to: DAY_TO });
    const row = agenda.find((a) => a.id === appt.id);
    assert.ok(row && row.service_name_snapshot === 'Haircut', 'service name preserved on the appointment');

    assert.equal(await reactivateService(s.tenantId, s.clientId, s.serviceHaircut), true);
    assert.ok((await slotCount(s)) > 0, 'service bookable again');
  }
});

test('SITE: deactivate removes availability, keeps history; reactivate restores (×2)', async () => {
  const { s, appt } = await scenarioWithAppt();
  assert.ok((await slotCount(s)) > 0, 'baseline');

  for (let round = 0; round < 2; round++) {
    assert.equal(await deactivateSite(s.tenantId, s.siteId), true);
    assert.equal(await slotCount(s), 0, 'inactive site offers no availability');
    // History survives: listAppointments does not filter on site.active.
    const agenda = await listAppointments(s.tenantId, { clientId: s.clientId, siteId: s.siteId, from: DAY_FROM, to: DAY_TO });
    assert.ok(agenda.some((a) => a.id === appt.id), 'appointment at an inactive site is still listed');

    assert.equal(await reactivateSite(s.tenantId, s.siteId), true);
    assert.ok((await slotCount(s)) > 0, 'availability returns after reactivation');
  }
});

test('GUARD: counts FUTURE active appointments per resource without mutating anything', async () => {
  const { s, appt, contactId } = await scenarioWithAppt();
  // One upcoming appointment for staff A / the haircut service / the site.
  assert.equal(await countUpcomingAppointmentsForResource(s.tenantId, { clientId: s.clientId, staffId: s.staffA }, NOW), 1);
  assert.equal(await countUpcomingAppointmentsForResource(s.tenantId, { clientId: s.clientId, serviceId: s.serviceHaircut }, NOW), 1);
  assert.equal(await countUpcomingAppointmentsForResource(s.tenantId, { clientId: s.clientId, siteId: s.siteId }, NOW), 1);
  // Staff B (no appointments) → 0.
  assert.equal(await countUpcomingAppointmentsForResource(s.tenantId, { clientId: s.clientId, staffId: s.staffB }, NOW), 0);

  // Cancelled/past do NOT count: cancelling the only appointment drops the count to 0.
  await transitionStatus('cancelled', { tenantId: s.tenantId, appointmentId: appt.id, actorType: 'agent', scopeClientId: s.clientId });
  assert.equal(await countUpcomingAppointmentsForResource(s.tenantId, { clientId: s.clientId, staffId: s.staffA }, NOW), 0, 'cancelled not counted');

  // The count is read-only — the appointment still exists (now cancelled) and is still listed.
  assert.equal((await listAppointmentsForContact(s.tenantId, contactId, s.clientId)).length, 1, 'nothing was deleted by counting');
});
