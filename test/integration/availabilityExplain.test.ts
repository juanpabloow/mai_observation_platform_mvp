import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { createException } from '../../src/db/repositories/scheduling/exceptions.js';
import { localWallClockToUtc } from '../../src/scheduling/timezone.js';
import { cleanupTenant, closeDb, seedMember, seedScenario, seedSiteForClient, seedWorkflow, type Scenario } from './fixtures.js';

/**
 * EXPLAINABLE AVAILABILITY through the real machine routes, server actions and PostgreSQL
 * (migration 1803). Synthetic fixtures: the scenario's two professionals are renamed
 * "Falla" and "Federico" — fixture names, not real data. Only the session read and three
 * Next boundaries are stubbed (same harness as timeOffPermissions.test.ts).
 */

let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: { getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null) },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), {
  namedExports: {
    redirect: () => { throw new Error('unexpected redirect()'); },
    notFound: () => { throw new Error('unexpected notFound()'); },
  },
});
mock.module(urlOf('next/headers'), { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) } });
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

const { createTimeOffAction, updateTimeOffAction } = await import('../../web/lib/timeOffActions.js');
const { createExceptionAction } = await import('../../web/lib/schedulingAdminActions.js');
const { GET: AvailGET } = await import('../../web/app/api/scheduling/v1/availability/route.js');
const { GET: StatusGET } = await import('../../web/app/api/scheduling/v1/staff/status/route.js');

const TZ = 'America/Bogota';
const SENSITIVE = 'Cita médica: control de rodilla';
const tenants: string[] = [];
const users: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  if (users.length) await query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [users]);
  await closeDb();
});

const day = (d: string, hhmm = '00:00') => localWallClockToUtc(`${d}T${hhmm}`, TZ);

async function gallery(): Promise<Scenario & { hdr: Record<string, string>; falla: string; federico: string }> {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  await query(`UPDATE staff SET name = 'Falla' WHERE id = $1`, [s.staffA]);
  await query(`UPDATE staff SET name = 'Federico' WHERE id = $1`, [s.staffB]);
  const wfRef = `wf-${s.tenantId.slice(0, 6)}`;
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
  const { rawToken } = await issueToken(s.tenantId, connectionId, ['scheduling.read']);
  return { ...s, hdr: { Authorization: `Bearer ${rawToken}`, 'x-workflow-ref': wfRef }, falla: s.staffA, federico: s.staffB };
}

async function avail(s: { siteId: string; hdr: Record<string, string> }, q: Record<string, string>) {
  const params = new URLSearchParams({ site_id: s.siteId, ...q });
  const res = await AvailGET(new Request(`http://t/api/scheduling/v1/availability?${params}`, { headers: s.hdr }));
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}
async function status(s: { siteId: string; hdr: Record<string, string> }, q: Record<string, string>) {
  const params = new URLSearchParams({ site_id: s.siteId, ...q });
  const res = await StatusGET(new Request(`http://t/api/scheduling/v1/staff/status?${params}`, { headers: s.hdr }));
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}
const leaks = (text: string) => text.includes('médica') || text.includes('rodilla') || /"reason"/.test(text);

// Wed 2026-11-04 (vacation), Thu 2026-11-05 (back).
const WED = '2026-11-04';
const THU = '2026-11-05';

test('full-day vacation with a public reason: explained, alternatives and the next REAL slot', async () => {
  const s = await gallery();
  await createException({ tenantId: s.tenantId, siteId: s.siteId, staffId: s.falla, startsAt: day(WED), endsAt: day(THU), reason: SENSITIVE, publicReason: 'vacation' });
  const r = await avail(s, { staff: 'Falla', service_id: s.serviceHaircut, from: day(WED).toISOString(), to: day(THU).toISOString(), explain: 'true', compact: 'true' });
  assert.equal(r.status, 200);
  assert.equal(r.json.slots.length, 0);
  const e = r.json.explanation;
  assert.equal(e.version, 1);
  assert.equal(e.staff.length, 1);
  const f = e.staff[0];
  assert.deepEqual([f.staff_name, f.status, f.summary, f.public_reason, f.public_reason_label], ['Falla', 'unavailable', 'absence', 'vacation', 'Vacaciones']);
  assert.equal(f.customer_message, 'Falla está de vacaciones en esa fecha.');
  assert.equal(f.days[0].date, WED);
  // Next bookable time: a real engine slot (Thursday 09:00), not "the block ends at midnight".
  assert.equal(f.next_available.day, THU);
  assert.equal(f.next_available.time, '09:00');
  // Alternatives: Federico, with a real slot that same Wednesday.
  assert.deepEqual(e.alternatives.map((a: { staff_name: string }) => a.staff_name), ['Federico']);
  assert.equal(e.alternatives[0].first_slot.day, WED);
  assert.ok(e.alternatives[0].slot_count > 0);
  assert.ok(!leaks(r.text), 'the internal reason never appears');
});

