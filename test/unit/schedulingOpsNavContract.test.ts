import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE-LEVEL CONTRACT TESTS for Scheduling Operations V1 (no HTTP/DB). The real
 * tenant/client isolation + module gating is proven by the PostgreSQL analytics/gate
 * integration tests; THESE guard the WIRING the runner can't execute:
 *  - the new operational routes (Team, Team detail, Analytics) are scheduling-module
 *    gated and readable by authorized MEMBERS (no owner/admin wall);
 *  - Settings stays owner/admin (requireFullAccessOrLand) — spec F #14;
 *  - the Team detail enforces staff→client ownership (404 for a foreign staff);
 *  - contact links only render when the CRM module is enabled — spec A #6 / F #16;
 *  - the nav exposes Agenda + Team + Analytics + (gated) Settings — spec D.
 */
const web = fileURLToPath(new URL('../../web/', import.meta.url));
const read = (rel: string): string => readFileSync(`${web}${rel}`, 'utf8');

test('#12 #13 Team list is scheduling-gated and NOT owner/admin-walled (members allowed)', () => {
  const src = read('app/clients/[clientId]/scheduling/staff/page.tsx');
  assert.ok(src.includes('requireClientModulePage(clientId, "scheduling")'), 'module + client + tenant gate');
  assert.ok(!src.includes('requireFullAccessOrLand'), 'operational view is open to authorized members');
  assert.ok(src.includes('clientId: client.id'), 'loads with the VALIDATED client id');
});

test('#12 #13 Analytics is scheduling-gated and NOT owner/admin-walled', () => {
  const src = read('app/clients/[clientId]/scheduling/analytics/page.tsx');
  assert.ok(src.includes('requireClientModulePage(clientId, "scheduling")'), 'module + client + tenant gate');
  assert.ok(!src.includes('requireFullAccessOrLand'), 'members authorized for the client can read analytics');
  assert.ok(src.includes('siteId: site.id'), 'every aggregate is anchored to a single site');
  assert.ok(src.includes('localDayRangeToUtc('), 'local site dates → UTC [from,to)');
});

test('#9 Team detail enforces staff→client ownership and 404s otherwise', () => {
  const src = read('app/clients/[clientId]/scheduling/staff/[staffId]/page.tsx');
  assert.ok(src.includes('requireClientModulePage(clientId, "scheduling")'), 'module gate');
  assert.ok(src.includes('getStaffForClient(tenantId, client.id, staffId)'), 'staff resolved only within this client');
  assert.ok(src.includes('if (!staff) notFound()'), 'foreign/cross-tenant staff → 404');
  assert.ok(!src.includes('requireFullAccessOrLand'), 'read-only detail open to authorized members');
});

test('#14 Settings (admin) stays owner/admin-only and lives inside the client', () => {
  const src = read('app/clients/[clientId]/scheduling/admin/page.tsx');
  assert.ok(src.includes('requireFullAccessOrLand('), 'owner/admin only — unchanged by this phase');
  assert.ok(src.includes('requireClientModulePage(clientId, "scheduling")'), 'still module + client gated');
});

test('#16 / A#6 contact links depend on the CRM module (agenda + team detail)', () => {
  const agendaPage = read('app/clients/[clientId]/scheduling/agenda/page.tsx');
  assert.ok(agendaPage.includes('isClientModuleEnabled(tenantId, client.id, "crm")'), 'agenda resolves CRM enablement');
  assert.ok(agendaPage.includes('crmEnabled ? `/clients/${client.id}/contacts` : null'), 'contactsBase null when CRM off');
  const agendaView = read('components/scheduling/AgendaView.tsx');
  assert.ok(agendaView.includes('a.contact_id && props.contactsBase ?'), 'link only when CRM enabled AND a contact exists');
  const detailPage = read('app/clients/[clientId]/scheduling/staff/[staffId]/page.tsx');
  assert.ok(detailPage.includes('crmEnabled ? `/clients/${client.id}/contacts` : null'), 'team detail gates contactsBase too');
  const detail = read('components/scheduling/StaffDetail.tsx');
  assert.ok(detail.includes('a.contact_id && props.contactsBase ?'), 'team detail links a contact only when CRM enabled');
});

test('D. nav: Scheduling exposes Agenda + Team + Analytics; Settings owner/admin-gated', () => {
  const src = read('components/AppSidebar.tsx');
  const i = src.indexOf('if (moduleKeys.includes("scheduling")) {');
  const j = src.indexOf('sections.push({ label: "Scheduling"', i);
  assert.ok(i >= 0 && j > i, 'the client Scheduling section exists');
  const sched = src.slice(i, j);
  assert.ok(sched.includes('key: "agenda"'), 'Agenda');
  assert.ok(sched.includes('key: "team"') && sched.includes('c("/scheduling/staff")'), 'Team → /scheduling/staff');
  assert.ok(sched.includes('key: "scheduling-analytics"') && sched.includes('c("/scheduling/analytics")'), 'Analytics → /scheduling/analytics');
  assert.ok(sched.includes('!isMember && clientId !== defaultClientId'), 'Settings gated: owner/admin + non-default');
  assert.ok(sched.includes('key: "scheduling-settings"') && sched.includes('c("/scheduling/admin")'), 'Settings → /scheduling/admin');
  // Team/Analytics must NOT sit behind the !isMember block (they precede it).
  assert.ok(
    sched.indexOf('key: "team"') < sched.indexOf('if (!isMember'),
    'Team is added before the owner/admin-only Settings gate (members see it)',
  );
});
