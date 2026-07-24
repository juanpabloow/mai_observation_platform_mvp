import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { createAppointment, rescheduleAppointment, transitionStatus } from '../../src/scheduling/booking.js';
import { getAppointmentById, listAppointments } from '../../src/db/repositories/scheduling/appointments.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient } from './fixtures.js';

/**
 * The DOMAIN scheduling gate (Phase 3C, Hallazgo 6): createAppointment /
 * transitionStatus / rescheduleAppointment re-check the client's scheduling
 * module INSIDE the transaction (FOR SHARE), so a disabled client — including a
 * disable that races the request — can never be written to. Plus the cross-client
 * idempotency guard (Hallazgo 5).
 */

const TZ = 'America/Bogota';
const NOW = zonedPartsToUtc(2026, 8, 1, 0, 0, TZ);
const wed = (h: number): Date => zonedPartsToUtc(2026, 8, 5, h, 0, TZ);

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

const disable = (tenantId: string, clientId: string) =>
  setClientModuleEnabled({ tenantId, clientId, moduleKey: 'scheduling', enabled: false });
const enable = (tenantId: string, clientId: string) =>
  setClientModuleEnabled({ tenantId, clientId, moduleKey: 'scheduling', enabled: true });
async function count(tenantId: string): Promise<number> {
  return (await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM appointments WHERE tenant_id = $1`, [tenantId])).rows[0].n;
}

test('disabled blocks a NEW create — zero writes', async () => {
  const s = await scenario({ enableScheduling: true });
  await disable(s.tenantId, s.clientId);
  const before = await count(s.tenantId);
  const r = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA, startAt: wed(10),
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, now: NOW,
  });
  assert.ok(!r.ok && r.error === 'module_disabled');
  assert.equal(await count(s.tenantId), before, 'no appointment written');
});

test('disabled blocks an idempotent REPLAY (does not resurrect a booking)', async () => {
  const s = await scenario({ enableScheduling: true });
  const key = 'replay-key';
  const first = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA, startAt: wed(11),
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, idempotencyKey: key, now: NOW,
  });
  assert.ok(first.ok);
  const before = await count(s.tenantId);
  await disable(s.tenantId, s.clientId);
  const replay = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA, startAt: wed(11),
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, idempotencyKey: key, now: NOW,
  });
  assert.ok(!replay.ok && replay.error === 'module_disabled', 'no replay while disabled');
  assert.equal(await count(s.tenantId), before);
});

test('disabled blocks confirm/cancel/complete/no-show — no status/version change', async () => {
  const s = await scenario({ enableScheduling: true });
  const created = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA, startAt: wed(12),
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, now: NOW,
  });
  assert.ok(created.ok);
  const id = created.value.id;
  const v0 = created.value.version;
  await disable(s.tenantId, s.clientId);
  for (const target of ['confirmed', 'cancelled', 'completed', 'no_show'] as const) {
    const r = await transitionStatus(target, { tenantId: s.tenantId, appointmentId: id, actorType: 'n8n', scopeClientId: s.clientId });
    assert.ok(!r.ok && r.error === 'module_disabled', `${target} blocked while disabled`);
  }
  const after = await getAppointmentById(s.tenantId, id);
  assert.equal(after?.status, 'scheduled', 'status unchanged');
  assert.equal(after?.version, v0, 'version unchanged');
  const events = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM appointment_events WHERE appointment_id = $1`, [id]);
  assert.equal(events.rows[0].n, 1, 'only the original created event exists (no transition events)');
});

test('disabled blocks reschedule — interval unchanged', async () => {
  const s = await scenario({ enableScheduling: true });
  const created = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA, startAt: wed(9),
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, now: NOW,
  });
  assert.ok(created.ok);
  await disable(s.tenantId, s.clientId);
  const r = await rescheduleAppointment({
    tenantId: s.tenantId, appointmentId: created.value.id, startAt: wed(15), actorType: 'n8n', scopeClientId: s.clientId, now: NOW,
  });
  assert.ok(!r.ok && r.error === 'module_disabled');
  const after = await getAppointmentById(s.tenantId, created.value.id);
  assert.equal(after?.start_at.getTime(), wed(9).getTime(), 'interval unchanged');
  assert.equal(after?.version, created.value.version, 'version unchanged');
});

