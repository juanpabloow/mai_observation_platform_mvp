import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE CONTRACT for the SETTER client role (replaces Editor). Setter = inbox + contacts
 * + agenda; NO analytics, executions, workflow internals, settings, custom fields or team.
 * These server-side web actions/pages import next/* and can't be driven headless, so the
 * guards are pinned at the source (the DB rename is proven by the integration test).
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');
const WF = 'web/app/clients/[clientId]/workflows/';

test('setter is the operational client role: canAccessClient YES, workflow insights NO', () => {
  const access = read('web/lib/access.ts');
  // buildScope accepts setter (owner/setter/staff) and fails closed on anything else.
  assert.match(access, /clientRole !== "owner" && clientRole !== "setter" && clientRole !== "staff"/);
  // canAccessClient admits non-staff (owner/setter) — the Setter reaches inbox/contacts/agenda.
  assert.match(access, /export function canAccessClient[\s\S]{0,200}if \(scope\.clientRole === "staff"\) return false/);
  // canSeeWorkflowInsights is the agency/OWNER-only capability — the Setter is excluded.
  assert.match(access, /export function canSeeWorkflowInsights[\s\S]{0,320}if \(scope\.clientRole !== "owner"\) return false/);
  // The Setter lands on the INBOX (analytics would 404 for it).
  assert.match(access, /clientRole === "setter".{0,80}\/inbox/);
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
  // One shared chokepoint helper.
  const cw = read('web/lib/clientWorkflow.ts');
  assert.match(cw, /export async function requireWorkflowInsights[\s\S]{0,220}if \(!canSeeWorkflowInsights\(scope\)\) notFound\(\)/);
  // Executions, analytics (per-workflow + aggregate), the all-executions redirect, the
  // workflows list, and workflow settings all gate on it.
  for (const rel of [
    '[workflowId]/(workspace)/layout.tsx',
    '[workflowId]/analytics/page.tsx',
    '[workflowId]/(padded)/conversations/settings/page.tsx',
    'all/analytics/page.tsx',
    'all/executions/page.tsx',
    'page.tsx',
  ]) {
    assert.match(read(WF + rel), /requireWorkflowInsights\(\)/, `${rel} gates on workflow insights`);
  }
  // The inbox shim under a workflow + the client-level inbox do NOT gate on insights, so a
  // Setter keeps the inbox (it still resolves a workflow via canAccessClient).
  assert.doesNotMatch(read(WF + '[workflowId]/(padded)/inbox/page.tsx'), /requireWorkflowInsights/);
  assert.doesNotMatch(read('web/app/clients/[clientId]/inbox/page.tsx'), /requireWorkflowInsights/);
});

test('inbox + contacts stay module+client gated (Setter ✓) and never leak an execution', () => {
  // The Setter reaches these through the SAME gates as before (module + canAccessClient).
  assert.match(read('web/app/clients/[clientId]/inbox/page.tsx'), /requireClientModulePage\(clientId, "inbox"\)/);
  assert.match(read('web/app/clients/[clientId]/contacts/page.tsx'), /requireClientModulePage\(clientId, "crm"\)/);
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
  assert.match(header, /!canSeeWorkflowInsights\(scope\)[\s\S]{0,20}\?[\s\S]{0,10}\[\]/);
});

test('sidebar: Setter gets inbox/contacts/agenda, not workflows/analytics', () => {
  const src = read('web/components/AppSidebar.tsx');
  assert.match(src, /canSeeGeneral = !isMember \|\| \(\(clientRole === "owner" \|\| clientRole === "setter"\)/);
  assert.match(src, /canSeeInsights = !isMember \|\| \(clientRole === "owner"/);
  // Workflows/Analytics pushed only under insights; inbox under general access.
  assert.match(src, /if \(canSeeInsights\) \{[\s\S]{0,400}key: "workflows"/);
  assert.match(src, /canSeeGeneral && moduleKeys\.includes\("inbox"\)/);
  // The off-client fallback sends a Setter to the inbox, never analytics.
  assert.match(src, /clientRole === "setter"[\s\S]{0,160}key: "inbox"/);
});

test('escalation: a Client Owner may grant Setter but never Owner; Setter grants nothing', () => {
  const invite = read('web/lib/inviteActions.ts');
  // Valid client roles are owner/setter/staff.
  assert.match(invite, /requestedRole !== "owner" && requestedRole !== "setter" && requestedRole !== "staff"/);
  // Only the agency mints owners (the canGrantClientRole gate is unchanged by the rename).
  assert.match(invite, /isClientOwner\(scope, clientId\)/);
  assert.match(invite, /Only the agency can add another Owner/);
});
