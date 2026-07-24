import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query, withTransaction } from '../../src/db/client.js';
import {
  disableInboxIfIdle,
  isClientModuleEnabled,
  isInboxEnabledForUpdate,
  listClientModules,
  setClientModuleEnabled,
} from '../../src/db/repositories/clientModules.js';
import {
  getOrCreateConversation,
  insertMessage,
  ModuleDisabledError,
  transitionMode,
} from '../../src/db/repositories/handoff.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * The `inbox` per-client module (MOD-2), proven behaviorally against PostgreSQL:
 * enable/disable lifecycle, the transactional disable policy (blocked while
 * pending/human handoffs exist), the race-safe escalation gate, per-client/tenant
 * isolation, and that disabling never deletes conversation data.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

/** A bot conversation for a client, via a workflow assigned to that client. */
async function seedConversation(tenantId: string, clientId: string, wf: string): Promise<string> {
  await seedWorkflow(tenantId, clientId, wf);
  const conv = await getOrCreateConversation(tenantId, wf, `ref-${randomUUID().slice(0, 8)}`);
  return conv.id;
}
const setMode = (tenantId: string, id: string, mode: string) =>
  query(`UPDATE conversations SET mode = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, id, mode]);

test('module lifecycle: absent → disabled; enable → one row; re-enable is idempotent; disable keeps the row + settings', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);

  assert.equal(await isClientModuleEnabled(s.tenantId, s.clientId, 'inbox'), false, 'no row → disabled');

  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: true, settings: { theme: 'x' } });
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: true });
  const rows = (await listClientModules(s.tenantId, s.clientId)).filter((r) => r.module_key === 'inbox');
  assert.equal(rows.length, 1, 'exactly one inbox row (no duplicates)');
  assert.equal(await isClientModuleEnabled(s.tenantId, s.clientId, 'inbox'), true);

  const res = await disableInboxIfIdle(s.tenantId, s.clientId);
  assert.equal(res.ok, true, 'idle client disables');
  const after1 = (await listClientModules(s.tenantId, s.clientId)).filter((r) => r.module_key === 'inbox');
  assert.equal(after1.length, 1, 'row preserved (not deleted)');
  assert.equal(after1[0].enabled, false);
  assert.deepEqual(after1[0].settings, { theme: 'x' }, 'settings survive the off cycle');
});

test('backfill predicate enables non-default clients and NEVER the default', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  // Run the migration's exact backfill INSERT for this tenant's clients.
  await query(
    `INSERT INTO client_modules (tenant_id, client_id, module_key)
     SELECT c.tenant_id, c.id, 'inbox' FROM clients c WHERE c.is_default = false AND c.tenant_id = $1
     ON CONFLICT (tenant_id, client_id, module_key) DO NOTHING`,
    [s.tenantId],
  );
  assert.equal(await isClientModuleEnabled(s.tenantId, s.clientId, 'inbox'), true, 'non-default A enabled');
  assert.equal(await isClientModuleEnabled(s.tenantId, s.otherClientId, 'inbox'), true, 'non-default B enabled');
  assert.equal(await isClientModuleEnabled(s.tenantId, s.defaultClientId, 'inbox'), false, 'Unassigned NOT enabled');
});

test('disable is blocked while pending/human conversations exist, allowed when all bot', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: true });

  const conv = await seedConversation(s.tenantId, s.clientId, 'wf-a');

  await setMode(s.tenantId, conv, 'pending');
  const p = await disableInboxIfIdle(s.tenantId, s.clientId);
  assert.equal(p.ok, false);
  if (!p.ok) assert.equal(p.reason, 'active_conversations');

  await setMode(s.tenantId, conv, 'human');
  const h = await disableInboxIfIdle(s.tenantId, s.clientId);
  assert.equal(h.ok, false, 'human also blocks');

  await setMode(s.tenantId, conv, 'bot');
  const b = await disableInboxIfIdle(s.tenantId, s.clientId);
  assert.equal(b.ok, true, 'all bot → disable succeeds');
  assert.equal(await isClientModuleEnabled(s.tenantId, s.clientId, 'inbox'), false);
});

test('race-safety (both interleavings): a disable + a new escalation never leave an active handoff with inbox disabled', async () => {
  // Order A: disable commits first → the escalation is refused (no pending created).
  const a = await seedScenario();
  tenants.push(a.tenantId);
  await setClientModuleEnabled({ tenantId: a.tenantId, clientId: a.clientId, moduleKey: 'inbox', enabled: true });
  const convA = await seedConversation(a.tenantId, a.clientId, 'wf-a');
  assert.equal((await disableInboxIfIdle(a.tenantId, a.clientId)).ok, true);
  await assert.rejects(
    () => transitionMode(a.tenantId, convA, 'pending', { source: 'workflow', inboxGate: { clientId: a.clientId } }),
    (e: unknown) => e instanceof ModuleDisabledError,
    'escalation after disable → ModuleDisabledError',
  );
  assert.equal((await query<{ mode: string }>(`SELECT mode FROM conversations WHERE id = $1`, [convA])).rows[0].mode, 'bot', 'no pending created');

  // Order B: the escalation commits first → the disable is then blocked.
  const b = await seedScenario();
  tenants.push(b.tenantId);
  await setClientModuleEnabled({ tenantId: b.tenantId, clientId: b.clientId, moduleKey: 'inbox', enabled: true });
  const convB = await seedConversation(b.tenantId, b.clientId, 'wf-b');
  const r = await transitionMode(b.tenantId, convB, 'pending', { source: 'workflow', inboxGate: { clientId: b.clientId } });
  assert.equal(r.changed, true, 'escalation succeeds while enabled');
  assert.equal((await disableInboxIfIdle(b.tenantId, b.clientId)).ok, false, 'disable now blocked by the new pending');
  assert.equal(await isClientModuleEnabled(b.tenantId, b.clientId, 'inbox'), true, 'inbox stays enabled');
});

test('per-(tenant,client) isolation: enabling A never enables B or another tenant', async () => {
  const s = await seedScenario();
  const other = await seedScenario();
  tenants.push(s.tenantId, other.tenantId);
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: true });

  assert.equal(await isClientModuleEnabled(s.tenantId, s.clientId, 'inbox'), true);
  assert.equal(await isClientModuleEnabled(s.tenantId, s.otherClientId, 'inbox'), false, 'sibling client unaffected');
  assert.equal(await isClientModuleEnabled(other.tenantId, other.clientId, 'inbox'), false, 'other tenant unaffected');

  // Transactional gate agrees.
  await withTransaction(async (c) => {
    assert.equal(await isInboxEnabledForUpdate(c, s.tenantId, s.clientId), true);
    assert.equal(await isInboxEnabledForUpdate(c, s.tenantId, s.otherClientId), false);
  });
});

test('disabling never deletes conversations or messages; re-enabling restores access', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: true });
  const conv = await seedConversation(s.tenantId, s.clientId, 'wf-a'); // bot
  await insertMessage({ tenantId: s.tenantId, conversationId: conv, sender: 'bot', text: 'hi', status: 'received', occurredAt: new Date() });

  assert.equal((await disableInboxIfIdle(s.tenantId, s.clientId)).ok, true);
  // Data intact after disable.
  assert.equal((await query(`SELECT 1 FROM conversations WHERE id = $1`, [conv])).rowCount, 1, 'conversation kept');
  assert.equal((await query(`SELECT 1 FROM handoff_messages WHERE conversation_id = $1`, [conv])).rowCount, 1, 'message kept');

  // Re-enable → access restored, data still there.
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: true });
  assert.equal(await isClientModuleEnabled(s.tenantId, s.clientId, 'inbox'), true);
  assert.equal((await query(`SELECT 1 FROM handoff_messages WHERE conversation_id = $1`, [conv])).rowCount, 1, 'history restored');
});
