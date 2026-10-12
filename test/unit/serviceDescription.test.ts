import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SERVICE_DESCRIPTION_MAX, normalizeServiceDescription } from '../../web/lib/serviceDescription.js';

test('normalizeServiceDescription: optional, trimmed, whitespace→NULL, capped at 500 (names the field)', () => {
  // Absent / empty / whitespace-only → NULL (no description).
  assert.deepEqual(normalizeServiceDescription(undefined), { ok: true, value: null });
  assert.deepEqual(normalizeServiceDescription(null), { ok: true, value: null });
  assert.deepEqual(normalizeServiceDescription(''), { ok: true, value: null });
  assert.deepEqual(normalizeServiceDescription('   \n\t '), { ok: true, value: null });

  // A real value is trimmed and stored as plain text.
  assert.deepEqual(
    normalizeServiceDescription('  Incluye lavado y corte.  '),
    { ok: true, value: 'Incluye lavado y corte.' },
  );

  // Exactly 500 is allowed; 501 is rejected with an error that NAMES the field + the limit.
  const ok = normalizeServiceDescription('x'.repeat(SERVICE_DESCRIPTION_MAX));
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.value?.length, 500);

  const tooLong = normalizeServiceDescription('x'.repeat(SERVICE_DESCRIPTION_MAX + 1));
  assert.equal(tooLong.ok, false);
  assert.match((tooLong as { error: string }).error, /description/);
  assert.match((tooLong as { error: string }).error, /500/);

  // The limit counts the TRIMMED length — trailing spaces don't push a 500-char body over.
  assert.equal(normalizeServiceDescription('x'.repeat(500) + '     ').ok, true);
});
