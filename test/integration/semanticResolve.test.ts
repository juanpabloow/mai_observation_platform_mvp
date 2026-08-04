import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { combineLocalDayTime, zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { createAppointment } from '../../src/scheduling/booking.js';
import { resolveServiceByNameAtSite, createService, setSiteService } from '../../src/db/repositories/scheduling/services.js';
import { resolveStaffByNameAtSite } from '../../src/db/repositories/scheduling/staff.js';
import { resolveActiveAppointmentByLocalTime } from '../../src/db/repositories/scheduling/appointments.js';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient } from './fixtures.js';

/**
 * Semantic resolution against the real DB: names → ids, and identity+local time → the
 * active appointment. The engine, idempotency and exclusion constraint are unchanged — the
 * semantic path just resolves the same ids/instant the opaque path would have used.
 */

const TZ = 'America/Bogota';
const NOW = zonedPartsToUtc(2026, 8, 1, 0, 0, TZ);
const DAY = '2026-08-05'; // a future Wednesday, site open 09:00–18:00
const at = (time: string): Date => combineLocalDayTime(DAY, time, TZ)!;

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});
async function scenario() {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true });
  tenants.push(s.tenantId);
  return s;
}
const book = (s: { tenantId: string; siteId: string; clientId: string }, serviceId: string, staffId: string, startAt: Date, phone: string, key: string | null = null) =>
  createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId, staffId, startAt,
    channel: 'whatsapp', channelUserId: phone, customerName: `C ${phone.slice(-4)}`, customerPhone: phone,
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, idempotencyKey: key, now: NOW,
  });

test('service name resolves (case/accent-insensitive); unknown → not_found with valid names', async () => {
  const s = await scenario();
  for (const name of ['Haircut', 'haircut', 'HÁIRCUT', '  haircut ']) {
    assert.deepEqual(await resolveServiceByNameAtSite(s.tenantId, s.siteId, name), { status: 'ok', id: s.serviceHaircut, name: 'Haircut' });
  }
  const nf = await resolveServiceByNameAtSite(s.tenantId, s.siteId, 'Manicure');
  assert.equal(nf.status, 'not_found');
  if (nf.status === 'not_found') assert.deepEqual(nf.valid, ['Beard trim', 'Color', 'Haircut']);
});

test('two services with the same name → ambiguous (never a silent pick)', async () => {
  const s = await scenario();
  const dup = await createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Haircut', durationMin: 30, price: 20 });
  await setSiteService(s.tenantId, s.siteId, dup.id);
  const m = await resolveServiceByNameAtSite(s.tenantId, s.siteId, 'haircut');
  assert.equal(m.status, 'ambiguous');
  if (m.status === 'ambiguous') assert.deepEqual(m.candidates.map((c) => c.id).sort(), [s.serviceHaircut, dup.id].sort());
});

test('staff name resolves; unknown → not_found with valid names', async () => {
  const s = await scenario();
  assert.deepEqual(await resolveStaffByNameAtSite(s.tenantId, s.siteId, 'ana'), { status: 'ok', id: s.staffA, name: 'Ana' });
  assert.deepEqual(await resolveStaffByNameAtSite(s.tenantId, s.siteId, 'BETO'), { status: 'ok', id: s.staffB, name: 'Beto' });
  const nf = await resolveStaffByNameAtSite(s.tenantId, s.siteId, 'Zoe');
  assert.equal(nf.status, 'not_found');
  if (nf.status === 'not_found') assert.deepEqual(nf.valid, ['Ana', 'Beto']);
});

test('CROSS-CLIENT: a name that exists only in another client does not resolve here', async () => {
  const s = await scenario();
  // A service that belongs to the OTHER client, enabled only at the other client's site.
  const other = await seedSiteForClient(s.tenantId, s.otherClientId);
  const secret = await createService({ tenantId: s.tenantId, clientId: s.otherClientId, name: 'Ritual Secreto', durationMin: 30, price: 1 });
  await setSiteService(s.tenantId, other.siteId, secret.id);
  // Resolving it at THIS client's site must miss (name resolution is site-scoped).
  assert.equal((await resolveServiceByNameAtSite(s.tenantId, s.siteId, 'Ritual Secreto')).status, 'not_found');
  // …but it DOES resolve at its own site (sanity: the seed is real).
  assert.equal((await resolveServiceByNameAtSite(s.tenantId, other.siteId, 'Ritual Secreto')).status, 'ok');
});

test('booking by resolved name + day/time targets the SAME slot as id + ISO (idempotency + 409 hold)', async () => {
  const s = await scenario();
  // Path A: resolve names → ids, combine day+time → instant, book.
  const svc = await resolveServiceByNameAtSite(s.tenantId, s.siteId, 'Haircut');
  const stf = await resolveStaffByNameAtSite(s.tenantId, s.siteId, 'Ana');
  assert.ok(svc.status === 'ok' && stf.status === 'ok');
  if (svc.status !== 'ok' || stf.status !== 'ok') throw new Error('unreachable');
  const r1 = await book(s, svc.id, stf.id, at('10:00'), '+573001110001', 'k1');
  assert.ok(r1.ok, 'name+day/time booking succeeds');
  if (!r1.ok) throw new Error('unreachable');

  // Idempotency: same key replays the SAME appointment.
  const r1b = await book(s, svc.id, stf.id, at('10:00'), '+573001110001', 'k1');
  assert.ok(r1b.ok && r1b.value.id === r1.value.id, 'same key → same appointment');

  // Path B: id + ISO at the exact same instant, DIFFERENT customer → 409 (same slot).
  const r2 = await book(s, s.serviceHaircut, s.staffA, at('10:00'), '+573002220002', 'k2');
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.ok(['conflict_slot', 'unavailable'].includes(r2.error), `overlap rejected (${r2.error})`);
});

test('resolveActiveAppointmentByLocalTime: one → ok, none → lists active, many → ambiguous', async () => {
  const s = await scenario();
  const r = await book(s, s.serviceHaircut, s.staffA, at('10:00'), '+573003330003');
  assert.ok(r.ok);
  if (!r.ok) throw new Error('unreachable');
  const contactId = r.value.contact_id!;

  // exactly one active appointment at 10:00 → ok(id)
  const one = await resolveActiveAppointmentByLocalTime(s.tenantId, s.clientId, [contactId], DAY, '10:00');
  assert.deepEqual(one, { status: 'ok', id: r.value.id });

  // none at 11:00 → lists the contact's active appointments (day/time/service)
  const none = await resolveActiveAppointmentByLocalTime(s.tenantId, s.clientId, [contactId], DAY, '11:00');
  assert.equal(none.status, 'none');
  if (none.status === 'none') {
    assert.equal(none.active.length, 1);
    assert.deepEqual({ day: none.active[0].day, time: none.active[0].time, service: none.active[0].service }, { day: DAY, time: '10:00', service: 'Haircut' });
  }

  // a SECOND appointment for the same contact at the same local time (different staff) → ambiguous
  const r2 = await book(s, s.serviceHaircut, s.staffB, at('10:00'), '+573003330003');
  assert.ok(r2.ok);
  const many = await resolveActiveAppointmentByLocalTime(s.tenantId, s.clientId, [contactId], DAY, '10:00');
  assert.equal(many.status, 'ambiguous');
  if (many.status === 'ambiguous') assert.equal(many.matches.length, 2);

  // empty identity set → none (no contact matched)
  assert.deepEqual(await resolveActiveAppointmentByLocalTime(s.tenantId, s.clientId, [], DAY, '10:00'), { status: 'none', active: [] });
});
