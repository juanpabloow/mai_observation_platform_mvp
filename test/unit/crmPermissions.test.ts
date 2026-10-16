import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  canEditNote,
  canManageTagCatalog,
  canManageTask,
  resolveAssignee,
  type CrmActor,
} from '../../web/lib/crmPermissions.js';

/**
 * Pure role rules for CRM actions. Recovered from PR #2 (C-3), adapted: canChangeOwner/
 * canChangeStage were removed — owner/stage changes go through C-2's contactActions
 * (owner/admin gated there), not crmPermissions.
 */
const owner: CrmActor = { role: 'owner', clientRole: null, userId: 'u-owner' };
const admin: CrmActor = { role: 'admin', clientRole: null, userId: 'u-admin' };
// Limited members (clientRole setter/staff) keep the narrow rules.
const memberA: CrmActor = { role: 'member', clientRole: 'setter', userId: 'u-a' };
const memberB: CrmActor = { role: 'member', clientRole: 'staff', userId: 'u-b' };
// MF-1 item 5: a Client Owner has FULL CRM control inside their client.
const clientOwner: CrmActor = { role: 'member', clientRole: 'owner', userId: 'u-co' };

test('notes: author edits own; another member cannot; owner/admin can', () => {
  const note = { created_by_user_id: 'u-a' };
  assert.equal(canEditNote(memberA, note), true, 'author');
  assert.equal(canEditNote(memberB, note), false, 'other member');
  assert.equal(canEditNote(owner, note), true);
  assert.equal(canEditNote(admin, note), true);
});

test('tasks: member manages own/assigned only; owner/admin manage all', () => {
  const created = { created_by_user_id: 'u-a', assigned_to_user_id: null };
  const assigned = { created_by_user_id: 'u-owner', assigned_to_user_id: 'u-a' };
  const foreign = { created_by_user_id: 'u-owner', assigned_to_user_id: 'u-b' };
  assert.equal(canManageTask(memberA, created), true, 'creator');
  assert.equal(canManageTask(memberA, assigned), true, 'assignee');
  assert.equal(canManageTask(memberA, foreign), false, 'neither');
  assert.equal(canManageTask(admin, foreign), true, 'admin all');
});

test('assignee: member only to self; owner/admin to anyone', () => {
  assert.deepEqual(resolveAssignee(memberA, null), { ok: true, assignee: 'u-a' }, 'member unassigned → self');
  assert.deepEqual(resolveAssignee(memberA, 'u-a'), { ok: true, assignee: 'u-a' }, 'member → self OK');
  assert.equal(resolveAssignee(memberA, 'u-b').ok, false, 'member → other denied');
  assert.deepEqual(resolveAssignee(owner, 'u-b'), { ok: true, assignee: 'u-b' }, 'owner → anyone');
  assert.deepEqual(resolveAssignee(owner, null), { ok: true, assignee: null }, 'owner unassigned stays null');
});

test('tag catalogue: full-access (agency + Client Owner) only', () => {
  assert.equal(canManageTagCatalog(owner), true);
  assert.equal(canManageTagCatalog(admin), true);
  assert.equal(canManageTagCatalog(clientOwner), true, 'Client Owner manages the catalogue');
  assert.equal(canManageTagCatalog(memberA), false, 'setter cannot');
  assert.equal(canManageTagCatalog(memberB), false, 'staff cannot');
});

test('MF-1 item 5: a Client Owner has FULL CRM control inside their client', () => {
  const foreignNote = { created_by_user_id: 'someone-else' };
  const foreignTask = { created_by_user_id: 'someone-else', assigned_to_user_id: 'another' };
  assert.equal(canEditNote(clientOwner, foreignNote), true, 'edits any note');
  assert.equal(canManageTask(clientOwner, foreignTask), true, 'manages any task');
  assert.deepEqual(resolveAssignee(clientOwner, 'u-b'), { ok: true, assignee: 'u-b' }, 'assigns to anyone');
  // A limited member is unchanged: still only own/assigned.
  assert.equal(canEditNote(memberA, foreignNote), false, 'setter still limited to own note');
  assert.equal(canManageTask(memberB, foreignTask), false, 'staff still limited to own/assigned task');
});
