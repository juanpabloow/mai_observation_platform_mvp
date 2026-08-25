import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizeE164, dialingRegionForTimezone } from '../../src/scheduling/phone.js';

/**
 * QA-3 §2: a WhatsApp wa_id arrives with the country code ("573058830676"); a customer
 * typing a relative's number in chat types it LOCALLY ("3058830676"). normalizeE164 must
 * prepend the site's default dialing prefix to a local number, PRESERVE a number that
 * already carries a code, and REJECT (not guess) anything ambiguous. Crucially, the DEFAULT
 * (no-region) behavior is unchanged, so every stored identity keeps normalizing to itself.
 */
const CO = dialingRegionForTimezone('America/Bogota'); // { countryCode: '57', nationalLength: 10 }

test('default path (no region) — behavior is UNCHANGED (wa_id form + the reported cases)', () => {
  assert.equal(normalizeE164('573058830676'), '+573058830676'); // wa_id
  assert.equal(normalizeE164('+573058830676'), '+573058830676');
  assert.equal(normalizeE164('3058830676'), '+3058830676'); // pre-existing default (local mis-normalizes without a region)
  assert.equal(normalizeE164('305 883 0676'), '+3058830676');
  assert.equal(normalizeE164('0573058830676'), null); // leading zero rejected
});

test('region-aware: a LOCAL number gets the country code prepended', () => {
  assert.equal(normalizeE164('3058830676', { defaultRegion: CO }), '+573058830676');
  assert.equal(normalizeE164('305 883 0676', { defaultRegion: CO }), '+573058830676');
  assert.equal(normalizeE164('(305) 8830676', { defaultRegion: CO }), '+573058830676');
});

test('region-aware: a number already carrying the code (wa_id / +) is preserved unchanged', () => {
  assert.equal(normalizeE164('573058830676', { defaultRegion: CO }), '+573058830676');
  assert.equal(normalizeE164('+573058830676', { defaultRegion: CO }), '+573058830676');
  assert.equal(normalizeE164('+57 305 883 0676', { defaultRegion: CO }), '+573058830676');
});

test('region-aware: the LOCAL and the CC form of the same number converge on ONE E.164', () => {
  assert.equal(
    normalizeE164('3058830676', { defaultRegion: CO }),
    normalizeE164('573058830676', { defaultRegion: CO }),
  );
});

test('region-aware: genuinely ambiguous lengths are REJECTED (ask for the CC, never guess)', () => {
  assert.equal(normalizeE164('88830676', { defaultRegion: CO }), null); // 8 digits — no known format
  assert.equal(normalizeE164('12125551234', { defaultRegion: CO }), null); // foreign, 11 digits, no +
  assert.equal(normalizeE164('0573058830676', { defaultRegion: CO }), null);
  assert.equal(normalizeE164('+12125551234', { defaultRegion: CO }), '+12125551234'); // foreign WITH + is fine
});

test('every E.164 value normalizes to ITSELF — stored identities stay stable (region or not)', () => {
  for (const v of ['+573058830676', '+573001112233', '+13058830676', '+34911234567', '+528110000000']) {
    assert.equal(normalizeE164(v), v, `${v} stable (default)`);
    assert.equal(normalizeE164(v, { defaultRegion: CO }), v, `${v} stable (region)`);
  }
});

test('unmapped timezone → no region → falls back to default behavior (no new rejection)', () => {
  assert.equal(dialingRegionForTimezone('Europe/Madrid'), null);
  assert.equal(dialingRegionForTimezone(null), null);
  const none = dialingRegionForTimezone('Europe/Madrid');
  assert.equal(normalizeE164('573058830676', { defaultRegion: none }), '+573058830676'); // wa_id still fine
  assert.equal(normalizeE164('3058830676', { defaultRegion: none }), '+3058830676'); // unchanged default (no CC known)
});