test('re-enabling preserves data and lets operations resume', async () => {
  const s = await scenario({ enableScheduling: true });
  const created = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA, startAt: wed(10),
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, now: NOW,
  });
  assert.ok(created.ok);
  await disable(s.tenantId, s.clientId);
  await enable(s.tenantId, s.clientId);
  // Data survived, and confirm now works.
  const stillThere = await getAppointmentById(s.tenantId, created.value.id);
  assert.equal(stillThere?.start_at.getTime(), wed(10).getTime());
  const c = await transitionStatus('confirmed', { tenantId: s.tenantId, appointmentId: created.value.id, actorType: 'n8n', scopeClientId: s.clientId });
  assert.ok(c.ok && c.value.status === 'confirmed');
});

test('cross-client Idempotency-Key collision never returns the foreign appointment', async () => {
  const s = await scenario({ enableScheduling: true });
  const other = await seedSiteForClient(s.tenantId, s.otherClientId); // client B's own site/staff/service
  const key = 'shared-key';
  // A books with the key.
  const a = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA, startAt: wed(10),
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, idempotencyKey: key, now: NOW,
  });
  assert.ok(a.ok);
  // B reuses the SAME (tenant-level) key — must NOT get A's appointment back.
  const b = await createAppointment({
    tenantId: s.tenantId, siteId: other.siteId, serviceId: other.serviceId, staffId: other.staffId, startAt: wed(10),
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.otherClientId, idempotencyKey: key, now: NOW,
  });
  assert.ok(!b.ok && b.error === 'conflict_idempotency', 'cross-client key reuse → conflict, not a foreign replay');
  const bAppts = await listAppointments(s.tenantId, { clientId: s.otherClientId });
  assert.equal(bAppts.length, 0, 'client B has no appointment');
});

test('FAIL CLOSED: omitting scopeClientId (untyped caller) → not_found, zero writes / no changes', async () => {
  const s = await scenario({ enableScheduling: true });
  // Seed one appointment WITH scope so we can prove transitions/reschedule don't touch it.
  const created = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA, startAt: wed(9),
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, now: NOW,
  });
  assert.ok(created.ok);
  const id = created.value.id;
  const before = await count(s.tenantId);
  const v0 = created.value.version;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  // createAppointment with NO scopeClientId → not_found, and NOT a single write.
  const c = await (createAppointment as any)({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA, startAt: wed(12),
    origin: 'n8n', createdByType: 'n8n', now: NOW,
  });
  assert.ok(!c.ok && c.error === 'not_found', 'create fails closed');
  assert.equal(await count(s.tenantId), before, 'no appointment written without scope');

  // transitionStatus with NO scope → not_found, no status/version/event change.
  const t = await (transitionStatus as any)('confirmed', { tenantId: s.tenantId, appointmentId: id, actorType: 'n8n' });
  assert.ok(!t.ok && t.error === 'not_found', 'transition fails closed');

  // rescheduleAppointment with NO scope → not_found, interval/version unchanged.
  const r = await (rescheduleAppointment as any)({ tenantId: s.tenantId, appointmentId: id, startAt: wed(15), actorType: 'n8n', now: NOW });
  assert.ok(!r.ok && r.error === 'not_found', 'reschedule fails closed');
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const after = await getAppointmentById(s.tenantId, id);
  assert.equal(after?.status, 'scheduled', 'status unchanged');
  assert.equal(after?.version, v0, 'version unchanged');
  assert.equal(after?.start_at.getTime(), wed(9).getTime(), 'interval unchanged');
  const events = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM appointment_events WHERE appointment_id = $1`, [id]);
  assert.equal(events.rows[0].n, 1, 'only the original created event exists');
});

test('positive control: valid create → list → confirm → reschedule → cancel', async () => {
  const s = await scenario({ enableScheduling: true });
  const created = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA, startAt: wed(10),
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, now: NOW,
  });
  assert.ok(created.ok);
  const id = created.value.id;
  const list = await listAppointments(s.tenantId, { clientId: s.clientId });
  assert.ok(list.some((x) => x.id === id));
  assert.ok((await transitionStatus('confirmed', { tenantId: s.tenantId, appointmentId: id, actorType: 'n8n', scopeClientId: s.clientId })).ok);
  assert.ok((await rescheduleAppointment({ tenantId: s.tenantId, appointmentId: id, startAt: wed(15), actorType: 'n8n', scopeClientId: s.clientId, now: NOW })).ok);
  assert.ok((await transitionStatus('cancelled', { tenantId: s.tenantId, appointmentId: id, actorType: 'n8n', scopeClientId: s.clientId })).ok);
});
