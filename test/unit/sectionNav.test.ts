import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildSections, locate, type NavContext } from '../../web/lib/sectionNav.js';
import {
  bookingPageAnchor,
  legacyAdminDestination,
  legacyAvailabilityDestination,
  schedulingHref,
} from '../../web/lib/schedulingNav.js';
import { memberLandingPath } from '../../web/lib/landing.js';
import { AGENCY_PERMISSIONS, SYSTEM_ROLE_PERMISSIONS, type SystemRoleKey } from '../../web/lib/permissions/catalog.js';

/**
 * The client navigation model behind the sidebar (proposal "Mismo sidebar, tres bloques")
 * — BEHAVIOUR, not source strings. This matrix is what every role × module combination
 * is shown. It is NOT the gate (each page enforces its own server check,
 * covered by the integration tests); it must never show a link whose page would 404,
 * and must never show anything the previous rail did not.
 */

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const DEF = 'dddddddd-0000-4000-8000-000000000003';
const ALL = ['inbox', 'crm', 'scheduling', 'catalog', 'campaigns', 'meetings'];

// The rail reads PERMISSIONS, never role names: a system role is just its permission set
// (the expected shapes below are unchanged from the role-name rail — that is the point).
const agency = (modules: string[], over: Partial<NavContext> = {}): NavContext => ({
  clientId: A, modules, isAgency: true, permissions: [...AGENCY_PERMISSIONS], staffBound: false, memberClientId: null, defaultClientId: DEF, ...over,
});
const member = (clientRole: SystemRoleKey, modules: string[], over: Partial<NavContext> = {}): NavContext => ({
  clientId: A, modules, isAgency: false, permissions: [...SYSTEM_ROLE_PERMISSIONS[clientRole]], staffBound: clientRole === 'staff', memberClientId: A, defaultClientId: null, ...over,
});

/** section id → page ids, the compact shape the assertions compare. */
const shape = (ctx: NavContext) => Object.fromEntries(buildSections(ctx).map((s) => [s.id, s.pages.map((p) => p.id)]));
const rail = (ctx: NavContext) => buildSections(ctx).map((s) => s.label);

test('agency on a client with every module: the three blocks of the proposal + Módulos, each page once', () => {
  assert.deepEqual(shape(agency(ALL)), {
    inbox: ['inbox'],
    contacts: ['contacts', 'pipeline'],
    agenda: ['calendar', 'team', 'hours'],
    catalog: ['services', 'products', 'promotions'],
    presence: ['booking-page', 'reviews', 'campaigns'],
    results: ['value'],
    settings: ['sites', 'rules', 'payment-methods', 'fields', 'users'],
    automations: ['workflows', 'tech-analytics', 'meetings'],
    agency: ['modules'],
  });
  const labels = Object.fromEntries(buildSections(agency(ALL)).map((x) => [x.id, x.pages.map((p) => p.label)]));
  assert.deepEqual(labels.agenda, ['Calendario', 'Equipo', 'Horarios y ausencias']);
  assert.deepEqual(labels.automations, ['Workflows', 'Analíticas técnicas', 'Reuniones']);
  assert.deepEqual(rail(agency(ALL)), [
    'Inbox', 'Contactos', 'Agenda', 'Catálogo', 'Presencia y marketing', 'Dashboard de valor', 'Configuración', 'Automatizaciones', 'Módulos',
  ]);
  const blocks = buildSections(agency(ALL)).map((s) => s.block);
  assert.deepEqual(blocks, [1, 1, 1, 2, 2, 2, 3, 3, 4], 'Operación · Negocio · Herramientas · agency apart');
});

test('groups vs direct links: Agenda is a group whose row opens the calendar; the others only unfold', () => {
  const by = Object.fromEntries(buildSections(agency(ALL)).map((x) => [x.id, x]));
  assert.equal(by.agenda.kind, 'group');
  assert.equal(by.agenda.homeHref, `/clients/${A}/scheduling/agenda`, 'pressing «Agenda» opens Calendario');
  assert.equal(by.agenda.href, `/clients/${A}/scheduling/agenda`);
  for (const id of ['contacts', 'catalog', 'presence', 'settings', 'automations']) {
    assert.equal(by[id].kind, 'group', id);
    assert.equal(by[id].homeHref, null, `${id} has no page of its own — its row only unfolds`);
  }
  for (const id of ['inbox', 'results', 'agency']) assert.equal(by[id].kind, 'link', id);
  // Reception: Agenda shrinks to a direct link (one page), never a group with one child.
  const setter = Object.fromEntries(buildSections(member('setter', ALL)).map((x) => [x.id, x]));
  assert.equal(setter.agenda.kind, 'link');
  assert.equal(setter.agenda.homeHref, null);
  assert.equal(setter.catalog.kind, 'link');
});

