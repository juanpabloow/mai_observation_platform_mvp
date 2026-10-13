import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COPY, checkAddedIdentities, checkIdentity } from '../../web/lib/contactForm.js';
import {
  INVALID_EMAIL,
  INVALID_PHONE,
  NEEDS_IDENTITY,
  parseContactCreate,
  parseContactPatch,
} from '../../web/lib/contactActionValidation.js';

/**
 * AUDIT F2/C1 — "Nuevo contacto" said "Listo para guardar" and enabled "Crear contacto"
 * with "abc" in the email, and the server would have stored it: parseContactCreate only
 * checked that SOMETHING was typed, and resolveContactByIdentity writes `email` verbatim.
 * The banner and the button both read `checkIdentity(...).canSubmit`; the server now
 * applies the same normalization.
 */

test('an invalid email is not "ready to save", even next to a valid phone', () => {
  const alone = checkIdentity([''], ['abc']);
  assert.equal(alone.canSubmit, false);
  assert.equal(alone.error, COPY.invalidEmail);
  assert.deepEqual(alone.invalidEmails, ['abc']);

  const withPhone = checkIdentity(['+573001112233'], ['abc']);
  assert.equal(withPhone.canSubmit, false, 'the invalid email would still be saved');
  assert.equal(withPhone.error, COPY.invalidEmail);
});

test('an invalid phone is not "ready to save"', () => {
  const r = checkIdentity(['12'], []);
  assert.equal(r.canSubmit, false);
  assert.equal(r.error, COPY.invalidPhone);
  assert.deepEqual(r.invalidPhones, ['12']);
});

test('the existing rules are kept: one valid identity is enough, name and blanks are irrelevant', () => {
  assert.equal(checkIdentity([], ['ana@example.com']).canSubmit, true);
  assert.equal(checkIdentity(['+57 300 111 2233'], []).canSubmit, true);
  assert.equal(checkIdentity(['+573001112233'], ['', '  ']).canSubmit, true, 'an opened, empty "+ Agregar email" row is not an identity');
  assert.equal(checkIdentity([''], ['']).error, COPY.needsIdentity);
  // Upper case and surrounding spaces normalize — not invalid.
  assert.equal(checkIdentity([], ['  Ana@Example.COM ']).canSubmit, true);
});

test('server: an invalid email is rejected with a readable message, before any write', () => {
  const r = parseContactCreate({ emails: ['abc'] });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, INVALID_EMAIL);
  assert.equal(INVALID_EMAIL, COPY.invalidEmail, 'the server speaks the form\'s words');

  const mixed = parseContactCreate({ phones: ['+573001112233'], emails: ['abc'] });
  assert.equal(mixed.ok, false);
  assert.equal(!mixed.ok && mixed.error, INVALID_EMAIL);
});

test('server: an invalid phone is rejected; the empty pair keeps its message', () => {
  const r = parseContactCreate({ phones: ['12'] });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, INVALID_PHONE);
  assert.equal(INVALID_PHONE, COPY.invalidPhone);

  const empty = parseContactCreate({ phones: [' '], emails: [''] });
  assert.equal(!empty.ok && empty.error, NEEDS_IDENTITY);
});

test('server: valid identities, consent and optional fields still pass unchanged', () => {
  const r = parseContactCreate({
    phones: ['+57 300 111 2233'],
    emails: ['Ana@Example.com'],
    messaging_consent: 'opted_in',
    consent_source: 'manual',
    do_not_contact: false,
  });
  assert.ok(r.ok);
  // Raw typed values go on to the spine, which normalizes them itself.
  assert.deepEqual(r.value.phones, ['+57 300 111 2233']);
  assert.deepEqual(r.value.emails, ['Ana@Example.com']);
  assert.equal(r.value.messaging_consent, 'opted_in');
  // Name stays optional; email alone is enough.
  assert.ok(parseContactCreate({ emails: ['ana@example.com'] }).ok);
});

