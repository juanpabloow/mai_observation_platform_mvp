import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { createAppointment, rescheduleAppointment } from '../../src/scheduling/booking.js';
import { loadAvailability } from '../../src/db/repositories/scheduling/availabilityData.js';
import { listStaffForService } from '../../src/db/repositories/scheduling/staff.js';
import { listBookableServicesForSite, listServicesForSite } from '../../src/db/repositories/scheduling/services.js';
import { claimFailedMessageForRetry, getOrCreateConversation, insertMessage } from '../../src/db/repositories/handoff.js';
import { getHandoffSendSummary } from '../../src/db/repositories/analytics.js';
import { cleanupTenant, closeDb, seedMember, seedScenario } from './fixtures.js';

/**
 * Fixes from the Gallery production incidents, against an ISOLATED test database with
 * synthetic data (seedScenario). Covers: professionals who do not take bookings, the
 * bot's service list, dated blocks and pauses, full service duration, reschedule with the
 * booking's own snapshot, concurrency, idempotency, multi-tenant isolation and the
 * atomic retry claim for failed WhatsApp sends.
 */
const TZ = 'America/Bogota';
const NOW = zonedPartsToUtc(2026, 8, 1, 0, 0, TZ);
const wed = (h: number, m = 0): Date => zonedPartsToUtc(2026, 8, 5, h, m, TZ); // 9–18 open
const thu = (h: number, m = 0): Date => zonedPartsToUtc(2026, 8, 6, h, m, TZ);

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

async function scenario() {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  return s;
}

const book = (s: Awaited<ReturnType<typeof scenario>>, startAt: Date, opts: { staffId?: string | null; serviceId?: string; key?: string | null } = {}) =>
  createAppointment({
    tenantId: s.tenantId,
    siteId: s.siteId,
    serviceId: opts.serviceId ?? s.serviceHaircut,
    staffId: opts.staffId === undefined ? s.staffA : opts.staffId,
    startAt,
    channel: null,
    channelUserId: null,
    customerName: null,
    customerPhone: null,
    origin: 'internal',
    createdByType: 'system',
    scopeClientId: s.clientId,
    idempotencyKey: opts.key ?? null,
    now: NOW,
  });

const slotsOf = async (s: Awaited<ReturnType<typeof scenario>>, from: Date, to: Date, opts: { staffId?: string | null; serviceId?: string } = {}) => {
  const r = await loadAvailability({ tenantId: s.tenantId, siteId: s.siteId, serviceId: opts.serviceId ?? s.serviceHaircut, staffId: opts.staffId ?? null, from, to, now: NOW });
  return r?.slots ?? [];
};

// ── takes_bookings, on every surface (they all book through the engine) ──────────

test('a professional who does not take bookings is never a candidate, nor bookable directly', async () => {
  const s = await scenario();
  await query(`UPDATE staff SET takes_bookings = false WHERE id = $1`, [s.staffB]);
  const slots = await slotsOf(s, wed(9), wed(18));
  assert.ok(slots.length > 0);
  assert.ok(slots.every((sl) => sl.candidates.every((c) => c.staff_id !== s.staffB)), '"any professional" never assigns them');
  const direct = await book(s, wed(10), { staffId: s.staffB });
  assert.equal(direct.ok, false, 'a hand-crafted staff_id is refused too');
  const any = await book(s, wed(10), { staffId: null });
  assert.ok(any.ok && any.value.staff_id === s.staffA);
  const bot = await listStaffForService(s.tenantId, s.siteId, s.serviceHaircut);
  assert.deepEqual(bot.map((x) => x.id), [s.staffA], 'the bot staff list agrees');
});

test("the bot's service list only offers what a bookable professional can perform", async () => {
  const s = await scenario();
  // Color is performed only by staffA; once A stops taking bookings nobody can do it.
  await query(`UPDATE staff SET takes_bookings = false WHERE id = $1`, [s.staffA]);
  const bot = (await listBookableServicesForSite(s.tenantId, s.siteId)).map((x) => x.id);
  assert.ok(!bot.includes(s.serviceColor), 'not offered to the bot');
  assert.ok(bot.includes(s.serviceHaircut) && bot.includes(s.serviceBeard));
  const admin = (await listServicesForSite(s.tenantId, s.siteId)).map((x) => x.id);
  assert.ok(admin.includes(s.serviceColor), 'the agenda/settings list is unchanged');
  // An inactive service is never offered either.
  await query(`UPDATE services SET active = false WHERE id = $1`, [s.serviceBeard]);
  assert.ok(!(await listBookableServicesForSite(s.tenantId, s.siteId)).some((x) => x.id === s.serviceBeard));
});

