import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedContact, seedScenario } from './fixtures.js';
import { mergeContacts } from '../../src/db/repositories/contactIdentities.js';

/**
 * FIX-1 §1 — contact merge must NEVER lose data.
 *
 * (1) COVERAGE GUARD: read every FK referencing `contacts` from the live catalog and fail if a
 *     referencing table is not in HANDLED — the set mergeContacts explicitly re-points/deletes. A
 *     future table added without merge handling breaks the build, not production data.
 * (2) BEHAVIOUR: opportunities (+ stage events), payments and the activity timeline move to the
 *     survivor; the one-open-per-contact rule closes the dropped contact's open sale as lost.
 */

const tenants: string[] = [];
after(async () => { for (const t of tenants) await cleanupTenant(t); await closeDb(); });
const one = async <T>(sql: string, p: unknown[]): Promise<T> => (await query<T>(sql, p)).rows[0];
type S = Awaited<ReturnType<typeof seedScenario>>;

/** Tables with an FK to `contacts` that mergeContacts explicitly handles (mirrors its body). If this
 *  diverges from the live catalog the test fails — forcing merge handling for any new table. */
const HANDLED = new Set<string>([
  'appointments',
  'attribution_touches',
  'contact_identities',
  'contact_notes',
  'contact_tag_links',
  'contacts', // self-ref: origin_ref_contact_id, re-pointed
  'conversations',
  'crm_activity_events',
  'crm_tasks',
  'duplicate_contact_candidates',
  'meeting_speakers',
  'opportunities',
  'payments',
]);

test('COVERAGE: every table with an FK to contacts is handled by mergeContacts', async () => {
  const rows = (await query<{ child: string }>(
    `SELECT DISTINCT c.conrelid::regclass::text AS child
       FROM pg_constraint c
      WHERE c.contype = 'f' AND c.confrelid::regclass::text = 'contacts'`,
    [],
  )).rows.map((r) => r.child.replace(/^public\./, ''));
  const referencing = new Set(rows);
  const unhandled = [...referencing].filter((t) => !HANDLED.has(t));
  assert.deepEqual(unhandled, [], `A table references contacts but mergeContacts does not handle it (add handling + update HANDLED): ${unhandled.join(', ')}`);
  const stale = [...HANDLED].filter((t) => !referencing.has(t));
  assert.deepEqual(stale, [], `HANDLED lists a table that no longer references contacts: ${stale.join(', ')}`);
});

async function seedOpp(s: S, contactId: string, status: 'open' | 'lost', stage = 'lead'): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO opportunities (tenant_id, client_id, contact_id, status, stage, lead_at, closed_at, lost_reason)
       VALUES ($1,$2,$3,$4,$5, now(), CASE WHEN $4='open' THEN NULL ELSE now() END, CASE WHEN $4='lost' THEN 'no_respondio' ELSE NULL END)
     RETURNING id`,
    [s.tenantId, s.clientId, contactId, status, stage],
  );
  return r.id;
}

let slot = 0;
async function seedPaidAppointment(s: S, contactId: string): Promise<{ apptId: string; paymentId: string }> {
  const h = 24 + slot++ * 2;
  const appt = await one<{ id: string }>(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id, start_at, service_end_at, blocked_from, blocked_until,
        service_name_snapshot, duration_min_snapshot, price_snapshot, buffer_before_min_snapshot, buffer_after_min_snapshot, status, origin, created_by_type, contact_id)
     VALUES ($1,$2,$3,$4,$5, now()+make_interval(hours=>$6::int), now()+make_interval(hours=>$6::int)+interval '60 min',
        now()+make_interval(hours=>$6::int), now()+make_interval(hours=>$6::int)+interval '60 min', 'Haircut',60,'50000',0,0,'completed','n8n','n8n',$7) RETURNING id`,
    [s.tenantId, s.clientId, s.siteId, s.staffA, s.serviceHaircut, h, contactId],
  );
  const pay = await one<{ id: string }>(
    `INSERT INTO payments (tenant_id, client_id, appointment_id, contact_id, status, method_key, total, recorded_by)
       VALUES ($1,$2,$3,$4,'recorded','efectivo','50000.00','u-test') RETURNING id`,
    [s.tenantId, s.clientId, appt.id, contactId],
  );
  return { apptId: appt.id, paymentId: pay.id };
}