test('owner of their own client: everything but Módulos (agency-only)', () => {
  const s = shape(member('owner', ALL));
  assert.equal(s.agency, undefined, 'Módulos is never shown to a business');
  assert.deepEqual(s.settings, ['sites', 'rules', 'payment-methods', 'fields', 'users']);
  assert.deepEqual(s.automations, ['workflows', 'tech-analytics', 'meetings']);
  assert.deepEqual(s.results, ['value']);
});

test('services WITHOUT products: Catálogo holds Servicios + Promociones — Productos is not implied', () => {
  const s = shape(agency(['scheduling']));
  assert.deepEqual(s.catalog, ['services', 'promotions']);
  assert.ok(!JSON.stringify(s).includes('products'), 'the catalog module is off, so no Productos anywhere');
});

test('products WITHOUT scheduling: «Productos» is a direct link; no Agenda, no scheduling page anywhere', () => {
  const secs = buildSections(agency(['catalog', 'crm']));
  const cat = secs.find((x) => x.id === 'catalog');
  assert.ok(cat);
  assert.deepEqual(cat.pages.map((p) => p.id), ['products']);
  assert.equal(cat.label, 'Productos', 'a lone page lends its own name to the rail');
  assert.equal(cat.href, `/clients/${A}/catalog`);
  for (const gone of ['agenda', 'presence']) assert.ok(!secs.some((x) => x.id === gone), `${gone} is hidden, not empty`);
  const settings = secs.find((x) => x.id === 'settings');
  assert.deepEqual(settings?.pages.map((p) => p.id), ['fields', 'users'], 'no Sedes/Reglas without scheduling');
});

test('scheduling WITHOUT campaigns: Presencia keeps Página de reservas + Reseñas — Campañas is not implied', () => {
  const s = shape(agency(['scheduling']));
  assert.deepEqual(s.presence, ['booking-page', 'reviews']);
});

test('a module set with nothing behind a section never shows an empty group', () => {
  for (const mods of [[], ['crm'], ['inbox'], ['catalog'], ['campaigns'], ['meetings']]) {
    for (const ctx of [agency(mods), member('owner', mods), member('setter', mods)]) {
      for (const sec of buildSections(ctx)) assert.ok(sec.pages.length > 0, `${sec.id} with ${mods.join(',')}`);
    }
  }
});

test('campaigns alone: «Campañas» is a direct link (lone non-home page)', () => {
  const sec = buildSections(agency(['campaigns'])).find((x) => x.id === 'presence');
  assert.equal(sec?.label, 'Campañas');
  assert.equal(sec?.href, `/clients/${A}/campaigns`);
});

test('the lone HOME page keeps the section name (Agenda for a reception login)', () => {
  const sec = buildSections(member('setter', ['scheduling'])).find((x) => x.id === 'agenda');
  assert.deepEqual(sec?.pages.map((p) => p.id), ['calendar']);
  assert.equal(sec?.label, 'Agenda');
});

test('setter (reception): operations only — no settings, roster, results or automations', () => {
  const s = shape(member('setter', ALL));
  assert.deepEqual(s, {
    inbox: ['inbox'],
    contacts: ['contacts', 'pipeline'],
    agenda: ['calendar'],
    catalog: ['products'],
    presence: ['campaigns'],
  });
  assert.deepEqual(rail(member('setter', ALL)), ['Inbox', 'Contactos', 'Agenda', 'Productos', 'Campañas']);
});

test('staff: their own agenda and nothing else; never on another client', () => {
  assert.deepEqual(shape(member('staff', ALL)), { agenda: ['calendar'] });
  assert.deepEqual(rail(member('staff', ALL)), ['Mi agenda']);
  assert.deepEqual(buildSections(member('staff', ['crm'])), [], 'no scheduling → nothing');
  assert.deepEqual(buildSections(member('staff', ALL, { clientId: OTHER })), [], 'another client → nothing');
});

