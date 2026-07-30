import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { createAppointment, rescheduleAppointment } from '../../src/scheduling/booking.js';
import { resolveContactByIdentity } from '../../src/db/repositories/contactIdentities.js';
import { listAppointmentsForContact } from '../../src/db/repositories/scheduling/appointments.js';
import { cleanupTenant, closeDb, seedContact, seedScenario, seedSiteForClient } from './fixtures.js';

/**
 * C-4.1: booking for an EXPLICIT contact (the record's "Book appointment"). Attaches to
 * that contact without creating/mutating one; refuses a foreign contact_id or typed
 * identity that resolves elsewhere; keeps every existing booking guarantee (idempotency,
 * exclusion 409, reschedule availability incl. the C-2 small-increment fix).
 */

const TZ = 'America/Bogota';
const NOW = zonedPartsToUtc(2026, 8, 1, 0, 0, TZ);
const wed = (h: number, m = 0): Date => zonedPartsToUtc(2026, 8, 5, h, m, TZ);

const tenants: string[] = [];
async function scenario(enableScheduling = true) {
  const s = await seedScenario({ enableScheduling, enableCrm: true });
  tenants.push(s.tenantId);
  return s;
}
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

async function contactCount(tenantId: string, clientId: string): Promise<number> {
  const r = await query<{ n: number }>(`SELECT count(*)::int AS n FROM contacts WHERE tenant_id=$1 AND client_id=$2`, [tenantId, clientId]);
  return r.rows[0].n;
}

test('book by contact_id attaches to it WITHOUT creating a new contact', async () => {
  const s = await scenario();
  const c = await seedContact(s.tenantId, s.clientId, { name: 'Ana', channelUserId: 'wa:ana' });
  const before = await contactCount(s.tenantId, s.clientId);

  const r = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(10), contactId: c, origin: 'internal', createdByType: 'agent', scopeClientId: s.clientId, now: NOW,
  });
  assert.ok(r.ok, 'booking succeeds');
  if (r.ok) assert.equal(r.value.contact_id, c, 'appointment attached to the supplied contact');
  assert.equal(await contactCount(s.tenantId, s.clientId), before, 'no new contact was created');
  assert.equal((await listAppointmentsForContact(s.tenantId, c, s.clientId)).length, 1, 'appointment shows on the contact');
});

test("a contact_id from ANOTHER client is refused (fail closed, no write)", async () => {
  const s = await scenario();
  const foreign = await seedContact(s.tenantId, s.otherClientId, { name: 'Bob', channelUserId: 'wa:bob' });
  const before = await contactCount(s.tenantId, s.otherClientId);
  const r = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(10), contactId: foreign, origin: 'internal', createdByType: 'agent', scopeClientId: s.clientId, now: NOW,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, 'not_found', 'foreign contact → indistinguishable not_found');
  assert.equal(await contactCount(s.tenantId, s.otherClientId), before, 'no contact touched');
  assert.equal((await listAppointmentsForContact(s.tenantId, foreign, s.otherClientId)).length, 0, 'no appointment written');
});

test('contact_id + identity that resolves to a DIFFERENT contact is refused; the SAME contact is fine', async () => {
  const s = await scenario();
  const keep = (await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: '+573001112233' })).contact;
  await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: '+573009998877' }); // "other"

  const conflict = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(10), contactId: keep.id, channel: 'manual', channelUserId: '+573009998877',
    origin: 'internal', createdByType: 'agent', scopeClientId: s.clientId, now: NOW,
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error, 'contact_conflict', 'typed identity belongs to someone else → refuse');

  // The same slot is still free (the conflict wrote nothing) — contact_id + its OWN identity books.
  const ok = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(10), contactId: keep.id, channel: 'manual', channelUserId: '+573001112233',
    origin: 'internal', createdByType: 'agent', scopeClientId: s.clientId, now: NOW,
  });
  assert.ok(ok.ok, 'identity matching the same contact is not a conflict');
  if (ok.ok) assert.equal(ok.value.contact_id, keep.id);
});

