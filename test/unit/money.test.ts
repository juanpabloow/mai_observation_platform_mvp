import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { priceLabelCOP } from '../../web/lib/money.ts';

test('priceLabelCOP: Colombian format, thousands dot, no decimals when whole', () => {
  assert.equal(priceLabelCOP('35000.00'), '$35.000');
  assert.equal(priceLabelCOP('72500.00'), '$72.500');
  assert.equal(priceLabelCOP('2500.00'), '$2.500');
  assert.equal(priceLabelCOP('120000.00'), '$120.000');
  assert.equal(priceLabelCOP('15000.00'), '$15.000');
});

test('priceLabelCOP: keeps cents (comma) when present; handles number, null, junk', () => {
  assert.equal(priceLabelCOP('2500.50'), '$2.500,50');
  assert.equal(priceLabelCOP('999.90'), '$999,90');
  assert.equal(priceLabelCOP(35000), '$35.000');
  assert.equal(priceLabelCOP(null), null);
  assert.equal(priceLabelCOP(undefined), null);
  assert.equal(priceLabelCOP(''), null);
  assert.equal(priceLabelCOP('abc'), null);
});
