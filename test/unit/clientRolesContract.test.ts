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
  // The grant gate is the shared delegation rule (roles v1): access.users.manage on that
  // business, never wider than the actor, the Dueño only by the agency. Its behaviour is
  // tested in test/unit/delegation.test.ts and test/integration/accessRoles.test.ts.
  assert.match(invite, /const grant = grantedRole \? canGrantRole\(scope, clientId, grantedRole\)/);
  // A custom role offered by an invitation is re-read from THIS tenant + business.
  assert.match(invite, /getAccessRole\(scope\.tenantId, clientId, input\.accessRoleId\)/);
  const d = read('web/lib/permissions/delegation.ts');
  assert.match(d, /export function canGrantRole[\s\S]{0,400}access\.users\.manage[\s\S]{0,300}DENY\.ownerTier[\s\S]{0,200}DENY\.wider/);
});

test('escalation: member management enforces owner-only, last-owner and own-client', () => {
  const m = read('web/lib/memberActions.ts');
  // Acting on a person and the role given both go through the delegation rules.
  assert.match(m, /export async function changeClientRoleAction[\s\S]{0,1400}canManageMember\(scope, input\.clientId/);
  assert.match(m, /export async function changeClientRoleAction[\s\S]{0,2600}canGrantRole\(scope, input\.clientId, next\)/);
  // The last Client Owner can't be demoted or removed.
  assert.match(m, /countClientOwners\(scope\.tenantId/);
  assert.match(m, /owners <= 1/);
  // Removal: the tenant owner is immutable; admin removal is owner-only; a client member
  // is removed within the delegation rules.
  assert.match(m, /target\.role === "owner"[\s\S]{0,120}can't be removed/);
  assert.match(m, /target\.role === "admin"[\s\S]{0,140}scope\.role !== "owner"/);
  assert.match(m, /export async function removeMemberAction[\s\S]{0,1200}canManageMember\(scope, clientId/);
  const d = read('web/lib/permissions/delegation.ts');
  // Self, the Dueño tier and wider roles are refused for anyone but the agency.
  assert.match(d, /export function canManageMember[\s\S]{0,500}DENY\.self[\s\S]{0,200}DENY\.ownerTier[\s\S]{0,200}DENY\.outside/);
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
  // effective access = module enabled ∧ permission ∧ scope — every caller names the
  // permission; a professional login reaches scheduling because ITS permissions are
  // agenda ones, not through a role-name exception.
  assert.match(gate, /isClientModuleEnabled/);
  assert.match(gate, /if \(!canAny\(scope, asList\(permission\), clientId\)\) return \{ ok: false, forbidden: true \}/);
  assert.doesNotMatch(gate, /clientRole/);
  const access = read('web/lib/access.ts');
  assert.doesNotMatch(access, /export function canAccessClient/, 'the role-shaped predicate is gone');
});