test('without explain the response is the previous contract, and the slots are identical', async () => {
  const s = await gallery();
  await createException({ tenantId: s.tenantId, siteId: s.siteId, staffId: s.falla, startsAt: day(WED, '10:00'), endsAt: day(WED, '11:00'), reason: SENSITIVE, publicReason: 'vacation' });
  const q = { staff_id: s.falla, service_id: s.serviceHaircut, from: day(WED).toISOString(), to: day(THU).toISOString() };
  const plain = await avail(s, q);
  const explained = await avail(s, { ...q, explain: 'true' });
  assert.deepEqual(Object.keys(plain.json).sort(), ['free_blocks', 'has_availability', 'site', 'slots']);
  assert.deepEqual(explained.json.slots, plain.json.slots, 'explain never changes the slots');
  assert.deepEqual(explained.json.free_blocks, plain.json.free_blocks);
  // A one-hour block does not make the day an absence.
  const f = explained.json.explanation.staff[0];
  assert.equal(f.status, 'available');
  assert.equal(f.public_reason, null);
  assert.ok(f.days[0].causes.some((c: { code: string; coverage: string }) => c.code === 'absence' && c.coverage === 'part'));
  assert.equal((await avail(s, { ...q, explain: 'yes' })).status, 400);
  assert.ok(!leaks(plain.text) && !leaks(explained.text));
});

test('a block WITHOUT public reason: neutral message; sensitive text never returned', async () => {
  const s = await gallery();
  await createException({ tenantId: s.tenantId, siteId: s.siteId, staffId: s.falla, startsAt: day(WED), endsAt: day(THU), reason: SENSITIVE });
  const r = await avail(s, { staff: 'Falla', service_id: s.serviceHaircut, from: day(WED).toISOString(), to: day(THU).toISOString(), explain: 'true' });
  const f = r.json.explanation.staff[0];
  assert.equal(f.summary, 'absence');
  assert.equal(f.public_reason, null);
  assert.equal(f.customer_message, 'Falla no tiene disponibilidad para ese horario.');
  assert.ok(!r.text.includes('vacaciones'));
  assert.ok(!leaks(r.text));
});

test('site closure, service mismatch and not bookable', async () => {
  const s = await gallery();
  await createException({ tenantId: s.tenantId, siteId: s.siteId, staffId: null, startsAt: day(WED), endsAt: day(THU), reason: 'Fumigación interna', publicReason: 'site_closed' });
  const closed = await avail(s, { staff: 'Falla', service_id: s.serviceHaircut, from: day(WED).toISOString(), to: day(THU).toISOString(), explain: 'true' });
  assert.equal(closed.json.explanation.staff[0].customer_message, 'La sede está cerrada en esa fecha.');
  assert.deepEqual(closed.json.explanation.alternatives, [], 'nobody else either');
  assert.ok(!closed.text.includes('Fumigación'));

  // Federico does not do Color: the 409 is unchanged, explain adds why.
  const mm = await avail(s, { staff: 'Federico', service_id: s.serviceColor, from: day(THU).toISOString(), to: day('2026-11-06').toISOString(), explain: 'true' });
  assert.equal(mm.status, 409);
  assert.equal(mm.json.error.code, 'staff_service_mismatch');
  assert.equal(mm.json.explanation.staff[0].summary, 'staff_does_not_perform_service');
  assert.deepEqual(mm.json.explanation.alternatives.map((a: { staff_name: string }) => a.staff_name), ['Falla']);
  const mmPlain = await avail(s, { staff: 'Federico', service_id: s.serviceColor, from: day(THU).toISOString(), to: day('2026-11-06').toISOString() });
  assert.equal(mmPlain.json.explanation, undefined, 'no explain → the old body');

  await query(`UPDATE staff SET takes_bookings = false WHERE id = $1`, [s.federico]);
  const nb = await avail(s, { staff: 'Federico', service_id: s.serviceHaircut, from: day(THU).toISOString(), to: day('2026-11-06').toISOString(), explain: 'true' });
  assert.equal(nb.json.explanation.staff[0].summary, 'not_bookable');
});

