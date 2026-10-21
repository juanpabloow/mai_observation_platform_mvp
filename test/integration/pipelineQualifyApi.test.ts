import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedContact, seedScenario, seedWorkflow } from './fixtures.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { getOrCreateConversation } from '../../src/db/repositories/handoff.js';
import {
  getLatestOpportunityForContact,
  getOpenOpportunityForContact,
  getOpportunityById,
  listOpportunityStageEvents,
} from '../../src/db/repositories/pipeline.js';
import { unqualifyOpportunity } from '../../src/pipeline/engine.js';

/**
 * PL-3 — POST /api/crm/v1/opportunities/qualify, the BOT-qualifies endpoint, against the real
 * route handler + engine + DB. Each test seeds its own tenant and drops it. Every action goes
 * through PL-1's engine (actor = bot); a person's UI correction (unqualify) still works after.
 */

const { POST } = await import('../../web/app/api/crm/v1/opportunities/qualify/route.js');

const tenants: string[] = [];
after(async () => { for (const t of tenants) await cleanupTenant(t); await closeDb(); });

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await query<T>(sql, params)).rows[0];

async function fx(opts: { enableCrm?: boolean; caps?: string[] } = {}) {
  const s = await seedScenario({ enableCrm: opts.enableCrm ?? true });
  tenants.push(s.tenantId);
  const workflowRef = `wf-${randomUUID()}`;
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, workflowRef);
  const { rawToken } = await issueToken(s.tenantId, connectionId, (opts.caps ?? ['pipeline.write']) as never);
  return { ...s, workflowRef, connectionId, token: rawToken };
}

type Fx = Awaited<ReturnType<typeof fx>>;

interface QBody { conversation_ref?: unknown; service?: unknown; timeframe?: unknown; message_ref?: unknown; identities?: unknown }
async function qualify(f: Fx, body: QBody, opts: { token?: string; wfRef?: string; omitWfRef?: boolean } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token ?? f.token}`, 'content-type': 'application/json' };
  if (!opts.omitWfRef) headers['x-workflow-ref'] = opts.wfRef ?? f.workflowRef;
  const res = await POST(new Request('http://t/api/crm/v1/opportunities/qualify', { method: 'POST', headers, body: JSON.stringify(body) }));
  let json: any = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}

/** A conversation under the fixture's workflow, linked to `contactId`. Returns its ref + id. */
async function convFor(f: Fx, contactId: string, ref = `co-${randomUUID()}`): Promise<{ id: string; ref: string }> {
  const c = await getOrCreateConversation(f.tenantId, f.workflowRef, ref);
  await query(`UPDATE conversations SET contact_id = $2 WHERE id = $1`, [c.id, contactId]);
  return { id: c.id, ref };
}

async function seedOpp(f: Fx, o: { contactId: string; conversationId?: string | null; stage: string; status: string; closedAgoDays?: number; lostReason?: string | null; originTouchId?: string | null }): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO opportunities (tenant_id, client_id, contact_id, conversation_id, status, stage, lead_at, booked_at, attended_at, origin_touch_id, lost_reason, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6, now(),
         CASE WHEN $6 IN ('booked','attended','paid') THEN now() ELSE NULL END,
         CASE WHEN $6 IN ('attended','paid') THEN now() ELSE NULL END, $7, $8,
         CASE WHEN $5 = 'open' THEN NULL ELSE now() - make_interval(days => $9::int) END)
     RETURNING id`,
    [f.tenantId, f.clientId, o.contactId, o.conversationId ?? null, o.status, o.stage, o.originTouchId ?? null, o.lostReason ?? null, o.closedAgoDays ?? 0],
  );
  return r.id;
}

