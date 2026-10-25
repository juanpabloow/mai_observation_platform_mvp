import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { ALL_CAPABILITIES } from '../../src/capabilities.js';
import { CAPABILITY_CHOICES, CAPABILITY_LABELS } from '../../web/lib/capabilityLabels.js';

/**
 * The token editor's capability checklist is DERIVED from ALL_CAPABILITIES (the single source of
 * truth), so a capability can never again exist without a checkbox (the pipeline.write bug). These
 * tests pin: every capability has a Spanish label, the derived list matches the vocabulary exactly,
 * and the component actually renders the derived list (not a re-hardcoded copy).
 */

test('the editor lists EVERY capability in ALL_CAPABILITIES, in order, each with a Spanish label', () => {
  assert.deepEqual(
    CAPABILITY_CHOICES.map((c) => c.key),
    [...ALL_CAPABILITIES],
    'the checklist derives from ALL_CAPABILITIES — same members, same order',
  );
  for (const cap of ALL_CAPABILITIES) {
    const meta = CAPABILITY_LABELS[cap];
    assert.ok(meta && meta.label.trim().length > 0, `${cap} has a label`);
    assert.ok(meta.hint.trim().length > 0, `${cap} has a hint`);
  }
  // The capability whose missing checkbox started this is present with its Spanish label.
  assert.equal(CAPABILITY_LABELS['pipeline.write'].label, 'Calificar oportunidades');
});

test('CAPABILITY_LABELS carries no key outside the vocabulary (no stale labels)', () => {
  for (const k of Object.keys(CAPABILITY_LABELS)) {
    assert.ok((ALL_CAPABILITIES as readonly string[]).includes(k), `${k} is a real capability`);
  }
  assert.equal(Object.keys(CAPABILITY_LABELS).length, ALL_CAPABILITIES.length, 'exactly one label per capability');
});

test('MachineTokens renders the derived list, not a re-hardcoded copy', () => {
  const src = readFileSync(resolve(process.cwd(), 'web/components/MachineTokens.tsx'), 'utf8');
  assert.match(src, /CAPABILITY_CHOICES/, 'the editor renders from CAPABILITY_CHOICES');
  // Guard against a future hand-written `{ key: "<capability>" }` array creeping back in.
  for (const cap of ALL_CAPABILITIES) {
    assert.ok(!new RegExp(`\\{\\s*key:\\s*["']${cap.replace('.', '\\.')}["']`).test(src), `no hardcoded entry for ${cap}`);
  }
});
