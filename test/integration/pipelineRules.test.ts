import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { cleanupTenant, closeDb, seedContact, seedScenario, seedWorkflow } from './fixtures.js';
import { getOrCreateConversation } from '../../src/db/repositories/handoff.js';
import type { AppointmentRow } from '../../src/db/repositories/scheduling/appointments.js';
import { transitionStatus } from '../../src/scheduling/booking.js';
import {
  getOpenOpportunityForContact,
  getOpportunityById,
  listOpportunityStageEvents,
  setPipelineSettings,
} from '../../src/db/repositories/pipeline.js';
import {
  markOpportunityLost,
  onAppointmentStatusChanged,
  onBookingCreated,
  openOnInbound,
  qualifyOpportunity,
} from '../../src/pipeline/engine.js';
import { countAwaitingBusinessReply, runAutoLostOnce } from '../../src/pipeline/autoLost.js';

/**
 * PL-1 §2 — the automatic pipeline rules, exercised against the real engine + DB. Each test seeds
 * its own tenant and drops it. The opportunity (one sale), not the contact, moves through the funnel.
 */
const tenants: string[] = [];
after(async () => { for (const t of tenants) await cleanupTenant(t); await closeDb(); });

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await query<T>(sql, params)).rows[0];

async function fixture() {
  const s = await seedScenario({ enableCrm: true });
  tenants.push(s.tenantId);
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: true });
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'scheduling', enabled: true });
  const workflowRef = `wf-${randomUUID()}`;
  await seedWorkflow(s.tenantId, s.clientId, workflowRef);
  return { ...s, workflowRef };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function mkContact(s: Fixture): Promise<string> {
  return seedContact(s.tenantId, s.clientId, { name: 'Lead', channelUserId: `wa:${randomUUID().slice(0, 8)}` });
}
async function mkConversation(s: Fixture, contactId: string): Promise<string> {
  const c = await getOrCreateConversation(s.tenantId, s.workflowRef, `co-${randomUUID()}`);
  await query(`UPDATE conversations SET contact_id = $2 WHERE id = $1`, [c.id, contactId]);
  return c.id;
}
/** A message in a conversation, N minutes ago, from a given sender. */
async function mkMessage(s: Fixture, conversationId: string, sender: 'user' | 'bot' | 'human_agent', agoMin = 0): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO handoff_messages (tenant_id, conversation_id, sender, status, text, content_type, occurred_at, created_at)
       VALUES ($1,$2,$3,$4,'m','text', now() - make_interval(mins => $5::int), now() - make_interval(mins => $5::int)) RETURNING id`,
    [s.tenantId, conversationId, sender, sender === 'user' ? 'received' : 'sent', agoMin],
  );
  return r.id;
}
async function mkAd(s: Fixture, isTest = false): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO ads (tenant_id, client_id, platform, source_type, external_id) VALUES ($1,$2,'meta','ad',$3) RETURNING id`,
    [s.tenantId, s.clientId, isTest ? `TEST-${randomUUID().slice(0, 8)}` : `ext-${randomUUID().slice(0, 10)}`],
  );
  return r.id;
}
async function mkTouch(s: Fixture, contactId: string, conversationId: string, messageId: string, adId: string, agoHours = 1): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO attribution_touches (tenant_id, client_id, contact_id, conversation_id, message_id, ad_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() - make_interval(hours => $7::int)) RETURNING id`,
    [s.tenantId, s.clientId, contactId, conversationId, messageId, adId, agoHours],
  );
  return r.id;
}
async function seedOpp(s: Fixture, o: { contactId: string; conversationId?: string | null; stage: string; status: string; closedAgoDays?: number; lostReason?: string | null; originTouchId?: string | null }): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO opportunities (tenant_id, client_id, contact_id, conversation_id, status, stage, lead_at, booked_at, origin_touch_id, lost_reason, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6, now(),
         CASE WHEN $6 IN ('booked','attended','paid') THEN now() ELSE NULL END, $7, $8,
         CASE WHEN $5 = 'open' THEN NULL ELSE now() - make_interval(days => $9::int) END)
     RETURNING id`,
    [s.tenantId, s.clientId, o.contactId, o.conversationId ?? null, o.status, o.stage, o.originTouchId ?? null, o.lostReason ?? null, o.closedAgoDays ?? 0],
  );
  return r.id;
}
// Each appointment gets a UNIQUE future slot so the staff anti-double-book exclusion never fires.
let apptSlot = 0;
async function seedAppt(s: Fixture, o: { contactId?: string | null; conversationId?: string | null; status?: string; opportunityId?: string | null }): Promise<AppointmentRow> {
  const slotHours = 24 + apptSlot++ * 2;
  const r = await one<AppointmentRow>(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id,
        start_at, service_end_at, blocked_from, blocked_until,
        service_name_snapshot, duration_min_snapshot, price_snapshot, buffer_before_min_snapshot, buffer_after_min_snapshot,
        status, origin, created_by_type, contact_id, source_conversation_id, opportunity_id)
     VALUES ($1,$2,$3,$4,$5,
        now() + make_interval(hours => $10::int), now() + make_interval(hours => $10::int) + interval '60 min',
        now() + make_interval(hours => $10::int), now() + make_interval(hours => $10::int) + interval '60 min',
        'Haircut', 60, '50000', 0, 0, $6, 'n8n', 'n8n', $7, $8, $9)
     RETURNING *`,
    [s.tenantId, s.clientId, s.siteId, s.staffA, s.serviceHaircut, o.status ?? 'scheduled', o.contactId ?? null, o.conversationId ?? null, o.opportunityId ?? null, slotHours],
  );
  return r;
}
const openOf = (s: Fixture, contactId: string) => getOpenOpportunityForContact(s.tenantId, s.clientId, contactId);
const eventsOf = (s: Fixture, oppId: string) => listOpportunityStageEvents(s.tenantId, oppId);

// ── OPENING ────────────────────────────────────────────────────────────────────

test('opening: an inbound message carrying an ad touch opens a lead with that origin', async () => {
  const s = await fixture();
  const contact = await mkContact(s);
  const conv = await mkConversation(s, contact);
  const msg = await mkMessage(s, conv, 'user');
  const touch = await mkTouch(s, contact, conv, msg, await mkAd(s));
  await openOnInbound({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, conversationId: conv, messageId: msg });
  const opp = await openOf(s, contact);
  assert.ok(opp, 'an open opportunity was created');
  assert.equal(opp!.stage, 'lead');
  assert.equal(opp!.status, 'open');
  assert.equal(opp!.origin_touch_id, touch);
  assert.equal((await eventsOf(s, opp!.id)).length, 1, 'exactly one opening event');
});

test('opening: a brand-new contact (no touch, no prior opp/appointment) opens a lead', async () => {
  const s = await fixture();
  const contact = await mkContact(s);
  const conv = await mkConversation(s, contact);
  const msg = await mkMessage(s, conv, 'user');
  await openOnInbound({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, conversationId: conv, messageId: msg });
  const opp = await openOf(s, contact);
  assert.ok(opp, 'opened for a brand-new contact');
  assert.equal(opp!.stage, 'lead');
  assert.equal(opp!.origin_touch_id, null);
});

test('opening: a returning customer\'s ordinary message (has a past appointment, no touch) opens nothing', async () => {
  const s = await fixture();
  const contact = await mkContact(s);
  await seedAppt(s, { contactId: contact, status: 'completed' }); // a prior appointment → not brand-new
  const conv = await mkConversation(s, contact);
  const msg = await mkMessage(s, conv, 'user');
  await openOnInbound({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, conversationId: conv, messageId: msg });
  assert.equal(await openOf(s, contact), null, 'no opportunity opened by an ordinary returning message');
});

test('opening: an existing open opportunity is left untouched (idempotent, no extra event)', async () => {
  const s = await fixture();
  const contact = await mkContact(s);
  const conv = await mkConversation(s, contact);
  const oppId = await seedOpp(s, { contactId: contact, conversationId: conv, stage: 'lead', status: 'open' });
  const msg = await mkMessage(s, conv, 'user');
  await openOnInbound({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, conversationId: conv, messageId: msg });
  const opp = await openOf(s, contact);
  assert.equal(opp!.id, oppId, 'the same open opportunity');
  assert.equal((await eventsOf(s, oppId)).length, 0, 'no new event (it was already open)');
});

// ── REOPEN ───────────────────────────────────────────────────────────────────────

test('reopen: a lost opportunity inside the reopen window is reopened at its stage, keeping origin', async () => {
  const s = await fixture();
  const contact = await mkContact(s);
  const conv = await mkConversation(s, contact);
  const touch = await mkTouch(s, contact, conv, await mkMessage(s, conv, 'user', 100), await mkAd(s), 48);
  const lost = await seedOpp(s, { contactId: contact, conversationId: conv, stage: 'qualified', status: 'lost', lostReason: 'no_respondio', closedAgoDays: 5, originTouchId: touch });
  const msg = await mkMessage(s, conv, 'user');
  await openOnInbound({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, conversationId: conv, messageId: msg });
  const opp = await openOf(s, contact);
  assert.equal(opp!.id, lost, 'the SAME opportunity reopened');
  assert.equal(opp!.stage, 'qualified', 'reopened at the stage it had when lost');
  assert.equal(opp!.origin_touch_id, touch, 'origin preserved');
  assert.equal((await eventsOf(s, lost)).length, 1, 'one reopen event');
});

test('reopen: past the window, an ordinary message does not reopen (stays lost), opens nothing', async () => {
  const s = await fixture();
  const contact = await mkContact(s);
  const conv = await mkConversation(s, contact);
  const lost = await seedOpp(s, { contactId: contact, conversationId: conv, stage: 'lead', status: 'lost', lostReason: 'no_respondio', closedAgoDays: 40 });
  const msg = await mkMessage(s, conv, 'user');
  await openOnInbound({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, conversationId: conv, messageId: msg });
  assert.equal(await openOf(s, contact), null, 'nothing reopened or opened');
  assert.equal((await getOpportunityById(s.tenantId, s.clientId, lost))!.status, 'lost');
});

// ── BOOKING ───────────────────────────────────────────────────────────────────────

test('booking: a conversational (third-party) booking links to the SENDER\'s opportunity', async () => {
  const s = await fixture();
  const sender = await mkContact(s);
  const attendee = await mkContact(s);
  const conv = await mkConversation(s, sender);
  const senderOpp = await seedOpp(s, { contactId: sender, conversationId: conv, stage: 'lead', status: 'open' });
  const appt = await seedAppt(s, { contactId: attendee, conversationId: conv });
  await onBookingCreated(appt, { kind: 'bot' });
  const sOpp = await getOpportunityById(s.tenantId, s.clientId, senderOpp);
  assert.equal(sOpp!.stage, 'booked', 'the sender\'s sale advanced to booked');
  assert.equal(await openOf(s, attendee), null, 'the attendee got no opportunity');
  const linked = await one<{ opportunity_id: string }>(`SELECT opportunity_id FROM appointments WHERE id = $1`, [appt.id]);
  assert.equal(linked.opportunity_id, senderOpp, 'appointment linked to the sender sale');
});

test('booking: with no open opportunity, one is created directly at booked (implicitly qualified)', async () => {
  const s = await fixture();
  const contact = await mkContact(s);
  const appt = await seedAppt(s, { contactId: contact }); // booking-page style: no conversation
  await onBookingCreated(appt, { kind: 'system' });
  const opp = await openOf(s, contact);
  assert.ok(opp, 'a sale was created');
  assert.equal(opp!.stage, 'booked');
  assert.equal(opp!.qualified_implicitly, true);
  assert.ok(opp!.qualified_at, 'qualified_at set (qualification skipped)');
  assert.ok(opp!.booked_at, 'booked_at set');
});

test('booking: from lead skips qualification (qualified_at = booked_at, implicit); one advance event', async () => {
  const s = await fixture();
  const contact = await mkContact(s);
  const conv = await mkConversation(s, contact);
  const oppId = await seedOpp(s, { contactId: contact, conversationId: conv, stage: 'lead', status: 'open' });
  const appt = await seedAppt(s, { contactId: contact, conversationId: conv });
  await onBookingCreated(appt, { kind: 'bot' });
  const opp = await getOpportunityById(s.tenantId, s.clientId, oppId);
  assert.equal(opp!.stage, 'booked');
  assert.equal(opp!.qualified_implicitly, true);
  assert.ok(opp!.qualified_at, 'implicitly qualified');
  assert.equal((await eventsOf(s, oppId)).length, 1, 'exactly one event (lead → booked)');
});

// ── AFTER BOOKING ──────────────────────────────────────────────────────────────────

test('completed → attended + won (closed); no_show → lost (no_asistio)', async () => {
  const s = await fixture();
  const contact = await mkContact(s);
  const oppId = await seedOpp(s, { contactId: contact, stage: 'booked', status: 'open' });
  const appt = await seedAppt(s, { contactId: contact, opportunityId: oppId });
  await onAppointmentStatusChanged(appt, 'completed', { kind: 'system' });
  let opp = await getOpportunityById(s.tenantId, s.clientId, oppId);
  assert.equal(opp!.stage, 'attended');
  assert.equal(opp!.status, 'won');
  assert.ok(opp!.closed_at && opp!.attended_at);

  const contact2 = await mkContact(s);
  const opp2 = await seedOpp(s, { contactId: contact2, stage: 'booked', status: 'open' });
  const appt2 = await seedAppt(s, { contactId: contact2, opportunityId: opp2 });
  await onAppointmentStatusChanged(appt2, 'no_show', { kind: 'system' });
  opp = await getOpportunityById(s.tenantId, s.clientId, opp2);
  assert.equal(opp!.status, 'lost');
  assert.equal(opp!.lost_reason, 'no_asistio');
});

test('cancel: reverts booked → qualified only when NO other active appointment remains', async () => {
  const s = await fixture();
  // Two active appointments on one sale → cancelling one leaves it booked.
  const c1 = await mkContact(s);
  const oppA = await seedOpp(s, { contactId: c1, stage: 'booked', status: 'open' });
  const a1 = await seedAppt(s, { contactId: c1, opportunityId: oppA, status: 'scheduled' });
  await seedAppt(s, { contactId: c1, opportunityId: oppA, status: 'confirmed' });
  await onAppointmentStatusChanged(a1, 'cancelled', { kind: 'system' });
  assert.equal((await getOpportunityById(s.tenantId, s.clientId, oppA))!.stage, 'booked', 'other active appt → stays booked');

  // Single appointment → cancelling reverts to qualified.
  const c2 = await mkContact(s);
  const oppB = await seedOpp(s, { contactId: c2, stage: 'booked', status: 'open' });
  const b1 = await seedAppt(s, { contactId: c2, opportunityId: oppB, status: 'scheduled' });
  await onAppointmentStatusChanged(b1, 'cancelled', { kind: 'system' });
  assert.equal((await getOpportunityById(s.tenantId, s.clientId, oppB))!.stage, 'qualified', 'no other active → back to qualified');
});

test('no-show then a later booking inside the reopen window reopens the sale', async () => {
  const s = await fixture();
  const contact = await mkContact(s);
  const conv = await mkConversation(s, contact);
  const oppId = await seedOpp(s, { contactId: contact, conversationId: conv, stage: 'booked', status: 'open' });
  const appt = await seedAppt(s, { contactId: contact, conversationId: conv, opportunityId: oppId });
  await onAppointmentStatusChanged(appt, 'no_show', { kind: 'system' });
  assert.equal((await getOpportunityById(s.tenantId, s.clientId, oppId))!.status, 'lost');
  // A new booking on the same contact, within the window, reopens THAT sale.
  const appt2 = await seedAppt(s, { contactId: contact, conversationId: conv });
  await onBookingCreated(appt2, { kind: 'system' });
  const opp = await getOpportunityById(s.tenantId, s.clientId, oppId);
  assert.equal(opp!.status, 'open', 'reopened');
  assert.equal(opp!.stage, 'booked');
});

// ── AUTO-LOST ───────────────────────────────────────────────────────────────────────

test('auto-lost: business spoke last and went unanswered past the threshold → lost (no_respondio)', async () => {
  const s = await fixture();
  await setPipelineSettings(s.tenantId, s.clientId, { auto_lost_after_hours: 10 });
  const contact = await mkContact(s);
  const conv = await mkConversation(s, contact);
  await mkMessage(s, conv, 'user', 60 * 20);
  await mkMessage(s, conv, 'bot', 60 * 15); // business spoke last, 15h ago (> 10h threshold)
  const oppId = await seedOpp(s, { contactId: contact, conversationId: conv, stage: 'lead', status: 'open' });
  const res = await runAutoLostOnce({ tenantId: s.tenantId });
  assert.equal(res.lost, 1);
  const opp = await getOpportunityById(s.tenantId, s.clientId, oppId);
  assert.equal(opp!.status, 'lost');
  assert.equal(opp!.lost_reason, 'no_respondio');
});

test('auto-lost: NEVER when the customer spoke last (counted as awaiting business reply)', async () => {
  const s = await fixture();
  await setPipelineSettings(s.tenantId, s.clientId, { auto_lost_after_hours: 1 });
  const contact = await mkContact(s);
  const conv = await mkConversation(s, contact);
  await mkMessage(s, conv, 'bot', 60 * 10);
  await mkMessage(s, conv, 'user', 60 * 5); // customer spoke last
  const oppId = await seedOpp(s, { contactId: contact, conversationId: conv, stage: 'qualified', status: 'open' });
  const res = await runAutoLostOnce({ tenantId: s.tenantId });
  assert.equal(res.lost, 0, 'not auto-lost');
  assert.equal((await getOpportunityById(s.tenantId, s.clientId, oppId))!.status, 'open');
  assert.ok((await countAwaitingBusinessReply(s.tenantId)) >= 1, 'counted as sin respuesta del negocio');
});

test('auto-lost: NEVER touches a booked opportunity', async () => {
  const s = await fixture();
  await setPipelineSettings(s.tenantId, s.clientId, { auto_lost_after_hours: 1 });
  const contact = await mkContact(s);
  const conv = await mkConversation(s, contact);
  await mkMessage(s, conv, 'bot', 60 * 50);
  const oppId = await seedOpp(s, { contactId: contact, conversationId: conv, stage: 'booked', status: 'open' });
  const res = await runAutoLostOnce({ tenantId: s.tenantId });
  assert.equal(res.lost, 0);
  assert.equal((await getOpportunityById(s.tenantId, s.clientId, oppId))!.stage, 'booked');
});

// ── INVARIANTS ──────────────────────────────────────────────────────────────────────

test('one open opportunity per contact under concurrency', async () => {
  const s = await fixture();
  const contact = await mkContact(s);
  const conv = await mkConversation(s, contact);
  const msgs = await Promise.all([0, 1, 2, 3, 4].map(() => mkMessage(s, conv, 'user')));
  await Promise.all(msgs.map((m) => openOnInbound({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, conversationId: conv, messageId: m })));
  const n = await one<{ n: number }>(`SELECT count(*)::int n FROM opportunities WHERE contact_id = $1 AND status = 'open'`, [contact]);
  assert.equal(n.n, 1, 'exactly one open opportunity despite concurrent opens');
});

test('the full happy path writes exactly one event per transition', async () => {
  const s = await fixture();
  const contact = await mkContact(s);
  const conv = await mkConversation(s, contact);
  const msg = await mkMessage(s, conv, 'user');
  await openOnInbound({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, conversationId: conv, messageId: msg }); // null→lead
  const oppId = (await openOf(s, contact))!.id;
  await qualifyOpportunity(s.tenantId, s.clientId, oppId, { service: 'Haircut' }, { kind: 'bot' }); // lead→qualified
  const appt = await seedAppt(s, { contactId: contact, conversationId: conv });
  await onBookingCreated(appt, { kind: 'bot' }); // qualified→booked
  await onAppointmentStatusChanged({ ...appt, opportunity_id: oppId }, 'completed', { kind: 'system' }); // booked→attended (won)
  const events = await eventsOf(s, oppId);
  assert.equal(events.length, 4, 'four transitions → four events');
  assert.deepEqual(events.map((e) => [e.from_stage, e.to_stage]), [[null, 'lead'], ['lead', 'qualified'], ['qualified', 'booked'], ['booked', 'attended']]);
});

test('transitionStatus (the real booking chokepoint) drives the linked sale to won', async () => {
  const s = await fixture();
  const contact = await mkContact(s);
  const oppId = await seedOpp(s, { contactId: contact, stage: 'booked', status: 'open' });
  const appt = await seedAppt(s, { contactId: contact, opportunityId: oppId, status: 'scheduled' });
  const r = await transitionStatus('completed', { tenantId: s.tenantId, appointmentId: appt.id, actorType: 'n8n', scopeClientId: s.clientId });
  assert.ok(r.ok, 'the appointment completed');
  const opp = await getOpportunityById(s.tenantId, s.clientId, oppId);
  assert.equal(opp!.status, 'won', 'the post-commit pipeline hook won the sale');
});

test('manual mark-lost requires a note for otro; isolation between clients is preserved', async () => {
  const s = await fixture();
  const contact = await mkContact(s);
  const oppId = await seedOpp(s, { contactId: contact, stage: 'lead', status: 'open' });
  await assert.rejects(() => markOpportunityLost(s.tenantId, s.clientId, oppId, 'otro', null, { kind: 'user', userId: 'u1' }), /otro/);
  await markOpportunityLost(s.tenantId, s.clientId, oppId, 'precio', null, { kind: 'user', userId: 'u1' });
  assert.equal((await getOpportunityById(s.tenantId, s.clientId, oppId))!.status, 'lost');
  // Another client in the same tenant cannot see / mutate it.
  assert.equal(await getOpportunityById(s.tenantId, s.otherClientId, oppId), null, 'cross-client read refused');
});
