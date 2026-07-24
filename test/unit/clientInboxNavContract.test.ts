import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE-LEVEL CONTRACT TESTS (no HTTP, no DB, no React render). The final-design
 * navigation lives in client components + server pages that use `server-only` +
 * `@/`/`@worker/` aliases and can't be invoked from the root runner. The DB-level
 * isolation is proven by the PostgreSQL clientInbox / clientWorkflows tests; THESE
 * guard the navigation WIRING those can't reach — sidebar grouping/order, the header
 * workflow switcher, the shared workflow tabs, the Workflows list page, and that the
 * unified Inbox + its legacy routes are preserved. Structure/wiring guards, NOT a
 * claim that anything renders.
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

// ─────────────────────────────── Sidebar ────────────────────────────────────

test('sidebar: Workflows is the FIRST option, under Automation, before Overview', () => {
  const src = read('components/AppSidebar.tsx');
  const inClient = slice(src, 'if (clientId) {', '// ── Outside a client');
  const automation = idx(inClient, '<SectionLabel>Automation</SectionLabel>');
  const workflows = idx(inClient, 'label="Workflows"');
  const overview = idx(inClient, 'label="Overview"');
  const conversations = idx(inClient, '<SectionLabel>Conversations</SectionLabel>');
  assert.ok(automation < workflows, 'Automation label precedes Workflows');
  assert.ok(workflows < overview, 'Workflows is above Overview');
  assert.ok(overview < conversations, 'Automation (Workflows+Overview) precedes Conversations');
  // Workflows links to the list page and stays active across every /workflows/… route.
  assert.ok(inClient.includes('href={`/clients/${clientId}/workflows`}'), 'Workflows → the list page');
  assert.ok(
    inClient.includes('pathname.startsWith(`/clients/${clientId}/workflows`)'),
    'Workflows is active on all /workflows/… routes',
  );
});

test('sidebar: NO individual workflow names are rendered (no workflows prop / no list map)', () => {
  const src = read('components/AppSidebar.tsx');
  assert.ok(!src.includes('SidebarWorkflow'), 'the SidebarWorkflow type is gone');
  assert.ok(!/\bworkflows[:,]/.test(slice(src, 'export function AppSidebar(', ') {')),
    'AppSidebar no longer takes a workflows prop');
  const inClient = slice(src, 'if (clientId) {', '// ── Outside a client');
  assert.ok(!inClient.includes('.map('), 'the in-client rail never maps a workflow list');
});

test('sidebar: Inbox lives under Conversations with the aggregated client-level badge', () => {
  const src = read('components/AppSidebar.tsx');
  const inClient = slice(src, 'if (clientId) {', '// ── Outside a client');
  assert.ok(
    idx(inClient, '<SectionLabel>Conversations</SectionLabel>') < idx(inClient, 'InboxTabLink'),
    'the Conversations label precedes the Inbox link',
  );
  assert.ok(inClient.includes('href={`/clients/${clientId}/inbox`}'), 'Inbox → the client-level route');
  assert.ok(
    inClient.includes('countEndpoint={`/api/inbox/${clientId}/pending-count`}'),
    'Inbox keeps the aggregated client-level pending badge',
  );
});

test('sidebar: categories respect modules + roles', () => {
  const src = read('components/AppSidebar.tsx');
  const inClient = slice(src, 'if (clientId) {', '// ── Outside a client');
  // CRM only when crm enabled; Scheduling only when scheduling enabled.
  assert.ok(inClient.includes('clientModuleKeys.includes("crm")'), 'CRM gated by the crm module');
  assert.ok(inClient.includes('clientModuleKeys.includes("scheduling")'), 'Scheduling gated by scheduling');
  // Administration (Team + Modules) is owner/admin only; Modules hidden for default.
  const admin = slice(inClient, '{!isMember ? (', '</aside>');
  assert.ok(admin.includes('<SectionLabel>Administration</SectionLabel>'), 'Administration is owner/admin only');
  assert.ok(admin.includes('label="Team"') && admin.includes('label="Modules"'), 'Team + Modules under it');
  assert.ok(admin.includes('clientId !== defaultClientId'), 'Modules hidden for the default client');
});

