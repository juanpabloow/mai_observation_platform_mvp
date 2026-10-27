import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * JP-1 — "Nueva cita" → Cliente → "Nuevo cliente": typing the name must NOT flip the field into a
 * committed chip on the first keystroke (which unmounted the input and stole focus). The bug was a
 * render-order one: the DESKTOP client step showed the locked chip whenever `customer.label` was
 * truthy, and in "new" mode `customer.label` is the half-typed name. The fix guards the chip with
 * `customerMode !== "new"`, so "new" mode always renders the editable inline form. Nothing is
 * searched or committed while typing (the debounced search is gated to search mode; the dup-check
 * runs only on submit). Mobile keeps the person in a dedicated sheet that commits only on tap.
 *
 * No DOM test harness in this repo → a source contract (the convention used by paymentsUiContract /
 * gridCardsContract / redesignIntegration). The key assertion below fails on the pre-fix source.
 */
const view = readFileSync(fileURLToPath(new URL('../../web/components/scheduling/AgendaView.tsx', import.meta.url)), 'utf8');

/** The desktop "Cliente" step — from its PanelSection to the services step. */
const desktopClient = (() => {
  const start = view.indexOf('id="nv-client"');
  assert.ok(start > 0, 'the desktop Cliente PanelSection exists');
  const end = view.indexOf('id="nv-service"', start);
  return view.slice(start, end > 0 ? end : start + 4000);
})();

test('desktop: the locked chip is guarded by customerMode !== "new" — a typed name never pre-empts the form', () => {
  // THE fix (would fail on the pre-JP-1 source, which gated the chip on `customer.label` alone).
  assert.match(view, /customerMode !== "new" && customer\.label \? \(/);
  // And within the desktop Cliente step there is no bare `{customer.label ? (` chip gate.
  assert.ok(!/\{customer\.label \? \(/.test(desktopClient), 'desktop chip gate is the guarded one, not the bare label check');
  // "new" mode renders the editable inline form branch.
  assert.match(desktopClient, /\) : customerMode === "new" \? \(/);
});

test('desktop: the new-client form lets the person type freely (name, phone, email), nothing committed', () => {
  assert.match(desktopClient, /value=\{name\} onChange=\{\(e\) => setName\(e\.target\.value\)\}/);
  assert.match(desktopClient, /value=\{phone\} onChange=\{\(e\) => setPhone\(e\.target\.value\)\}/);
  assert.match(desktopClient, /value=\{email\} onChange=\{\(e\) => setEmail\(e\.target\.value\)\}/);
  // "Cambiar" (on the committed chip) is the explicit way back — it clears the typed fields.
  assert.match(desktopClient, /setCustomerMode\("search"\);\s*setName\(""\);\s*setPhone\(""\);\s*setEmail\(""\);/);
});

test('search is debounced, gated to search mode, and reads only the search box (never the name, never steals focus)', () => {
  // Gated so typing a new-client name triggers NO search.
  assert.match(view, /if \(customerMode !== "search" \|\| bookingContact \|\| isReschedule\) return;/);
  // Debounced via setTimeout; searches the search box term, not `name`.
  assert.match(view, /setTimeout\(async \(\) => \{\s*const r = await searchSchedulingContactsAction\(props\.clientId, term\)/);
  // The effect never rewrites the input or moves focus (no setContactQuery / focus call inside it).
  const effect = view.slice(view.indexOf('Customer lookup, debounced'), view.indexOf('Customer lookup, debounced') + 1200);
  assert.ok(!effect.includes('setContactQuery('), 'the debounced search never replaces the input text');
  assert.ok(!/\.focus\(\)/.test(effect), 'the debounced search never steals focus');
});

test('nothing is searched on keystroke in new mode: the dup-check runs only on submit', () => {
  // setContactMatches is only called from the submit result (r.matches), never from an input onChange.
  const calls = view.match(/setContactMatches\(/g) ?? [];
  assert.ok(calls.length >= 1);
  assert.match(view, /setContactMatches\(r\.matches \?\? \[\]\)/);
  assert.ok(!/onChange=\{[^}]*setContactMatches/.test(view), 'no input commits a contact-match lookup while typing');
});

test('mobile: new-client entry is a dedicated sheet that commits only on "Usar este contacto"', () => {
  // The sheet has its own name/phone/email inputs…
  assert.match(view, /phoneSheet === "contact"/);
  assert.match(view, /id="nc-name" value=\{name\} onChange=\{\(e\) => setName\(e\.target\.value\)\}/);
  // …and only its primary button commits (setCustomerMode("new") + close), so typing never flips the
  // panel behind it (customerMode stays "search" while the sheet is open).
  assert.match(view, /Usar este contacto/);
  assert.match(view, /setPickedContact\(null\);\s*setCustomerMode\("new"\);\s*setPhoneSheet\(null\);/);
});

test('selecting a recent / search hit still picks that existing contact', () => {
  assert.match(view, /setPickedContact\(h\)/); // desktop recents + hits
  assert.match(view, /setPickedContact\(hit\)/); // mobile hits
});
