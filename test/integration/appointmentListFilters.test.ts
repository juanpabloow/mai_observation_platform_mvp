import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { createAppointment, transitionStatus } from '../../src/scheduling/booking.js';
import { listAppointments } from '../../src/db/repositories/scheduling/appointments.js';
import { findContactIdsByIdentity, getContactCardById } from '../../src/db/repositories/contactIdentities.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

/**
 * C-7 — the list-route contract that the machine handler enforces, proven at the
 * repository + identity-spine level (the Next handler itself can't run in this
 * runner; its param-parsing wiring is guarded by the source-level contract test):
 *
 *  1. IDENTITY IDENTIFICATION (Task 2): every appointment row carries the contact's
 *     name + primary identity from ONE lateral join, and a walk-in (NULL contact_id)
 *     carries neither.
 *  2. NO-WIDEN (Task 3): a `contactIds` filter that resolves to NOBODY returns 0
 *     rows — never the whole client (this is the bug the route used to have when an
 *     empty/unsupported identity param dropped the filter).
 *  3. IDENTITY FILTER (Task 3): phone/email resolve through the C-2 spine to the
 *     right contact, and the resolved set excludes walk-ins (NULL contact_id).
 *  4. STATUS: an array status filter selects exactly those statuses.
 */

const TZ = 'America/Bogota';
const NOW = zonedPartsToUtc(2026, 8, 1, 0, 0, TZ);
const wed = (h: number): Date => zonedPartsToUtc(2026, 8, 5, h, 0, TZ); // a future Wednesday, 9–18 open

const A_PHONE = '+573001110001';
const B_PHONE = '+573002220002';

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

async function seed() {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true });
  tenants.push(s.tenantId);
  const book = async (h: number, phone: string | null) => {
    const r = await createAppointment({
      tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
      startAt: wed(h), channel: phone ? 'whatsapp' : null, channelUserId: phone,
      customerName: phone ? `Cust ${phone.slice(-4)}` : null, customerPhone: phone,
      origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, idempotencyKey: null, now: NOW,
    });
    assert.ok(r.ok, `booking at ${h}:00 should succeed`);
    if (!r.ok) throw new Error('unreachable');
    return r.value;
  };
  const a1 = await book(10, A_PHONE); // A — scheduled
  const a2 = await book(12, A_PHONE); // A — will be cancelled
  const b1 = await book(14, B_PHONE); // B — scheduled
  const walkIn = await book(16, null); // walk-in — contact_id NULL
  await transitionStatus('cancelled', { tenantId: s.tenantId, appointmentId: a2.id, actorType: 'n8n', scopeClientId: s.clientId });
  return { s, aId: a1.contact_id!, bId: b1.contact_id!, walkInId: walkIn.id };
}

test('every row carries the contact identity from the lateral join; a walk-in carries none', async () => {
  const { s, aId, walkInId } = await seed();
  const rows = await listAppointments(s.tenantId, { clientId: s.clientId });
  assert.equal(rows.length, 4, 'all four appointments of the client');

  const aRow = rows.find((r) => r.contact_id === aId)!;
  assert.equal(aRow.contact_name, 'Cust 0001', 'contact name projected');
  assert.equal(aRow.primary_identity, A_PHONE, 'primary identity is the phone (ONE lateral join)');

  const walkRow = rows.find((r) => r.id === walkInId)!;
  assert.equal(walkRow.contact_id, null, 'walk-in has no contact');
  assert.equal(walkRow.contact_name, null);
  assert.equal(walkRow.primary_identity, null);
});

test('a contactIds filter that resolves to NOBODY returns 0 rows — never the whole client', async () => {
  const { s } = await seed();
  const none = await listAppointments(s.tenantId, { clientId: s.clientId, contactIds: [] });
  assert.equal(none.length, 0, 'empty identity set must NOT widen to the full client list');
});

test('phone/email resolve through the C-2 spine and exclude walk-ins', async () => {
  const { s, aId } = await seed();

  const aIds = await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.clientId, phone: A_PHONE });
  assert.deepEqual(aIds, [aId], 'phone resolves to exactly contact A');

  const rows = await listAppointments(s.tenantId, { clientId: s.clientId, contactIds: aIds });
  assert.equal(rows.length, 2, "both of A's appointments (scheduled + cancelled)");
  assert.ok(rows.every((r) => r.contact_id === aId), 'only A');

  const unknown = await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.clientId, email: 'nobody@example.com' });
  assert.deepEqual(unknown, [], 'an unknown email resolves to nobody');
});

test('status array filters to exactly those statuses', async () => {
  const { s } = await seed();
  const scheduled = await listAppointments(s.tenantId, { clientId: s.clientId, status: ['scheduled', 'confirmed'] });
  assert.equal(scheduled.length, 3, 'A(scheduled) + B(scheduled) + walk-in(scheduled); A(cancelled) excluded');
  assert.ok(scheduled.every((r) => r.status === 'scheduled' || r.status === 'confirmed'));

  const cancelled = await listAppointments(s.tenantId, { clientId: s.clientId, status: 'cancelled' });
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].status, 'cancelled');
});

test('getContactCardById returns the same identity card used by single-appointment routes', async () => {
  const { s, aId } = await seed();
  const card = await getContactCardById(s.tenantId, s.clientId, aId);
  assert.ok(card, 'card resolves for a client-owned contact');
  assert.equal(card!.id, aId);
  assert.equal(card!.name, 'Cust 0001');
  assert.equal(card!.primary_identity, A_PHONE);

  // Cross-client / unknown → null (never leaks a foreign contact card).
  const foreign = await getContactCardById(s.tenantId, s.otherClientId, aId);
  assert.equal(foreign, null, 'a contact of another client is not returned');
});
