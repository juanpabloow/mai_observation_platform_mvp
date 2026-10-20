import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { getOrCreateConversation } from '../../src/db/repositories/handoff.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { setAttributionBriefWindowDays } from '../../src/db/repositories/attribution.js';
import { cleanupTenant, closeDb, seedContact, seedScenario, seedWorkflow } from './fixtures.js';
import { GET } from '../../web/app/api/handoff/v1/context/route.js';

/**
 * AT-3 — the `origin` block on GET /api/handoff/v1/context. The block appears ONLY when the
 * campaigns module is on and the conversation's contact has an AD TOUCH inside the brief window
 * (decided by the TOUCH, never by origin_kind). It carries the ad's promise + the campaign brief
 * and NO forbidden field (ctwa_clid, external/internal ids, counts). Same per-tenant isolation as
 * every integration file: each test seeds its own tenant and drops it after.
 */
const tenants: string[] = [];
after(async () => { for (const t of tenants) await cleanupTenant(t); await closeDb(); });

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await query<T>(sql, params)).rows[0];

async function fixture() {
  const s = await seedScenario({ enableCrm: true });
  tenants.push(s.tenantId);
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: true });
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'campaigns', enabled: true });
  const workflowRef = `wf-${randomUUID()}`;
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, workflowRef);
  const token = await issueToken(s.tenantId, connectionId, ['handoff.context.read']);
  const conversationRef = `co-${randomUUID()}`;
  const conv = await getOrCreateConversation(s.tenantId, workflowRef, conversationRef);
  const contactId = await seedContact(s.tenantId, s.clientId, { name: 'Lead', channelUserId: `wa:${randomUUID().slice(0, 8)}` });
  await query(`UPDATE conversations SET contact_id = $2 WHERE id = $1`, [conv.id, contactId]);
  return { ...s, workflowRef, connectionId, token, conversationRef, conversationId: conv.id, contactId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function mkAd(s: Fixture, opts: {
  externalId?: string; sourceType?: 'ad' | 'post'; name?: string | null; botNote?: string | null;
  headline?: string | null; body?: string | null; campaignId?: string | null;
} = {}): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO ads (tenant_id, client_id, platform, source_type, external_id, name, bot_note, headline, body, campaign_id)
       VALUES ($1,$2,'meta',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [s.tenantId, s.clientId, opts.sourceType ?? 'ad', opts.externalId ?? `ext-${randomUUID().slice(0, 10)}`,
      opts.name ?? null, opts.botNote ?? null, opts.headline ?? null, opts.body ?? null, opts.campaignId ?? null],
  );
  return r.id;
}

async function mkCampaign(s: Fixture, opts: {
  name?: string; botBrief?: string | null; targetServiceId?: string | null; promotionId?: string | null; externalCampaignId?: string | null;
} = {}): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO campaigns (tenant_id, client_id, name, bot_brief, target_service_id, promotion_id, external_campaign_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [s.tenantId, s.clientId, opts.name ?? 'Campaña', opts.botBrief ?? null,
      opts.targetServiceId ?? null, opts.promotionId ?? null, opts.externalCampaignId ?? null],
  );
  return r.id;
}

/** Defaults to a PUBLISHED, window-open (on-offer) promotion — the only kind the origin block
 *  surfaces. Pass status / a booking window to exercise the AT-3 promotion filter. */
