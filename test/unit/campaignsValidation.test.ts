import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  AD_NOTE_MAX,
  CAMPAIGN_BRIEF_MAX,
  CAMPAIGN_NAME_MAX,
  normalizeAdName,
  normalizeAdNote,
  normalizeCampaignBrief,
  normalizeCampaignDate,
  normalizeCampaignName,
  normalizeCampaignStatus,
  normalizeExternalCampaignId,
  normalizeMetaAdId,
  validateDateRange,
} from '../../web/lib/campaignsValidation.js';

test('normalizeCampaignName: required, trimmed, bounded', () => {
  assert.equal(normalizeCampaignName('  Verano  ').ok && normalizeCampaignName('  Verano  ').value, 'Verano');
  assert.equal(normalizeCampaignName('   ').ok, false);
  assert.equal(normalizeCampaignName(null).ok, false);
  assert.equal(normalizeCampaignName('x'.repeat(CAMPAIGN_NAME_MAX + 1)).ok, false);
  assert.equal(normalizeCampaignName('x'.repeat(CAMPAIGN_NAME_MAX)).ok, true);
});

test('normalizeCampaignBrief: optional, blank→null, ≤1500', () => {
  assert.deepEqual(normalizeCampaignBrief(undefined), { ok: true, value: null });
  assert.deepEqual(normalizeCampaignBrief('   '), { ok: true, value: null });
  assert.equal(normalizeCampaignBrief('x'.repeat(CAMPAIGN_BRIEF_MAX)).ok, true);
  assert.equal(normalizeCampaignBrief('x'.repeat(CAMPAIGN_BRIEF_MAX + 1)).ok, false, 'over 1500 rejected');
});

test('normalizeExternalCampaignId: optional, blank→null, bounded', () => {
  assert.deepEqual(normalizeExternalCampaignId(''), { ok: true, value: null });
  assert.equal(normalizeExternalCampaignId('1200399').ok && normalizeExternalCampaignId('1200399').value, '1200399');
  assert.equal(normalizeExternalCampaignId('x'.repeat(201)).ok, false);
});

test('normalizeCampaignStatus: closed set', () => {
  for (const s of ['active', 'paused', 'ended']) assert.equal(normalizeCampaignStatus(s).ok, true);
  assert.equal(normalizeCampaignStatus('live').ok, false);
  assert.equal(normalizeCampaignStatus(undefined).ok, false);
});

test('normalizeCampaignDate: optional YYYY-MM-DD', () => {
  assert.deepEqual(normalizeCampaignDate(''), { ok: true, value: null });
  assert.equal(normalizeCampaignDate('2026-10-16').ok && normalizeCampaignDate('2026-10-16').value, '2026-10-16');
  assert.equal(normalizeCampaignDate('16/10/2026').ok, false);
  assert.equal(normalizeCampaignDate('2026-13-40').ok, false, 'not a real date');
});

test('validateDateRange: end must not precede start', () => {
  assert.equal(validateDateRange('2026-01-01', '2026-02-01').ok, true);
  assert.equal(validateDateRange('2026-02-01', '2026-01-01').ok, false);
  assert.equal(validateDateRange(null, '2026-01-01').ok, true);
  assert.equal(validateDateRange('2026-01-01', null).ok, true);
});

test('normalizeAdName: optional, blank→null, ≤200', () => {
  assert.deepEqual(normalizeAdName(undefined), { ok: true, value: null });
  assert.deepEqual(normalizeAdName('  '), { ok: true, value: null });
  assert.equal(normalizeAdName('  Factos Falla ').ok && normalizeAdName('  Factos Falla ').value, 'Factos Falla');
  assert.equal(normalizeAdName('x'.repeat(201)).ok, false);
});

test('normalizeAdNote: optional, blank→null, ≤500', () => {
  assert.deepEqual(normalizeAdNote(''), { ok: true, value: null });
  assert.equal(normalizeAdNote('x'.repeat(AD_NOTE_MAX)).ok, true);
  assert.equal(normalizeAdNote('x'.repeat(AD_NOTE_MAX + 1)).ok, false);
});

test('normalizeMetaAdId: required, digits only, ≤200', () => {
  assert.equal(normalizeMetaAdId('120210000000000').ok && normalizeMetaAdId('120210000000000').value, '120210000000000');
  assert.equal(normalizeMetaAdId('  777  ').ok && normalizeMetaAdId('  777  ').value, '777');
  assert.equal(normalizeMetaAdId('').ok, false);
  assert.equal(normalizeMetaAdId('abc').ok, false);
  assert.equal(normalizeMetaAdId('TEST-1').ok, false, 'pre-register is a real digit id, not a TEST- id');
  assert.equal(normalizeMetaAdId('12 34').ok, false);
});
