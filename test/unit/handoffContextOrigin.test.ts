import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  ORIGIN_AD_BODY_CHARS,
  ORIGIN_AD_HEADLINE_CHARS,
  projectConversationOrigin,
  type OriginSnapshot,
} from '../../src/handoff/context.js';

const base: OriginSnapshot = {
  source_type: 'ad',
  ad_name: 'Factos vic V2',
  ad_headline: 'Agenda tu cita hoy',
  ad_body: 'Promo de lanzamiento, cupos limitados.',
  ad_bot_note: 'Mencionar el 20% de descuento.',
  campaign_name: 'Campaña Presentación',
  campaign_bot_brief: 'Saluda, confirma interés en el combo y agenda.',
  service_id: 'svc-1',
  service_name: 'Combo Presentación',
  promo_title: 'Lanzamiento',
  promo_description: '20% off la primera cita',
};

test('AT-3 projector: full block has EXACTLY the contracted key set, no extras', () => {
  const o = projectConversationOrigin(base);
  assert.deepEqual(Object.keys(o), ['source_type', 'ad', 'campaign']);
  assert.deepEqual(Object.keys(o.ad), ['name', 'headline', 'body', 'bot_note']);
  assert.deepEqual(Object.keys(o.campaign!), ['name', 'bot_brief', 'target_service', 'promotion']);
  assert.deepEqual(Object.keys(o.campaign!.target_service!), ['id', 'name']);
  assert.deepEqual(Object.keys(o.campaign!.promotion!), ['title', 'description']);
  assert.equal(o.source_type, 'ad');
  assert.equal(o.ad.name, 'Factos vic V2');
  assert.equal(o.ad.bot_note, 'Mencionar el 20% de descuento.');
  assert.equal(o.campaign!.target_service!.id, 'svc-1');
  assert.equal(o.campaign!.promotion!.title, 'Lanzamiento');
});

test('AT-3 projector: a null campaign_name means no campaign — the bot still gets the ad text', () => {
  const o = projectConversationOrigin({ ...base, campaign_name: null, campaign_bot_brief: null, service_id: null, service_name: null, promo_title: null, promo_description: null });
  assert.equal(o.campaign, null);
  assert.equal(o.ad.headline, 'Agenda tu cita hoy');
});

test('AT-3 projector: a campaign with no service / no promotion / no brief nulls each independently', () => {
  const o = projectConversationOrigin({ ...base, campaign_bot_brief: null, service_id: null, service_name: null, promo_title: null, promo_description: null });
  assert.equal(o.campaign!.bot_brief, null);
  assert.equal(o.campaign!.target_service, null);
  assert.equal(o.campaign!.promotion, null);
  assert.equal(o.campaign!.name, 'Campaña Presentación');
});

test('AT-3 projector: headline/body are truncated to sensible limits; name/note/brief are not', () => {
  const o = projectConversationOrigin({
    ...base,
    ad_headline: 'h'.repeat(ORIGIN_AD_HEADLINE_CHARS + 50),
    ad_body: 'b'.repeat(ORIGIN_AD_BODY_CHARS + 50),
  });
  assert.equal(o.ad.headline!.length, ORIGIN_AD_HEADLINE_CHARS);
  assert.equal(o.ad.body!.length, ORIGIN_AD_BODY_CHARS);
  // bot_note is business config, passed whole.
  assert.equal(o.ad.bot_note, base.ad_bot_note);
});

test('AT-3 projector: null ad copy stays null (no empty strings)', () => {
  const o = projectConversationOrigin({ ...base, ad_name: null, ad_headline: null, ad_body: null, ad_bot_note: null });
  assert.deepEqual(o.ad, { name: null, headline: null, body: null, bot_note: null });
});

test('AT-3 route: attaches origin AFTER context resolves, only when present', () => {
  const route = readFileSync(new URL('../../web/app/api/handoff/v1/context/route.ts', import.meta.url), 'utf8');
  assert.ok(route.includes('readConversationOrigin'));
  // origin is computed on the RESOLVED conversation id (fail-closed rules inherited)…
  assert.ok(route.includes('conversationId: context.conversation_id'));
  // …and only added when present (absent → the response is byte-for-byte what it was before).
  assert.ok(route.includes('origin ? { ...context, origin } : context'));
});