async function mkPromotion(
  s: Fixture,
  name: string,
  description: string | null,
  opts: { status?: 'draft' | 'published' | 'paused' | 'archived'; bookableFrom?: string | null; bookableUntil?: string | null } = {},
): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO promotions (tenant_id, client_id, name, description, benefit_type, status, bookable_from, bookable_until)
       VALUES ($1,$2,$3,$4,'two_for_one',$5,$6::timestamptz,$7::timestamptz) RETURNING id`,
    [s.tenantId, s.clientId, name, description, opts.status ?? 'published', opts.bookableFrom ?? null, opts.bookableUntil ?? null],
  );
  return r.id;
}

const daysFromNow = (n: number): string => new Date(Date.now() + n * 86400000).toISOString();

/** A touch N hours ago (its own message), on this conversation unless overridden. */
async function mkTouch(s: Fixture, opts: { adId: string; agoHours: number; conversationId?: string; contactId?: string; ctwaClid?: string }): Promise<string> {
  const conversationId = opts.conversationId ?? s.conversationId;
  const contactId = opts.contactId ?? s.contactId;
  const m = await one<{ id: string }>(
    `INSERT INTO handoff_messages (tenant_id, conversation_id, sender, status, text, content_type, occurred_at)
       VALUES ($1,$2,'user','received','ref','text', now() - make_interval(hours => $3::int)) RETURNING id`,
    [s.tenantId, conversationId, opts.agoHours],
  );
  const t = await one<{ id: string }>(
    `INSERT INTO attribution_touches (tenant_id, client_id, contact_id, conversation_id, message_id, ad_id, ctwa_clid, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() - make_interval(hours => $8::int)) RETURNING id`,
    [s.tenantId, s.clientId, contactId, conversationId, m.id, opts.adId, opts.ctwaClid ?? null, opts.agoHours],
  );
  return t.id;
}

/** The current inbound customer message — the required anchor. */
async function anchor(s: Fixture, conversationId?: string): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO handoff_messages (tenant_id, conversation_id, sender, status, text, content_type, occurred_at)
       VALUES ($1,$2,'user','received','hola actual','text', now()) RETURNING id`,
    [s.tenantId, conversationId ?? s.conversationId],
  );
  return r.id;
}

async function call(s: Fixture, anchorId: string) {
  const params = new URLSearchParams({ workflow_ref: s.workflowRef, conversation_ref: s.conversationRef, through_message_id: anchorId });
  return GET(new Request(`http://test/api/handoff/v1/context?${params}`, { headers: { authorization: `Bearer ${s.token.rawToken}` } }));
}

test('AT-3: an ad touch inside the window attaches the full origin block', async () => {
  const s = await fixture();
  const promo = await mkPromotion(s, 'Lanzamiento', '20% off la primera cita');
  const camp = await mkCampaign(s, { name: 'Campaña Presentación', botBrief: 'Saluda, confirma interés y agenda el combo.', targetServiceId: s.serviceHaircut, promotionId: promo });
  const ad = await mkAd(s, { externalId: '120210000000001', name: 'Factos vic V2', botNote: 'Mencionar el 20% de descuento.', headline: 'Agenda tu cita hoy', body: 'Promo de lanzamiento, cupos limitados.', campaignId: camp });
  await mkTouch(s, { adId: ad, agoHours: 24 });
  const res = await call(s, await anchor(s));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.origin, {
    source_type: 'ad',
    ad: { name: 'Factos vic V2', headline: 'Agenda tu cita hoy', body: 'Promo de lanzamiento, cupos limitados.', bot_note: 'Mencionar el 20% de descuento.' },
    campaign: {
      name: 'Campaña Presentación',
      bot_brief: 'Saluda, confirma interés y agenda el combo.',
      target_service: { id: s.serviceHaircut, name: 'Haircut' },
      promotion: { title: 'Lanzamiento', description: '20% off la primera cita' },
    },
  });
});

test('AT-3 promotion filter: a published promotion within an explicit open window is surfaced', async () => {
  const s = await fixture();
  const promo = await mkPromotion(s, 'En vigencia', 'válida ahora', { status: 'published', bookableFrom: daysFromNow(-5), bookableUntil: daysFromNow(5) });
  const camp = await mkCampaign(s, { name: 'C', botBrief: 'b', promotionId: promo });
  const ad = await mkAd(s, { name: 'A', campaignId: camp });
  await mkTouch(s, { adId: ad, agoHours: 1 });
  const body = await (await call(s, await anchor(s))).json();
  assert.deepEqual(body.origin.campaign.promotion, { title: 'En vigencia', description: 'válida ahora' });
});

