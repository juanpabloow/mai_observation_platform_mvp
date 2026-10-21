import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE-LEVEL CONTRACT TESTS for the per-client Scheduling admin move (no HTTP/DB).
 * The real tenant/client isolation is proven by the PostgreSQL scheduling gate +
 * schedulingAdminScope tests; THESE guard the navigation + action WIRING the root
 * runner can't execute: Scheduling admin is GONE from the Hub and lives inside a
 * client (gated), the canonical page is properly guarded, the legacy route only
 * redirects, and every admin action validates the route client before mutating.
 */

const web = fileURLToPath(new URL('../../web/', import.meta.url));
const read = (rel: string): string => readFileSync(`${web}${rel}`, 'utf8');
const idx = (src: string, needle: string): number => {
  const i = src.indexOf(needle);
  assert.ok(i >= 0, `expected to find ${JSON.stringify(needle)}`);
  return i;
};
function slice(src: string, start: string, end: string): string {
  const i = idx(src, start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(j >= 0, `expected ${JSON.stringify(end)} after ${JSON.stringify(start)}`);
  return src.slice(i, j);
}

test('sidebar: the Hub (tenant level) has NO Scheduling admin', () => {
  const src = read('components/AppSidebar.tsx');
  // The tenant-level (else) branch — from its "Owner/admin tenant level" comment to
  // the component return — must not offer any scheduling admin.
  const hub = slice(src, 'Owner/admin tenant level', 'return (');
  assert.ok(!hub.includes('/scheduling/admin'), 'no /scheduling/admin link at the Hub');
  assert.ok(!/scheduling/i.test(hub) || !hub.includes('label: "Scheduling'), 'no Scheduling section at the Hub');
  assert.ok(hub.includes('label: "Agencia"') && hub.includes('label: "Clientes y workflows"'), 'the Hub keeps its agency section (Clientes y workflows)');
});

// «Configuración de agenda» became one PAGE per job (lib/schedulingNav.ts), spread over
// the Agenda, Catálogo, Presencia and Configuración sections (lib/sectionNav.ts).
const SETTINGS_PAGES = ['sites', 'rules', 'hours', 'services', 'promotions', 'booking-page'] as const;

test('sidebar: the scheduling settings appear INSIDE a client, gated by module + role + non-default', () => {
  const model = read('lib/sectionNav.ts');
  assert.ok(model.includes('const schedManage = manage && has("scheduling") && !isDefault;'), 'settings gated: agency/owner + module + non-default');
  for (const [id, href] of [
    ['team', '/scheduling/staff'],
    ['hours', '/scheduling/hours'],
    ['services', '/scheduling/services'],
    ['promotions', '/scheduling/promotions'],
    ['booking-page', '/scheduling/booking-page'],
    ['reviews', '/scheduling/reviews'],
    ['sites', '/scheduling/sites'],
    ['rules', '/scheduling/rules'],
  ] as const) {
    assert.match(model, new RegExp(`schedManage && \\{ id: "${id}", label: "[^"]+", href: c\\("${href}"\\) \\}`), `${id} is behind the settings gate`);
  }
  // The calendar: agency or a member on their own client (the people its page admits).
  assert.ok(model.includes('(isAgency || forOwnClient) && has("scheduling") && { id: "calendar", label: "Calendario", href: c("/scheduling/agenda") }'), 'Agenda → calendar');
  assert.ok(!model.includes('/scheduling/admin"'), 'nothing links to the legacy admin route any more');
});

test('canonical pages: agency/owner + scheduling-module gate, client-scoped data', () => {
  for (const page of SETTINGS_PAGES) {
    const src = read(`app/clients/[clientId]/scheduling/${page}/page.tsx`);
    assert.ok(src.includes('requireClientModulePage(clientId, "scheduling")'), `${page}: tenant+client+non-default+enabled gate`);
    assert.ok(src.includes('if (!canManageClient(scope, clientId)) notFound();'), `${page}: client-admin gate (agency or client owner; setters/staff 404)`);
    assert.ok(src.includes('loadSchedulingSettings(scope.tenantId, client)'), `${page}: data loaded with the VALIDATED client`);
    assert.ok(src.includes(`<SchedulingSettings page="${page}"`), `${page}: renders its own page of the shared settings`);
  }
  const data = read('lib/schedulingSettingsData.ts');
  assert.ok(data.includes('clientId: client.id'), 'sites/staff loaded with the VALIDATED client id');
  // The legacy route keeps the SAME gate before it redirects, so it never tells a refused
  // user where the settings live.
  const legacy = read('app/clients/[clientId]/scheduling/admin/page.tsx');
  assert.ok(legacy.includes('requireClientModulePage(clientId, "scheduling")') && legacy.includes('if (!canManageClient(scope, clientId)) notFound();'), 'legacy admin: same gate');
  assert.ok(legacy.includes('redirect(legacyAdminDestination(client.id, await searchParams))'), 'legacy admin → the page that owns the screen');
  assert.ok(!legacy.includes('SchedulingSettings') && !legacy.includes('AdminPanel'), 'and renders nothing itself');
  const avail = read('app/clients/[clientId]/scheduling/availability/page.tsx');
  assert.ok(avail.includes('requireClientModulePage(clientId, "scheduling")') && avail.includes('canManageClient(scope, clientId)'), 'legacy availability: same gate');
  assert.ok(avail.includes('legacyAvailabilityDestination('), 'legacy availability → Horarios y ausencias');
  const exc = read('app/clients/[clientId]/scheduling/exceptions/page.tsx');
  assert.ok(exc.includes('requireClientModulePage(clientId, "scheduling")') && exc.includes('if (!canManageClient(scope, clientId)) notFound();'), 'Excepciones: same gate');
  assert.ok(exc.includes('redirect(schedulingHref(client.id, "hours", undefined, ABSENCES_ANCHOR))'), 'Excepciones → Horarios y ausencias #ausencias');
});

test('AdminPanel: no client selector — a single route client threads into every action', () => {
  const src = read('components/scheduling/AdminPanel.tsx');
  assert.ok(!src.includes('clients:'), 'no clients[] prop / selector');
  assert.ok(!src.includes('<select value={clientId}'), 'no client <select>');
  assert.ok(src.includes('clientId: string'), 'takes a single clientId');
  // Actions all receive the clientId.
  // Creating a site moved to the Sedes screen's in-page editor; it threads the SAME route client.
  assert.ok(read('components/scheduling/settings/SitesScreen.tsx').includes('createSiteAction({ clientId'), 'createSite carries clientId');
  // Deactivate/activate now thread clientId through the shared ActiveToggle (kind → action
  // map), not a per-row inline call — the client scoping is unchanged.
  assert.ok(src.includes('DEACTIVATE[kind](clientId, id)'), 'deactivate carries clientId (via ActiveToggle)');
  assert.ok(src.includes('ACTIVATE[kind](clientId, id)'), 'activate (the inverse) carries clientId');
  // Services moved to the services menu + its editor; they thread the SAME route clientId.
  const editor = read('components/scheduling/services/ServiceEditor.tsx');
  const menu = read('components/scheduling/services/ServiceMenu.tsx');
  assert.ok(/<ServiceMenu\s+clientId=\{clientId\}/.test(src), 'the services menu receives the route client');
  assert.ok(editor.includes('setSiteServiceAction(clientId, siteId, serviceId, on)'), 'setSiteService carries clientId');
  assert.ok(editor.includes('setStaffServiceAction(clientId, staffId, serviceId, on)'), 'setStaffService carries clientId');
  assert.ok(editor.includes('createServiceAction({ clientId,') && editor.includes('updateServiceAction(clientId,'), 'create/update service carry clientId');
  assert.ok(menu.includes('deactivateServiceAction(clientId, id)') && menu.includes('activateServiceAction(clientId, s.id)'), 'archive / reactivate carry clientId');
  // Staff moved to the roster, and the pairing is now toggled INLINE in the panel's
  // Services tab (it used to live in a separate editor). It still threads the SAME
  // clientId. Asserted at its new home so the contract follows the code instead of
  // quietly passing on a file that no longer does this.
  assert.ok(
    read('components/scheduling/staff/StaffTab.tsx').includes('setStaffServiceAction(clientId, member.id, sv.id, !on)'),
    'setStaffService carries clientId (now on the Staff roster panel)',
  );
  assert.ok(src.includes('deleteExceptionAction(clientId'), 'deleteException carries clientId');
});

test('legacy /scheduling/admin: NO global admin — redirect only', () => {
  const src = read('app/scheduling/admin/page.tsx');
  assert.ok(!src.includes('AdminPanel'), 'the legacy route never renders the admin');
  assert.ok(src.includes('requireFullAccessOrLand('), 'owner/admin only');
  assert.ok(src.includes('/clients/${client.id}/scheduling/admin'), 'valid clientId → canonical route');
  assert.ok(src.includes('redirect("/clients")'), 'no client → /clients');
  assert.ok(src.includes('!client.is_default'), 'the default client never redirects into an admin');
});

test('actions: every admin action validates the route client (no cross-client admin)', () => {
  const src = read('lib/schedulingAdminActions.ts');
  // The shared guard checks tenant + client + non-default + enabled, then client-admin
  // capability (agency OR this client's owner — editors/staff refused).
  assert.ok(src.includes('canManageClient(res.context.scope, clientId)'), 'guard: agency or client owner');
  assert.ok(src.includes('resolveClientModuleContext(clientId, "scheduling")'), 'guard: tenant+client+non-default+enabled');
  // Resource-ownership helpers keep a forged id from another client from taking effect.
  assert.ok(src.includes('async function siteInClient'), 'site→client ownership helper');
  assert.ok(src.includes('async function staffInClient'), 'staff→client ownership helper');
  // Every exported action funnels through requireSchedulingAdmin first — EXCEPT the two
  // time-off adapters (createException/deleteException), which MF-1 item 7 routes through the
  // single time-off writer (writeTimeOff / deleteTimeOffAction); that writer carries the
  // tenant+client+module+capability guard, so the client is still validated, just one level
  // down. They are the only actions allowed to guard by delegation.
  const exported = src.match(/export async function \w+Action/g) ?? [];
  assert.ok(exported.length >= 10, 'all admin actions are present');
  const delegatesToTimeOff = /writeTimeOff\(|deleteTimeOffAction\(/;
  for (const seg of src.split(/export async function /).slice(1)) {
    const guarded = seg.includes('requireSchedulingAdmin(') || delegatesToTimeOff.test(seg);
    assert.ok(guarded, `an action is missing the client guard: ${seg.slice(0, 40)}`);
  }
  // The exception actions are adapters over the ONE time-off writer (item 7).
  assert.ok(src.includes('writeTimeOff(') && src.includes('deleteTimeOffAction('), 'exception actions delegate to the single time-off writer');
  // Tenant id comes from the validated guard, never trusted from the request.
  assert.ok(!src.includes('getCurrentTenantId'), 'tenantId comes from the guard, not an ambient read');
});
