import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { isExclusionViolation, query, withTransaction } from '../../src/db/client.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import {
  createAppointment,
  rescheduleAppointment,
  transitionStatus,
} from '../../src/scheduling/booking.js';
import { loadAvailability } from '../../src/db/repositories/scheduling/availabilityData.js';
import {
  getAppointmentById,
  insertAppointment,
  listAppointments,
  listAppointmentsForContact,
} from '../../src/db/repositories/scheduling/appointments.js';
import { listContactConversations } from '../../src/db/repositories/contacts.js';
import { listEventsSince } from '../../src/db/repositories/scheduling/events.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

const TZ = 'America/Bogota';
const NOW = zonedPartsToUtc(2026, 8, 1, 0, 0, TZ); // well before the test slots
const wed = (h: number, m = 0): Date => zonedPartsToUtc(2026, 8, 5, h, m, TZ);

const tenants: string[] = [];
async function scenario(opts = {}) {
  const s = await seedScenario(opts);
  tenants.push(s.tenantId);
  return s;
}

after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

test('#12 two concurrent bookings for same staff+slot → exactly one wins, other 409', async () => {
  const s = await scenario();
  const base = {
    tenantId: s.tenantId,
    siteId: s.siteId,
    serviceId: s.serviceHaircut,
    staffId: s.staffA,
    startAt: wed(10),
    origin: 'n8n' as const,
    createdByType: 'n8n' as const,
    now: NOW,
  };
  const [r1, r2] = await Promise.all([createAppointment({ ...base }), createAppointment({ ...base })]);
  const oks = [r1, r2].filter((r) => r.ok);
  // Depending on interleaving the loser is rejected either at revalidation
  // ('unavailable') or at the DB exclusion constraint ('conflict_slot'); the
  // GUARANTEE the test asserts is that AT MOST ONE booking is ever created.
  const losers = [r1, r2].filter((r) => !r.ok);
  assert.equal(oks.length, 1, 'exactly one booking should succeed');
  assert.equal(losers.length, 1, 'the other must be rejected');
  assert.ok(!losers[0].ok && ['conflict_slot', 'unavailable'].includes(losers[0].error));
  const count = await query(`SELECT COUNT(*)::int AS n FROM appointments WHERE tenant_id = $1`, [s.tenantId]);
  assert.equal(count.rows[0].n, 1, 'exactly one row committed');
});

test('#12b DB exclusion constraint: two concurrent RAW inserts → exactly one 23P01', async () => {
  const s = await scenario();
  const start = wed(10);
  const end = wed(11);
  const insertRaw = () =>
    withTransaction((client) =>
      insertAppointment(client, {
        tenantId: s.tenantId, siteId: s.siteId, contactId: null, sourceConversationId: null,
        staffId: s.staffA, serviceId: s.serviceHaircut, startAt: start, serviceEndAt: end,
        blockedFrom: start, blockedUntil: end, serviceNameSnapshot: 'Haircut', durationMinSnapshot: 60,
        priceSnapshot: null, bufferBeforeMinSnapshot: 0, bufferAfterMinSnapshot: 0,
        origin: 'internal', createdByType: 'agent', createdByUserId: null, idempotencyKey: null,
      }),
    );
  const results = await Promise.allSettled([insertRaw(), insertRaw()]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(ok.length, 1, 'exactly one insert commits');
  assert.equal(rejected.length, 1, 'the other is rejected');
  assert.ok(isExclusionViolation(rejected[0].reason), 'rejection is SQLSTATE 23P01');
});

test('#13 same Idempotency-Key + same payload → no duplicate, returns same appointment', async () => {
  const s = await scenario();
  const input = {
    tenantId: s.tenantId,
    siteId: s.siteId,
    serviceId: s.serviceHaircut,
    staffId: s.staffA,
    startAt: wed(11),
    origin: 'n8n' as const,
    createdByType: 'n8n' as const,
    idempotencyKey: 'key-abc',
    now: NOW,
  };
  const r1 = await createAppointment({ ...input });
  const r2 = await createAppointment({ ...input });
  assert.ok(r1.ok && r2.ok);
  assert.equal(r2.deduped, true);
  assert.equal(r1.value.id, r2.value.id);
  const count = await query(`SELECT COUNT(*)::int AS n FROM appointments WHERE tenant_id = $1`, [s.tenantId]);
  assert.equal(count.rows[0].n, 1);
});

test('#14 same Idempotency-Key + different payload → conflict', async () => {
  const s = await scenario();
  const base = {
    tenantId: s.tenantId,
    siteId: s.siteId,
    serviceId: s.serviceHaircut,
    staffId: s.staffA,
    origin: 'n8n' as const,
    createdByType: 'n8n' as const,
    idempotencyKey: 'key-xyz',
    now: NOW,
  };
  const r1 = await createAppointment({ ...base, startAt: wed(12) });
  const r2 = await createAppointment({ ...base, startAt: wed(13) }); // different slot, same key
  assert.ok(r1.ok);
  assert.ok(!r2.ok && r2.error === 'conflict_idempotency');
});

test('#15 cancellation frees the slot', async () => {
  const s = await scenario();
  const r = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(14), origin: 'internal', createdByType: 'agent', now: NOW,
  });
  assert.ok(r.ok);
  // Slot is taken → a second booking is rejected (revalidation sees it busy).
  const blocked = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(14), origin: 'internal', createdByType: 'agent', now: NOW,
  });
  assert.ok(!blocked.ok && ['conflict_slot', 'unavailable'].includes(blocked.error));
  // Cancel, then the same slot books again.
  const c = await transitionStatus('cancelled', { tenantId: s.tenantId, appointmentId: r.value.id, actorType: 'agent' });
  assert.ok(c.ok);
  const rebook = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(14), origin: 'internal', createdByType: 'agent', now: NOW,
  });
  assert.ok(rebook.ok, 'slot should be free after cancellation');
});