for (const status of ['draft', 'paused', 'archived'] as const) {
  test(`AT-3 promotion filter: a ${status} promotion is NOT pitched (promotion null, campaign intact)`, async () => {
    const s = await fixture();
    const promo = await mkPromotion(s, 'No vigente', 'desc', { status });
    const camp = await mkCampaign(s, { name: 'Camp', botBrief: 'brief', targetServiceId: s.serviceHaircut, promotionId: promo });
    const ad = await mkAd(s, { name: 'A', campaignId: camp });
    await mkTouch(s, { adId: ad, agoHours: 1 });
    const body = await (await call(s, await anchor(s))).json();
    assert.ok(body.origin.campaign, 'the campaign block still reaches the bot');
    assert.equal(body.origin.campaign.promotion, null, `a ${status} promo is filtered out`);
    assert.deepEqual(body.origin.campaign.target_service, { id: s.serviceHaircut, name: 'Haircut' }, 'the rest of the campaign is intact');
  });
}

test('AT-3 promotion filter: a published promotion BEFORE its booking window is not pitched', async () => {
  const s = await fixture();
  const promo = await mkPromotion(s, 'Aún no', 'desc', { status: 'published', bookableFrom: daysFromNow(3) });
  const camp = await mkCampaign(s, { name: 'C', botBrief: 'b', promotionId: promo });
  const ad = await mkAd(s, { name: 'A', campaignId: camp });
  await mkTouch(s, { adId: ad, agoHours: 1 });
  const body = await (await call(s, await anchor(s))).json();
  assert.ok(body.origin.campaign, 'campaign still present');
  assert.equal(body.origin.campaign.promotion, null);
});

test('AT-3 promotion filter: a published promotion AFTER its booking window has closed is not pitched', async () => {
  const s = await fixture();
  const promo = await mkPromotion(s, 'Ya cerró', 'desc', { status: 'published', bookableUntil: daysFromNow(-1) });
  const camp = await mkCampaign(s, { name: 'C', botBrief: 'b', promotionId: promo });
  const ad = await mkAd(s, { name: 'A', campaignId: camp });
  await mkTouch(s, { adId: ad, agoHours: 1 });
  const body = await (await call(s, await anchor(s))).json();
  assert.ok(body.origin.campaign, 'campaign still present');
  assert.equal(body.origin.campaign.promotion, null);
});

test('AT-3: a touch OUTSIDE the brief window attaches nothing', async () => {
  const s = await fixture();
  await setAttributionBriefWindowDays(s.tenantId, s.clientId, 3);
  const ad = await mkAd(s, { name: 'Viejo' });
  await mkTouch(s, { adId: ad, agoHours: 24 * 10 }); // 10 days ago; window 3
  const body = await (await call(s, await anchor(s))).json();
  assert.equal('origin' in body, false);
});

test('AT-3: with the campaigns module OFF there is no origin block (but context still returns)', async () => {
  const s = await fixture();
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'campaigns', enabled: false });
  const ad = await mkAd(s, { name: 'A' });
  await mkTouch(s, { adId: ad, agoHours: 1 });
  const res = await call(s, await anchor(s));
  assert.equal(res.status, 200, 'inbox context still resolves');
  assert.equal('origin' in (await res.json()), false);
});

test('AT-3: an unconfigured ad (no campaign) still gives the bot the ad text, campaign null', async () => {
  const s = await fixture();
  const ad = await mkAd(s, { name: 'Sin campaña', headline: 'H', body: 'B', botNote: 'N' });
  await mkTouch(s, { adId: ad, agoHours: 1 });
  const body = await (await call(s, await anchor(s))).json();
  assert.equal(body.origin.campaign, null);
  assert.deepEqual(body.origin.ad, { name: 'Sin campaña', headline: 'H', body: 'B', bot_note: 'N' });
  assert.equal(body.origin.source_type, 'ad');
});

