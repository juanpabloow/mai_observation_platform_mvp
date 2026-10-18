import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseReferral } from '../../src/attribution/ingest.js';
import { decideInboundOrigin } from '../../src/db/repositories/attribution.js';
import { classifyContactOrigin } from '../../src/attribution/backfill.js';

test('parseReferral: absent → present:false (not an error)', () => {
  assert.deepEqual(parseReferral(null), { present: false });
  assert.deepEqual(parseReferral({}), { present: false });
  assert.deepEqual(parseReferral({ text: 'hola' }), { present: false });
});

test('parseReferral: a valid ad / post', () => {
  const ad = parseReferral({ referral_source_type: 'ad', referral_source_id: '1209876', referral_ctwa_clid: 'clid', referral_headline: 'h' });
  assert.equal(ad.present && ad.ok, true);
  if (ad.present && ad.ok) {
    assert.equal(ad.value.sourceType, 'ad');
    assert.equal(ad.value.sourceId, '1209876');
    assert.equal(ad.value.ctwaClid, 'clid');
  }
  const post = parseReferral({ referral_source_type: 'post', referral_source_id: '555' });
  assert.equal(post.present && post.ok && post.value.sourceType === 'post', true);
});

test('parseReferral: a TEST- id is valid (the is_test flag is derived in the DB)', () => {
  const r = parseReferral({ referral_source_type: 'ad', referral_source_id: 'TEST-0001' });
  assert.equal(r.present && r.ok && r.value.sourceId === 'TEST-0001', true);
});

test('parseReferral: invalid → present:true, ok:false (store the message, no touch, count it)', () => {
  const badType = parseReferral({ referral_source_type: 'carousel', referral_source_id: '123' });
  assert.equal(badType.present && !badType.ok, true);
  const missingType = parseReferral({ referral_source_id: '123' });
  assert.equal(missingType.present && !missingType.ok, true);
  const nonDigit = parseReferral({ referral_source_type: 'ad', referral_source_id: 'abc-not-test' });
  assert.equal(nonDigit.present && !nonDigit.ok, true);
  const tooLong = parseReferral({ referral_source_type: 'ad', referral_source_id: '1'.repeat(201) });
  assert.equal(tooLong.present && !tooLong.ok, true);
});

test('parseReferral: long free-text fields are capped, not rejected', () => {
  const r = parseReferral({ referral_source_type: 'ad', referral_source_id: '1', referral_headline: 'x'.repeat(900), referral_body: 'y'.repeat(5000) });
  assert.equal(r.present && r.ok, true);
  if (r.present && r.ok) {
    assert.equal(r.value.headline!.length, 500);
    assert.equal(r.value.body!.length, 2000);
  }
});

test('decideInboundOrigin: facts only', () => {
  assert.equal(decideInboundOrigin({ hasReferral: true, sourceType: 'ad', atOrAfterTrackingStart: true }), 'meta_ad');
  assert.equal(decideInboundOrigin({ hasReferral: true, sourceType: 'post', atOrAfterTrackingStart: false }), 'meta_post');
  assert.equal(decideInboundOrigin({ hasReferral: false, atOrAfterTrackingStart: true }), 'organic_whatsapp');
  assert.equal(decideInboundOrigin({ hasReferral: false, atOrAfterTrackingStart: false }), 'unknown');
});

test('classifyContactOrigin: first-message referral, booking page, tracking-start boundary', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const adRef = { sourceType: 'ad' as const, sourceId: '1', sourceUrl: null, ctwaClid: null, headline: null, body: null, mediaType: null };
  assert.equal(classifyContactOrigin({ channel: 'whatsapp', trackingStartedAt: start, firstMsgAt: new Date('2026-02-01'), firstReferral: adRef }), 'meta_ad');
  assert.equal(classifyContactOrigin({ channel: 'public', trackingStartedAt: start, firstMsgAt: null, firstReferral: null }), 'booking_page');
  // boundary: AT or after → organic; strictly before → unknown.
  assert.equal(classifyContactOrigin({ channel: 'whatsapp', trackingStartedAt: start, firstMsgAt: start, firstReferral: null }), 'organic_whatsapp');
  assert.equal(classifyContactOrigin({ channel: 'whatsapp', trackingStartedAt: start, firstMsgAt: new Date('2025-12-31'), firstReferral: null }), 'unknown');
  // tracking not started (no row) → unknown.
  assert.equal(classifyContactOrigin({ channel: 'whatsapp', trackingStartedAt: null, firstMsgAt: new Date('2026-02-01'), firstReferral: null }), 'unknown');
  // no inbound message at all → unknown.
  assert.equal(classifyContactOrigin({ channel: 'manual', trackingStartedAt: start, firstMsgAt: null, firstReferral: null }), 'unknown');
});