const seedActivity = (s: S, contactId: string) =>
  query(`INSERT INTO crm_activity_events (tenant_id, client_id, contact_id, event_type, detail, actor_kind) VALUES ($1,$2,$3,'origin_set','{}'::jsonb,'automation')`, [s.tenantId, s.clientId, contactId]);

test('BEHAVIOUR: merge re-points opportunities/payments/activity and closes the dropped open sale as lost', async () => {
  const s = await seedScenario({ enableCrm: true, enableScheduling: true });
  tenants.push(s.tenantId);
  const keep = await seedContact(s.tenantId, s.clientId, { name: 'Keep', channelUserId: `wa:${randomUUID().slice(0, 8)}` });
  const drop = await seedContact(s.tenantId, s.clientId, { name: 'Drop', channelUserId: `wa:${randomUUID().slice(0, 8)}` });

  const keepOpen = await seedOpp(s, keep, 'open');
  const dropOpen = await seedOpp(s, drop, 'open');
  const dropLost = await seedOpp(s, drop, 'lost');
  const { paymentId } = await seedPaidAppointment(s, drop);
  await seedActivity(s, drop);

  const r = await mergeContacts(s.tenantId, s.clientId, keep, drop, null); // null = automation (merged_by FK → "user")
  assert.ok(r.ok, r.ok ? '' : r.reason);

  // Nothing deleted: all three opportunities survive, now all owned by the survivor.
  const forKeep = await one<{ n: string }>(`SELECT count(*)::text n FROM opportunities WHERE tenant_id=$1 AND contact_id=$2`, [s.tenantId, keep]);
  const forDrop = await one<{ n: string }>(`SELECT count(*)::text n FROM opportunities WHERE tenant_id=$1 AND contact_id=$2`, [s.tenantId, drop]);
  assert.equal(forKeep.n, '3', 'survivor owns all three sales');
  assert.equal(forDrop.n, '0', 'the dropped contact owns none');

  // The survivor's open sale stays open; the dropped contact's open sale is closed as lost 'otro'.
  assert.equal((await one<{ status: string }>(`SELECT status FROM opportunities WHERE id=$1`, [keepOpen])).status, 'open');
  const closed = await one<{ status: string; lost_reason: string; lost_note: string }>(`SELECT status, lost_reason, lost_note FROM opportunities WHERE id=$1`, [dropOpen]);
  assert.equal(closed.status, 'lost');
  assert.equal(closed.lost_reason, 'otro');
  assert.match(closed.lost_note, /^fusionado con /);
  assert.equal((await one<{ status: string }>(`SELECT status FROM opportunities WHERE id=$1`, [dropLost])).status, 'lost', 'the already-lost sale is still lost, just re-pointed');

  // One stage event for the close (to_status lost, reason merged).
  const ev = await one<{ n: string }>(`SELECT count(*)::text n FROM opportunity_stage_events WHERE opportunity_id=$1 AND to_status='lost' AND reason='merged'`, [dropOpen]);
  assert.equal(ev.n, '1');

  // Financial history + activity timeline moved to the survivor; nothing deleted.
  assert.equal((await one<{ cid: string }>(`SELECT contact_id cid FROM payments WHERE id=$1`, [paymentId])).cid, keep, 'payment re-pointed to survivor');
  assert.equal((await one<{ n: string }>(`SELECT count(*)::text n FROM crm_activity_events WHERE tenant_id=$1 AND contact_id=$2 AND event_type='origin_set'`, [s.tenantId, drop])).n, '0', 'no activity left on the dropped contact');
  assert.equal((await one<{ n: string }>(`SELECT count(*)::text n FROM contacts WHERE id=$1`, [drop])).n, '0', 'dropped contact removed');
});
