import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query, withTransaction } from '../../src/db/client.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { cleanupTenant, closeDb, seedContact, seedScenario, type Scenario } from './fixtures.js';
import { getAppointmentById, insertAppointment } from '../../src/db/repositories/scheduling/appointments.js';
import { backfillPaidOpportunities } from '../../src/pipeline/backfillPaid.js';
import { getOpportunityById } from '../../src/db/repositories/pipeline.js';

/**
 * JP-6 — the payments → paid backfill. DRY-RUN counts what it would do and writes nothing; --apply
 * brings every recorded payment's sale to paid (creating/advancing as needed) and is idempotent.
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
async function mkAppt(s: Scenario, opts: { contactId?: string | null; opportunityId?: string | null } = {}): Promise<string> {
  const a = await withTransaction((c) =>
    insertAppointment(c, {
      tenantId: s.tenantId, clientId: s.clientId, siteId: s.siteId, contactId: opts.contactId ?? null, sourceConversationId: null,
      staffId: s.staffA, serviceId: s.serviceHaircut, startAt: START, serviceEndAt: new Date(START.getTime() + 60 * 60_000),
      blockedFrom: START, blockedUntil: new Date(START.getTime() + 60 * 60_000),
      serviceNameSnapshot: 'Corte', durationMinSnapshot: 60, priceSnapshot: '50000',
      bufferBeforeMinSnapshot: 0, bufferAfterMinSnapshot: 0, origin: 'internal', createdByType: 'agent', createdByUserId: null, idempotencyKey: null,
    }),
  );
  await query(`UPDATE appointments SET status='completed' WHERE id=$1`, [a.id]);
  if (opts.opportunityId) await query(`UPDATE appointments SET opportunity_id = $2 WHERE id = $1`, [a.id, opts.opportunityId]);
  return a.id;
}
async function mkOpp(s: Scenario, contactId: string, stage: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO opportunities (tenant_id, client_id, contact_id, status, stage, lead_at, booked_at, attended_at, paid_at, closed_at)
     VALUES ($1,$2,$3, CASE WHEN $4 IN ('attended','paid') THEN 'won' ELSE 'open' END, $4, now(), now(),
       CASE WHEN $4 IN ('attended','paid') THEN now() ELSE NULL END,
       CASE WHEN $4='paid' THEN now() ELSE NULL END,
       CASE WHEN $4 IN ('attended','paid') THEN now() ELSE NULL END)
     RETURNING id`,
    [s.tenantId, s.clientId, contactId, stage],
  );
  return r.rows[0].id;
}
async function pay(s: Scenario, appointmentId: string): Promise<void> {
  await query(`INSERT INTO payments (tenant_id, client_id, appointment_id, method_key, total, recorded_by) VALUES ($1,$2,$3,'efectivo','50000','seed')`, [s.tenantId, s.clientId, appointmentId]);
}

test('backfill: dry-run counts every cause and writes nothing; --apply fixes them; re-run is idempotent', async () => {
  const s = await fx();
  const c1 = await seedContact(s.tenantId, s.clientId, { name: 'Sin sale' });
  const c2 = await seedContact(s.tenantId, s.clientId, { name: 'Atascada' });
  const c3 = await seedContact(s.tenantId, s.clientId, { name: 'Ya pagada' });

  const a1 = await mkAppt(s, { contactId: c1 }); // no opportunity → create
  const booked = await mkOpp(s, c2, 'booked');
  const a2 = await mkAppt(s, { contactId: c2, opportunityId: booked }); // stuck at booked → advance
  const already = await mkOpp(s, c3, 'paid');
  const a3 = await mkAppt(s, { contactId: c3, opportunityId: already }); // already paid
  const a4 = await mkAppt(s, { contactId: null }); // guest → skip
  for (const a of [a1, a2, a3, a4]) await pay(s, a);

  // DRY RUN — counts each cause, writes nothing.
  const dry = await backfillPaidOpportunities({ apply: false, tenantId: s.tenantId });
  assert.equal(dry.paymentsScanned, 4);
  assert.equal(dry.alreadyPaid, 1);
  assert.equal(dry.advancedToPaid, 1);
  assert.equal(dry.opportunitiesCreated, 1);
  assert.equal(dry.skippedNoContact, 1);
  assert.equal((await getOpportunityById(s.tenantId, s.clientId, booked))!.stage, 'booked', 'dry run wrote nothing');
  assert.equal((await getAppointmentById(s.tenantId, a1))!.opportunity_id, null, 'dry run created nothing');

  // APPLY — same classification, now written.
  const applied = await backfillPaidOpportunities({ apply: true, tenantId: s.tenantId });
  assert.deepEqual(
    { created: applied.opportunitiesCreated, advanced: applied.advancedToPaid, already: applied.alreadyPaid, skipped: applied.skippedNoContact, failed: applied.failed },
    { created: 1, advanced: 1, already: 1, skipped: 1, failed: 0 },
  );
  assert.equal((await getOpportunityById(s.tenantId, s.clientId, booked))!.stage, 'paid', 'the stuck sale is now paid');
  const a1opp = (await getAppointmentById(s.tenantId, a1))!.opportunity_id;
  assert.ok(a1opp, 'a sale was created + linked for the orphan payment');
  assert.equal((await getOpportunityById(s.tenantId, s.clientId, a1opp!))!.stage, 'paid');

  // IDEMPOTENT — a second pass changes nothing (all paid now, the guest still skipped).
  const again = await backfillPaidOpportunities({ apply: true, tenantId: s.tenantId });
  assert.deepEqual(
    { created: again.opportunitiesCreated, advanced: again.advancedToPaid, already: again.alreadyPaid, skipped: again.skippedNoContact },
    { created: 0, advanced: 0, already: 3, skipped: 1 },
  );
});
