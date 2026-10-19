import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CAMPAIGN_BRIEF_MAX,
  CAMPAIGN_NAME_MAX,
  normalizeCampaignBrief,
  normalizeCampaignDate,
  normalizeCampaignName,
  normalizeCampaignStatus,
  normalizeExternalCampaignId,
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
