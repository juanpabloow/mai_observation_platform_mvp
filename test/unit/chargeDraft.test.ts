import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { amountInput, checkCharge, needsReason, parseAmount, toDraftInput, type ChargeForm } from '../../web/lib/chargeDraft.ts';

test('amounts are read the Colombian way; empty is unknown, never $0', () => {
  assert.equal(parseAmount('45.000'), 45000);
  assert.equal(parseAmount('45000'), 45000);
  assert.equal(parseAmount('$ 45.000'), 45000);
  assert.equal(parseAmount('12,5'), 12.5);
  assert.equal(parseAmount('1.234.567'), 1234567);
  assert.equal(parseAmount(''), null, 'empty is unknown');
  assert.equal(parseAmount('0'), 0, 'a free service is a real 0');
  assert.equal(parseAmount('-5'), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(amountInput('45000.00'), '45000');
  assert.equal(amountInput(null), '');
});

const base = (over: Partial<ChargeForm> = {}): ChargeForm => ({
  methodKey: 'efectivo',
  service: { listPrice: '45000.00', amount: '45000', reason: '', note: '' },
  products: [],
  note: '',
  ...over,
});

test('the service line: unknown price needs an amount; under the price needs a reason; «Otro» needs a note', () => {
  assert.equal(checkCharge(base({ service: { listPrice: null, amount: '', reason: '', note: '' } })).errors.amount, 'Escribe el importe: este servicio no tiene precio guardado.');
  assert.deepEqual(checkCharge(base()).errors, {}, 'full price: nothing to explain');
  assert.ok(checkCharge(base({ service: { listPrice: '45000.00', amount: '40000', reason: '', note: '' } })).errors.reason);
  assert.ok(checkCharge(base({ service: { listPrice: '45000.00', amount: '40000', reason: 'otro', note: ' ' } })).errors.reasonNote);
  assert.deepEqual(checkCharge(base({ service: { listPrice: '45000.00', amount: '40000', reason: 'promocion', note: '' } })).errors, {});
  assert.deepEqual(checkCharge(base({ service: { listPrice: '0.00', amount: '0', reason: '', note: '' } })).errors, {}, 'a free service charges 0 with no reason');
  assert.equal(needsReason(null, 10), false, 'no list price: nothing to compare');
  assert.ok(checkCharge(base({ methodKey: '' })).errors.method);
});

test('products: quantities, unit prices and the estimated total (in cents)', () => {
  const f = base({
    products: [
      { productId: 'p1', name: 'Cera', listPrice: '25000.00', quantity: 2, unit: '25000', reason: '', note: '', inStock: true },
      { productId: 'p2', name: 'Aceite', listPrice: '30000.00', quantity: 1, unit: '20000', reason: 'cortesia', note: '', inStock: false },
    ],
  });
  const c = checkCharge(f);
  assert.deepEqual(c.errors, {});
  assert.equal(c.totalCents, (45000 + 2 * 25000 + 20000) * 100);
  const d = toDraftInput(f, 'staff-1');
  assert.equal(d.products[0].quantity, 2);
  assert.equal(d.products[1].adjustmentReason, 'cortesia');
  assert.equal(d.products[0].adjustmentReason, null, 'no reason sent when charged at list');
  assert.equal((d as Record<string, unknown>).total, undefined, 'the draft carries no total: the server computes it');
  assert.ok(checkCharge(base({ products: [{ productId: 'p', name: 'x', listPrice: '1.00', quantity: 0, unit: '1', reason: '', note: '', inStock: true }] })).errors['qty-0']);
  assert.equal(checkCharge(base({ products: [{ productId: 'p', name: 'x', listPrice: '1.00', quantity: 1, unit: '', reason: '', note: '', inStock: true }] })).totalCents, null);
});
