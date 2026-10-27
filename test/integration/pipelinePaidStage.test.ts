import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query, withTransaction } from '../../src/db/client.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { cleanupTenant, closeDb, seedContact, seedScenario, type Scenario } from './fixtures.js';
import { getAppointmentById, insertAppointment, type AppointmentRow } from '../../src/db/repositories/scheduling/appointments.js';
import { ensureOpportunityPaidForPayment } from '../../src/pipeline/engine.js';
import { getOpportunityById, listOpportunityStageEvents } from '../../src/db/repositories/pipeline.js';

/**
 * JP-6 — a RECORDED payment must leave its sale at `paid`. Exercises the engine heal the live
 * payment hook now calls (`ensureOpportunityPaidForPayment`) against the real DB, covering the two
 * data causes the operator saw: (b) the appointment had no opportunity (none was created), and
 * (c) the opportunity was stuck before `attended` (its completion hook had failed). Each test seeds
 * its own tenant and drops it. (Cause (a) — the board never rendered paid — is the board unit test.)
 */
const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

async function fx(): Promise<Scenario> {
  const s = await seedScenario({ enableCrm: true });
  tenants.push(s.tenantId);
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'scheduling', enabled: true });
  return s;
}

const START = new Date('2026-11-02T15:00:00.000Z');
async function mkAppt(s: Scenario, opts: { contactId?: string | null; opportunityId?: string | null } = {}): Promise<AppointmentRow> {
  const a = await withTransaction((c) =>
    insertAppointment(c, {
      tenantId: s.tenantId, clientId: s.clientId, siteId: s.siteId, contactId: opts.contactId ?? null, sourceConversationId: null,
      staffId: s.staffA, serviceId: s.serviceHaircut, startAt: START, serviceEndAt: new Date(START.getTime() + 60 * 60_000),
      blockedFrom: START, blockedUntil: new Date(START.getTime() + 60 * 60_000),
      serviceNameSnapshot: 'Corte', durationMinSnapshot: 60, priceSnapshot: '50000',
      bufferBeforeMinSnapshot: 0, bufferAfterMinSnapshot: 0, origin: 'internal', createdByType: 'agent', createdByUserId: null, idempotencyKey: null,
    }),
  );
  if (opts.opportunityId) await query(`UPDATE appointments SET opportunity_id = $2 WHERE id = $1`, [a.id, opts.opportunityId]);
  return (await getAppointmentById(s.tenantId, a.id))!;
}