test('#16 reschedule re-validates availability (blocked target fails, free target succeeds)', async () => {
  const s = await scenario();
  const a1 = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(9), origin: 'internal', createdByType: 'agent', now: NOW,
  });
  const a2 = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(11), origin: 'internal', createdByType: 'agent', now: NOW,
  });
  assert.ok(a1.ok && a2.ok);
  // Move a1 onto a2's slot → conflict/unavailable.
  const clash = await rescheduleAppointment({
    tenantId: s.tenantId, appointmentId: a1.value.id, startAt: wed(11), actorType: 'agent', now: NOW,
  });
  assert.ok(!clash.ok);
  // Move a1 to a free slot → ok, same id, version bumped.
  const moved = await rescheduleAppointment({
    tenantId: s.tenantId, appointmentId: a1.value.id, startAt: wed(15), actorType: 'agent', now: NOW,
  });
  assert.ok(moved.ok);
  assert.equal(moved.value.id, a1.value.id);
  assert.equal(moved.value.start_at.getTime(), wed(15).getTime());
  assert.ok(moved.value.version > a1.value.version);
});

test('#17 terminal states reject invalid transitions', async () => {
  const s = await scenario();
  const r = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(16), origin: 'internal', createdByType: 'agent', now: NOW,
  });
  assert.ok(r.ok);
  const done = await transitionStatus('completed', { tenantId: s.tenantId, appointmentId: r.value.id, actorType: 'agent' });
  assert.ok(done.ok);
  const illegal = await transitionStatus('confirmed', { tenantId: s.tenantId, appointmentId: r.value.id, actorType: 'agent' });
  assert.ok(!illegal.ok && illegal.error === 'invalid_transition');
});

test('#20 old appointments keep their snapshot when the service later changes', async () => {
  const s = await scenario();
  const r = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(9, 30), origin: 'internal', createdByType: 'agent', now: NOW,
  });
  assert.ok(r.ok);
  assert.equal(r.value.duration_min_snapshot, 60);
  assert.equal(r.value.service_name_snapshot, 'Haircut');
  // Change the service duration + price + name AFTER the booking.
  await query(`UPDATE services SET duration_min = 45, price = 99, name = 'Haircut Deluxe' WHERE id = $1`, [s.serviceHaircut]);
  const reload = await getAppointmentById(s.tenantId, r.value.id);
  assert.equal(reload?.duration_min_snapshot, 60, 'snapshot duration must not change');
  assert.equal(reload?.service_name_snapshot, 'Haircut', 'snapshot name must not change');
});

