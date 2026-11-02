import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedContact, seedMember, seedScenario, seedWorkflow } from './fixtures.js';
import { getOrCreateConversation } from '../../src/db/repositories/handoff.js';
import {
  getCohortFunnel,
  getInboxContactPipeline,
  listAwaitingBusinessReply,
  listBoardOpportunities,
  listContactOpportunities,
} from '../../src/db/repositories/pipeline.js';

/**
 * PL-2 §8 — the board / queue / inbox / contact READS. Test-ad origins are excluded by default; the
 * awaiting-reply queue lists exactly the opportunities whose customer spoke last; isolation holds.
 */
const tenants: string[] = [];
const users: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  if (users.length) await query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [users]);
  await closeDb();
});
const one = async <T>(sql: string, p: unknown[]): Promise<T> => (await query<T>(sql, p)).rows[0];

async function fixture() {
  const s = await seedScenario({ enableCrm: true, enableCampaigns: true });
  tenants.push(s.tenantId);
  const wfRef = `wf-${randomUUID().slice(0, 8)}`;
  await seedWorkflow(s.tenantId, s.clientId, wfRef);
  return { ...s, wfRef };
}
type F = Awaited<ReturnType<typeof fixture>>;

const mkContact = (s: F) => seedContact(s.tenantId, s.clientId, { channelUserId: `wa:${randomUUID().slice(0, 8)}` });
async function mkAd(s: F, opts: { test?: boolean; name?: string; campaignId?: string | null } = {}): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO ads (tenant_id, client_id, platform, source_type, external_id, name, campaign_id) VALUES ($1,$2,'meta','ad',$3,$4,$5) RETURNING id`,
    [s.tenantId, s.clientId, opts.test ? `TEST-${randomUUID().slice(0, 8)}` : `ext-${randomUUID().slice(0, 8)}`, opts.name ?? null, opts.campaignId ?? null],
  );
  return r.id;
}
async function mkConv(s: F, contactId: string): Promise<string> {
  const c = await getOrCreateConversation(s.tenantId, s.wfRef, `co-${randomUUID()}`);
  await query(`UPDATE conversations SET contact_id = $2 WHERE id = $1`, [c.id, contactId]);
  return c.id;
}
async function mkMsg(s: F, conv: string, sender: 'user' | 'bot', agoHours: number): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO handoff_messages (tenant_id, conversation_id, sender, status, text, content_type, occurred_at, created_at)
       VALUES ($1,$2,$3,$4,'m','text', now() - make_interval(hours => $5::int), now() - make_interval(hours => $5::int)) RETURNING id`,
    [s.tenantId, conv, sender, sender === 'user' ? 'received' : 'sent', agoHours],
  );
  return r.id;
}
/** Give a contact an ad ORIGIN: a touch on `adId`, set as first_touch + origin_kind=meta_ad. */
async function setAdOrigin(s: F, contactId: string, conv: string, adId: string): Promise<void> {
  const msg = await mkMsg(s, conv, 'user', 72);
  const t = await one<{ id: string }>(
    `INSERT INTO attribution_touches (tenant_id, client_id, contact_id, conversation_id, message_id, ad_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() - interval '72 hours') RETURNING id`,
    [s.tenantId, s.clientId, contactId, conv, msg, adId],
  );
  await query(`UPDATE contacts SET origin_kind='meta_ad', first_touch_id=$1 WHERE id=$2`, [t.id, contactId]);
}
async function seedOpp(s: F, o: { contactId: string; conv?: string | null; stage?: string; status?: string }): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO opportunities (tenant_id, client_id, contact_id, conversation_id, status, stage, lead_at, booked_at)
       VALUES ($1,$2,$3,$4,$5,$6, now(), CASE WHEN $6 IN ('booked','attended') THEN now() ELSE NULL END) RETURNING id`,
    [s.tenantId, s.clientId, o.contactId, o.conv ?? null, o.status ?? 'open', o.stage ?? 'lead'],
  );
  return r.id;
}

test('listBoardOpportunities: excludes test-ad origins by default; honors origin + campaign filters', async () => {
  const s = await fixture();
  const camp = await one<{ id: string }>(`INSERT INTO campaigns (tenant_id, client_id, name) VALUES ($1,$2,'Camp') RETURNING id`, [s.tenantId, s.clientId]);
  const realAd = await mkAd(s, { name: 'Real', campaignId: camp.id });
  const testAd = await mkAd(s, { test: true });

  const a = await mkContact(s); await setAdOrigin(s, a, await mkConv(s, a), realAd); await seedOpp(s, { contactId: a, stage: 'lead' });
  const b = await mkContact(s); await setAdOrigin(s, b, await mkConv(s, b), testAd); await seedOpp(s, { contactId: b, stage: 'lead' });
  const d = await mkContact(s); await seedOpp(s, { contactId: d, stage: 'booked' }); // organic

  const idsOf = (rows: Array<{ contact_id: string }>) => rows.map((r) => r.contact_id).sort();
  const def = await listBoardOpportunities(s.tenantId, s.clientId);
  assert.deepEqual(idsOf(def), [a, d].sort(), 'test-ad origin (b) excluded by default');
  const withTest = await listBoardOpportunities(s.tenantId, s.clientId, { includeTest: true });
  assert.deepEqual(idsOf(withTest), [a, b, d].sort(), 'includeTest brings back the test-ad origin');
  const byOrigin = await listBoardOpportunities(s.tenantId, s.clientId, { originKinds: ['meta_ad', 'meta_post'] });
  assert.deepEqual(idsOf(byOrigin), [a].sort(), 'origin filter = the ad contact (b still excluded as test)');
  const byCampaign = await listBoardOpportunities(s.tenantId, s.clientId, { campaignId: camp.id });
  assert.deepEqual(idsOf(byCampaign), [a].sort());
  const lost = await listBoardOpportunities(s.tenantId, s.clientId, { status: 'lost' });
  assert.equal(lost.length, 0);
});

test('listAwaitingBusinessReply: exactly the open lead/qualified sales whose customer spoke last', async () => {
  const s = await fixture();
  // E: customer spoke last → listed.
  const e = await mkContact(s); const ce = await mkConv(s, e); await mkMsg(s, ce, 'bot', 10); await mkMsg(s, ce, 'user', 5); await seedOpp(s, { contactId: e, conv: ce, stage: 'lead' });
  // F: business spoke last → not listed.
  const f = await mkContact(s); const cf = await mkConv(s, f); await mkMsg(s, cf, 'user', 10); await mkMsg(s, cf, 'bot', 5); await seedOpp(s, { contactId: f, conv: cf, stage: 'qualified' });
  // G: booked (never in the queue) even though the customer spoke last.
  const g = await mkContact(s); const cg = await mkConv(s, g); await mkMsg(s, cg, 'user', 5); await seedOpp(s, { contactId: g, conv: cg, stage: 'booked' });

  const rows = await listAwaitingBusinessReply(s.tenantId, s.clientId);
  assert.deepEqual(rows.map((r) => r.contact_id), [e], 'only E');
});

test('getInboxContactPipeline: ad origin + opportunity stage; listContactOpportunities newest first', async () => {
  const s = await fixture();
  const camp = await one<{ id: string }>(`INSERT INTO campaigns (tenant_id, client_id, name) VALUES ($1,$2,'Presentación') RETURNING id`, [s.tenantId, s.clientId]);
  const ad = await mkAd(s, { name: 'Factos Falla', campaignId: camp.id });
  const c = await mkContact(s);
  const conv = await mkConv(s, c);
  await setAdOrigin(s, c, conv, ad);
  await seedOpp(s, { contactId: c, conv, stage: 'lead' });

  const p = await getInboxContactPipeline(s.tenantId, s.clientId, c);
  assert.ok(p);
  assert.equal(p!.origin_kind, 'meta_ad');
  assert.equal(p!.ad_name, 'Factos Falla');
  assert.equal(p!.campaign_name, 'Presentación');
  assert.equal(p!.ad_is_test, false);
  assert.equal(p!.opp_stage, 'lead');

  // Two opportunities (an older closed one + the current) → newest first.
  await query(`UPDATE opportunities SET status='lost', lost_reason='no_respondio', closed_at=now() - interval '40 days', created_at=now() - interval '45 days' WHERE contact_id=$1`, [c]);
  await seedOpp(s, { contactId: c, conv, stage: 'lead' });
  const opps = await listContactOpportunities(s.tenantId, s.clientId, c);
  assert.equal(opps.length, 2);
  assert.equal(opps[0].status, 'open', 'newest first = the current open sale');
  assert.equal(opps[1].status, 'lost');
});

test('JP-7 board filters: search (name / phone / @username) and owner (incl. unassigned)', async () => {
  const s = await fixture();
  const owner = await seedMember(s.tenantId);
  users.push(owner);
  const c1 = await seedContact(s.tenantId, s.clientId, { name: 'Wilson Cuellar' });
  await query(`UPDATE contacts SET phone_e164='+573001234567', whatsapp_username='wilson99', assigned_to=$2 WHERE id=$1`, [c1, owner]);
  const c2 = await seedContact(s.tenantId, s.clientId, { name: 'Marcela Ruiz' });
  await seedOpp(s, { contactId: c1, stage: 'booked' });
  await seedOpp(s, { contactId: c2, stage: 'lead' });

  const ids = async (f: Parameters<typeof listBoardOpportunities>[2]) => (await listBoardOpportunities(s.tenantId, s.clientId, f)).map((x) => x.contact_id).sort();
  assert.deepEqual(await ids({ search: 'wilson' }), [c1], 'by name');
  assert.deepEqual(await ids({ search: '1234567' }), [c1], 'by phone fragment');
  assert.deepEqual(await ids({ search: 'wilson99' }), [c1], 'by @username');
  assert.deepEqual(await ids({ search: 'zzz-no-match' }), [], 'no match');
  assert.deepEqual(await ids({ owner }), [c1], 'owner filter');
  assert.deepEqual(await ids({ owner: 'unassigned' }), [c2], 'unassigned bucket');

  // The JP-7 per-card fields are projected in one query (no N+1): owner + the new columns exist.
  const wilson = (await listBoardOpportunities(s.tenantId, s.clientId, { search: 'wilson' }))[0];
  assert.equal(wilson.owner_user_id, owner);
  assert.ok('appt_tz' in wilson && 'last_message_text' in wilson && 'qualification_service' in wilson);
});

/** Seed one opportunity OPENED `openedDaysAgo` days ago, having reached the given stage timestamps. */
async function seedCohortOpp(
  s: F,
  o: { contactId: string; openedDaysAgo: number; reach: { qualified?: boolean; booked?: boolean; attended?: boolean; paid?: boolean }; status?: string; lostReason?: string | null },
): Promise<string> {
  const stage = o.reach.paid ? 'paid' : o.reach.attended ? 'attended' : o.reach.booked ? 'booked' : o.reach.qualified ? 'qualified' : 'lead';
  const r = await one<{ id: string }>(
    `INSERT INTO opportunities (tenant_id, client_id, contact_id, status, stage, created_at, lead_at, qualified_at, booked_at, attended_at, paid_at, closed_at, lost_reason)
       VALUES ($1,$2,$3,$4,$5,
         now() - make_interval(days => $6::int), now() - make_interval(days => $6::int),
         CASE WHEN $7 THEN now() - make_interval(days => $6::int) END,
         CASE WHEN $8 THEN now() - make_interval(days => $6::int) END,
         CASE WHEN $9 THEN now() - make_interval(days => $6::int) END,
         CASE WHEN $10 THEN now() - make_interval(days => $6::int) END,
         CASE WHEN $4 = 'lost' THEN now() - make_interval(days => $6::int) END, $11)
     RETURNING id`,
    [s.tenantId, s.clientId, o.contactId, o.status ?? 'open', stage, o.openedDaysAgo,
      !!o.reach.qualified, !!o.reach.booked, !!o.reach.attended, !!o.reach.paid, o.lostReason ?? null],
  );
  return r.id;
}

test('JP-7b §1 getCohortFunnel: monotonic reached-counts for one group, lost by reason, window + origin filters', async () => {
  const s = await fixture();
  const win = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const from = win(40);
  const to = win(10); // a settled window: [40d ago, 10d ago]

  // Five opportunities OPENED ~30 days ago (inside the window), reaching different stages.
  const A = await mkContact(s); await seedCohortOpp(s, { contactId: A, openedDaysAgo: 30, reach: { qualified: true, booked: true, attended: true, paid: true } });
  const B = await mkContact(s); await seedCohortOpp(s, { contactId: B, openedDaysAgo: 30, reach: { qualified: true, booked: true } });
  const C = await mkContact(s); await seedCohortOpp(s, { contactId: C, openedDaysAgo: 30, reach: { qualified: true } });
  const D = await mkContact(s); await seedCohortOpp(s, { contactId: D, openedDaysAgo: 30, reach: {}, status: 'lost', lostReason: 'no_respondio' });
  const E = await mkContact(s); await seedCohortOpp(s, { contactId: E, openedDaysAgo: 30, reach: { qualified: true, booked: true, attended: true }, status: 'lost', lostReason: 'no_asistio' });
  // One opened AFTER the window (5 days ago) → excluded.
  const F2 = await mkContact(s); await seedCohortOpp(s, { contactId: F2, openedDaysAgo: 5, reach: { qualified: true } });

  const c = await getCohortFunnel(s.tenantId, s.clientId, {}, from, to);
  assert.equal(c.cohort, 5, 'only the five opened inside the window (the 5-day-old one excluded)');
  assert.deepEqual(
    [c.cohort, c.reached_qualified, c.reached_booked, c.reached_attended, c.reached_paid],
    [5, 4, 3, 2, 1],
    'reached is monotonic: Lead 5 ≥ Calificado 4 ≥ Reservó 3 ≥ Asistió 2 ≥ Pagó 1',
  );
  assert.equal(c.lost, 2);
  assert.equal(c.lost_no_respondio, 1);
  assert.equal(c.lost_no_asistio, 1);

  // Origin filter narrows the SAME cohort: give A a real ad origin, filter to meta_ad.
  const realAd = await mkAd(s, { name: 'Camp A' });
  await setAdOrigin(s, A, await mkConv(s, A), realAd);
  const byOrigin = await getCohortFunnel(s.tenantId, s.clientId, { originKinds: ['meta_ad'] }, from, to);
  assert.equal(byOrigin.cohort, 1, 'the origin filter narrows the cohort to the ad contact');
  assert.equal(byOrigin.reached_paid, 1);
});

test('JP-7b §7: a contact literally named "TEST" is hidden by default (board + cohort), shown with includeTest', async () => {
  const s = await fixture();
  const real = await seedContact(s.tenantId, s.clientId, { name: 'Wendy Real' });
  const testC = await seedContact(s.tenantId, s.clientId, { name: 'TEST' });
  await seedOpp(s, { contactId: real, stage: 'lead' });
  await seedCohortOpp(s, { contactId: testC, openedDaysAgo: 5, reach: { qualified: true } });

  const names = (rows: Array<{ contact_id: string }>) => rows.map((r) => r.contact_id).sort();
  const def = await listBoardOpportunities(s.tenantId, s.clientId);
  assert.ok(def.some((r) => r.contact_id === real), 'the real contact shows');
  assert.ok(!def.some((r) => r.contact_id === testC), 'the "TEST" contact is hidden by default');
  const withTest = await listBoardOpportunities(s.tenantId, s.clientId, { includeTest: true });
  assert.ok(withTest.some((r) => r.contact_id === testC), 'includeTest brings it back');
  void names;

  // The cohort funnel excludes it too (both opps are in the last-30-days window: the real lead +
  // the TEST one). Default counts only the real one; includeTest counts both.
  const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const to = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal((await getCohortFunnel(s.tenantId, s.clientId, {}, from, to)).cohort, 1, 'the TEST opp is excluded; only the real lead counts');
  assert.equal((await getCohortFunnel(s.tenantId, s.clientId, { includeTest: true }, from, to)).cohort, 2, 'includeTest counts the TEST opp too');
});