test('AT-3: decided by the TOUCH (origin_kind unknown still gets the brief); no forbidden field leaks', async () => {
  const s = await fixture();
  // An EXISTING contact who clicked an ad keeps origin unknown by design — the brief must still arrive.
  await query(`UPDATE contacts SET origin_kind='unknown', origin_set_by='system' WHERE id=$1`, [s.contactId]);
  const camp = await mkCampaign(s, { name: 'Camp', botBrief: 'brief', externalCampaignId: 'CID-EXTERNAL-999' });
  const ad = await mkAd(s, { externalId: 'AD-EXTERNAL-888', name: 'A', headline: 'H', body: 'B', botNote: 'N', campaignId: camp });
  await mkTouch(s, { adId: ad, agoHours: 1, ctwaClid: 'CLID-SECRET-123' });
  const body = await (await call(s, await anchor(s))).json();
  assert.ok(body.origin, 'the touch drives the block regardless of origin_kind');
  const j = JSON.stringify(body.origin);
  assert.ok(!j.includes('CLID-SECRET-123'), 'no ctwa_clid');
  assert.ok(!j.includes('AD-EXTERNAL-888'), 'no external ad id');
  assert.ok(!j.includes('CID-EXTERNAL-999'), 'no external campaign id');
  assert.ok(!j.includes(ad), 'no internal ad uuid');
  assert.ok(!j.includes(camp), 'no internal campaign uuid');
  assert.deepEqual(Object.keys(body.origin), ['source_type', 'ad', 'campaign']);
  assert.deepEqual(Object.keys(body.origin.ad), ['name', 'headline', 'body', 'bot_note']);
  assert.deepEqual(Object.keys(body.origin.campaign), ['name', 'bot_brief', 'target_service', 'promotion']);
});

test('AT-3: the MOST RECENT ad touch in the window wins', async () => {
  const s = await fixture();
  const campOld = await mkCampaign(s, { name: 'Vieja', botBrief: 'vieja' });
  const campNew = await mkCampaign(s, { name: 'Nueva', botBrief: 'nueva' });
  const adOld = await mkAd(s, { name: 'Anuncio viejo', campaignId: campOld });
  const adNew = await mkAd(s, { name: 'Anuncio nuevo', campaignId: campNew });
  await mkTouch(s, { adId: adOld, agoHours: 48 });
  await mkTouch(s, { adId: adNew, agoHours: 2 });
  const body = await (await call(s, await anchor(s))).json();
  assert.equal(body.origin.ad.name, 'Anuncio nuevo');
  assert.equal(body.origin.campaign.name, 'Nueva');
});

test('AT-3: a real ad touch on ANOTHER conversation of the same contact still drives the block (contact-scoped)', async () => {
  const s = await fixture();
  const other = await getOrCreateConversation(s.tenantId, s.workflowRef, `other-${randomUUID()}`);
  await query(`UPDATE conversations SET contact_id = $2 WHERE id = $1`, [other.id, s.contactId]);
  const ad = await mkAd(s, { name: 'Desde otra conversación' });
  await mkTouch(s, { adId: ad, conversationId: other.id, agoHours: 1 });
  const body = await (await call(s, await anchor(s))).json();
  assert.ok(body.origin);
  assert.equal(body.origin.ad.name, 'Desde otra conversación');
});

test('AT-3: a TEST ad is ignored unless THIS conversation itself came from it', async () => {
  const s = await fixture();
  const testAd = await mkAd(s, { externalId: 'TEST-0001', name: 'Prueba' });
  // (a) a test-ad touch on ANOTHER conversation of the same contact → ignored.
  const other = await getOrCreateConversation(s.tenantId, s.workflowRef, `other-${randomUUID()}`);
  await query(`UPDATE conversations SET contact_id = $2 WHERE id = $1`, [other.id, s.contactId]);
  await mkTouch(s, { adId: testAd, conversationId: other.id, agoHours: 1 });
  const a = await anchor(s);
  assert.equal('origin' in (await (await call(s, a)).json()), false, 'test-ad touch on another conversation is ignored');
  // (b) the SAME test ad on THIS conversation → the conversation itself came from it.
  await mkTouch(s, { adId: testAd, conversationId: s.conversationId, agoHours: 1 });
  const body = await (await call(s, a)).json();
  assert.ok(body.origin, 'a test-ad touch on THIS conversation is included');
  assert.equal(body.origin.ad.name, 'Prueba');
});

test('AT-3: with no qualifying touch the response is byte-for-byte what it was before AT-3', async () => {
  const s = await fixture();
  const a = await anchor(s);
  const before = await (await call(s, a)).json();
  assert.equal('origin' in before, false);
  // An out-of-window touch must not change a single byte of the response.
  await setAttributionBriefWindowDays(s.tenantId, s.clientId, 1);
  const ad = await mkAd(s, { name: 'Fuera de ventana' });
  await mkTouch(s, { adId: ad, agoHours: 48 });
  const afterOutOfWindow = await (await call(s, a)).json();
  assert.deepEqual(afterOutOfWindow, before);
});