test('idempotency replay still returns the ORIGINAL booking', async () => {
  const s = await scenario();
  const c = await seedContact(s.tenantId, s.clientId, { channelUserId: 'wa:idem' });
  const input = {
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(11), contactId: c, idempotencyKey: 'c41-key', origin: 'internal' as const, createdByType: 'agent' as const, scopeClientId: s.clientId, now: NOW,
  };
  const r1 = await createAppointment({ ...input });
  const r2 = await createAppointment({ ...input });
  assert.ok(r1.ok && r2.ok);
  if (r1.ok && r2.ok) assert.equal(r1.value.id, r2.value.id, 'replay returns the same appointment');
});

test('overlapping bookings still hit the exclusion 409 (concurrent race)', async () => {
  const s = await scenario();
  const c = await seedContact(s.tenantId, s.clientId, { channelUserId: 'wa:ov' });
  const base = {
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(12), contactId: c, origin: 'internal' as const, createdByType: 'agent' as const, scopeClientId: s.clientId, now: NOW,
  };
  // Concurrent — both pass availability, then the GiST exclusion lets exactly one commit.
  const [r1, r2] = await Promise.all([createAppointment({ ...base }), createAppointment({ ...base })]);
  const ok = [r1, r2].filter((r) => r.ok);
  const bad = [r1, r2].filter((r) => !r.ok);
  assert.equal(ok.length, 1, 'exactly one booking wins');
  assert.equal(bad.length, 1, 'the other is refused');
  const err = bad[0].ok === false ? bad[0].error : "";
  assert.ok(err === 'conflict_slot' || err === 'unavailable', `overlap refused (${err})`);
});

test('reschedule a small increment succeeds (C-2 fix); a real conflict still 409s', async () => {
  const s = await scenario();
  const c = await seedContact(s.tenantId, s.clientId, { channelUserId: 'wa:resch' });
  // A 90-min service at 10:00 (only staffA performs Color).
  const a1 = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceColor, staffId: s.staffA,
    startAt: wed(10), contactId: c, origin: 'internal', createdByType: 'agent', scopeClientId: s.clientId, now: NOW,
  });
  assert.ok(a1.ok);
  if (!a1.ok) return;
  // Move it 30 minutes — overlaps its OWN original interval; the C-2 window fix keeps it bookable.
  const moved = await rescheduleAppointment({
    tenantId: s.tenantId, appointmentId: a1.value.id, startAt: wed(10, 30), actorType: 'agent', scopeClientId: s.clientId, now: NOW,
  });
  assert.ok(moved.ok, 'small-increment reschedule succeeds');

  // A second appointment, then reschedule a1 onto it → genuine conflict.
  const a2 = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(14), contactId: c, origin: 'internal', createdByType: 'agent', scopeClientId: s.clientId, now: NOW,
  });
  assert.ok(a2.ok);
  const clash = await rescheduleAppointment({
    tenantId: s.tenantId, appointmentId: a1.value.id, startAt: wed(14), actorType: 'agent', scopeClientId: s.clientId, now: NOW,
  });
  assert.equal(clash.ok, false, 'a real conflict still 409s');
});

test('cross-client + module-off are refused at the domain (what the action gate relies on)', async () => {
  // Booking at ANOTHER client's site under my scope → not_found (the scopeClientId guard
  // that backs "member of A cannot book for B").
  const s = await scenario();
  const other = await seedSiteForClient(s.tenantId, s.otherClientId);
  const crossClient = await createAppointment({
    tenantId: s.tenantId, siteId: other.siteId, serviceId: other.serviceId, staffId: other.staffId,
    startAt: wed(10), origin: 'internal', createdByType: 'agent', scopeClientId: s.clientId, now: NOW,
  });
  assert.equal(crossClient.ok, false);
  if (!crossClient.ok) assert.equal(crossClient.error, 'not_found');

  // Scheduling module OFF for the client → refused, zero writes.
  const off = await scenario(false);
  const c = await seedContact(off.tenantId, off.clientId, { channelUserId: 'wa:off' });
  const r = await createAppointment({
    tenantId: off.tenantId, siteId: off.siteId, serviceId: off.serviceHaircut, staffId: off.staffA,
    startAt: wed(10), contactId: c, origin: 'internal', createdByType: 'agent', scopeClientId: off.clientId, now: NOW,
  });
  assert.equal(r.ok, false, 'module off → refused');
  if (!r.ok) assert.ok(r.error === 'module_disabled' || r.error === 'not_found', `refused (${r.error})`);
});