test('sidebar server: never serializes any workflow list (member gets no foreign workflows)', () => {
  const src = read('components/AppSidebarServer.tsx');
  assert.ok(!src.includes('listWorkflowsWithClientForTenant'), 'no workflow query feeds the sidebar');
  assert.ok(!src.includes('workflows='), 'no workflows prop is passed to AppSidebar');
});

// ────────────────────────── Header workflow switcher ─────────────────────────

test('switcher panel: search + Active/Inactive groups + accessible listbox', () => {
  const src = read('components/WorkflowSwitcherPanel.tsx');
  assert.ok(src.includes('placeholder="Search workflows…"'), 'has a Search workflows… field');
  assert.ok(src.includes('role="combobox"') && src.includes('aria-activedescendant'), 'combobox + activedescendant');
  assert.ok(src.includes('role="listbox"') && src.includes('role="option"'), 'listbox with option roles');
  assert.ok(src.includes('aria-label="Active"') && src.includes('aria-label="Inactive"'), 'Active/Inactive groups');
  // Grouping is by the workflow active flag.
  assert.ok(src.includes('(w.active ?? false) && matchWf(w)'), 'Active group = active workflows');
  assert.ok(src.includes('!(w.active ?? false) && matchWf(w)'), 'Inactive group = inactive workflows');
  // Keyboard navigation.
  assert.ok(src.includes('"ArrowDown"') && src.includes('"ArrowUp"') && src.includes('"Enter"'), 'keyboard nav');
});

test('switcher panel: preserves section for a workflow, aggregate → all/analytics', () => {
  const src = read('components/WorkflowSwitcherPanel.tsx');
  // A specific workflow keeps the current section; "All workflows" opens the aggregate.
  assert.ok(
    src.includes('/workflows/${encodeURIComponent(workflowId)}/${section}`'),
    'a workflow selection preserves the section',
  );
  assert.ok(src.includes('/workflows/all/analytics`'), '"All workflows" opens the aggregate analytics');
});

test('header: the switcher only ever receives the CURRENT client\'s workflows + section', () => {
  const src = read('components/HeaderBar.tsx');
  // section = analytics on analytics routes, else executions (the fallback).
  assert.ok(
    src.includes('const section: "executions" | "analytics" = isAnalytics ? "analytics" : "executions"'),
    'section preserves analytics, else falls back to executions',
  );
  // clientWorkflows is filtered to the current client; that list feeds the panel.
  assert.ok(
    src.includes('workflows.filter((w) => w.clientId === currentClient.id)'),
    'only the current client\'s workflows are collected',
  );
  const panel = slice(src, '<WorkflowSwitcherPanel', '/>');
  assert.ok(panel.includes('workflows={clientWorkflows'), 'the panel receives the current-client list');
  assert.ok(panel.includes('section={section}'), 'the panel receives the section to preserve');
});

// ──────────────────────────── Shared workflow tabs ───────────────────────────

test('workflow tabs: a SHARED component with Executions + Analytics only (no Inbox)', () => {
  const src = read('components/WorkflowTabs.tsx');
  assert.ok(src.includes('"Executions"') && src.includes('"Analytics"'), 'both tabs present');
  // No Inbox tab and no /inbox link (the doc comment may mention Inbox in prose).
  assert.ok(!src.includes('/inbox'), 'no /inbox route is a workflow tab');
  const tabs = slice(src, 'const TABS = [', '] as const');
  assert.ok(!/inbox/i.test(tabs), 'the TABS list is Executions/Analytics only');
  // Mounted once in the shared workflow layout (not duplicated per page).
  const layout = read('app/clients/[clientId]/workflows/[workflowId]/layout.tsx');
  assert.ok(layout.includes('<WorkflowTabs'), 'the shared layout renders the tabs');
});

// ───────────────────────────── Workflows list page ───────────────────────────