test('createContactAction answers the parse error before touching access or data', () => {
  const src = readFileSync(fileURLToPath(new URL('../../web/lib/contactActions.ts', import.meta.url)), 'utf8');
  const body = src.slice(src.indexOf('export async function createContactAction'));
  const parse = body.indexOf('if (!parsed.ok) return { ok: false, error: parsed.error };');
  assert.ok(parse > 0, 'the parse result is returned as-is');
  assert.ok(parse < body.indexOf('resolveClientModuleContext('), 'before resolving the client');
  assert.ok(parse < body.indexOf('resolveContactByIdentity('), 'before the identity write');
});

test('the banner and the button read the same validity', () => {
  const form = readFileSync(fileURLToPath(new URL('../../web/components/contacts/form/ContactCreateForm.tsx', import.meta.url)), 'utf8');
  assert.match(form, /banner=\{identity\.canSubmit \? <FormBanner tone="success">\{COPY\.readyToSave\}/);
  assert.match(form, /disabled=\{pending \|\| !identity\.canSubmit\}/);
});

// ── EDIT (phase-1 follow-up): the same email rule on the patch path ─────────────

test('edit, server: a malformed email in the patch is rejected with the form\'s words', () => {
  for (const bad of ['abc', 'ana@', '@x.com', 'ana@x', 'ana @x.com']) {
    const r = parseContactPatch({ email: bad });
    assert.equal(r.ok, false, bad);
    assert.equal(!r.ok && r.error, INVALID_EMAIL, bad);
  }
});

test('edit, server: an empty email still clears the field, exactly as before', () => {
  const cleared = parseContactPatch({ email: '' });
  assert.ok(cleared.ok);
  assert.deepEqual(cleared.value, { email: '' }, 'passed through unchanged — the repo writes it as before');
  // Whitespace-only is "empty", not "malformed": not newly rejected.
  assert.ok(parseContactPatch({ email: '   ' }).ok);
});

test('edit, server: valid emails, other fields, consent and the over-posting gate are unchanged', () => {
  const r = parseContactPatch({ email: 'Ana@Example.com', name: 'Ana', messaging_consent: 'opted_in', consent_source: 'manual' });
  assert.ok(r.ok);
  assert.deepEqual(r.value, { email: 'Ana@Example.com', name: 'Ana', messaging_consent: 'opted_in', consent_source: 'manual' });
  // A patch without an email is not affected at all.
  assert.ok(parseContactPatch({ phone: '+573001112233', do_not_contact: true }).ok);
  // Shape failures still carry no message (the action answers its generic error).
  const unknown = parseContactPatch({ anything_else: 1 });
  assert.equal(unknown.ok, false);
  assert.equal(!unknown.ok && unknown.error, undefined);
});

test('edit, client: an added malformed email blocks the save; blanks and valid ones do not', () => {
  const bad = checkAddedIdentities([], ['abc']);
  assert.equal(bad.error, COPY.invalidEmail);
  assert.equal(bad.count, 1, 'still counted as a change, so the bar shows it');
  assert.equal(checkAddedIdentities([], ['']).error, null, 'an opened, empty row is nothing');
  assert.equal(checkAddedIdentities([], ['']).count, 0);
  assert.equal(checkAddedIdentities([], ['ana@example.com']).error, null);
  assert.equal(checkAddedIdentities(['+573001112233'], []).error, null);
});

test('edit: the action answers the parse message, and the button reads the same check', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');
  const actions = read('lib/contactActions.ts');
  assert.match(actions, /if \(!parsedPatch\.ok\) return \{ ok: false, error: parsedPatch\.error \?\? GENERIC \};/);
  const body = actions.slice(actions.indexOf('export async function updateContactAction'));
  assert.ok(body.indexOf('parseContactPatch(patch)') < body.indexOf('updateContact('), 'rejected before the write');
  const form = read('components/contacts/form/ContactEditForm.tsx');
  assert.match(form, /disabled=\{pending \|\| !dirty \|\| added\.error !== null\}/);
  assert.match(form, /if \(added\.error\) \{\s*setError\(added\.error\);/);
});
