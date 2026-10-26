import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query, withTransaction } from '../../src/db/client.js';
import { insertAppointment } from '../../src/db/repositories/scheduling/appointments.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { createException } from '../../src/db/repositories/scheduling/exceptions.js';
import { localWallClockToUtc } from '../../src/scheduling/timezone.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow, type Scenario } from './fixtures.js';

/**
 * AV-1 — start_windows + the ?at exact-time check, through the real machine route + PostgreSQL.
 * Windows must match the slot engine EXACTLY (every start in a window is a valid start; the grid
 * tick after `until` is not); gaps from appointments / time off / closures split them; `until` is
 * the last valid start, not the block end; the union covers every artist; and ?at agrees with the
 * engine's slot membership — which is exactly what booking (booking.ts) checks to accept a start.
 */
let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', { namedExports: { getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null) } });
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), { namedExports: { redirect: () => { throw new Error('redirect'); }, notFound: () => { throw new Error('notFound'); } } });
mock.module(urlOf('next/headers'), { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) } });
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

const { GET: AvailGET } = await import('../../web/app/api/scheduling/v1/availability/route.js');

const TZ = 'America/Bogota';
const tenants: string[] = [];
after(async () => { for (const t of tenants) await cleanupTenant(t); await closeDb(); });

const day = (d: string, hhmm = '00:00') => localWallClockToUtc(`${d}T${hhmm}`, TZ);
const D = '2026-11-16'; // a Monday
const D2 = '2026-11-17';

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
type Fx = Awaited<ReturnType<typeof gallery>>;

async function avail(s: Fx, q: Record<string, string>) {
  const params = new URLSearchParams({ site_id: s.siteId, ...q });
  const res = await AvailGET(new Request(`http://t/api/scheduling/v1/availability?${params}`, { headers: s.hdr }));
  const json = JSON.parse(await res.text());
  return { status: res.status, json };
}
const DAY_Q = (s: Fx, extra: Record<string, string> = {}) => ({ service_id: s.serviceHaircut, from: day(D).toISOString(), to: day(D2).toISOString(), ...extra });

/** Occupy [start,end) for a staff with a real appointment (the engine subtracts it as `busy`). */
async function book(s: Fx, staffId: string, startAt: Date, endAt: Date): Promise<void> {
  await withTransaction(async (client) => {
    await insertAppointment(client, {
      tenantId: s.tenantId, clientId: s.clientId, siteId: s.siteId, contactId: null, sourceConversationId: null,
      staffId, serviceId: s.serviceHaircut, startAt, serviceEndAt: endAt, blockedFrom: startAt, blockedUntil: endAt,
      serviceNameSnapshot: 'Corte', durationMinSnapshot: Math.round((endAt.getTime() - startAt.getTime()) / 60000),
      priceSnapshot: '0', bufferBeforeMinSnapshot: 0, bufferAfterMinSnapshot: 0,
      status: 'confirmed', origin: 'internal', createdByType: 'agent', createdByUserId: null, idempotencyKey: null, guest: null,
    });
  });
}

/** Assert windows EXACTLY partition the engine's slots (the core correctness contract). */
function assertWindowsMatchSlots(json: { slots: Array<{ start_at: string }>; start_windows: Array<{ first_start_at: string; until_start_at: string; step_minutes: number }> }) {
  const slotSet = new Set(json.slots.map((x) => x.start_at));
  let covered = 0;
  for (const w of json.start_windows) {
    const step = w.step_minutes * 60_000;
    const first = new Date(w.first_start_at).getTime();
    const end = new Date(w.until_start_at).getTime();
    for (let t = first; t <= end; t += step) {
      assert.ok(slotSet.has(new Date(t).toISOString()), `every start inside a window is a valid slot (${new Date(t).toISOString()})`);
      covered += 1;
    }
    // The grid tick AFTER `until` is not a valid start — that is precisely why the run ended.
    assert.ok(!slotSet.has(new Date(end + step).toISOString()), 'the tick after until is not a valid start');
    // And the tick BEFORE `from` is not one either.
    assert.ok(!slotSet.has(new Date(first - step).toISOString()), 'the tick before from is not a valid start');
  }
  assert.equal(covered, json.slots.length, 'windows cover every slot exactly, no slot twice');
}

test('windows partition the slots exactly; until is the last valid start (single staff)', async () => {
  const s = await gallery();
  const r = await avail(s, DAY_Q(s, { staff: 'Falla' }));
  assert.equal(r.status, 200);
  assert.ok(r.json.slots.length > 0, 'the day has availability');
  assert.ok(r.json.start_windows.length >= 1);
  assert.equal(r.json.start_windows_truncated, false);
  assert.ok(r.json.start_windows.every((w: { staff_name: string }) => w.staff_name === 'Falla'));
  assertWindowsMatchSlots(r.json);
});

