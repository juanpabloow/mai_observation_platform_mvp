import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseContactPatch } from '../../web/lib/contactActionValidation.js';

/** Anti-over-posting validation for the contact-update patch. */

test('valid payload parses; result is a fresh object with only provided fields', () => {
  const input = { name: 'Ana', phone: '+573001112233', stage: 'active' as const };
  const r = parseContactPatch(input);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { name: 'Ana', phone: '+573001112233', stage: 'active' });
  assert.notEqual(r.value, input, 'never the original reference');
  // Empty strings stay valid (current UI behavior).
  const empty = parseContactPatch({ name: '', email: '' });
  assert.ok(empty.ok);
  assert.deepEqual(empty.value, { name: '', email: '' });
  // An empty patch object is valid (no-op update).
  assert.ok(parseContactPatch({}).ok);
});

test('null / array / scalar payloads fail cleanly, never throw', () => {
  for (const bad of [null, undefined, [], ['name'], 'x', 42, true]) {
    assert.equal(parseContactPatch(bad).ok, false, `${JSON.stringify(bad)} rejected`);
  }
});

test('invalid enum values are rejected', () => {
  assert.equal(parseContactPatch({ stage: 'vip' }).ok, false);
  assert.equal(parseContactPatch({ bot_human_mode: 'auto' }).ok, false);
});

test('assigned_to (and any unknown key) is rejected — over-posting blocked', () => {
  assert.equal(parseContactPatch({ name: 'x', assigned_to: 'user-1' }).ok, false);
  assert.equal(parseContactPatch({ assigned_to: null }).ok, false);
  assert.equal(parseContactPatch({ anything_else: 1 }).ok, false);
});

test('overlong strings are rejected', () => {
  assert.equal(parseContactPatch({ name: 'a'.repeat(257) }).ok, false);
  assert.equal(parseContactPatch({ phone: '1'.repeat(65) }).ok, false);
  assert.equal(parseContactPatch({ email: 'e'.repeat(257) }).ok, false);
});

test('no coercion: non-string scalars and coercible values are rejected as-is', () => {
  assert.equal(parseContactPatch({ name: 123 }).ok, false);
  assert.equal(parseContactPatch({ stage: 1 }).ok, false);
  assert.equal(parseContactPatch({ bot_human_mode: true }).ok, false);
  // "false" is a fine STRING for name (no boolean field here), but must stay a string.
  const r = parseContactPatch({ name: 'false' });
  assert.ok(r.ok && r.value.name === 'false' && typeof r.value.name === 'string');
});