test('workflows page: session-authorized, filtered to this client, searchable list', () => {
  const page = read('app/clients/[clientId]/workflows/page.tsx');
  assert.ok(page.includes('getClientForTenant('), 'authorizes via getClientForTenant');
  assert.ok(page.includes('notFound()'), 'foreign/bogus/out-of-scope client → 404');
  assert.ok(page.includes('w.client_id === client.id'), 'only THIS client\'s workflows are listed');
  assert.ok(page.includes('<ClientWorkflowsList'), 'renders the list component');

  const list = read('components/ClientWorkflowsList.tsx');
  assert.ok(list.includes('placeholder="Search workflows…"'), 'has a search field');
  assert.ok(list.includes('Active') && list.includes('Inactive'), 'shows active/inactive status');
  assert.ok(list.includes('w.n8nWorkflowId'), 'shows the workflow id');
  assert.ok(list.includes('/executions`'), 'rows open the workflow Executions');
  assert.ok(list.includes('No workflows yet'), 'has an empty state');
});

// ───────────────────── Preserved: unified Inbox + legacy routes ───────────────

test('client Inbox page (unified): still session-authorized, client-level poll', () => {
  const src = read('app/clients/[clientId]/inbox/page.tsx');
  assert.ok(src.includes('getClientForTenant('), 'authorizes via getClientForTenant');
  assert.ok(src.includes('notFound()'), 'foreign/bogus/out-of-scope client → 404');
  assert.ok(
    src.includes('`/api/inbox/${encodeURIComponent(client.id)}/conversations`'),
    'polls the client-level conversations endpoint',
  );
  assert.ok(src.includes('loadClientInboxList('), 'loads the unified list');
  assert.ok(src.includes('w.client_id === client.id'), 'the workflow filter is scoped to this client');
});

test('RSC-safe: the server page passes NO function to ConversationGrid, only conversationRoute="client"', () => {
  const src = read('app/clients/[clientId]/inbox/page.tsx');
  // The regressed prop (a callback) must be gone — passing it broke RSC serialization
  // ("Functions cannot be passed directly to Client Components").
  assert.ok(!src.includes('conversationHref'), 'no conversationHref callback prop');
  // No inline arrow / function is handed to the grid at all.
  const grid = slice(src, '<ConversationGrid', '/>');
  assert.ok(!grid.includes('=>') && !grid.includes('function'), 'no function crosses the RSC boundary');
  // The serializable selector is used instead.
  assert.ok(grid.includes('conversationRoute="client"'), 'passes the serializable conversationRoute="client"');
});

test('grid builds the drawer href from conversationRoute (client vs workflow), all segments encoded', () => {
  const src = read('components/ConversationGrid.tsx');
  // Serializable prop, not a callback.
  assert.ok(
    src.includes('conversationRoute?: "client" | "workflow"'),
    'conversationRoute is a serializable string union',
  );
  assert.ok(!src.includes('conversationHref'), 'the callback prop is fully removed');
  // Client mode → /clients/{clientId}/inbox?c={id}.
  assert.ok(
    src.includes(
      '`/clients/${encodeURIComponent(clientId)}/inbox?c=${encodeURIComponent(v.id)}`',
    ),
    'client mode builds /clients/{clientId}/inbox?c={id}',
  );
  // Workflow mode → the per-workflow route is preserved.
  assert.ok(
    src.includes(
      '`/clients/${encodeURIComponent(clientId)}/workflows/${encodeURIComponent(v.workflowId)}/inbox?c=${encodeURIComponent(v.id)}`',
    ),
    'workflow mode preserves the per-workflow inbox route',
  );
});

test('legacy routes still exist / compile (compatibility)', () => {
  assert.ok(
    read('app/clients/[clientId]/workflows/[workflowId]/(padded)/inbox/page.tsx').includes('ConversationGrid'),
    'the per-workflow inbox page is still present',
  );
  assert.ok(
    read('app/clients/[clientId]/inbox/[conversationId]/page.tsx').includes('redirect('),
    'the legacy client thread URL still redirects',
  );
  assert.ok(
    read('app/clients/[clientId]/workflows/all/analytics/page.tsx').length > 0,
    'the aggregate All-workflows analytics view still exists',
  );
});