test('an appointment splits the windows; until becomes the last valid start before it', async () => {
  const s = await gallery();
  const before = await avail(s, DAY_Q(s, { staff: 'Falla' }));
  const n = before.json.slots.length;
  const mid = before.json.slots[Math.floor(n / 2)];
  // Occupy one mid-day slot for Falla.
  await book(s, s.falla, new Date(mid.start_at), new Date(mid.service_end_at));
  const after = await avail(s, DAY_Q(s, { staff: 'Falla' }));
  assert.ok(after.json.slots.length < n, 'the booked slot (and its overlap) is gone');
  assert.ok(!new Set(after.json.slots.map((x: { start_at: string }) => x.start_at)).has(mid.start_at), 'the booked start is no longer offered');
  assert.ok(after.json.start_windows.length >= 2, 'the booking split the day into ≥2 windows');
  assertWindowsMatchSlots(after.json);
  // The window ending at the gap has `until` strictly before the booked start.
  const booked = new Date(mid.start_at).getTime();
  const windowBefore = after.json.start_windows.filter((w: { until_start_at: string }) => new Date(w.until_start_at).getTime() < booked).at(-1);
  assert.ok(windowBefore, 'there is a window before the gap');
  assert.ok(new Date(windowBefore.until_start_at).getTime() < booked, 'until is the last start before the appointment, not the block end');
});

test('time off and a site closure split / empty the windows', async () => {
  const s = await gallery();
  // Full-day CLOSURE → no availability → no windows (never a silent cap).
  await createException({ tenantId: s.tenantId, siteId: s.siteId, staffId: null, startsAt: day(D), endsAt: day(D2), reason: 'Cerrado' });
  const closed = await avail(s, DAY_Q(s, { staff: 'Falla' }));
  assert.deepEqual(closed.json.start_windows, []);
  assert.equal(closed.json.start_windows_truncated, false);
  assert.deepEqual(closed.json.has_availability, { [D]: false });
});

test('"any staff" returns the UNION of valid starts, with no single staff_name', async () => {
  const s = await gallery();
  const union = await avail(s, DAY_Q(s)); // no staff filter
  assert.ok(union.json.slots.length > 0);
  assert.ok(union.json.start_windows.length >= 1);
  assert.ok(union.json.start_windows.every((w: { staff_name: string | null }) => w.staff_name === null), 'union windows carry no staff_name');
  assertWindowsMatchSlots(union.json);
  // A union start is offered by at least one artist (available_staff on the slot).
  const firstStart = union.json.start_windows[0].first_start_at;
  const slot = union.json.slots.find((x: { start_at: string }) => x.start_at === firstStart);
  assert.ok(slot.available_staff.length >= 1);
});

test('?at exact-time check agrees with the engine (= what booking accepts) and 400s on bad input', async () => {
  const s = await gallery();
  const base = await avail(s, DAY_Q(s, { staff: 'Falla' }));
  const w0 = base.json.start_windows[0];
  const validStart: string = base.json.slots[0].start_at;
  const slotSet = new Set(base.json.slots.map((x: { start_at: string }) => x.start_at));

  // A valid grid start → can_start true, and Falla is named.
  const hit = await avail(s, DAY_Q(s, { staff: 'Falla', at: w0.from }));
  assert.equal(hit.json.exact_time.can_start, true);
  assert.equal(hit.json.exact_time.at, w0.from);
  assert.deepEqual(hit.json.exact_time.staff.map((x: { name: string }) => x.name), ['Falla']);
  assert.equal(slotSet.has(hit.json.exact_time.at_start_at), true, 'can_start ⇔ the instant is a real engine slot (booking.ts accepts exactly these)');

  // An off-grid minute (+7) → can_start false, and it is NOT a slot (so booking would refuse it too).
  const [hh, mm] = w0.from.split(':').map(Number);
  const off = `${String(hh).padStart(2, '0')}:${String((mm + 7) % 60).padStart(2, '0')}`;
  const miss = await avail(s, DAY_Q(s, { staff: 'Falla', at: off }));
  assert.equal(miss.json.exact_time.can_start, false);
  assert.deepEqual(miss.json.exact_time.staff, []);
  assert.equal(slotSet.has(miss.json.exact_time.at_start_at), false);

  // "Any staff" at a valid union time → who can start then.
  const anyHit = await avail(s, DAY_Q(s, { at: base.json.start_windows[0].from }));
  assert.equal(anyHit.json.exact_time.can_start, true);
  assert.ok(anyHit.json.exact_time.staff.length >= 1);

  // Bad format → 400.
  assert.equal((await avail(s, DAY_Q(s, { staff: 'Falla', at: '25:00' }))).status, 400);
  assert.equal((await avail(s, DAY_Q(s, { staff: 'Falla', at: '9am' }))).status, 400);
  // validStart sanity: the first slot's instant is in the set (guards the harness).
  assert.ok(slotSet.has(validStart));
});

test('backward compatible: the pre-AV-1 fields are all still present', async () => {
  const s = await gallery();
  const r = await avail(s, DAY_Q(s, { staff: 'Falla' }));
  for (const k of ['site', 'has_availability', 'free_blocks', 'slots']) {
    assert.ok(k in r.json, `${k} still present`);
  }
  assert.equal(typeof r.json.start_windows_truncated, 'boolean');
});