// ── Dated blocks and pauses ──────────────────────────────────────────────────────

test('a dated pause blocks only that professional on that day; a site block blocks everyone', async () => {
  const s = await scenario();
  await query(`INSERT INTO schedule_exceptions (tenant_id, site_id, staff_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4,$5,'Pausa')`, [
    s.tenantId,
    s.siteId,
    s.staffA,
    wed(12, 25),
    wed(13, 25),
  ]);
  const onWed = await slotsOf(s, wed(9), wed(18), { staffId: s.staffA, serviceId: s.serviceBeard });
  const overlapsPause = (start: Date) => start < wed(13, 25) && new Date(start.getTime() + 30 * 60_000) > wed(12, 25);
  assert.ok(onWed.length > 0);
  assert.ok(!onWed.some((sl) => overlapsPause(sl.start_at)), 'no 30-min slot touches 12:25–13:25');
  const onThu = await slotsOf(s, thu(12), thu(14), { staffId: s.staffA, serviceId: s.serviceBeard });
  assert.ok(onThu.some((sl) => sl.start_at.getTime() === thu(12, 30).getTime()), 'the next day is untouched (not a weekly rule)');
  const staffBWed = await slotsOf(s, wed(12), wed(14), { staffId: s.staffB, serviceId: s.serviceBeard });
  assert.ok(staffBWed.some((sl) => sl.start_at.getTime() === wed(12, 30).getTime()), 'the other professional is untouched');
  // A site-wide block (staff_id NULL) blocks everyone.
  await query(`INSERT INTO schedule_exceptions (tenant_id, site_id, staff_id, starts_at, ends_at, reason) VALUES ($1,$2,NULL,$3,$4,'Cierre')`, [
    s.tenantId,
    s.siteId,
    thu(10),
    thu(18),
  ]);
  assert.equal((await slotsOf(s, thu(10), thu(18), { serviceId: s.serviceBeard })).length, 0);
});

test('a slot needs the FULL service duration inside the hours', async () => {
  const s = await scenario();
  const slots = await slotsOf(s, wed(16), wed(18), { staffId: s.staffA }); // 60-min Haircut, closes 18:00
  const starts = slots.map((sl) => sl.start_at.getTime());
  assert.ok(starts.includes(wed(17).getTime()), '17:00 + 60 min fits');
  assert.ok(!starts.includes(wed(17, 30).getTime()), '17:30 + 60 min would end after closing');
});

// ── Reschedule uses the booking's own snapshot ───────────────────────────────────

test('reschedule checks the slot with the snapshot, not the service changed afterwards', async () => {
  const s = await scenario();
  const beard = await book(s, wed(10), { serviceId: s.serviceBeard }); // 30 min, snapshot
  assert.ok(beard.ok);
  const later = await book(s, wed(11), { serviceId: s.serviceBeard });
  assert.ok(later.ok);
  // The catalogue changes after booking: the service now lasts 2 h.
  await query(`UPDATE services SET duration_min = 120 WHERE id = $1`, [s.serviceBeard]);
  // Moving the 30-min booking to 10:30 ends at 11:00 — free. The old check (current 120 min)
  // refused it because 10:30–12:30 overlaps the 11:00 booking.
  if (!beard.ok) throw new Error('unreachable');
  const moved = await rescheduleAppointment({ tenantId: s.tenantId, appointmentId: beard.value.id, startAt: wed(10, 30), actorType: 'system', scopeClientId: s.clientId, now: NOW });
  assert.ok(moved.ok, moved.ok ? '' : moved.message);
  if (!moved.ok) throw new Error('unreachable');
  assert.equal(moved.value.duration_min_snapshot, 30, 'the history keeps its own duration');
  assert.equal(moved.value.service_end_at.getTime(), wed(11).getTime());
});

// ── Concurrency and idempotency ──────────────────────────────────────────────────

test('two simultaneous bookings for the same professional and time: exactly one wins', async () => {
  const s = await scenario();
  const results = await Promise.all([book(s, wed(15)), book(s, wed(15)), book(s, wed(15))]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && ['conflict_slot', 'unavailable', 'no_staff'].includes(r.error)));
});

test('the same idempotency key books once (an external id replayed by a reconciliation)', async () => {
  const s = await scenario();
  const key = `fresha:loc-test:appointment:${randomUUID()}`;
  const a = await book(s, wed(9), { key });
  const b = await book(s, wed(9), { key });
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) throw new Error('unreachable');
  assert.equal(a.value.id, b.value.id);
  const count = await query<{ n: number }>(`SELECT count(*)::int n FROM appointments WHERE tenant_id = $1 AND idempotency_key = $2`, [s.tenantId, key]);
  assert.equal(count.rows[0].n, 1);
});