test('status without a service: vacation day vs. working day; no appointment is read', async () => {
  const s = await gallery();
  await createException({ tenantId: s.tenantId, siteId: s.siteId, staffId: s.falla, startsAt: day(WED), endsAt: day(THU), reason: SENSITIVE, publicReason: 'vacation' });
  const r = await status(s, { staff: 'Falla', date: WED, days: '2' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.days.map((d: { date: string; status: string; summary: string; public_reason: string | null }) => [d.date, d.status, d.summary, d.public_reason]), [
    [WED, 'not_working', 'absence', 'vacation'],
    [THU, 'working', 'working', null],
  ]);
  assert.equal(r.json.days[0].customer_message, 'Falla está de vacaciones en esa fecha.');
  assert.deepEqual(r.json.days[1].shift, [{ from: '09:00', until: '18:00' }]);
  assert.ok(!leaks(r.text));
  assert.equal((await status(s, { date: WED })).status, 400, 'a professional is required');
  assert.equal((await status(s, { staff: 'Falla', date: '2026-02-31' })).status, 400);
  assert.equal((await status(s, { staff: 'Falla', date: WED, days: '15' })).status, 400);
});

test('isolation: another professional, another client, another tenant', async () => {
  const s = await gallery();
  // Federico's block never explains Falla; a block at the OTHER client's site never shows.
  await createException({ tenantId: s.tenantId, siteId: s.siteId, staffId: s.federico, startsAt: day(WED), endsAt: day(THU), reason: SENSITIVE, publicReason: 'vacation' });
  const other = await seedSiteForClient(s.tenantId, s.otherClientId);
  await createException({ tenantId: s.tenantId, siteId: other.siteId, staffId: null, startsAt: day(WED), endsAt: day(THU), reason: 'Otro negocio', publicReason: 'site_closed' });
  const r = await avail(s, { staff: 'Falla', service_id: s.serviceHaircut, from: day(WED).toISOString(), to: day(THU).toISOString(), explain: 'true' });
  assert.equal(r.json.explanation.staff[0].status, 'available');
  assert.ok(!r.text.includes('Otro negocio'));
  // The token of this client cannot read the other client's site at all.
  const foreign = await avail({ siteId: other.siteId, hdr: s.hdr }, { service_id: other.serviceId, from: day(WED).toISOString(), to: day(THU).toISOString(), explain: 'true' });
  assert.ok(foreign.status === 403 || foreign.status === 404, `foreign site → ${foreign.status}`);
  const foreignStatus = await status({ siteId: other.siteId, hdr: s.hdr }, { staff_id: other.staffId, date: WED });
  assert.ok(foreignStatus.status === 403 || foreignStatus.status === 404);
  // Another tenant's token.
  const t2 = await gallery();
  const cross = await avail({ siteId: s.siteId, hdr: t2.hdr }, { service_id: s.serviceHaircut, from: day(WED).toISOString(), to: day(THU).toISOString(), explain: 'true' });
  assert.ok(cross.status === 403 || cross.status === 404);
});

test('forms: the public reason is explicit, validated per scope, default none, never medical', async () => {
  const s = await gallery();
  const owner = await seedMember(s.tenantId, { role: 'owner' });
  users.push(owner);
  CURRENT = { id: owner, email: `${owner.slice(0, 8)}@test.local` };
  const full = { mode: 'full_day' as const, startDate: '2026-11-10', endDate: '2026-11-12' };

  const none = await createTimeOffAction({ clientId: s.clientId, siteId: s.siteId, staffId: s.falla, reason: 'Vacaciones', ...full });
  assert.ok(none.ok);
  const stored = await query<{ reason: string; public_reason: string | null }>(`SELECT reason, public_reason FROM schedule_exceptions WHERE id = $1`, [(none as { id: string }).id]);
  assert.deepEqual(stored.rows[0], { reason: 'Vacaciones', public_reason: null }, 'the internal text is NOT copied into the public reason');

  assert.ok((await updateTimeOffAction(s.clientId, (none as { id: string }).id, { publicReason: 'vacation', ...full, reason: 'Vacaciones' })).ok);
  const after = await query<{ public_reason: string | null }>(`SELECT public_reason FROM schedule_exceptions WHERE id = $1`, [(none as { id: string }).id]);
  assert.equal(after.rows[0].public_reason, 'vacation');

  for (const bad of ['medical', 'incapacidad', 'Vacaciones']) {
    const r = await createTimeOffAction({ clientId: s.clientId, siteId: s.siteId, staffId: s.federico, publicReason: bad, ...full });
    assert.equal(r.ok, false, `${bad} is refused`);
  }
  const siteVacation = await createExceptionAction({ clientId: s.clientId, siteId: s.siteId, staffId: null, startsAt: '2026-11-20T00:00', endsAt: '2026-11-21T00:00', publicReason: 'vacation' });
  assert.equal(siteVacation.ok, false, 'a site cannot be "on vacation"');
  const siteClosed = await createExceptionAction({ clientId: s.clientId, siteId: s.siteId, staffId: null, startsAt: '2026-11-20T00:00', endsAt: '2026-11-21T00:00', publicReason: 'site_closed' });
  assert.ok(siteClosed.ok);

  // The database refuses what the forms refuse.
  await assert.rejects(
    query(`INSERT INTO schedule_exceptions (tenant_id, site_id, staff_id, starts_at, ends_at, public_reason) VALUES ($1, $2, NULL, now() + interval '40 days', now() + interval '41 days', 'vacation')`, [s.tenantId, s.siteId]),
    (e: { code?: string }) => e.code === '23514',
  );
  await assert.rejects(
    query(`INSERT INTO schedule_exceptions (tenant_id, site_id, staff_id, starts_at, ends_at, public_reason) VALUES ($1, $2, $3, now() + interval '40 days', now() + interval '41 days', 'medical')`, [s.tenantId, s.siteId, s.falla]),
    (e: { code?: string }) => e.code === '23514',
  );
  CURRENT = null;
});