test("an owner looking at ANOTHER client's path gets no manage/insights pages", () => {
  // Nothing at all: every page there refuses them (requireClientModulePage → 404), so the
  // rail offers no link either.
  assert.deepEqual(shape(member('owner', ALL, { clientId: OTHER })), {});
  assert.deepEqual(shape(member('setter', ALL, { clientId: OTHER })), {});
});

test('the default ("Unassigned") client: no scheduling settings and no Módulos, even for the agency', () => {
  const s = shape(agency(ALL, { clientId: DEF }));
  assert.equal(s.agency, undefined);
  for (const p of ['team', 'hours', 'services', 'promotions', 'booking-page', 'reviews', 'sites', 'rules']) {
    assert.ok(!JSON.stringify(s).includes(`"${p}"`), `${p} hidden on the default client`);
  }
});

test('Automatizaciones keeps the workflow scope on Workflows and Analíticas técnicas', () => {
  const all = buildSections(agency(ALL)).find((x) => x.id === 'automations')!;
  assert.deepEqual(all.pages.slice(0, 2).map((p) => p.href), [`/clients/${A}/workflows`, `/clients/${A}/workflows/all/analytics`]);
  const one = buildSections(agency(ALL, { workflowScope: 'wf 1' })).find((x) => x.id === 'automations')!;
  assert.deepEqual(one.pages.slice(0, 2).map((p) => p.href), [
    `/clients/${A}/workflows/wf%201/executions`,
    `/clients/${A}/workflows/wf%201/analytics`,
  ]);
});

test('every visible label is Spanish (no leftover English rail names)', () => {
  const labels = buildSections(agency(ALL)).flatMap((s) => [s.label, ...s.pages.map((p) => p.label)]);
  // «Workflows» stays: it is the product's own name for them (as in the proposal).
  for (const en of ['Workspace', 'Scheduling', 'Administration', 'Users & access', 'Custom fields', 'Analytics', 'Settings', 'Contacts', 'Staff']) {
    assert.ok(!labels.includes(en), `${en} is not a label`);
  }
});

test('locate marks section + page on a direct link, including the legacy routes', () => {
  const at = (p: string) => locate(A, `/clients/${A}${p}`);
  assert.deepEqual(at('/scheduling/hours'), { section: 'agenda', page: 'hours' });
  assert.deepEqual(at('/scheduling/availability'), { section: 'agenda', page: 'hours' });
  assert.deepEqual(at('/scheduling/exceptions'), { section: 'agenda', page: 'hours' });
  assert.deepEqual(at('/scheduling/agenda'), { section: 'agenda', page: 'calendar' });
  assert.deepEqual(at('/scheduling/staff'), { section: 'agenda', page: 'team' });
  assert.deepEqual(at('/scheduling/booking-page'), { section: 'presence', page: 'booking-page' });
  assert.deepEqual(at('/scheduling/admin'), { section: 'settings', page: 'sites' });
  assert.deepEqual(at('/contacts/fields'), { section: 'settings', page: 'fields' }, 'fields before contacts');
  assert.deepEqual(at('/contacts/123'), { section: 'contacts', page: 'contacts' });
  assert.deepEqual(at('/catalog'), { section: 'catalog', page: 'products' });
  assert.deepEqual(at('/workflows/all/analytics'), { section: 'automations', page: 'tech-analytics' });
  assert.deepEqual(at('/workflows/w1/analytics'), { section: 'automations', page: 'tech-analytics' });
  assert.deepEqual(at('/workflows'), { section: 'automations', page: 'workflows' });
  assert.deepEqual(at('/workflows/w1/executions'), { section: 'automations', page: 'workflows' });
  assert.deepEqual(at('/workflows/w1/inbox'), { section: 'automations', page: 'workflows' });
  assert.deepEqual(at('/analytics'), { section: 'results', page: 'value' });
  assert.equal(locate(A, `/clients/${OTHER}/inbox`), null, 'another client path is not this client');
});

test('interim /scheduling/availability links land on Horarios y ausencias (closures at #ausencias)', () => {
  assert.equal(legacyAvailabilityDestination(A, {}), `/clients/${A}/scheduling/hours`);
  assert.equal(legacyAvailabilityDestination(A, { tab: 'sede' }), `/clients/${A}/scheduling/hours`);
  assert.equal(legacyAvailabilityDestination(A, { tab: 'profesionales' }), `/clients/${A}/scheduling/hours`);
  assert.equal(legacyAvailabilityDestination(A, { tab: 'excepciones' }), `/clients/${A}/scheduling/hours#ausencias`);
  // The phone keeps its screen (?m=…) and the desktop lands on «Ausencias» (#ausencias).
  assert.equal(legacyAvailabilityDestination(A, { m: 'bloqueo-nuevo', plantilla: 'festivo' }), `/clients/${A}/scheduling/hours?m=bloqueo-nuevo&plantilla=festivo#ausencias`);
});

