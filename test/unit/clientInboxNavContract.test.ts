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

test('sidebar: the client rail is the proposal\'s three blocks, built from ONE section model, Módulos apart', () => {
  // Operación (Inbox · Contactos · Agenda) | Negocio (Catálogo · Presencia y marketing ·
  // Dashboard de valor) | Herramientas (Configuración · Automatizaciones), split by a
  // hairline with no headings, and the agency's Módulos at the foot. Order, gates and labels
  // live in lib/sectionNav.ts; its behaviour (every role × module) is sectionNav.test.ts.
  const src = read('components/AppSidebar.tsx');
  const ctx = slice(src, 'if (clientId) {', '} else if (isMember) {');
  assert.ok(ctx.includes('buildSections({'), 'the client rail comes from buildSections');
  assert.ok(ctx.includes('const here = locate(clientId, pathname);'), 'the current page comes from locate (direct links too)');
  assert.ok(ctx.includes('const BLOCK_LABEL = { 1: "Operación", 2: "Negocio", 3: "Herramientas" } as const;'), 'the three blocks');
  assert.ok(ctx.includes('divider: true'), 'split by a hairline, not titled');
  assert.ok(ctx.includes('agency = { key: "modules", label: "Módulos"') && ctx.includes('tag: "AGENCIA"'), 'Módulos is apart, tagged AGENCIA');
  for (const gone of ['label: "Workspace"', 'label: "CRM"', 'label: "Scheduling"', 'label: "Administration"']) {
    assert.ok(!ctx.includes(gone), `${gone} heading is gone`);
  }
  const model = read('lib/sectionNav.ts');
  const order = ['inbox: [', 'contacts: [', 'agenda: [', 'catalog: [', 'presence: [', 'results: [', 'settings: [', 'automations: [', 'agency: ['];
  const pages = slice(model, 'const pages: Record<SectionId', 'return (Object.keys(pages)');
  let prev = -1;
  for (const marker of order) {
    const k = idx(pages, marker);
    assert.ok(k > prev, `section ${marker} is in the expected order`);
    prev = k;
  }
  // The section search (on request) narrows the SAME permission-filtered model — it can
  // never list a page the rail would not show. No ⌘K shortcut (not requested).
  assert.ok(src.includes('placeholder="Buscar sección"') && src.includes('function filterSections('), 'a section search at the top of the rail');
  assert.ok(src.includes('const shown = filterSections(sections, agency, searchable ? q : "");'), 'it filters the already-gated sections');
  assert.ok(!src.includes('⌘K') && !/key(\.toLowerCase\(\))? === ["']k["']/.test(src), 'no ⌘K shortcut');
});

test('sidebar: Automatizaciones = Workflows + Analíticas técnicas + Reuniones; the Dashboard de valor is Negocio', () => {
  const src = read('components/AppSidebar.tsx');
  assert.ok(!src.includes('key: "hub"'), 'Hub is no longer a rail item — the brand wordmark links home instead');
  const model = read('lib/sectionNav.ts');
  // Workflows (their executions) and the value dashboard are INSIGHTS (agency/owner) —
  // a Setter never sees them. Both workflow entries follow the remembered scope.
  assert.ok(model.includes('const insights = isAgency || (clientRole === "owner" && forOwnClient);'), 'insights = agency or own owner');
  assert.ok(model.includes('insights && { id: "workflows", label: "Workflows", href: wf.executions }'), 'Workflows is insights, scope-aware');
  assert.ok(model.includes('insights && { id: "tech-analytics", label: "Analíticas técnicas", href: wf.analytics }'), 'Analíticas técnicas is insights, scope-aware');
  assert.ok(model.includes('results: [insights && { id: "value", label: "Dashboard de valor", href: c("/analytics") }]'), 'the value dashboard is insights');
  assert.ok(src.includes('workflowScope: scopeFor(clientId)'), 'the remembered workflow scope rides the rail link');
  // No duplicate destination: there is no all-workflows execution screen besides Workflows.
  assert.ok(!model.includes('label: "Ejecuciones"'), 'no second entry for the same screen');
  const ctx = slice(src, 'if (clientId) {', '} else if (isMember) {');
  for (const gone of ['key: "executions"', 'key: "settings"']) {
    assert.ok(!ctx.includes(gone), `${gone} is not a rail item`);
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
  const model = read('lib/sectionNav.ts');
  assert.ok(model.includes('inbox: [general && has("inbox") && { id: "inbox", label: "Inbox", href: c("/inbox") }]'), 'Inbox → the unified /clients/{id}/inbox route, inbox-gated');
  const src = read('components/AppSidebar.tsx');
  assert.ok(
    src.includes('countEndpoint: sec.id === "inbox" ? `/api/inbox/${clientId}/pending-count` : undefined'),
    'Inbox keeps the aggregated client-level pending badge',
  );
});

test('sidebar: modules + roles still gate the entries', () => {
  const model = read('lib/sectionNav.ts');
  assert.ok(model.includes('general && has("crm") && { id: "contacts"'), 'Contacts gated by the crm module');
  assert.ok(model.includes('has("scheduling") && { id: "calendar"'), 'Agenda gated by the scheduling module');
  assert.ok(model.includes('const schedManage = manage && has("scheduling") && !isDefault;'), 'scheduling settings: manage + module + non-default');
  // Usuarios y accesos is behind the client-admin capability; Módulos stays agency-only
  // and hidden for the default client.
  assert.ok(model.includes('manage && { id: "users", label: "Usuarios y accesos"'), 'Usuarios y accesos gated (agency or client owner)');
  assert.ok(model.includes('agency: [isAgency && !isDefault && { id: "modules"'), 'Módulos is agency-only + non-default');
});

test('sidebar: collapsed mode keeps navigation accessible (aria-label + tooltip + aria-current + group menus)', () => {
  const src = read('components/AppSidebar.tsx');
  assert.ok(src.includes('aria-label={collapsed ? tip : undefined}'), 'collapsed NavLink exposes its name');
  // The tooltip is CSS (u-rail-tip + data-tip) so it also shows on keyboard focus.
  assert.ok(src.includes('data-tip={collapsed ? tip : undefined}'), 'collapsed NavLink has a tooltip');
  assert.ok(read('app/globals.css').includes('.u-rail-tip[data-tip]:focus-visible::after'), 'the tooltip also shows on focus');
  assert.ok(src.includes('aria-current={item.active ? "page" : undefined}'), 'active item is aria-current="page"');
  assert.ok(src.includes('aria-label="Primary"'), 'the nav is a labelled landmark');
  // A collapsed GROUP is one icon that opens a floating menu; Escape closes it and focus
  // returns to the icon.
  const fly = slice(src, 'function CollapsedGroup(', 'function BlockDivider(');
  assert.ok(fly.includes('aria-expanded={open}') && fly.includes('aria-controls={panelId}'), 'the icon is a disclosure button');
  assert.ok(fly.includes('if (e.key === "Escape")') && fly.includes('btnRef.current?.focus()'), 'Escape closes and returns focus');
  // Collapsed Inbox keeps an accessible name including the pending count.
  const inbox = read('components/InboxTabLink.tsx');
  assert.ok(inbox.includes('aria-label={count > 0 ? `${label}, ${count} pendientes` : label}'), 'collapsed Inbox has an accessible name with its count');
});

test('sidebar: has a fixed account footer that opens the SHARED account menu', () => {
  const src = read('components/AppSidebar.tsx');
  // The footer sits on the rail's own surface; the proposal draws no rule above it (one
  // continuous ground), the spacing is the separation.
  assert.ok(src.includes('<div ref={footerRef} className={`relative shrink-0 ${collapsed ? "p-2 pb-3" : "pb-3 pt-1"}`}>'), 'a bottom footer area exists');
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
