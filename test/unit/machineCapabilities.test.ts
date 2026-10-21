import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ALL_CAPABILITIES,
  LEGACY_CAPABILITIES,
  isCapability,
  tokenHasCapability,
} from '../../src/db/repositories/handoffTokens.js';

/**
 * C-5 machine-token capability vocabulary + the deny-by-default membership check. This
 * pure logic is the core of the audit-① fix: a token grants ONLY what it lists, an
 * unknown string is never a wildcard, and legacy tokens get exactly the pre-C-5 authority.
 */

test('the vocabulary includes the opt-in context capability', () => {
  assert.deepEqual(
    [...ALL_CAPABILITIES],
    ['handoff', 'scheduling.read', 'scheduling.write', 'crm.read', 'crm.write', 'pipeline.write', 'catalog.read', 'handoff.context.read'],
  );
});

test('LEGACY_CAPABILITIES is the pre-C-5 authority — NO crm.*, pipeline.* or catalog.*', () => {
  assert.deepEqual([...LEGACY_CAPABILITIES], ['handoff', 'scheduling.read', 'scheduling.write']);
  assert.ok(!LEGACY_CAPABILITIES.includes('crm.read' as never));
  assert.ok(!LEGACY_CAPABILITIES.includes('crm.write' as never));
  // A new API family must never be auto-granted to existing tokens.
  assert.ok(!LEGACY_CAPABILITIES.includes('pipeline.write' as never), 'PL-3: the bot-qualify capability is opt-in, never backfilled');
  assert.ok(!LEGACY_CAPABILITIES.includes('catalog.read' as never));
  assert.ok(!LEGACY_CAPABILITIES.includes('handoff.context.read' as never));
});

test('isCapability accepts only the vocabulary', () => {
  assert.ok(isCapability('crm.write'));
  assert.ok(!isCapability('crm.delete'));
  assert.ok(!isCapability('*'));
  assert.ok(!isCapability(''));
});

test('tokenHasCapability is deny-by-default; unknown strings are never a wildcard', () => {
  assert.ok(tokenHasCapability(['handoff', 'scheduling.read'], 'handoff'));
  assert.ok(!tokenHasCapability(['handoff'], 'crm.read'), 'missing capability → denied');
  assert.ok(!tokenHasCapability(['handoff'], 'handoff.context.read'), 'handoff alone never grants history');
  assert.ok(!tokenHasCapability([], 'handoff'), 'empty grants → denied');
  assert.ok(!tokenHasCapability(['*', 'admin'], 'crm.write'), 'an unknown/wildcard-looking string grants nothing');
  assert.ok(!tokenHasCapability(null, 'handoff'));
  assert.ok(!tokenHasCapability(undefined, 'scheduling.write'));
});
