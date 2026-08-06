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
 * workflow SCOPE switcher (W-1/W-2), the Workflows list page, and that the unified Inbox
 * + its legacy redirects are preserved. Structure/wiring guards, NOT a claim that
 * anything renders. (W-1 removed the in-content WorkflowTabs; W-2 removed the per-
 * workflow inbox grid — both are reflected below.)
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

test('sidebar: sections are ordered Workspace → CRM → Scheduling → Administration', () => {
  // FINAL DESIGN: the rail is grouped by PLACE, not by workflow surface. The old
  // "Workflows / Conversations" split collapsed into one WORKSPACE group holding
  // Hub, Workflows and Inbox — see the next test for why.
  const src = read('components/AppSidebar.tsx');
  const ctx = slice(src, 'if (clientId) {', '} else if (isMember) {');
  const order = ['label: "Workspace"', 'label: "CRM"', 'label: "Scheduling"', 'label: "Administration"'];
  let prev = -1;
  for (const marker of order) {
    const i = idx(ctx, marker);
    assert.ok(i > prev, `section ${marker} is in the expected order`);
    prev = i;
  }
  assert.ok(!ctx.includes('label: "Conversations"'), 'Inbox lives in Workspace, not its own group');
});

test('sidebar: WORKSPACE is Hub → Workflows → Inbox; workflow SURFACES are not rail items', () => {
  // Executions / Analytics / Settings are surfaces INSIDE a workflow, reached from
  // the Workflows list and the header scope switcher. As rail items they appeared as
  // peers of Inbox and CRM while pointing at a different context entirely — so the
  // client rail now shows the workflow CONTEXT once, as "Workflows".
  const src = read('components/AppSidebar.tsx');
  const workspace = slice(src, 'const workspace: NavItem[] = [', '];');
  assert.ok(idx(workspace, 'key: "hub"') < idx(workspace, 'key: "workflows"'), 'Hub precedes Workflows');
  assert.ok(workspace.includes('scopeHref(clientId, "executions", scope)'), 'Workflows href still comes from scopeHref');
  assert.ok(src.includes('const onWorkflows = pathname.startsWith(c("/workflows"));'), 'active across all /workflows/… routes');
  // Inbox is appended to the SAME group (module-gated), so it renders under Workspace.
  assert.ok(src.includes('workspace.push({'), 'Inbox joins the Workspace group');
  assert.ok(src.includes('sections = [{ label: "Workspace", items: workspace }];'), 'Workspace is the first section');

  // The client rail must NOT offer the per-surface workflow items any more.
  const ctx = slice(src, 'if (clientId) {', '} else if (isMember) {');
  for (const gone of ['key: "executions"', 'key: "analytics"', 'key: "settings"']) {
    assert.ok(!ctx.includes(gone), `${gone} is no longer a rail item`);
  }
});

test('sidebar: the brand sits at the TOP of the rail (the header no longer carries it)', () => {
  const src = read('components/AppSidebar.tsx');
  assert.ok(src.includes('function Brand('), 'the rail owns the brand block');
  assert.ok(src.includes('<Brand homeHref={homeHref}'), 'and renders it above the nav');
  const header = read('components/HeaderBar.tsx');
  assert.ok(!header.includes('Observability'), 'the header no longer renders a wordmark');
  assert.ok(!/homeHref/.test(header), 'and no longer needs a home target');
});

