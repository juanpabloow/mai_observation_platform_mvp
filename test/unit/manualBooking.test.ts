import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createThenMaybeConfirm, type CreateOutcome } from '../../web/lib/manualBooking.js';

/** BEHAVIOUR of "Estado inicial" (create → confirm only when asked). */
const created = (status = 'scheduled'): (() => Promise<CreateOutcome>) => async () => ({ ok: true, id: 'a1', status });

test('Sin confirmar: creates only — the confirm step never runs', async () => {
  let confirms = 0;
  const r = await createThenMaybeConfirm(created(), async () => (confirms++, { ok: true }), 'scheduled');
  assert.deepEqual(r, { ok: true, id: 'a1' });
  assert.equal(confirms, 0);
});

test('Confirmada: creates, then runs the real confirm transition once', async () => {
  const seen: string[] = [];
  const r = await createThenMaybeConfirm(created(), async (id) => (seen.push(id), { ok: true }), 'confirmed');
  assert.deepEqual(r, { ok: true, id: 'a1' });
  assert.deepEqual(seen, ['a1']);
});

test('confirm fails: still ok (the booking exists) with a warning — never an error that invites a re-create', async () => {
  const r = await createThenMaybeConfirm(created(), async () => ({ ok: false, error: 'boom' }), 'confirmed');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.id, 'a1');
  assert.match(r.ok ? r.warning ?? '' : '', /se creó como «Sin confirmar»/);
  const thrown = await createThenMaybeConfirm(created(), async () => {
    throw new Error('network');
  }, 'confirmed');
  assert.equal(thrown.ok, true, 'a thrown confirm is the same warning, not a failure');
});

test('a deduped replay that is already confirmed is not confirmed again', async () => {
  let confirms = 0;
  const r = await createThenMaybeConfirm(created('confirmed'), async () => (confirms++, { ok: true }), 'confirmed');
  assert.deepEqual(r, { ok: true, id: 'a1' });
  assert.equal(confirms, 0);
});

test('create fails: the error passes through and nothing is confirmed', async () => {
  let confirms = 0;
  const r = await createThenMaybeConfirm(async () => ({ ok: false, error: 'Ese horario ya no está disponible.' }), async () => (confirms++, { ok: true }), 'confirmed');
  assert.deepEqual(r, { ok: false, error: 'Ese horario ya no está disponible.' });
  assert.equal(confirms, 0);
});
