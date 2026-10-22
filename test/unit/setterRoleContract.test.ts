import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SYSTEM_ROLE_PERMISSIONS } from '../../web/lib/permissions/catalog.js';

/**
 * SOURCE CONTRACT for the SETTER client role (replaces Editor). Setter = inbox + contacts
 * + agenda; NO analytics, executions, workflow internals, settings, custom fields or team.
 * These server-side web actions/pages import next/* and can't be driven headless, so the
 * guards are pinned at the source (the DB rename is proven by the integration test).
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');
const WF = 'web/app/clients/[clientId]/workflows/';

test('setter is the operational client role: inbox/contacts/agenda YES, workflow insights NO', () => {
  // Since roles v1 the Setter (Recepción) is a PERMISSION SET in the catalog, resolved by
  // buildScope — no gate compares its name. Behaviour, not strings:
  const setter = SYSTEM_ROLE_PERMISSIONS.setter;
  for (const k of ['inbox.view', 'inbox.reply', 'contacts.view', 'contacts.edit', 'agenda.view', 'agenda.book'] as const) {
    assert.ok(setter.has(k), `setter keeps ${k}`);
  }
  for (const k of ['analytics.view', 'automations.view', 'meetings.view', 'settings.sites', 'contacts.fields', 'team.manage', 'access.users.view'] as const) {
    assert.ok(!setter.has(k), `setter never had ${k}`);
  }
  const access = read('web/lib/access.ts');
  // buildScope accepts the three system roles + 'custom' and fails closed on anything else.
  assert.match(access, /clientRole === "owner" \|\| clientRole === "setter" \|\| clientRole === "staff"/);
  assert.match(access, /SYSTEM_ROLE_PERMISSIONS\[clientRole\]/);
  assert.match(access, /return \{ ok: false \}; \/\/ unknown \/ absent client role → deny/);
  // The Setter lands on the INBOX (analytics would 404 for it) — one shared rule.
  assert.match(access, /memberLandingPath\(/);
  assert.match(read('web/lib/landing.ts'), /has\("inbox.view"\)\) return c\("\/inbox"\)/);
  // No FUNCTIONAL 'editor' value remains in the role model.
  assert.doesNotMatch(access, /clientRole === "editor"/);
  assert.doesNotMatch(access, /!== "editor"/);
});

test('migration renames editor → setter (reversible)', () => {
  const m = read('migrations/1795000000000_setter-role.ts');
  assert.match(m, /UPDATE tenant_members SET client_role = 'setter' WHERE client_role = 'editor'/);
  assert.match(m, /UPDATE invitations\s+SET client_role = 'setter' WHERE client_role = 'editor'/);
  // The CHECK is built from a template helper; up() admits 'setter', down() restores 'editor'.
  assert.match(m, /client_role IN \('owner','\$\{op\}'\)/);
  assert.match(m, /clientRoleCheck\('setter'\)/);
  // down() reverses it.
  assert.match(m, /SET client_role = 'editor' WHERE client_role = 'setter'/);
  assert.match(m, /clientRoleCheck\('editor'\)/);
});

test('every workflow-INSIGHTS surface is gated (Setter 404s); the inbox is NOT', () => {
  // One shared chokepoint helper, always bound to the URL client and a permission.
  const cw = read('web/lib/clientWorkflow.ts');
  assert.match(cw, /export async function requireWorkflowInsights\([\s\S]{0,260}if \(!can\(scope, permission, clientId\)\) notFound\(\)/);
  // Executions, analytics (per-workflow + aggregate), the all-executions redirect, the
  // workflows list, and workflow settings all gate on it.
  for (const [rel, perm] of [
    ['[workflowId]/(workspace)/layout.tsx', 'automations.view'],
    ['[workflowId]/analytics/page.tsx', 'analytics.view'],
    ['[workflowId]/(padded)/conversations/settings/page.tsx', 'automations.view'],
    ['all/analytics/page.tsx', 'analytics.view'],
    ['all/executions/page.tsx', 'automations.view'],
    ['page.tsx', 'automations.view'],
  ]) {
    assert.match(read(WF + rel), new RegExp(`requireWorkflowInsights\\(\\(await params\\)\\.clientId, "${perm}"\\)`), `${rel} gates on ${perm}`);
  }
  // The inbox shim under a workflow + the client-level inbox do NOT gate on insights, so a
  // Setter keeps the inbox (it still resolves a workflow via WORKFLOW_SURFACE_PERMISSIONS).
  assert.doesNotMatch(read(WF + '[workflowId]/(padded)/inbox/page.tsx'), /requireWorkflowInsights/);
  assert.doesNotMatch(read('web/app/clients/[clientId]/inbox/page.tsx'), /requireWorkflowInsights/);
  assert.match(read('web/lib/access.ts'), /WORKFLOW_SURFACE_PERMISSIONS: readonly PermissionKey\[\] = \["inbox.view", "automations.view", "analytics.view"\]/);
});

test('inbox + contacts stay module+permission gated (Setter ✓) and never leak an execution', () => {
  assert.match(read('web/app/clients/[clientId]/inbox/page.tsx'), /requireClientModulePage\(clientId, "inbox", "inbox.view"\)/);
  assert.match(read('web/app/clients/[clientId]/contacts/page.tsx'), /requireClientModulePage\(clientId, "crm", "contacts.view"\)/);
  // No execution/analytics link FROM an allowed surface (inbox thread, contact timeline).
  for (const rel of [
    'web/components/ClientInboxWorkspace.tsx',
    'web/components/InboxThread.tsx',
    'web/components/contacts/ContactTimeline.tsx',
  ]) {
    const src = read(rel);
    assert.doesNotMatch(src, /\/executions/, `${rel} links to no executions route`);
    assert.doesNotMatch(src, /view execution/i, `${rel} has no "view execution" affordance`);
  }
});

test('the header workflow switcher (and "All workflows") is hidden from a Setter', () => {
  const header = read('web/components/AppHeader.tsx');
  assert.match(header, /!\(scope\.permissions\.has\("automations\.view"\) \|\| scope\.permissions\.has\("analytics\.view"\)\)[\s\S]{0,20}\?[\s\S]{0,10}\[\]/);
});

test('sidebar: Setter gets inbox/contacts/agenda, not workflows/analytics', () => {
  const src = read('web/components/AppSidebar.tsx');
  const model = read('web/lib/sectionNav.ts');
  // Each page reads the permission its own gate checks (behaviour: test/unit/sectionNav.test.ts).
  assert.match(model, /p\("automations\.view"\) && \{ id: "workflows"/);
  assert.match(model, /p\("analytics\.view"\) && \{ id: "tech-analytics"/);
  assert.match(model, /p\("analytics\.view"\) && \{ id: "value"/);
  assert.match(model, /p\("inbox\.view"\) && has\("inbox"\)/);
  assert.doesNotMatch(model, /clientRole/, 'the rail never reads a role name');
  // The off-client fallback: Dashboard only with analytics.view; Inbox with inbox.view.
  assert.match(src, /may\("analytics\.view"\)\) items\.push\(\{ key: "analytics"/);
  assert.match(src, /may\("inbox\.view"\) && memberModules\.includes\("inbox"\)/);
});

test('escalation: a Client Owner may grant Setter but never Owner; Setter grants nothing', () => {
  const invite = read('web/lib/inviteActions.ts');
  // Valid client roles: the three system roles or a custom role of this business.
  assert.match(invite, /!isSystemRoleKey\(requestedRole\) && requestedRole !== "custom"/);
  // Only the agency mints owners — the shared delegation rule.
  assert.match(invite, /canGrantRole\(scope, clientId, grantedRole\)/);
  const d = read('web/lib/permissions/delegation.ts');
  assert.match(d, /role\.kind === "system" && role\.key === "owner"\) return isAgencyActor\(actor\) \? OK : deny\(DENY\.ownerTier\)/);
  // Recepción holds no access.* permission, so it grants nothing.
  assert.ok(!SYSTEM_ROLE_PERMISSIONS.setter.has('access.users.manage'));
});
