import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import {
  assignAdsToCampaign,
  countUnconfiguredAds,
  createCampaign,
  endCampaign,
  getContactOriginDetail,
  listAdsWithStats,
  listCampaignsWithStats,
  unconfiguredAdCountsByClient,
  updateCampaign,
} from '../../src/db/repositories/attribution.js';
import { listContacts } from '../../src/db/repositories/contacts.js';
import { cleanupTenant, closeDb, seedContact, seedScenario, seedWorkflow } from './fixtures.js';

after(closeDb);

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await query<T>(sql, params)).rows[0];

type S = Awaited<ReturnType<typeof seedScenario>>;
const insertAd = async (s: S, externalId: string, campaignId: string | null = null, clientId = s.clientId): Promise<string> =>
  (await one<{ id: string }>(
    `INSERT INTO ads (tenant_id, client_id, platform, source_type, external_id, campaign_id) VALUES ($1,$2,'meta','ad',$3,$4) RETURNING id`,
    [s.tenantId, clientId, externalId, campaignId],
  )).id;

const insertTouch = async (s: S, wfRef: string, contactId: string, adId: string, when: string): Promise<string> => {
  const cv = await one<{ id: string }>(
    `INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref, contact_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [s.tenantId, wfRef, `cv-${randomUUID().slice(0, 8)}`, contactId],
  );
  const m = await one<{ id: string }>(
    `INSERT INTO handoff_messages (tenant_id, conversation_id, sender, status, content_type, occurred_at) VALUES ($1,$2,'user','received','text',$3) RETURNING id`,
    [s.tenantId, cv.id, when],
  );
  return (await one<{ id: string }>(
    `INSERT INTO attribution_touches (tenant_id, client_id, contact_id, conversation_id, message_id, ad_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [s.tenantId, s.clientId, contactId, cv.id, m.id, adId, when],
  )).id;
};

