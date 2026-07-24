import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  isUuid,
  parseSetClientModuleInput,
} from '../../web/lib/clientModuleValidation.js';

/**
 * Strict runtime validation for the client-modules action input: no coercion,
 * never throws, registry-backed module keys, UUID-validated client ids.
 */

const CLIENT_ID = '5f0c3d54-1234-4abc-9def-0123456789ab';

test('valid input parses and preserves values', () => {
  const r = parseSetClientModuleInput({ clientId: CLIENT_ID, moduleKey: 'crm', enabled: true });
  assert.ok(r.ok);
  assert.deepEqual(r.value, { clientId: CLIENT_ID, moduleKey: 'crm', enabled: true });
  const off = parseSetClientModuleInput({ clientId: CLIENT_ID, moduleKey: 'scheduling', enabled: false });
  assert.ok(off.ok && off.value.enabled === false);
});

test('enabled: "false" (string) is rejected — no boolean coercion', () => {
  const r = parseSetClientModuleInput({ clientId: CLIENT_ID, moduleKey: 'crm', enabled: 'false' });
  assert.equal(r.ok, false);
});

test('enabled: 1 (number) is rejected — no truthiness coercion', () => {
  const r = parseSetClientModuleInput({ clientId: CLIENT_ID, moduleKey: 'crm', enabled: 1 });
  assert.equal(r.ok, false);
});

test('null / undefined / non-object inputs fail cleanly, never throw', () => {
  for (const bad of [null, undefined, 'string', 42, [], {}, { clientId: CLIENT_ID }]) {
    const r = parseSetClientModuleInput(bad);
    assert.equal(r.ok, false, `input ${JSON.stringify(bad)} must be rejected`);
  }
});

test('invalid UUID is rejected', () => {
  const r = parseSetClientModuleInput({ clientId: 'not-a-uuid', moduleKey: 'crm', enabled: true });
  assert.equal(r.ok, false);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(CLIENT_ID), true);
  assert.equal(isUuid(null), false);
  assert.equal(isUuid(123), false);
});

test('unknown module key is rejected', () => {
  const r = parseSetClientModuleInput({ clientId: CLIENT_ID, moduleKey: 'payments', enabled: true });
  assert.equal(r.ok, false);
});