test('legacy /scheduling/admin links land on the page that now owns each phone screen', () => {
  assert.equal(legacyAdminDestination(A, {}), `/clients/${A}/scheduling/sites`);
  assert.equal(legacyAdminDestination(A, { tab: 'reglas' }), `/clients/${A}/scheduling/sites`, 'desktop tabs were never in the URL');
  assert.equal(legacyAdminDestination(A, { m: 'reglas' }), `/clients/${A}/scheduling/rules?m=reglas`);
  assert.equal(legacyAdminDestination(A, { m: 'servicio', id: 's1' }), `/clients/${A}/scheduling/services?m=servicio&id=s1`);
  assert.equal(legacyAdminDestination(A, { m: 'bloqueos' }), `/clients/${A}/scheduling/hours?m=bloqueos#ausencias`);
  assert.equal(legacyAdminDestination(A, { m: 'bloqueo-nuevo', plantilla: 'festivo' }), `/clients/${A}/scheduling/hours?m=bloqueo-nuevo&plantilla=festivo#ausencias`);
  assert.equal(legacyAdminDestination(A, { m: 'sede', id: 'x' }), `/clients/${A}/scheduling/sites?m=sede&id=x`);
  assert.equal(legacyAdminDestination(A, { m: 'nope', id: 'x' }), `/clients/${A}/scheduling/sites`, 'unknown screens drop their params');
});

test('booking-page: old ?tab= links become section anchors; only known tabs map', () => {
  assert.equal(bookingPageAnchor('enlace'), 'enlace');
  assert.equal(bookingPageAnchor('categorias'), 'categorias');
  assert.equal(bookingPageAnchor('presentacion'), 'presentacion');
  assert.equal(bookingPageAnchor('x'), null);
  assert.equal(bookingPageAnchor(undefined), null);
  assert.equal(schedulingHref('a b', 'rules'), '/clients/a%20b/scheduling/rules');
});

test('landing: staff → agenda, setter → inbox, owner → value dashboard', () => {
  const land = (r: SystemRoleKey) => memberLandingPath(A, { permissions: SYSTEM_ROLE_PERMISSIONS[r], staffBound: r === 'staff' });
  assert.equal(land('staff'), `/clients/${A}/scheduling/agenda`);
  assert.equal(land('setter'), `/clients/${A}/inbox`);
  assert.equal(land('owner'), `/clients/${A}/analytics`);
  // A custom role lands on the first page its permissions open; none at all → /no-access.
  assert.equal(memberLandingPath(A, { permissions: ['contacts.view'], staffBound: false }), `/clients/${A}/contacts`);
  assert.equal(memberLandingPath(A, { permissions: ['access.users.view'], staffBound: false }), `/clients/${A}/team`);
  assert.equal(memberLandingPath(A, { permissions: [], staffBound: false }), '/no-access');
});

test('a CUSTOM role sees exactly the pages its permissions open — the name plays no part', () => {
  const custom = (permissions: string[], modules = ALL): NavContext => ({
    clientId: A, modules, isAgency: false, permissions, staffBound: false, memberClientId: A, defaultClientId: null,
  });
  // «Marketing»: campaigns + results, nothing operational.
  assert.deepEqual(shape(custom(['campaigns.view', 'campaigns.manage', 'analytics.view'])), {
    presence: ['campaigns'],
    results: ['value'],
    automations: ['tech-analytics'],
  });
  // «Encargado de sede»: agenda + team + hours, no inbox/contacts/settings.
  assert.deepEqual(shape(custom(['agenda.view', 'agenda.book', 'team.manage', 'hours.manage'])), {
    agenda: ['calendar', 'team', 'hours'],
  });
  // A permission whose module is NOT contracted shows nothing.
  assert.deepEqual(shape(custom(['inbox.view', 'products.view'], ['crm'])), {});
  // No permissions → no rail at all (lands on /no-access).
  assert.deepEqual(shape(custom([])), {});
  // On ANOTHER client's path, nothing — whatever the permissions.
  assert.deepEqual(shape({ ...custom(['contacts.view', 'analytics.view']), clientId: OTHER }), {});
});
