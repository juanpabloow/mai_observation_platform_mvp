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
  assert.ok(hub.includes('label: "Workspace"'), 'the Hub keeps its Workspace section (Hub + Clients & Workflows)');
});

test('sidebar: Scheduling settings appears INSIDE a client, gated by module + role + non-default', () => {
  const src = read('components/AppSidebar.tsx');
  const sched = slice(src, 'if (moduleKeys.includes("scheduling")) {', 'sections.push({ label: "Scheduling"');
  // Agenda always; Scheduling settings only for owner/admin on a non-default client.
  assert.ok(sched.includes('key: "agenda"'), 'Agenda is in the client Scheduling section');
  assert.ok(sched.includes('!isMember && clientId !== defaultClientId'), 'settings gated: owner/admin + non-default');
  assert.ok(sched.includes('key: "scheduling-settings"'), 'the settings item is present');
  assert.ok(sched.includes('c("/scheduling/admin")'), 'settings → the per-client canonical admin route');
});

test('canonical page: owner/admin + scheduling-module gate, renders the client-scoped AdminPanel', () => {
  const src = read('app/clients/[clientId]/scheduling/admin/page.tsx');
  assert.ok(src.includes('requireFullAccessOrLand('), 'owner/admin gate (members bounced)');
  assert.ok(src.includes('requireClientModulePage(clientId, "scheduling")'), 'tenant+client+non-default+enabled gate');
  assert.ok(src.includes('clientId: client.id'), 'sites/staff loaded with the VALIDATED client id');
  assert.ok(src.includes('<AdminPanel'), 'renders the AdminPanel');
  assert.ok(src.includes('clientId={client.id}'), 'AdminPanel is scoped to the route client (no selector)');
});

test('AdminPanel: no client selector — a single route client threads into every action', () => {
  const src = read('components/scheduling/AdminPanel.tsx');
  assert.ok(!src.includes('clients:'), 'no clients[] prop / selector');
  assert.ok(!src.includes('<select value={clientId}'), 'no client <select>');
  assert.ok(src.includes('clientId: string'), 'takes a single clientId');
  // Actions all receive the clientId.
  assert.ok(src.includes('createSiteAction({ clientId'), 'createSite carries clientId');
  // Deactivate/activate now thread clientId through the shared ActiveToggle (kind → action
  // map), not a per-row inline call — the client scoping is unchanged.
  assert.ok(src.includes('DEACTIVATE[kind](clientId, id)'), 'deactivate carries clientId (via ActiveToggle)');
  assert.ok(src.includes('ACTIVATE[kind](clientId, id)'), 'activate (the inverse) carries clientId');
  assert.ok(src.includes('setSiteServiceAction(clientId'), 'setSiteService carries clientId');
  // Staff moved to the TEAM screen's roster tab; the pairing action went with it and
  // still threads the SAME clientId. Asserted at its new home so the contract
  // follows the code instead of quietly passing on a file that no longer does this.
  assert.ok(
    read('components/team/StaffEditDialog.tsx').includes('setStaffServiceAction(clientId'),
    'setStaffService carries clientId (now on the Team roster)',
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
  // The shared guard checks owner/admin + tenant + client + non-default + enabled.
  assert.ok(src.includes('requireFullAccessForAction()'), 'guard: owner/admin');
  assert.ok(src.includes('resolveClientModuleContext(clientId, "scheduling")'), 'guard: tenant+client+non-default+enabled');
  // Resource-ownership helpers keep a forged id from another client from taking effect.
  assert.ok(src.includes('async function siteInClient'), 'site→client ownership helper');
  assert.ok(src.includes('async function staffInClient'), 'staff→client ownership helper');
  // Every exported action funnels through requireSchedulingAdmin first.
  const exported = src.match(/export async function \w+Action/g) ?? [];
  assert.ok(exported.length >= 10, 'all admin actions are present');
  for (const seg of src.split(/export async function /).slice(1)) {
    assert.ok(seg.includes('requireSchedulingAdmin('), `an action is missing the client guard: ${seg.slice(0, 40)}`);
  }
  // Tenant id comes from the validated guard, never trusted from the request.
  assert.ok(!src.includes('getCurrentTenantId'), 'tenantId comes from the guard, not an ambient read');
});
