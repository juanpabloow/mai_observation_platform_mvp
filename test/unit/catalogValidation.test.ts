import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  PRODUCT_DESCRIPTION_MAX,
  normalizeProductCategory,
  normalizeProductDescription,
  normalizeProductName,
  normalizeProductPrice,
} from '../../web/lib/catalogValidation.js';

test('normalizeProductName: required, trimmed, non-blank', () => {
  assert.equal(normalizeProductName('  Óleo para barba  ').ok && normalizeProductName('  Óleo para barba  ').value, 'Óleo para barba');
  assert.equal(normalizeProductName('').ok, false);
  assert.equal(normalizeProductName('   ').ok, false);
  assert.equal(normalizeProductName(null).ok, false);
  const long = normalizeProductName('x'.repeat(201));
  assert.equal(long.ok, false);
  assert.match((long as { error: string }).error, /name/);
});

test('normalizeProductDescription: optional, blank→NULL, ≤500 (names the field)', () => {
  assert.deepEqual(normalizeProductDescription(undefined), { ok: true, value: null });
  assert.deepEqual(normalizeProductDescription(null), { ok: true, value: null });
  assert.deepEqual(normalizeProductDescription(''), { ok: true, value: null });
  assert.deepEqual(normalizeProductDescription('   \n\t '), { ok: true, value: null });
  assert.deepEqual(normalizeProductDescription('  Aceite natural.  '), { ok: true, value: 'Aceite natural.' });

  assert.equal(normalizeProductDescription('x'.repeat(PRODUCT_DESCRIPTION_MAX)).ok, true);
  const tooLong = normalizeProductDescription('x'.repeat(PRODUCT_DESCRIPTION_MAX + 1));
  assert.equal(tooLong.ok, false);
  assert.match((tooLong as { error: string }).error, /description/);
  assert.match((tooLong as { error: string }).error, /500/);
  // The limit counts the TRIMMED length — trailing spaces don't push a 500-char body over.
  assert.equal(normalizeProductDescription('x'.repeat(500) + '     ').ok, true);
});

test('normalizeProductCategory: optional free text, blank→NULL, trimmed', () => {
  assert.deepEqual(normalizeProductCategory(undefined), { ok: true, value: null });
  assert.deepEqual(normalizeProductCategory(''), { ok: true, value: null });
  assert.deepEqual(normalizeProductCategory('   '), { ok: true, value: null });
  assert.deepEqual(normalizeProductCategory('  Cuidado de barba '), { ok: true, value: 'Cuidado de barba' });
});

test('normalizeProductPrice: required, > 0, finite, rounded to 2 decimals (names the field)', () => {
  assert.deepEqual(normalizeProductPrice(35000), { ok: true, value: 35000 });
  assert.deepEqual(normalizeProductPrice('35000'), { ok: true, value: 35000 });
  assert.deepEqual(normalizeProductPrice('2500.509'), { ok: true, value: 2500.51 });

  for (const bad of [0, -1, '-5', 'abc', '', null, undefined, Infinity, NaN]) {
    const r = normalizeProductPrice(bad as number);
    assert.equal(r.ok, false, `price ${String(bad)} must be rejected`);
    assert.match((r as { error: string }).error, /price/);
  }
});
