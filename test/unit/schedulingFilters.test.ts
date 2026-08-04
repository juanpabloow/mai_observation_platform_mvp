import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  APPOINTMENT_STATUSES,
  parseStatus,
  parseYmd,
  pickAllowedId,
  isUuid,
} from '../../web/lib/schedulingFilters.js';

/** Pure scheduling filter validation — foreign/malformed ids are ignored, enums exact. */
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '99999999-9999-4999-8999-999999999999';

test('status: exact enum only', () => {
  for (const s of APPOINTMENT_STATUSES) assert.equal(parseStatus(s), s);
  assert.equal(parseStatus('done'), null);
  assert.equal(parseStatus('no-show'), null, 'hyphen variant rejected');
  assert.equal(parseStatus(undefined), null);
});

test('date: strict YYYY-MM-DD incl. real calendar dates', () => {
  assert.equal(parseYmd('2026-08-03'), '2026-08-03');
  assert.equal(parseYmd('2026-13-01'), null, 'month 13 rejected');
  assert.equal(parseYmd('2026-02-30'), null, 'Feb 30 rejected');
  assert.equal(parseYmd('26-8-3'), null);
  assert.equal(parseYmd(undefined), null);
});

test('pickAllowedId: only a UUID present in the client-scoped set is honored', () => {
  const allowed = new Set([A, B]);
  assert.equal(pickAllowedId(A, allowed), A, 'own id kept');
  assert.equal(pickAllowedId(FOREIGN, allowed), undefined, 'foreign (another client) id ignored');
  assert.equal(pickAllowedId('not-a-uuid', allowed), undefined, 'malformed ignored');
  assert.equal(pickAllowedId(undefined, allowed), undefined);
  assert.equal(pickAllowedId(A, []), undefined, 'empty allow-set ignores everything');
});

test('isUuid', () => {
  assert.ok(isUuid(A));
  assert.equal(isUuid('x'), false);
  assert.equal(isUuid(123 as unknown as string), false);
});
