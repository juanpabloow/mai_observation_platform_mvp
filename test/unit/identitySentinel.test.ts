import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isSentinelIdentifier, isQuarantinedRef, QUARANTINE_PREFIX } from '../../src/identity/sentinel.js';
import { isBsuid, normalizeE164 } from '../../src/scheduling/phone.js';

test('isSentinelIdentifier: empty, placeholder words, and n8n expressions are refused', () => {
  for (const bad of [
    undefined, null, '', '   ', '\n\t ',
    'undefined', 'UNDEFINED', ' Undefined ', 'null', 'NULL', 'nan', 'NaN', 'none', 'None',
    'true', 'false', '[object Object]', '[OBJECT OBJECT]',
    '{{ $json.contacts[0].wa_id }}', 'prefix {{x}}', '=$json.id', '=1+1',
  ]) {
    assert.equal(isSentinelIdentifier(bad as string), true, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('isSentinelIdentifier: real identifiers pass', () => {
  for (const ok of ['+573001234567', '573001234567', 'CO.2405123456', 'US.ENT.11815799212886844830', 'ana@example.com', 'wa:573001112233', 'IG_12345']) {
    assert.equal(isSentinelIdentifier(ok), false, `should accept ${ok}`);
  }
});

test('isQuarantinedRef: only the quarantine prefix', () => {
  assert.equal(QUARANTINE_PREFIX, 'quarantined:');
  assert.equal(isQuarantinedRef('quarantined:3f2a…'), true);
  assert.equal(isQuarantinedRef('QUARANTINED:abc'), true);
  assert.equal(isQuarantinedRef('quarantined'), false); // no colon
  assert.equal(isQuarantinedRef('CO.2405'), false);
  assert.equal(isQuarantinedRef(null), false);
});

test('isBsuid: direct and managed-portfolio (ENT) variants, never a phone', () => {
  assert.equal(isBsuid('CO.2405123456'), true);
  assert.equal(isBsuid('US.ENT.11815799212886844830'), true); // the ENT variant the audit flagged
  assert.equal(isBsuid(' co.abc123 '), true); // trimmed
  assert.equal(isBsuid('CO.'), false); // needs at least one segment
  assert.equal(isBsuid('C.2405'), false); // one-letter country
  assert.equal(isBsuid('573001234567'), false); // a phone is not a BSUID
  assert.equal(isBsuid('+573001234567'), false);
  assert.equal(isBsuid('ana@example.com'), false);
  assert.equal(isBsuid('x'.repeat(200)), false); // length cap
});

test('normalizeE164 INVARIANT: a letter-country+dot value can never become a phone (1444d5a + ENT)', () => {
  // The bug class 1444d5a fixed must not reopen through the ENT variant.
  assert.equal(normalizeE164('CO.2405123456'), null);
  assert.equal(normalizeE164('US.ENT.11815799212886844830'), null);
  assert.equal(normalizeE164('US.ENT.118'), null);
  // Real phones still normalize exactly as before (shipped behavior unchanged).
  assert.equal(normalizeE164('573001234567'), '+573001234567');
  assert.equal(normalizeE164('+57 300 123 4567'), '+573001234567');
  assert.equal(normalizeE164('wa:573001112233'), '+573001112233'); // documented wa: form keeps its digits
});