test('shell: the header starts AFTER the sidebar, not across the whole viewport', () => {
  const layout = read('app/layout.tsx');
  const sidebarAt = idx(layout, '<AppSidebarServer />');
  const headerAt = idx(layout, '<AppHeader />');
  assert.ok(sidebarAt < headerAt, 'the sidebar is the first column; the header renders inside the content column');
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
  // The Conversations section is now gated by the inbox module; the Inbox item lives
  // inside that block.
  const conv = slice(src, 'if (moduleKeys.includes("inbox"))', 'if (moduleKeys.includes("crm"))');
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
  // The footer sits on the rail's own surface, separated by the rail's border —
  // so it follows the Sidebar-appearance preference with the rest of the rail.
  assert.ok(src.includes('border-t border-sidebar-border'), 'a bottom footer area exists');
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

test('switcher panel: a pure scope PICKER (emits onSelect(scope)); builds no routes', () => {
  // W-1: the panel no longer builds section hrefs. It emits onSelect("all" | workflowId)
  // and the host (HeaderBar) turns that into a route via scopeHref, preserving the
  // current section. So the panel itself must contain NO /workflows route strings.
  const src = read('components/WorkflowSwitcherPanel.tsx');
  assert.ok(src.includes('scope: "all", label: "All workflows"'), '"All workflows" is the first option (scope "all")');
  assert.ok(src.includes('scope: w.id'), 'each workflow option carries its id as the scope');
  assert.ok(src.includes('onSelect(o.scope)'), 'selecting an option emits onSelect(scope)');
  assert.ok(src.includes('o.scope === currentScope'), 'the current scope is marked (✓)');
  assert.ok(!src.includes('/workflows'), 'the picker builds no routes (the host does, via scopeHref)');
});

test('header: the switcher gets ONLY the current client\'s workflows + remembered scope', () => {
  // W-1/W-2: the section is no longer a local const — it comes from the scope SURFACE
  // (parseScopeSurface: executions / analytics / inbox / settings). The panel is a pure
  // picker; the header turns a selection into a route via scopeHref, preserving section.
  const src = read('components/HeaderBar.tsx');
  assert.ok(src.includes('const surface = parseScopeSurface(pathname);'), 'the section comes from the scope surface');
  // clientWorkflows is filtered to the current client; that list feeds the panel.
  assert.ok(
    src.includes('workflows.filter((w) => w.clientId === currentClient.id)'),
    'only the current client\'s workflows are collected',
  );
  // Selecting a scope preserves the current section (non-inbox via scopeHref, inbox via ?workflow=).
  assert.ok(
    src.includes('scopeHref(surface.clientId, surface.section, scope)'),
    'a selection navigates keeping the section',
  );
  const panel = slice(src, '<WorkflowSwitcherPanel', '/>');
  assert.ok(panel.includes('workflows={clientWorkflows'), 'the panel receives the current-client list');
  assert.ok(panel.includes('currentScope={currentScope}'), 'the panel receives the remembered scope (drives the ✓)');
  assert.ok(panel.includes('onSelect={onSelectScope}'), 'the panel reports selections back to the host');
});

// ─────────── Shared workflow tabs — REMOVED (W-1): see the deletion note below ──────
// The shared in-content "Executions | Analytics" WorkflowTabs component was removed in
// W-1. Those sections are now scope-driven sidebar items (covered by the "Workflows
// section" sidebar test above), and the per-workflow layout is a guard-only pass-through
// (no tab bar). The previous "workflow tabs: a SHARED component…" case — which asserted
// a TABS list of Executions/Analytics with no Inbox, mounted by the layout — was deleted
// because the component and the layout tab bar no longer exist.
test('workflow layout: guard-only pass-through, no in-content tab bar (W-1)', () => {
  const layout = read('app/clients/[clientId]/workflows/[workflowId]/layout.tsx');
  assert.ok(layout.includes('return children;'), 'the layout renders its child straight through');
  assert.ok(!layout.includes('WorkflowTabs') && !layout.includes('role="tablist"'), 'no in-content tab bar');
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
  // W-1: rows link through the single scopeHref() source of truth; the default section
  // is "executions", so a row opens that workflow's Executions (the /executions literal
  // now lives in scopeSurface, exercised by its own tests).
  assert.ok(list.includes('scopeHref(clientId, section, w.n8nWorkflowId)'), 'rows link via scopeHref');
  assert.ok(list.includes('section = "executions"'), 'rows default to the workflow Executions');
  assert.ok(list.includes('No workflows yet'), 'has an empty state');
});

// ───────────────────── Preserved: unified Inbox + legacy routes ───────────────

test('client Inbox page (unified): inbox-gated, resolves W-2 scope, loads the scoped list', () => {
  const src = read('app/clients/[clientId]/inbox/page.tsx');
  // Gated by the canonical module gate (tenant + client + non-default + inbox enabled →
  // indistinguishable 404).
  assert.ok(src.includes('requireClientModulePage(clientId, "inbox")'), 'gated by the inbox module');
  // W-2: the effective scope is URL-first (?workflow=, validated) else the remembered
  // cookie; the list is loaded ALREADY-SCOPED server-side (no client-side workflow
  // filtering, no flash of the full list).
  assert.ok(src.includes('validateWorkflowForClient(') && src.includes('resolveWorkflowScope('), 'resolves the URL-first / cookie scope');
  assert.ok(src.includes('loadScopedClientInbox('), 'loads the already-scoped unified list');
  // The workspace is keyed by the scope so a scope change re-seeds it.
  const ws = slice(src, '<ClientInboxWorkspace', '/>');
  assert.ok(ws.includes('key={effective}') && ws.includes('scope={effective}'), 'the workspace is keyed by + given the scope');
  // The client-level poll lives in the workspace (a serializable prop crossing; the page
  // itself no longer polls).
  const wsSrc = read('components/ClientInboxWorkspace.tsx');
  assert.ok(
    wsSrc.includes('`/api/inbox/${encodeURIComponent(clientId)}/conversations`'),
    'the workspace polls the client-level conversations endpoint',
  );
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

// The "grid builds the drawer href from conversationRoute (client vs workflow)…" case
// was DELETED: the ConversationGrid + InboxDrawer components were removed. The unified
// client inbox is now the three-column ClientInboxWorkspace, which selects via the ?c=
// deep link (covered by inboxWorkspaceContract), and the "workflow mode" route it built
// (/workflows/<w>/inbox) no longer renders a grid — it 307-redirects (see below).

test('legacy routes still exist / compile (compatibility)', () => {
  // W-2: the per-workflow inbox surface was removed; the route is now a 307-redirect to
  // the client inbox scoped to that workflow (?workflow=<w>), preserving ?c=.
  const perWorkflow = read('app/clients/[clientId]/workflows/[workflowId]/(padded)/inbox/page.tsx');
  assert.ok(perWorkflow.includes('redirect(') && perWorkflow.includes('/inbox?workflow='), 'the per-workflow inbox 307-redirects to the scoped client inbox');
  assert.ok(
    read('app/clients/[clientId]/inbox/[conversationId]/page.tsx').includes('redirect('),
    'the legacy client thread URL still redirects',
  );
  assert.ok(
    read('app/clients/[clientId]/workflows/all/analytics/page.tsx').length > 0,
    'the aggregate All-workflows analytics view still exists',
  );
});