async function mkExtMessage(f: Fx, conversationId: string, externalId: string): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO handoff_messages (tenant_id, conversation_id, sender, status, text, content_type, external_message_id, occurred_at, created_at)
       VALUES ($1,$2,'user','received','hola','text',$3, now(), now()) RETURNING id`,
    [f.tenantId, conversationId, externalId],
  );
  return r.id;
}

// ── 1. open lead → qualified (evidence + one bot event); then idempotent repeat ──────────────
test('open lead → qualified with evidence, one event, actor bot; repeat is a no-op', async () => {
  const f = await fx();
  const contact = await seedContact(f.tenantId, f.clientId, { name: 'Lead' });
  const conv = await convFor(f, contact);
  const oppId = await seedOpp(f, { contactId: contact, conversationId: conv.id, stage: 'lead', status: 'open' });

  const r = await qualify(f, { conversation_ref: conv.ref, service: 'Corte + barba', timeframe: 'mañana' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { stage: 'qualified', status: 'open', changed: true });

  const opp = await getOpportunityById(f.tenantId, f.clientId, oppId);
  assert.ok(opp);
  assert.equal(opp.stage, 'qualified');
  assert.equal(opp.status, 'open');
  assert.equal(opp.qualification_service, 'Corte + barba');
  assert.equal(opp.qualification_timeframe, 'mañana');
  assert.equal(opp.qualified_by, 'bot');
  assert.equal(opp.qualified_implicitly, false);

  const qualEvents = (await listOpportunityStageEvents(f.tenantId, oppId)).filter((e) => e.to_stage === 'qualified');
  assert.equal(qualEvents.length, 1, 'exactly one qualify event');
  assert.equal(qualEvents[0].actor, 'bot');
  assert.equal(qualEvents[0].from_stage, 'lead');

  // Idempotent repeat with DIFFERENT evidence → no change, no new event, earlier evidence kept.
  const r2 = await qualify(f, { conversation_ref: conv.ref, service: 'Otro', timeframe: 'hoy' });
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.body, { stage: 'qualified', status: 'open', changed: false });
  const opp2 = await getOpportunityById(f.tenantId, f.clientId, oppId);
  assert.equal(opp2!.qualification_service, 'Corte + barba', 'evidence not overwritten');
  assert.equal((await listOpportunityStageEvents(f.tenantId, oppId)).filter((e) => e.to_stage === 'qualified').length, 1, 'still one qualify event');
});

// ── 2. booked / attended are untouched (idempotent, no downgrade) ────────────────────────────
test('a booked or attended sale is left untouched (changed:false)', async () => {
  const f = await fx();
  const booked = await seedContact(f.tenantId, f.clientId, { name: 'Booked' });
  const bConv = await convFor(f, booked);
  const bOpp = await seedOpp(f, { contactId: booked, conversationId: bConv.id, stage: 'booked', status: 'open' });
  const rb = await qualify(f, { conversation_ref: bConv.ref, service: 'X', timeframe: 'hoy' });
  assert.equal(rb.status, 200);
  assert.deepEqual(rb.body, { stage: 'booked', status: 'open', changed: false });
  assert.equal((await getOpportunityById(f.tenantId, f.clientId, bOpp))!.stage, 'booked');

  const attended = await seedContact(f.tenantId, f.clientId, { name: 'Attended' });
  const aConv = await convFor(f, attended);
  const aOpp = await seedOpp(f, { contactId: attended, conversationId: aConv.id, stage: 'attended', status: 'won' });
  const ra = await qualify(f, { conversation_ref: aConv.ref, service: 'X', timeframe: 'hoy' });
  assert.deepEqual(ra.body, { stage: 'attended', status: 'won', changed: false });
  assert.equal((await getOpportunityById(f.tenantId, f.clientId, aOpp))!.status, 'won');
});

// ── 3. no open sale → create one directly at qualified, origin from the ad window ────────────
test('creates a sale at qualified when none is open; origin = latest ad touch in the window', async () => {
  const f = await fx();
  const contact = await seedContact(f.tenantId, f.clientId, { name: 'Fresh' });
  const conv = await convFor(f, contact);
  // A non-test ad touch 1h ago → inside the default 7-day brief window.
  const msg = await mkExtMessage(f, conv.id, `ext-${randomUUID().slice(0, 8)}`);
  const ad = await one<{ id: string }>(`INSERT INTO ads (tenant_id, client_id, platform, source_type, external_id) VALUES ($1,$2,'meta','ad',$3) RETURNING id`, [f.tenantId, f.clientId, `ext-${randomUUID().slice(0, 10)}`]);
  const touch = await one<{ id: string }>(`INSERT INTO attribution_touches (tenant_id, client_id, contact_id, conversation_id, message_id, ad_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6, now() - make_interval(hours => 1)) RETURNING id`, [f.tenantId, f.clientId, contact, conv.id, msg, ad.id]);

  const r = await qualify(f, { conversation_ref: conv.ref, service: 'Color', timeframe: 'el sábado' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { stage: 'qualified', status: 'open', changed: true });

  const opp = await getOpenOpportunityForContact(f.tenantId, f.clientId, contact);
  assert.ok(opp);
  assert.equal(opp.stage, 'qualified');
  assert.equal(opp.origin_touch_id, touch.id, 'origin resolved from the ad touch in the window');
  assert.equal(opp.qualification_service, 'Color');
  assert.equal(opp.qualified_by, 'bot');
  const events = await listOpportunityStageEvents(f.tenantId, opp.id);
  assert.equal(events.length, 1, 'one opening event');
  assert.equal(events[0].from_stage, null);
  assert.equal(events[0].to_stage, 'qualified');
  assert.equal(events[0].actor, 'bot');
});

// ── 4. a lost sale inside the reopen window → reopen then qualify (both recorded) ────────────
test('reopens then qualifies a sale lost inside the reopen window (both events)', async () => {
  const f = await fx();
  const contact = await seedContact(f.tenantId, f.clientId, { name: 'Lost recently' });
  const conv = await convFor(f, contact);
  const oppId = await seedOpp(f, { contactId: contact, conversationId: conv.id, stage: 'lead', status: 'lost', lostReason: 'no_respondio', closedAgoDays: 2 });

  const r = await qualify(f, { conversation_ref: conv.ref, service: 'Corte', timeframe: 'esta semana' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { stage: 'qualified', status: 'open', changed: true });

  const opp = await getOpportunityById(f.tenantId, f.clientId, oppId);
  assert.equal(opp!.status, 'open');
  assert.equal(opp!.stage, 'qualified');
  const events = await listOpportunityStageEvents(f.tenantId, oppId);
  assert.ok(events.some((e) => e.from_status === 'lost' && e.to_status === 'open'), 'a reopen event');
  assert.ok(events.some((e) => e.to_stage === 'qualified' && e.actor === 'bot'), 'a qualify event by the bot');
});

// ── 5. a lost sale OUTSIDE the window → a brand-new sale; the old one stays lost ─────────────
test('opens a NEW sale when the latest was lost outside the reopen window', async () => {
  const f = await fx();
  const contact = await seedContact(f.tenantId, f.clientId, { name: 'Lost long ago' });
  const conv = await convFor(f, contact);
  const oldLost = await seedOpp(f, { contactId: contact, conversationId: conv.id, stage: 'lead', status: 'lost', lostReason: 'no_respondio', closedAgoDays: 60 });

  const r = await qualify(f, { conversation_ref: conv.ref, service: 'Corte', timeframe: 'hoy' });
  assert.deepEqual(r.body, { stage: 'qualified', status: 'open', changed: true });

  assert.equal((await getOpportunityById(f.tenantId, f.clientId, oldLost))!.status, 'lost', 'the old sale stays lost');
  const latest = await getLatestOpportunityForContact(f.tenantId, f.clientId, contact);
  assert.notEqual(latest!.id, oldLost, 'a different, new sale');
  assert.equal(latest!.stage, 'qualified');
  assert.equal(latest!.status, 'open');
  const count = await one<{ n: string }>(`SELECT count(*)::text n FROM opportunities WHERE tenant_id=$1 AND contact_id=$2`, [f.tenantId, contact]);
  assert.equal(count.n, '2');
});

// ── 6. message_ref: stored only when it belongs to THIS conversation; else ignored ──────────
test('message_ref is stored only when it belongs to this conversation', async () => {
  const f = await fx();
  // Foreign external id (lives in another conversation) → ignored, qualification still happens.
  const cA = await seedContact(f.tenantId, f.clientId, { name: 'A' });
  const convA = await convFor(f, cA);
  const oppA = await seedOpp(f, { contactId: cA, conversationId: convA.id, stage: 'lead', status: 'open' });
  const cOther = await seedContact(f.tenantId, f.clientId, { name: 'Other' });
  const convOther = await convFor(f, cOther);
  await mkExtMessage(f, convOther.id, 'EXT-FOREIGN');
  const rIgnored = await qualify(f, { conversation_ref: convA.ref, service: 'Corte', timeframe: 'hoy', message_ref: 'EXT-FOREIGN' });
  assert.equal(rIgnored.status, 200);
  assert.equal((await getOpportunityById(f.tenantId, f.clientId, oppA))!.qualification_message_id, null, 'foreign message_ref ignored');

  // An external id that IS in this conversation → stored as the evidence message.
  const cB = await seedContact(f.tenantId, f.clientId, { name: 'B' });
  const convB = await convFor(f, cB);
  const oppB = await seedOpp(f, { contactId: cB, conversationId: convB.id, stage: 'lead', status: 'open' });
  const msgId = await mkExtMessage(f, convB.id, 'EXT-OWN');
  const rStored = await qualify(f, { conversation_ref: convB.ref, service: 'Corte', timeframe: 'hoy', message_ref: 'EXT-OWN' });
  assert.equal(rStored.status, 200);
  assert.equal((await getOpportunityById(f.tenantId, f.clientId, oppB))!.qualification_message_id, msgId, 'own message_ref stored');
});

// ── 7. every refusal shape ───────────────────────────────────────────────────────────────────
test('refusals: bad token, missing/legacy capability, foreign + missing workflow_ref, module off, sentinels', async () => {
  const f = await fx();
  const contact = await seedContact(f.tenantId, f.clientId, { name: 'R' });
  const conv = await convFor(f, contact);
  await seedOpp(f, { contactId: contact, conversationId: conv.id, stage: 'lead', status: 'open' });
  const ok = { conversation_ref: conv.ref, service: 'Corte', timeframe: 'hoy' };

  const bad = await qualify(f, ok, { token: 'not-a-real-token' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error?.code, 'unauthorized');

  // A token WITHOUT pipeline.write (crm.write only) → the SAME 401 as a bad token.
  const { rawToken: crmOnly } = await issueToken(f.tenantId, f.connectionId, ['crm.write'] as never);
  const noCap = await qualify(f, ok, { token: crmOnly });
  assert.equal(noCap.status, 401);
  assert.equal(noCap.body.error?.code, 'unauthorized');

  // The legacy triple (what the backfill grants) never includes pipeline.write → 401.
  const { rawToken: legacy } = await issueToken(f.tenantId, f.connectionId, ['handoff', 'scheduling.read', 'scheduling.write'] as never);
  assert.equal((await qualify(f, ok, { token: legacy })).status, 401);

  // Foreign / unknown workflow_ref → 404; missing header → 400.
  const foreign = await qualify(f, ok, { wfRef: `nope-${randomUUID()}` });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error?.code, 'not_found');
  const noWf = await qualify(f, ok, { omitWfRef: true });
  assert.equal(noWf.status, 400);
  assert.equal(noWf.body.error?.code, 'workflow_ref_required');

  // CRM module OFF for the client → 403 module_disabled.
  const off = await fx({ enableCrm: false });
  const offContact = await seedContact(off.tenantId, off.clientId, { name: 'Off' });
  const offConv = await convFor(off, offContact);
  const offRes = await qualify(off, { conversation_ref: offConv.ref, service: 'Corte', timeframe: 'hoy' });
  assert.equal(offRes.status, 403);
  assert.equal(offRes.body.error?.code, 'module_disabled');

  // Sentinels → 422, each with its stable code (and nothing written).
  const sConv = await qualify(f, { conversation_ref: 'undefined', service: 'Corte', timeframe: 'hoy' });
  assert.equal(sConv.status, 422);
  assert.equal(sConv.body.error?.code, 'invalid_conversation_ref');
  const sService = await qualify(f, { conversation_ref: conv.ref, service: 'null', timeframe: 'hoy' });
  assert.equal(sService.status, 422);
  assert.equal(sService.body.error?.code, 'invalid_body');
  const sIdent = await qualify(f, { conversation_ref: conv.ref, service: 'Corte', timeframe: 'hoy', identities: [{ kind: 'phone', value: 'undefined' }] });
  assert.equal(sIdent.status, 422);
  assert.equal(sIdent.body.error?.code, 'invalid_identity');

  // Missing required evidence → 422 invalid_body (zod).
  const noTimeframe = await qualify(f, { conversation_ref: conv.ref, service: 'Corte' });
  assert.equal(noTimeframe.status, 422);
  assert.equal(noTimeframe.body.error?.code, 'invalid_body');
});

// ── 8. client isolation: a token for A never touches B's sale ────────────────────────────────
test('client isolation: qualifying under client A leaves client B untouched', async () => {
  const f = await fx();
  const aContact = await seedContact(f.tenantId, f.clientId, { name: 'A lead' });
  const aConv = await convFor(f, aContact);
  const aOpp = await seedOpp(f, { contactId: aContact, conversationId: aConv.id, stage: 'lead', status: 'open' });
  // B's open lead, same tenant, different client.
  const bContact = await seedContact(f.tenantId, f.otherClientId, { name: 'B lead' });
  const bOpp = await seedOpp({ ...f, clientId: f.otherClientId } as Fx, { contactId: bContact, stage: 'lead', status: 'open' });

  const r = await qualify(f, { conversation_ref: aConv.ref, service: 'Corte', timeframe: 'hoy' });
  assert.deepEqual(r.body, { stage: 'qualified', status: 'open', changed: true });
  assert.equal((await getOpportunityById(f.tenantId, f.clientId, aOpp))!.stage, 'qualified');

  const b = await getOpportunityById(f.tenantId, f.otherClientId, bOpp);
  assert.equal(b!.stage, 'lead', "B's sale is untouched");
  assert.equal(b!.status, 'open');
  assert.equal(await getOpportunityById(f.tenantId, f.clientId, bOpp), null, "A's client can't see B's sale");
});

// ── 9. a Setter's later UI correction (unqualify) still works on the bot-qualified sale ──────
test('a Setter can unqualify (PL-2 engine path) what the bot qualified', async () => {
  const f = await fx();
  const contact = await seedContact(f.tenantId, f.clientId, { name: 'Corrected' });
  const conv = await convFor(f, contact);
  const oppId = await seedOpp(f, { contactId: contact, conversationId: conv.id, stage: 'lead', status: 'open' });
  await qualify(f, { conversation_ref: conv.ref, service: 'Corte', timeframe: 'hoy' });
  assert.equal((await getOpportunityById(f.tenantId, f.clientId, oppId))!.stage, 'qualified');

  // The exact engine call behind the PL-2 unqualify action (actor = the Setter, a user).
  const setterId = randomUUID();
  const after = await unqualifyOpportunity(f.tenantId, f.clientId, oppId, { kind: 'user', userId: setterId }, 'No dio evidencia');
  assert.equal(after!.stage, 'lead');
  assert.equal(after!.qualification_service, null, 'evidence cleared on unqualify');
  assert.equal(after!.status, 'open');
  const last = (await listOpportunityStageEvents(f.tenantId, oppId)).at(-1);
  assert.equal(last!.to_stage, 'lead');
  assert.equal(last!.actor, setterId, 'the correction is attributed to the Setter, not the bot');
});
