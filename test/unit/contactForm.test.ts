import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildEditPatch,
  changedFields,
  checkIdentity,
  cleanIdentities,
  consentProvenance,
  contactSince,
  COPY,
  initialsFor,
  matchHeading,
  normalizeIdentity,
  relativeAge,
  unsavedLabel,
  type ContactFormValues,
} from '../../web/lib/contactForm.js';
import { conversationAvatarLabel } from '../../web/lib/inboxView.js';

/**
 * The contact form's RULES, tested away from React. Each block below is a rule the
 * brief states explicitly, so a regression here is a regression against the spec and
 * not merely against an implementation detail.
 */

// ── THE identity rule: at least one of phone or email; name irrelevant ──────────

test('identity: neither field is required on its own, the PAIR is', () => {
  assert.equal(checkIdentity([], []).canSubmit, false);
  assert.equal(checkIdentity([''], ['  ']).canSubmit, false, 'blank inputs are not identities');
  assert.equal(checkIdentity([], []).error, COPY.needsIdentity);

  // Phone alone is enough. Email alone is enough. Neither is individually required.
  assert.equal(checkIdentity(['+573001112233'], []).canSubmit, true);
  assert.equal(checkIdentity([], ['a@b.com']).canSubmit, true);
  assert.equal(checkIdentity(['+573001112233'], []).error, null);
});

test('identity: a name is never required and never makes a contact submittable', () => {
  // The brief: "El nombre es OPCIONAL (muchos leads llegan solo con número)". The check
  // takes no name at all — there is nowhere for a name to influence the decision.
  assert.equal(checkIdentity([], []).canSubmit, false);
  assert.equal(checkIdentity(['573001112233'], []).canSubmit, true);
});

test('identity: a duplicate never blocks — the check knows nothing about matches', () => {
  // Deliberate: checkIdentity is the ONLY gate on submit, and it has no notion of an
  // existing contact. Duplicates are a warning rendered elsewhere.
  const r = checkIdentity(['+573185980405'], []);
  assert.equal(r.canSubmit, true);
  assert.equal(r.error, null);
});

// ── E.164 normalization: the DB holds both "+57 318…" and "573043906303" ────────

test('phone normalizes to E.164 the same way the identity spine will', () => {
  assert.equal(normalizeIdentity('phone', '+57 318 598 0405'), '+573185980405');
  assert.equal(normalizeIdentity('phone', '573043906303'), '+573043906303');
  assert.equal(normalizeIdentity('phone', '57-304-390-6303'), '+573043906303');
  // Unnormalizable → null, so the field says "no parece válido" instead of querying.
  assert.equal(normalizeIdentity('phone', '123'), null);
  assert.equal(normalizeIdentity('phone', '0573001112233'), null, 'no leading zero in E.164');
});

test('email normalizes to lowercase; a malformed one is null', () => {
  assert.equal(normalizeIdentity('email', '  Camila@Mail.COM '), 'camila@mail.com');
  assert.equal(normalizeIdentity('email', 'not-an-email'), null);
  assert.equal(normalizeIdentity('email', 'a@b'), null);
});

test('the same number typed two ways counts ONCE', () => {
  // Both forms normalize to +573185980405, so the form must not claim two identities.
  const phones = cleanIdentities('phone', ['+57 318 598 0405', '573185980405', '']);
  assert.deepEqual(phones, ['+57 318 598 0405'], 'first typed form wins, dupe dropped');
});

test('multiple DISTINCT emails are all kept (the DB already has such contacts)', () => {
  const emails = cleanIdentities('email', ['a@mail.com', 'B@Mail.com', 'a@mail.com']);
  assert.deepEqual(emails, ['a@mail.com', 'B@Mail.com'], 'case-insensitive dedupe, order kept');
  assert.equal(checkIdentity([], emails).emails.length, 2);
});

test('an unnormalizable value still reaches the server rather than vanishing', () => {
  // Silently dropping it would let the form submit "successfully" having discarded what
  // the operator typed. It must survive and be rejected server-side.
  assert.deepEqual(cleanIdentities('phone', ['123']), ['123']);
});

// ── Edit: only what changed ────────────────────────────────────────────────────

const base: ContactFormValues = {
  name: 'Camila Reyes',
  stage: 'customer',
  assignedTo: 'user-paola',
  preferredChannel: 'whatsapp',
  doNotContact: false,
  consent: 'opted_in',
  customFields: { origen: 'Referido' },
  tags: ['VIP', 'Renueva en nov'],
};

test('no edits → no changes and an empty patch', () => {
  assert.deepEqual(changedFields(base, { ...base }), []);
  assert.deepEqual(buildEditPatch(base, { ...base }), {});
});

test('the patch carries ONLY the changed fields', () => {
  const next = { ...base, name: 'Camila R.', stage: 'active' };
  assert.deepEqual(changedFields(base, next).sort(), ['name', 'stage']);
  assert.deepEqual(buildEditPatch(base, next), { name: 'Camila R.', stage: 'active' });
});