/** A pre-existing opportunity at a given stage/status (its funnel timestamps filled to match). */
async function mkOpp(s: Scenario, contactId: string, stage: string, status: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO opportunities (tenant_id, client_id, contact_id, status, stage, lead_at, qualified_at, booked_at, attended_at, paid_at, closed_at, lost_reason)
     VALUES ($1,$2,$3,$4,$5, now(),
       CASE WHEN $5 = 'lead' THEN NULL ELSE now() END,
       CASE WHEN $5 IN ('booked','attended','paid') THEN now() ELSE NULL END,
       CASE WHEN $5 IN ('attended','paid') THEN now() ELSE NULL END,
       CASE WHEN $5 = 'paid' THEN now() ELSE NULL END,
       CASE WHEN $4 <> 'open' THEN now() ELSE NULL END,
       CASE WHEN $4 = 'lost' THEN 'precio' ELSE NULL END)
     RETURNING id`,
    [s.tenantId, s.clientId, contactId, status, stage],
  );
  return r.rows[0].id;
}
const paidEvents = (s: Scenario, oppId: string) => listOpportunityStageEvents(s.tenantId, oppId).then((es) => es.filter((e) => e.to_stage === 'paid'));
const countOppsForContact = (s: Scenario, contactId: string) =>
  query<{ n: number }>(`SELECT count(*)::int AS n FROM opportunities WHERE tenant_id=$1 AND client_id=$2 AND contact_id=$3`, [s.tenantId, s.clientId, contactId]).then((r) => r.rows[0].n);

// ── cause (b): no opportunity on the appointment ──────────────────────────────────────────────
test('(b) a payment on an appointment with a CONTACT but no sale creates one directly at paid, linked', async () => {
  const s = await fx();
  const contactId = await seedContact(s.tenantId, s.clientId, { name: 'Nuevo' });
  const appt = await mkAppt(s, { contactId });
  const opp = await ensureOpportunityPaidForPayment(appt, { kind: 'system' });
  assert.ok(opp, 'an opportunity is created');
  assert.equal(opp!.stage, 'paid');
  assert.equal(opp!.status, 'won');
  assert.ok(opp!.paid_at, 'paid_at set');
  assert.equal((await getAppointmentById(s.tenantId, appt.id))!.opportunity_id, opp!.id, 'the appointment is now linked');
  assert.equal(await countOppsForContact(s, contactId), 1, 'exactly one sale');
  assert.equal((await paidEvents(s, opp!.id)).length, 1, 'a paid event was written');
});

test('(b) a GUEST walk-in (no contact) has nothing to attach a sale to — no-op', async () => {
  const s = await fx();
  const appt = await mkAppt(s, { contactId: null });
  const opp = await ensureOpportunityPaidForPayment(appt, { kind: 'system' });
  assert.equal(opp, null);
  assert.equal((await getAppointmentById(s.tenantId, appt.id))!.opportunity_id, null, 'still unlinked');
  assert.equal((await query<{ n: number }>(`SELECT count(*)::int AS n FROM opportunities WHERE tenant_id=$1`, [s.tenantId])).rows[0].n, 0, 'no sale invented');
});

test('(b) no sale on the appointment but the contact has an OPEN sale → that one advances (no duplicate)', async () => {
  const s = await fx();
  const contactId = await seedContact(s.tenantId, s.clientId, { name: 'Abierta' });
  const openId = await mkOpp(s, contactId, 'qualified', 'open');
  const appt = await mkAppt(s, { contactId }); // not linked
  const opp = await ensureOpportunityPaidForPayment(appt, { kind: 'system' });
  assert.equal(opp!.id, openId, 'the existing open sale is the one that advanced');
  assert.equal(opp!.stage, 'paid');
  assert.equal(await countOppsForContact(s, contactId), 1, 'no duplicate sale');
  assert.equal((await getAppointmentById(s.tenantId, appt.id))!.opportunity_id, openId, 'linked to it');
});

// ── cause (c): the linked opportunity isn't at attended-won ───────────────────────────────────
test('(c) a sale stuck at BOOKED (its completion hook failed) is fast-forwarded to paid', async () => {
  const s = await fx();
  const contactId = await seedContact(s.tenantId, s.clientId, { name: 'Atascada' });
  const oppId = await mkOpp(s, contactId, 'booked', 'open');
  const appt = await mkAppt(s, { contactId, opportunityId: oppId });
  await ensureOpportunityPaidForPayment(appt, { kind: 'system' });
  const opp = await getOpportunityById(s.tenantId, s.clientId, oppId);
  assert.equal(opp!.stage, 'paid');
  assert.equal(opp!.status, 'won');
  assert.ok(opp!.attended_at && opp!.paid_at && opp!.closed_at, 'the skipped funnel timestamps are filled');
});

test('a completed (attended, won) sale advances attended → paid', async () => {
  const s = await fx();
  const contactId = await seedContact(s.tenantId, s.clientId, { name: 'Atendida' });
  const oppId = await mkOpp(s, contactId, 'attended', 'won');
  const appt = await mkAppt(s, { contactId, opportunityId: oppId });
  await ensureOpportunityPaidForPayment(appt, { kind: 'system' });
  assert.equal((await getOpportunityById(s.tenantId, s.clientId, oppId))!.stage, 'paid');
});

test('idempotent: a sale already at paid is left untouched (no second paid event)', async () => {
  const s = await fx();
  const contactId = await seedContact(s.tenantId, s.clientId, { name: 'Ya pagada' });
  const oppId = await mkOpp(s, contactId, 'paid', 'won');
  const appt = await mkAppt(s, { contactId, opportunityId: oppId });
  await ensureOpportunityPaidForPayment(appt, { kind: 'system' });
  assert.equal((await paidEvents(s, oppId)).length, 0, 'the seeded paid sale got no new event');
  assert.equal((await getOpportunityById(s.tenantId, s.clientId, oppId))!.stage, 'paid');
});

test('a LOST sale linked to the appointment is reopened and paid (the service clearly happened)', async () => {
  const s = await fx();
  const contactId = await seedContact(s.tenantId, s.clientId, { name: 'Perdida' });
  const oppId = await mkOpp(s, contactId, 'booked', 'lost');
  const appt = await mkAppt(s, { contactId, opportunityId: oppId });
  await ensureOpportunityPaidForPayment(appt, { kind: 'system' });
  const opp = await getOpportunityById(s.tenantId, s.clientId, oppId);
  assert.equal(opp!.status, 'won', 'reopened then won');
  assert.equal(opp!.stage, 'paid');
});