test('AT-2 repo: listAdsWithStats excludes test ads by default; leads + touches are right', async () => {
  const s = await seedScenario({ enableCrm: true, enableCampaigns: true });
  try {
    const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
    await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const realAd = await insertAd(s, '900100');
    await insertAd(s, 'TEST-1');
    const c = await seedContact(s.tenantId, s.clientId, { channelUserId: 'wa:c1' });
    const t1 = await insertTouch(s, wfRef, c, realAd, '2026-06-01T10:00:00Z');
    await insertTouch(s, wfRef, c, realAd, '2026-06-02T10:00:00Z'); // a second touch on the same ad
    await query(`UPDATE contacts SET first_touch_id=$1 WHERE id=$2`, [t1, c]);

    const def = await listAdsWithStats(s.tenantId, s.clientId);
    assert.equal(def.length, 1, 'the TEST- ad is hidden by default');
    assert.equal(def[0].external_id, '900100');
    assert.equal(def[0].touches, 2, 'both touches counted');
    assert.equal(def[0].leads, 1, 'one contact whose first touch is this ad');

    const all = await listAdsWithStats(s.tenantId, s.clientId, { includeTest: true });
    assert.equal(all.length, 2);
    assert.ok(all.find((a) => a.external_id === 'TEST-1')?.is_test, 'TEST- ad flagged is_test');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2 repo: unconfigured counts exclude test + assigned; campaign CRUD + ad_count', async () => {
  const s = await seedScenario({ enableCampaigns: true });
  try {
    const a1 = await insertAd(s, '111');
    await insertAd(s, '222');
    await insertAd(s, 'TEST-9'); // never counts

    assert.equal(await countUnconfiguredAds(s.tenantId, s.clientId), 2, 'two real unconfigured ads');
    assert.equal((await unconfiguredAdCountsByClient(s.tenantId))[s.clientId], 2);

    const camp = await createCampaign({ tenantId: s.tenantId, clientId: s.clientId, name: 'Verano', botBrief: 'promo' });
    let list = await listCampaignsWithStats(s.tenantId, s.clientId);
    assert.equal(list.length, 1);
    assert.equal(list[0].ad_count, 0);

    const changed = await assignAdsToCampaign(s.tenantId, s.clientId, [a1], camp.id);
    assert.equal(changed, 1);
    assert.equal(await countUnconfiguredAds(s.tenantId, s.clientId), 1, 'assigning one leaves one unconfigured');
    list = await listCampaignsWithStats(s.tenantId, s.clientId);
    assert.equal(list[0].ad_count, 1);

    await updateCampaign(s.tenantId, s.clientId, camp.id, { status: 'paused', botBrief: 'nuevo brief' });
    assert.equal((await listCampaignsWithStats(s.tenantId, s.clientId))[0].status, 'paused');

    const ended = await endCampaign(s.tenantId, s.clientId, camp.id);
    assert.equal(ended?.status, 'ended');
    assert.ok(ended?.end_date, 'end_date defaulted on finalizar');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2 repo: assign + ads are isolated between clients', async () => {
  const s = await seedScenario({ enableCampaigns: true });
  try {
    const mine = await insertAd(s, '700');
    const theirs = await insertAd(s, '701', null, s.otherClientId);
    const camp = await createCampaign({ tenantId: s.tenantId, clientId: s.clientId, name: 'C' });
    // Assigning the OTHER client's ad through my client scope changes nothing.
    assert.equal(await assignAdsToCampaign(s.tenantId, s.clientId, [theirs], camp.id), 0);
    assert.equal(await assignAdsToCampaign(s.tenantId, s.clientId, [mine], camp.id), 1);
    // The other client never sees my ad.
    assert.equal((await listAdsWithStats(s.tenantId, s.otherClientId, { includeTest: true })).some((a) => a.id === mine), false);
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2 repo: getContactOriginDetail returns ad + campaign + touches, never ctwa_clid', async () => {
  const s = await seedScenario({ enableCrm: true, enableCampaigns: true });
  try {
    const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
    await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const camp = await createCampaign({ tenantId: s.tenantId, clientId: s.clientId, name: 'Primavera' });
    const ad = await insertAd(s, '555', camp.id);
    const c = await seedContact(s.tenantId, s.clientId, { channelUserId: 'wa:od' });
    const t1 = await insertTouch(s, wfRef, c, ad, '2026-06-01T10:00:00Z');
    await query(`UPDATE contacts SET origin_kind='meta_ad', first_touch_id=$1 WHERE id=$2`, [t1, c]);

    const detail = await getContactOriginDetail(s.tenantId, s.clientId, c);
    assert.equal(detail?.originKind, 'meta_ad');
    assert.equal(detail?.ad?.externalId, '555');
    assert.equal(detail?.campaign?.name, 'Primavera');
    assert.equal(detail?.touches.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(detail!.touches[0], 'ctwa_clid'), false, 'ctwa_clid never surfaced');
    assert.equal(Object.prototype.hasOwnProperty.call(detail!.touches[0], 'ctwaClid'), false);
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2 repo: contacts origin filter + campaign filter return exactly the right contacts', async () => {
  const s = await seedScenario({ enableCrm: true, enableCampaigns: true });
  try {
    const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
    await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const camp = await createCampaign({ tenantId: s.tenantId, clientId: s.clientId, name: 'Camp' });
    const ad = await insertAd(s, '900', camp.id);

    const cAd = await seedContact(s.tenantId, s.clientId, { channelUserId: 'wa:ad' });
    const cOrg = await seedContact(s.tenantId, s.clientId, { channelUserId: 'wa:org' });
    const cNull = await seedContact(s.tenantId, s.clientId, { channelUserId: 'wa:null' });
    const tAd = await insertTouch(s, wfRef, cAd, ad, '2026-06-01T10:00:00Z');
    await query(`UPDATE contacts SET origin_kind='meta_ad', first_touch_id=$1 WHERE id=$2`, [tAd, cAd]);
    await query(`UPDATE contacts SET origin_kind='organic_whatsapp' WHERE id=$1`, [cOrg]);
    // cNull keeps origin_kind NULL (never classified).

    const anuncio = await listContacts(s.tenantId, { clientId: s.clientId, originKinds: ['meta_ad', 'meta_post'] });
    assert.deepEqual(anuncio.items.map((i) => i.id).sort(), [cAd].sort(), 'Anuncio = exactly the meta_ad contact');

    const organico = await listContacts(s.tenantId, { clientId: s.clientId, originKinds: ['organic_whatsapp', 'booking_page', 'booked_by_contact'] });
    assert.deepEqual(organico.items.map((i) => i.id), [cOrg]);

    const desconocido = await listContacts(s.tenantId, { clientId: s.clientId, originKinds: ['import', 'unknown'], includeNullOrigin: true });
    assert.deepEqual(desconocido.items.map((i) => i.id).sort(), [cNull].sort(), 'Desconocido includes the NULL-origin contact');

    const byCampaign = await listContacts(s.tenantId, { clientId: s.clientId, campaignId: camp.id });
    assert.deepEqual(byCampaign.items.map((i) => i.id), [cAd], 'campaign = the lead whose first touch is on its ad');

    const emptyCampaign = await listContacts(s.tenantId, { clientId: s.clientId, campaignId: randomUUID() });
    assert.equal(emptyCampaign.items.length, 0);
  } finally { await cleanupTenant(s.tenantId); }
});
