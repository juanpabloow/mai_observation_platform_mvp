import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  readStaffProfileId,
  STAFF_PROFILE_ALIAS,
  STAFF_PROFILE_PARAM,
  staffProfileHref,
} from '../../web/lib/staffProfileUrl.ts';

/**
 * EQUIPO — one URL parameter for the open profile on every width. A link copied on a
 * computer must open the same professional on a phone and the other way round.
 */

const web = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');

test('the canonical parameter is `s`; `p` is only an alias', () => {
  assert.equal(STAFF_PROFILE_PARAM, 's');
  assert.equal(STAFF_PROFILE_ALIAS, 'p');
});

test('reading: the canonical `s` opens the profile', () => {
  assert.equal(readStaffProfileId({ s: 'ana' }), 'ana');
  assert.equal(readStaffProfileId({ s: 'ana', site: 'centro', dtab: 'hours' }), 'ana');
});

test('reading: an old phone link (`p`) still opens its profile', () => {
  assert.equal(readStaffProfileId({ p: 'ana' }), 'ana');
  assert.equal(readStaffProfileId({ p: 'ana', site: 'centro' }), 'ana');
});

test('reading: with both, the canonical `s` wins', () => {
  assert.equal(readStaffProfileId({ s: 'ana', p: 'luis' }), 'ana');
  assert.equal(readStaffProfileId({ p: 'luis', s: 'ana' }), 'ana');
  // An EMPTY canonical counts as absent, so the alias still answers.
  assert.equal(readStaffProfileId({ s: '', p: 'luis' }), 'luis');
  assert.equal(readStaffProfileId({ s: '  ', p: 'luis' }), 'luis');
});

test('reading: nothing, empties and repeated values', () => {
  assert.equal(readStaffProfileId({}), null);
  assert.equal(readStaffProfileId({ s: '', p: '' }), null);
  assert.equal(readStaffProfileId({ s: undefined, p: undefined }), null);
  // `?s=a&s=b` arrives as an array: the first one, like URLSearchParams.get.
  assert.equal(readStaffProfileId({ s: ['ana', 'luis'] }), 'ana');
  assert.equal(readStaffProfileId({ s: [], p: ['luis'] }), 'luis');
});

test('links: opening a profile writes only `s`', () => {
  assert.equal(staffProfileHref('', 'ana'), '?s=ana');
  assert.equal(staffProfileHref('site=centro', 'ana'), '?site=centro&s=ana');
  // From an old `?p=` URL, the next link is canonical and carries one profile.
  assert.equal(staffProfileHref('site=centro&p=luis', 'ana'), '?site=centro&s=ana');
  assert.equal(staffProfileHref('s=luis&p=luis', 'ana'), '?s=ana');
  const href = staffProfileHref('p=x&s=y&site=centro', 'ana');
  assert.equal(new URLSearchParams(href.slice(1)).getAll('s').length, 1);
  assert.equal(new URLSearchParams(href.slice(1)).has('p'), false);
});

test('links: closing drops every profile parameter and keeps the rest', () => {
  assert.equal(staffProfileHref('site=centro&s=ana', null), '?site=centro');
  assert.equal(staffProfileHref('site=centro&p=ana', null), '?site=centro');
  assert.equal(staffProfileHref('s=ana&p=ana&dtab=hours', null), '?');
  // A bare `?` (never ""), so a Link to it really clears the query.
  assert.equal(staffProfileHref('', null), '?');
});

test('links: other parameters survive; the deep-link tab goes with its profile', () => {
  assert.equal(staffProfileHref('site=centro&tab=shifts&utm=x', 'ana'), '?site=centro&tab=shifts&utm=x&s=ana');
  assert.equal(staffProfileHref('site=centro&s=luis&dtab=hours&utm=x', 'ana'), '?site=centro&utm=x&s=ana');
  assert.equal(staffProfileHref('site=centro&s=luis&dtab=hours&utm=x', null), '?site=centro&utm=x');
  // URLSearchParams in, too (what useSearchParams returns).
  assert.equal(staffProfileHref(new URLSearchParams('site=centro'), 'ana'), '?site=centro&s=ana');
});

test('links: the roster pins its site, replacing a stale one', () => {
  assert.equal(staffProfileHref('', 'ana', { siteId: 'centro' }), '?site=centro&s=ana');
  assert.equal(staffProfileHref('site=norte&s=luis', 'ana', { siteId: 'centro' }), '?site=centro&s=ana');
  assert.equal(staffProfileHref('', null, { siteId: 'centro' }), '?site=centro');
});

test('wiring: the page reads one profile for both trees; neither tree writes `p`', () => {
  const page = web('app/clients/[clientId]/scheduling/staff/page.tsx');
  assert.ok(page.includes('selectedId: readStaffProfileId(sp)'), 'the page reads s, then p');
  assert.ok(!page.includes('sp.p'), 'no separate phone selection');
  assert.ok(!page.includes('sp.s ??'), 'no separate desktop selection');

  const mobile = web('components/scheduling/mobile/team/TeamMobile.tsx');
  const desk = web('components/scheduling/staff/StaffTab.tsx');
  for (const [name, src] of [['TeamMobile', mobile], ['StaffTab', desk]] as const) {
    assert.ok(src.includes('staffProfileHref(query.toString(), id,'), `${name} builds its links from the current query`);
    assert.ok(!/\.set\("p"/.test(src) && !/\.set\("s"/.test(src), `${name} sets no profile parameter by hand`);
  }
  assert.ok(mobile.includes('staff.selectedId'), 'the phone opens the shared selection');
  // Configuración's deep link writes the canonical one too.
  assert.ok(web('components/scheduling/AdminPanel.tsx').includes('s: member.id, dtab'));
});

test('wiring: the desktop ficha is a page — it never traps focus (on any width)', () => {
  const desk = web('components/scheduling/staff/StaffTab.tsx');
  assert.equal(desk.includes('useTrappedPanel({ active: desktopTree,'), false, 'no focus trap: the ficha is not an overlay');
  assert.ok(web('components/scheduling/staff/StaffWorkspace.tsx').includes('hidden md:flex'), 'the desktop tree is the one hidden below md');
});
