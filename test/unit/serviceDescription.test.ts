import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SERVICE_DESCRIPTION_MAX, normalizeServiceDescription } from '../../web/lib/serviceDescription.js';

test('normalizeServiceDescription: optional, trimmed, whitespace→NULL, capped at 2000 (names the field)', () => {
  assert.equal(SERVICE_DESCRIPTION_MAX, 2000);
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

  // Exactly 2000 is allowed; 2001 is rejected with an error that NAMES the field + the limit.
  const ok = normalizeServiceDescription('x'.repeat(SERVICE_DESCRIPTION_MAX));
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.value?.length, 2000);

  const tooLong = normalizeServiceDescription('x'.repeat(SERVICE_DESCRIPTION_MAX + 1));
  assert.equal(tooLong.ok, false);
  assert.match((tooLong as { error: string }).error, /description/);
  assert.match((tooLong as { error: string }).error, /2000/);

  // The limit counts the TRIMMED length — trailing spaces don't push a max-size body over.
  assert.equal(normalizeServiceDescription('x'.repeat(2000) + '     ').ok, true);
  const completeText = 'Descripción completa.\n\n'.repeat(40);
  assert.ok(completeText.trim().length > 500);
  assert.deepEqual(normalizeServiceDescription(completeText), { ok: true, value: completeText.trim() });
});