test('an untouched consent is NEVER in the patch', () => {
  // Why this matters: updateContact re-stamps consent_updated_at whenever
  // messaging_consent is present, so including it on a name-only save would rewrite
  // "Aceptado el 12 mar 2023" to today.
  const next = { ...base, name: 'Otro nombre' };
  assert.equal('messaging_consent' in buildEditPatch(base, next), false);
});

test('untouched custom fields are NEVER in the patch', () => {
  // Re-asserting the whole blob on every save defeats the partial merge that stops one
  // editor wiping another's enrichment.
  const next = { ...base, doNotContact: true };
  assert.deepEqual(buildEditPatch(base, next), { do_not_contact: true });
});

test('reordering tags or chips is not a change', () => {
  const reordered = { ...base, tags: ['Renueva en nov', 'VIP'] };
  assert.deepEqual(changedFields(base, reordered), []);
});

test('clearing the name sends null, not an empty string', () => {
  const patch = buildEditPatch(base, { ...base, name: '   ' });
  assert.deepEqual(patch, { name: null });
});

test('clearing the owner and the channel sends null for each', () => {
  const patch = buildEditPatch(base, { ...base, assignedTo: null, preferredChannel: null });
  assert.deepEqual(patch, { assigned_to: null, preferred_channel: null });
});

test('identities are never part of the patch (they are add-only, via the spine)', () => {
  const patch = buildEditPatch(base, { ...base, name: 'x' });
  assert.equal('phone' in patch, false);
  assert.equal('email' in patch, false);
  assert.equal('phones' in patch, false);
});

test('tags change the COUNT but are written as their own rows, not patched', () => {
  const next = { ...base, tags: ['VIP'] };
  assert.deepEqual(changedFields(base, next), ['tags']);
  assert.deepEqual(buildEditPatch(base, next), {}, 'tags are attach/detach, not a column');
});

test('unsaved label is singular for one change', () => {
  assert.equal(unsavedLabel(1), '1 cambio sin guardar');
  assert.equal(unsavedLabel(2), '2 cambios sin guardar');
});

// ── Copy ───────────────────────────────────────────────────────────────────────

test('the duplicate heading pluralises on the TRUE total', () => {
  assert.equal(matchHeading(1, 'phone'), 'Ya existe 1 contacto con este número');
  assert.equal(matchHeading(3, 'phone'), 'Ya existen 3 contactos con este número');
  assert.equal(matchHeading(2, 'email'), 'Ya existen 2 contactos con este email');
});

test('the blocking message is exactly the one the brief specifies', () => {
  assert.equal(COPY.needsIdentity, 'Necesitas al menos un teléfono o un email.');
});

test('labels are neutral — never "Work email"', () => {
  const all = Object.values(COPY).join(' ');
  assert.equal(/work/i.test(all), false);
});

// ── Display helpers ────────────────────────────────────────────────────────────

test('initials follow ONE rule app-wide — the contacts table\'s', () => {
  // The disc must not change between the table row, the quick view and the drawer.
  assert.equal(initialsFor('Camila Reyes', 'x'), 'CR');
  assert.equal(initialsFor('Camila', 'x'), 'C', 'one word gives one letter, never an invented second');
  // First TWO words, not first+last: "SV" is the pair a Spanish reader recognises.
  assert.equal(initialsFor('Santiago Vanegas Mora', 'x'), 'SV');
  // A bare number falls back to its LAST two digits — the part that distinguishes two
  // numbers sharing a country code.
  assert.equal(initialsFor(null, '+57 318 598 0405'), '05');
  assert.equal(initialsFor('  ', 'a@b.com'), 'A');
  // It IS the table's helper, not a copy of it.
  assert.equal(initialsFor('Santiago Vanegas Mora', 'x'), conversationAvatarLabel('x', 'Santiago Vanegas Mora'));
});

test('relative age reads in Spanish and rounds coarsely', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  assert.equal(relativeAge('2026-08-09T12:00:00Z', now), 'hace 3 días');
  assert.equal(relativeAge('2026-08-11T12:00:00Z', now), 'hace 1 día');
  assert.equal(relativeAge('2026-02-12T12:00:00Z', now), 'hace 6 meses');
  assert.equal(relativeAge('2026-08-12T11:30:00Z', now), 'hace 30 min');
});

test('"Contacto desde …" uses a Spanish month', () => {
  assert.match(contactSince('2023-03-14T00:00:00Z'), /^Contacto desde /);
});

test('consent provenance appears only when consent is actually on record', () => {
  assert.equal(consentProvenance('unknown', '2023-03-12T00:00:00Z', 'WhatsApp'), null);
  assert.equal(consentProvenance('opted_out', '2023-03-12T00:00:00Z', 'WhatsApp'), null);
  const line = consentProvenance('opted_in', '2023-03-12T15:00:00Z', 'WhatsApp');
  assert.ok(line && line.startsWith('Aceptado el ') && line.endsWith(' por WhatsApp'), line ?? 'null');
  // Degrades when the source was never recorded.
  const noSource = consentProvenance('opted_in', '2023-03-12T15:00:00Z', null);
  assert.ok(noSource && !noSource.includes(' por '), noSource ?? 'null');
  assert.equal(consentProvenance('opted_in', null, null), null);
});
