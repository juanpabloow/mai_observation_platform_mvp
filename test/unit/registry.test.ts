import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CLIENT_MODULE_KEYS, isClientModuleKey } from '../../src/modules/registry.js';

test('crm and scheduling are valid client module keys', () => {
  assert.equal(isClientModuleKey('crm'), true);
  assert.equal(isClientModuleKey('scheduling'), true);
  // The guard agrees with the exported list.
  for (const key of CLIENT_MODULE_KEYS) assert.equal(isClientModuleKey(key), true);
});

test('unknown keys are invalid', () => {
  assert.equal(isClientModuleKey('payments'), false);
  assert.equal(isClientModuleKey(''), false);
  assert.equal(isClientModuleKey('CRM'), false); // keys are case-sensitive
});
