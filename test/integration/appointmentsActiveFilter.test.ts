import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { createAppointment, transitionStatus } from '../../src/scheduling/booking.js';
import { listAppointments } from '../../src/db/repositories/scheduling/appointments.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

/**
 * `active=true` must mean "still ACTIONABLE", not just "status in (scheduled, confirmed)":
 * an appointment that has already ended must drop out — otherwise the machine list keeps
 * returning weeks-old "scheduled" rows and an agent quotes a customer a date that has
 * passed. The boundary is service_end_at >= now (an absolute instant), so one in progress
 * stays in. `status=` keeps its no-time-bound meaning; the two never conflate.
 */
const TZ = 'America/Bogota';
const NOW0 = zonedPartsToUtc(2026, 8, 1, 0, 0, TZ); // booking "now": 4 days before the day
const wed = (h: number, m = 0): Date => zonedPartsToUtc(2026, 8, 5, h, m, TZ); // Wed, site open 9–18

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
async function book(s: Awaited<ReturnType<typeof scenario>>, staffId: string, hour: number, phone: string) {
  const r = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId,
    startAt: wed(hour), channel: 'whatsapp', channelUserId: phone, customerName: 'Cliente', customerPhone: phone,
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, idempotencyKey: null, now: NOW0,
  });
  assert.ok(r.ok, `book ${hour} ok`);
  if (!r.ok) throw new Error('unreachable');
  return r.value; // { id, start_at, service_end_at, status, ... } — haircut = 60 min
}
const has = (rows: { id: string }[], id: string): boolean => rows.some((r) => r.id === id);
const active = (s: { tenantId: string; clientId: string }, at: Date) =>
  listAppointments(s.tenantId, { clientId: s.clientId, activeAt: at });
const all = (s: { tenantId: string; clientId: string }) => listAppointments(s.tenantId, { clientId: s.clientId });

test('an ENDED appointment is excluded from active=true, but stays in the unfiltered list', async () => {
  const s = await scenario();
  const a = await book(s, s.staffA, 10, '+573000000010'); // 10:00–11:00
  assert.equal(has(await active(s, wed(12)), a.id), false, 'ended (queried at 12:00) is not active');
  assert.equal(has(await all(s), a.id), true, 'but the unfiltered list still returns it');
});

test('an appointment IN PROGRESS right now stays active (boundary is service_end_at, not start_at)', async () => {
  const s = await scenario();
  const a = await book(s, s.staffA, 10, '+573000000010'); // 10:00–11:00
  const mid = new Date((new Date(a.start_at).getTime() + new Date(a.service_end_at).getTime()) / 2); // 10:30
  assert.equal(has(await active(s, mid), a.id), true, 'started-but-not-ended is active');
});

test('a FUTURE appointment is active', async () => {
  const s = await scenario();
  const a = await book(s, s.staffA, 14, '+573000000014');
  assert.equal(has(await active(s, wed(9)), a.id), true);
});

test('cancelled / completed / no_show are NEVER active, even when their time is future', async () => {
  const s = await scenario();
  const c = await book(s, s.staffA, 10, '+573000000010');
  const d = await book(s, s.staffA, 12, '+573000000012');
  const e = await book(s, s.staffB, 14, '+573000000014');
  await transitionStatus('cancelled', { tenantId: s.tenantId, appointmentId: c.id, actorType: 'agent', scopeClientId: s.clientId });
  await transitionStatus('completed', { tenantId: s.tenantId, appointmentId: d.id, actorType: 'agent', scopeClientId: s.clientId });
  await transitionStatus('no_show', { tenantId: s.tenantId, appointmentId: e.id, actorType: 'agent', scopeClientId: s.clientId });
  // Queried at 09:00 — the time boundary alone WOULD include all three (they end later);
  // the status half of active=true is what must exclude them.
  const act = await active(s, wed(9));
  for (const x of [c, d, e]) assert.equal(has(act, x.id), false, 'a terminal status is never active');
  const unfiltered = await all(s);
  for (const x of [c, d, e]) assert.equal(has(unfiltered, x.id), true, 'but all present in the unfiltered list');
});

test('status=scheduled explicitly still returns PAST rows — the time boundary is NOT applied', async () => {
  const s = await scenario();
  const a = await book(s, s.staffA, 10, '+573000000010'); // scheduled, 10:00–11:00
  const byStatus = await listAppointments(s.tenantId, { clientId: s.clientId, status: ['scheduled'] });
  assert.equal(has(byStatus, a.id), true, 'status=scheduled has no time bound (past ones included)');
  // The SAME appointment, at the SAME later instant, is excluded by active=true — proving the
  // two filters are distinct, not aliases.
  assert.equal(has(await active(s, wed(12)), a.id), false, 'active=true does apply the boundary');
});

test('the boundary is an ABSOLUTE instant (service_end_at >= now) — tz cannot shift membership', async () => {
  // The repo compares service_end_at (timestamptz) to the activeAt instant; there is no tz
  // in the query, so a presentation `?tz` can only relabel a row, never add or drop one. The
  // exact edge: at end−1s the appointment is active, at end+1s it is not — same stored
  // instant either way, whatever timezone a caller would render it in.
  const s = await scenario();
  const a = await book(s, s.staffA, 10, '+573000000010');
  const end = new Date(a.service_end_at).getTime();
  assert.equal(has(await active(s, new Date(end - 1000)), a.id), true, 'inside end by 1s → active');
  assert.equal(has(await active(s, new Date(end + 1000)), a.id), false, 'past end by 1s → not active');
});

test('SOURCE CONTRACT: active=true is a time-bounded filter, decoupled from status=', () => {
  const web = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');
  const src = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');
  const route = web('app/api/scheduling/v1/appointments/route.ts');
  // active no longer aliases into the status set (the conflation that dropped the boundary).
  assert.equal(route.includes('statusSet.add("scheduled")'), false, 'active does not dump into the status set');
  assert.ok(route.includes('activeAt = new Date()'), 'active=true resolves to a now-instant');
  assert.ok(/activeAt,/.test(route), 'and is passed to listAppointments');
  // The repo predicate: the two open statuses AND the end-instant boundary.
  const repo = src('db/repositories/scheduling/appointments.ts');
  assert.ok(repo.includes("['scheduled', 'confirmed']") && /service_end_at >= \$\$\{i\}/.test(repo), 'repo bounds active by status + service_end_at');
});
