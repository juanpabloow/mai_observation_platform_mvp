import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE CONTRACT for the CLIENT-ROLES security core (§4 privilege escalation + the four
 * pre-existing holes closed in this phase). These web-side server actions import
 * next/cache etc. and can't be driven headless, so — as the rest of this suite does —
 * the guards are pinned at the source. The DB-backed invariants (CHECK/FKs/last-owner)
 * are proven by test/integration/schedulingMemberAccess.test.ts.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');

test('escalation: only the AGENCY mints admins and Client Owners', () => {
  const invite = read('web/lib/inviteActions.ts');
  // Admin invites are agency + owner only (a client owner can never reach the admin tier).
  assert.match(invite, /if \(input\.role === "admin"\) \{\s*\n\s*if \(!hasFullAccess\(scope\) \|\| scope\.role !== "owner"\)/);
  // The grant gate: agency may grant anything; a Client Owner may grant editor/staff for
  // their OWN client only — never another Owner.
  assert.match(invite, /function canGrantClientRole/);
  assert.match(invite, /if \(hasFullAccess\(scope\)\) return \{ ok: true \}/);
  assert.match(invite, /if \(isClientOwner\(scope, clientId\)\)/);
  assert.match(invite, /clientRole === "owner"[\s\S]{0,120}Only the agency can add another Owner/);
  // The gate runs BEFORE any client lookup (deny-by-default, no info leak).
  assert.match(invite, /const grant = canGrantClientRole\(scope, clientId, requestedRole\)/);
});

test('escalation: member management enforces owner-only, last-owner and own-client', () => {
  const m = read('web/lib/memberActions.ts');
  // Only the agency may ASSIGN the owner role.
  assert.match(m, /input\.clientRole === "owner" && !hasFullAccess\(scope\)/);
  // A Client Owner can't act on another Owner (which also blocks self-escalation).
  assert.match(m, /!hasFullAccess\(scope\) && target\.client_role === "owner"/);
  // The last Client Owner can't be demoted or removed.
  assert.match(m, /countClientOwners\(scope\.tenantId/);
  assert.match(m, /owners <= 1/);
  // Removal: the tenant owner is immutable; admin removal is owner-only; a client member
  // is removed by the agency or the client's owner (canManageClient).
  assert.match(m, /target\.role === "owner"[\s\S]{0,120}can't be removed/);
  assert.match(m, /target\.role === "admin"[\s\S]{0,140}scope\.role !== "owner"/);
  assert.match(m, /canManageClient\(scope, clientId\)/);
  // changeClientRole is gated by canManageClient (agency or this client's owner).
  assert.match(m, /export async function changeClientRoleAction[\s\S]{0,600}canManageClient\(scope, input\.clientId\)/);
});

test('the four pre-existing holes are closed server-side (resolve-then-mutate, agency-only)', () => {
  // 1 + 2: column + conversation-role mappings are agency plumbing, and resolve the
  // workflow BEFORE mutating (the old order deleted by id first — a cross-client bypass).
  const col = read('web/lib/columnActions.ts');
  assert.match(col, /export async function deleteColumnAction[\s\S]{0,500}requireFullAccessForAction\(\)[\s\S]{0,500}getWorkflowForCurrentTenant\(input\.workflowId\)[\s\S]{0,500}deleteColumnMapping/);
  assert.match(col, /export async function addColumnAction[\s\S]{0,200}requireFullAccessForAction\(\)/);
  const conv = read('web/lib/conversationActions.ts');
  assert.match(conv, /export async function deleteConversationRoleAction[\s\S]{0,500}requireFullAccessForAction\(\)[\s\S]{0,500}getWorkflowForCurrentTenant\(input\.workflowId\)[\s\S]{0,500}deleteConversationMapping/);
  assert.match(conv, /export async function upsertConversationRoleAction[\s\S]{0,200}requireFullAccessForAction\(\)/);
  // 3: the conversation field-role editor is agency plumbing — its mutations are now
  // hasFullAccess-gated (covered by the upsert/delete assertions above).
  // 4: the scheduling events poll validates the site param and pins a staff login to
  // its own site (no cross-site / cross-column event leak).
  const events = read('web/app/api/scheduling/internal/events/route.ts');
  assert.match(events, /!canAccessSchedulingSite\(scope, siteId\)/);
  assert.match(events, /isSchedulingStaff\(scope\) && scope\.schedulingSiteId\) siteId = scope\.schedulingSiteId/);
});

test('module gating still sits ON TOP of roles', () => {
  const gate = read('web/lib/clientModuleAccess.ts');
  // A staff login reaches ONLY the scheduling module, and only when it's enabled.
  assert.match(gate, /scope\.clientRole === "staff"/);
  assert.match(gate, /isClientModuleEnabled/);
  // canAccessClient denies staff for the general (crm/inbox/analytics) modules.
  const access = read('web/lib/access.ts');
  assert.match(access, /export function canAccessClient[\s\S]{0,160}if \(scope\.clientRole === "staff"\) return false/);
});
