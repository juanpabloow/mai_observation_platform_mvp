import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedContact, seedMember, seedScenario, seedWorkflow } from './fixtures.js';
import { getOrCreateConversation } from '../../src/db/repositories/handoff.js';
import {
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
