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

test('sidebar: sections are ordered Automation → Conversations → CRM → Scheduling → Administration', () => {
  const src = read('components/AppSidebar.tsx');
  const ctx = slice(src, 'if (clientId) {', '} else if (isMember) {');
  const order = [
    '{ label: "Automation"',
    '{ label: "Conversations"',
    'label: "CRM"',
    'label: "Scheduling"',
    'label: "Administration"',
  ];
  let prev = -1;
  for (const marker of order) {
    const i = idx(ctx, marker);
    assert.ok(i > prev, `section ${marker} is in the expected order`);
    prev = i;
  }
});

test('sidebar: Workflows is the FIRST item, active on every /workflows/… route; Overview → aggregate', () => {
  const src = read('components/AppSidebar.tsx');
  const automation = slice(src, 'const automation: NavItem[] = [', '];');
  assert.ok(idx(automation, 'key: "workflows"') < idx(automation, 'key: "overview"'), 'Workflows precedes Overview');
  assert.ok(automation.includes('href: c("/workflows")'), 'Workflows → the client workflow list');
  assert.ok(automation.includes('pathname.startsWith(c("/workflows"))'), 'active across all /workflows/… routes');
  assert.ok(automation.includes('c("/workflows/all/analytics")'), 'Overview keeps the aggregate analytics target');
});

test('sidebar: NO full workflow list — no workflows prop, no workflow query', () => {
  const src = read('components/AppSidebar.tsx');
  assert.ok(!src.includes('SidebarWorkflow'), 'the SidebarWorkflow type is gone');
  const props = slice(src, 'export function AppSidebar({', '}: {');
  assert.ok(!/\bworkflows\b/.test(props), 'AppSidebar takes no workflows prop');
  assert.ok(!src.includes('listWorkflows'), 'the sidebar never queries the workflow list');
});

test('sidebar: Inbox uses the unified client-level route + aggregated pending badge', () => {
  const src = read('components/AppSidebar.tsx');
  const conv = slice(src, 'const conversations: NavItem[] = [', '];');
  assert.ok(conv.includes('key: "inbox"'), 'the Conversations section is the Inbox');
  assert.ok(conv.includes('href: c("/inbox")'), 'Inbox → the unified /clients/{id}/inbox route');
  assert.ok(
    conv.includes('countEndpoint: `/api/inbox/${clientId}/pending-count`'),
    'Inbox keeps the aggregated client-level pending badge',
  );
});

test('sidebar: modules + roles still gate the entries', () => {
  const src = read('components/AppSidebar.tsx');
  assert.ok(src.includes('moduleKeys.includes("crm")'), 'Contacts gated by the crm module');
  assert.ok(src.includes('moduleKeys.includes("scheduling")'), 'Agenda gated by the scheduling module');
  assert.ok(src.includes('if (!isMember) {'), 'Administration (Team/Modules) is owner/admin only');
  assert.ok(src.includes('clientId !== defaultClientId'), 'Modules hidden for the default client');
});

test('sidebar: collapsed mode keeps navigation accessible (aria-label + tooltip + aria-current)', () => {
  const src = read('components/AppSidebar.tsx');
  assert.ok(src.includes('aria-label={collapsed ? item.label : undefined}'), 'collapsed NavLink exposes its name');
  assert.ok(src.includes('title={collapsed ? item.label : undefined}'), 'collapsed NavLink has a tooltip');
  assert.ok(src.includes('aria-current={item.active ? "page" : undefined}'), 'active item is aria-current="page"');
  assert.ok(src.includes('aria-label="Primary"'), 'the nav is a labelled landmark');
  // Collapsed Inbox keeps an accessible name including the pending count.
  const inbox = read('components/InboxTabLink.tsx');
  assert.ok(
    inbox.includes('aria-label={count > 0 ? `${label}, ${count} pending` : label}'),
    'collapsed Inbox has an accessible name with its count',
  );
});

test('sidebar: has a fixed account footer that opens the SHARED account menu', () => {
  const src = read('components/AppSidebar.tsx');
  assert.ok(src.includes('border-t border-line'), 'a bottom footer area exists');
  assert.ok(src.includes('<AccountMenu'), 'the footer opens the shared AccountMenu (no duplicated actions)');
  assert.ok(src.includes('aria-haspopup="menu"'), 'the account trigger is a menu button');
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

test('RSC-safe: the server page passes NO function to the client workspace', () => {
  const src = read('app/clients/[clientId]/inbox/page.tsx');
  // The three-column workspace is a client component; the server page must hand it
  // only serializable props (a callback would break RSC serialization —
  // "Functions cannot be passed directly to Client Components").
  assert.ok(src.includes('<ClientInboxWorkspace'), 'the page renders the client workspace');
  assert.ok(!src.includes('conversationHref'), 'no conversationHref callback prop');
  const ws = slice(src, '<ClientInboxWorkspace', '/>');
  assert.ok(!ws.includes('=>') && !ws.includes('function'), 'no function crosses the RSC boundary');
  // The workspace itself owns the ?c= deep link (the client-scoped route selector).
  const wsSrc = read('components/ClientInboxWorkspace.tsx');
  assert.ok(wsSrc.includes('searchParams.get("c")'), 'selection is the existing ?c= param');
  assert.ok(wsSrc.includes('p.set("c", id)'), 'selecting a row sets ?c= (preserving other params)');
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