test('#3 tenant isolation: one tenant never sees another tenant\'s appointments', async () => {
  const a = await scenario();
  const b = await scenario();
  const ra = await createAppointment({
    tenantId: a.tenantId, siteId: a.siteId, serviceId: a.serviceHaircut, staffId: a.staffA,
    startAt: wed(10), origin: 'internal', createdByType: 'agent', now: NOW,
  });
  assert.ok(ra.ok);
  // Tenant B cannot read A's appointment, and B's list is empty.
  assert.equal(await getAppointmentById(b.tenantId, ra.value.id), null);
  assert.equal((await listAppointments(b.tenantId)).length, 0);
  // A's own list has exactly the one.
  assert.equal((await listAppointments(a.tenantId)).length, 1);
});

test('#1 one contact, many conversations (no duplication)', async () => {
  const s = await scenario();
  const common = {
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    channel: 'whatsapp', channelUserId: '573001112233', customerName: 'Carlos',
    origin: 'n8n' as const, createdByType: 'n8n' as const, now: NOW,
  };
  const r1 = await createAppointment({ ...common, startAt: wed(9), workflowRef: 'wf1', conversationRef: 'conv-1' });
  const r2 = await createAppointment({ ...common, startAt: wed(11), workflowRef: 'wf1', conversationRef: 'conv-2' });
  assert.ok(r1.ok && r2.ok);
  assert.equal(r1.value.contact_id, r2.value.contact_id, 'same person → same contact');
  const contactCount = await query(`SELECT COUNT(*)::int AS n FROM contacts WHERE tenant_id = $1 AND channel = 'whatsapp'`, [s.tenantId]);
  assert.equal(contactCount.rows[0].n, 1, 'no duplicate contact');
  const convs = await listContactConversations(s.tenantId, r1.value.contact_id!);
  assert.equal(convs.length, 2, 'one contact, two conversations');
});

test('#2 one contact, many appointments', async () => {
  const s = await scenario();
  const common = {
    tenantId: s.tenantId, siteId: s.siteId, staffId: s.staffA,
    channel: 'whatsapp', channelUserId: '573009998877',
    origin: 'n8n' as const, createdByType: 'n8n' as const, now: NOW,
  };
  const r1 = await createAppointment({ ...common, serviceId: s.serviceHaircut, startAt: wed(9) });
  const r2 = await createAppointment({ ...common, serviceId: s.serviceBeard, startAt: wed(11) });
  assert.ok(r1.ok && r2.ok);
  const appts = await listAppointmentsForContact(s.tenantId, r1.value.contact_id!);
  assert.equal(appts.length, 2);
});

test('#11 "any staff" assigns a concrete staff and both barbers usable', async () => {
  const s = await scenario();
  const r = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, // no staffId → any
    startAt: wed(10), origin: 'public', createdByType: 'public', now: NOW,
  });
  assert.ok(r.ok);
  assert.ok([s.staffA, s.staffB].includes(r.value.staff_id), 'a concrete staff was assigned');
});

test('#18 + #19 public and n8n share one agenda; realtime event emitted after commit', async () => {
  const s = await scenario();
  const before = await listEventsSince(s.tenantId, null, { siteId: s.siteId });
  const rn = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(9), origin: 'n8n', createdByType: 'n8n', now: NOW,
  });
  const rp = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffB,
    startAt: wed(9), origin: 'public', createdByType: 'public', now: NOW,
  });
  assert.ok(rn.ok && rp.ok);
  const agenda = await listAppointments(s.tenantId, { siteId: s.siteId });
  assert.equal(agenda.length, 2, 'both origins land in the same agenda');
  const after = await listEventsSince(s.tenantId, before[before.length - 1]?.seq ?? null, { siteId: s.siteId });
  const created = after.filter((e) => e.event_type === 'appointment.created');
  assert.ok(created.length >= 2, 'a realtime created-event was recorded post-commit for each');
});

test('availability reflects a booking (loadAvailability hides the taken slot)', async () => {
  const s = await scenario();
  await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(10), origin: 'internal', createdByType: 'agent', now: NOW,
  });
  const avail = await loadAvailability({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    from: wed(0), to: wed(23, 59), now: NOW,
  });
  assert.ok(avail);
  assert.ok(!avail.slots.some((sl) => sl.start_at.getTime() === wed(10).getTime()), 'taken slot is gone');
});
