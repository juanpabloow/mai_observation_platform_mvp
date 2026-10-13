import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isBsuid, normalizeE164 } from '../../src/scheduling/phone.js';
import { r0NormalizeE164 } from '../support/r0Identity.js';

/**
 * WhatsApp business-scoped user ids (BSUID, "CO.…") are TRANSPORT ids, not phones. The
 * audit saw conversation refs flagged `es_bsuid: true`; normalizeE164 used to strip the
 * letters and invent a phone from the digits. Synthetic ids only. (The identity
 * classification and the resolve path are covered in test/integration/bsuidIdentity.)
 */
test('a BSUID is never turned into a phone', () => {
  for (const bsuid of ['CO.1234567890', 'co.573001112233', 'US.1555123', 'CO.573001112233456789', 'CO.ABCdef123']) {
    assert.equal(normalizeE164(bsuid), null, bsuid);
    assert.equal(normalizeE164(bsuid, { defaultRegion: { countryCode: '57', nationalLength: 10 } }), null, `${bsuid} (region-aware)`);
  }
});

test('real phones normalise exactly as before (stored identities still match themselves)', () => {
  assert.equal(normalizeE164('573001112233'), '+573001112233', 'the wa_id form');
  assert.equal(normalizeE164('+57 300 111 2233'), '+573001112233');
  assert.equal(normalizeE164('(57) 300-111-2233'), '+573001112233');
  assert.equal(normalizeE164('+573001112233'), '+573001112233', 'idempotent on E.164');
  assert.equal(normalizeE164('3001112233', { defaultRegion: { countryCode: '57', nationalLength: 10 } }), '+573001112233');
  // Only the BSUID SHAPE is refused: other inputs with letters read exactly as before.
  assert.equal(normalizeE164('wa:573001112233'), '+573001112233', 'the documented n8n conversation_ref form');
  assert.equal(normalizeE164('Tel. 573001112233'), '+573001112233');
});

test('isBsuid recognises the shape and nothing else', () => {
  for (const v of ['CO.1234567890', ' US.13491208655302741918 ', 'co.abc123']) assert.equal(isBsuid(v), true, v);
  for (const v of ['wa:573001112233', '573001112233', '+573001112233', 'COL.123', 'CO.', 'CO.12-34', 'a@b.co', null, undefined]) assert.equal(isBsuid(v), false, String(v));
});

// ── Parity with the deployed image (R0 = f7c4cf7) ──────────────────────────────────
// Production BSUIDs observed: 15, 16 and 17 digits (diagnostic 13 oct, Q6s). R0 already
// kept every BSUID of 16+ digits as an opaque value; the fix only changes the 7–15 range.
const bsuidOf = (n: number, first = '5') => `CO.${first}${'7'.repeat(n - 1)}`;

test('16- and 17-digit BSUIDs: R0 already refused them as phones — the fix agrees', () => {
  for (const n of [16, 17]) {
    const v = bsuidOf(n);
    assert.equal(r0NormalizeE164(v), null, `R0, ${n} digits`);
    assert.equal(normalizeE164(v), null, `fix, ${n} digits`);
    assert.equal(isBsuid(v), true);
  }
});

test('the ONLY behaviour change is a 7–15 digit BSUID not starting with 0', () => {
  for (let n = 1; n <= 20; n++) {
    for (const first of ['5', '0']) {
      const v = bsuidOf(n, first);
      const r0 = r0NormalizeE164(v);
      const r0ReadsPhone = n >= 7 && n <= 15 && first !== '0';
      assert.equal(r0 !== null, r0ReadsPhone, `R0 ${v}`);
      assert.equal(normalizeE164(v), null, `fix ${v}`);
    }
  }
  // Letters after the dot: R0 stripped them too, so it is the digit COUNT that matters.
  assert.equal(r0NormalizeE164('CO.AB5730011122334'), '+5730011122334');
  assert.equal(r0NormalizeE164('CO.AB5730011122334455'), null, '16 digits once the letters go');
  assert.equal(normalizeE164('CO.AB5730011122334'), null);
});

test('real phones: the fix and R0 normalise identically', () => {
  for (const v of ['573001112233', '+57 300 111 2233', '(57) 300-111-2233', '+573001112233', 'wa:573001112233', 'Tel. 573001112233', '0573001112233', '1234567', '1234567890123456']) {
    assert.equal(normalizeE164(v), r0NormalizeE164(v), v);
  }
});