test('multi-business isolation: another tenant sees nothing of this site', async () => {
  const s = await scenario();
  const other = await scenario();
  assert.deepEqual(await listBookableServicesForSite(other.tenantId, s.siteId), []);
  assert.deepEqual(await listStaffForService(other.tenantId, s.siteId, s.serviceHaircut), []);
  assert.equal(await loadAvailability({ tenantId: other.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, from: wed(9), to: wed(18), now: NOW }), null);
});

// ── WhatsApp sends: the retry claim ─────────────────────────────────────────────

test('a retry claims ONLY a still-failed human message, once — never a sent one', async () => {
  const s = await scenario();
  const agent = await seedMember(s.tenantId);
  const conv = await getOrCreateConversation(s.tenantId, 'wf-gallery', `c-${randomUUID().slice(0, 8)}`);
  const human = (status: 'failed' | 'sent') =>
    insertMessage({ tenantId: s.tenantId, conversationId: conv.id, sender: 'human_agent', agentUserId: agent, text: 'hola', status, occurredAt: new Date() });
  const failed = (await human('failed')).message;
  await query(`UPDATE handoff_messages SET failure_code = 'CHANNEL_ERROR', failure_detail = 'x' WHERE id = $1`, [failed.id]);
  const sent = (await human('sent')).message;

  // Two concurrent clicks: exactly one claim.
  const claims = await Promise.all([
    claimFailedMessageForRetry(s.tenantId, conv.id, failed.id),
    claimFailedMessageForRetry(s.tenantId, conv.id, failed.id),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const won = claims.find(Boolean)!;
  assert.equal(won.status, 'sending');
  assert.equal(won.failure_code, null);
  assert.equal(await claimFailedMessageForRetry(s.tenantId, conv.id, failed.id), null, 'already sending');
  assert.equal(await claimFailedMessageForRetry(s.tenantId, conv.id, sent.id), null, 'a delivered message is never re-sent');
  const other = await scenario();
  assert.equal(await claimFailedMessageForRetry(other.tenantId, conv.id, failed.id), null, 'other tenant');
});

// ── Analytics: agent sends apart from execution success ─────────────────────────

test('agent-send summary: only human-agent messages of THIS workflow and tenant, by outcome', async () => {
  const s = await scenario();
  const agent = await seedMember(s.tenantId);
  const wf = `wf-${randomUUID().slice(0, 6)}`;
  const conv = await getOrCreateConversation(s.tenantId, wf, `c-${randomUUID().slice(0, 8)}`);
  const otherWf = await getOrCreateConversation(s.tenantId, 'wf-other', `c-${randomUUID().slice(0, 8)}`);
  const put = async (convId: string, sender: 'human_agent' | 'user' | 'bot', status: 'sent' | 'failed' | 'sending' | 'received', code?: string) => {
    const m = (await insertMessage({ tenantId: s.tenantId, conversationId: convId, sender, agentUserId: sender === 'human_agent' ? agent : undefined, text: 'x', status, occurredAt: new Date() })).message;
    if (code) await query(`UPDATE handoff_messages SET failure_code = $2 WHERE id = $1`, [m.id, code]);
  };
  await put(conv.id, 'human_agent', 'sent');
  await put(conv.id, 'human_agent', 'sent');
  await put(conv.id, 'human_agent', 'failed', 'CHANNEL_POLICY');
  await put(conv.id, 'human_agent', 'failed', 'CHANNEL_ERROR');
  await put(conv.id, 'human_agent', 'sending');
  await put(conv.id, 'user', 'received'); // not a send
  await put(conv.id, 'bot', 'received'); // not an agent send
  await put(otherWf.id, 'human_agent', 'failed', 'CHANNEL_ERROR'); // another workflow
  const sum = await getHandoffSendSummary({ tenantId: s.tenantId, n8nWorkflowId: wf, days: 30 });
  assert.deepEqual({ total: sum.total, accepted: sum.accepted, failed: sum.failed, pending: sum.pending }, { total: 5, accepted: 2, failed: 2, pending: 1 });
  assert.deepEqual(sum.failedByCode, [{ code: 'CHANNEL_ERROR', count: 1 }, { code: 'CHANNEL_POLICY', count: 1 }]);
  const other = await scenario();
  assert.equal((await getHandoffSendSummary({ tenantId: other.tenantId, n8nWorkflowId: wf, days: 30 })).total, 0, 'tenant-scoped');
});
