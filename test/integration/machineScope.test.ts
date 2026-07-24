import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { resolveMachineSchedulingScope } from '../../src/scheduling/machineScope.js';
import { resolveWorkflowForConnection } from '../../src/db/repositories/workflows.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { cleanupTenant, closeDb, reassignWorkflow, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * The machine-API scheduling scope core (resolveMachineSchedulingScope) — the
 * PostgreSQL-backed security chain every /api/scheduling/v1/* call runs after
 * Bearer auth:
 *   (tenantId, connectionId, X-Workflow-Ref) → workflow of THAT connection
 *   → client_id → non-default → scheduling enabled.
 * Tested directly (no Next handlers) so the guarantees are real, not simulated.
 */

const tenants: string[] = [];
async function scenario(opts = {}) {
  const s = await seedScenario(opts);
  tenants.push(s.tenantId);
  return s;
}

after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

test('correct workflow of the connection → its client (non-default, scheduling on)', async () => {
  const s = await scenario({ enableScheduling: true });
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, 'wf-1');
  const r = await resolveMachineSchedulingScope({ tenantId: s.tenantId, connectionId, workflowRef: 'wf-1' });
  assert.ok(r.ok);
  assert.equal(r.clientId, s.clientId);
  assert.equal(r.workflowRef, 'wf-1');
});

test('workflow of ANOTHER connection (same tenant) → workflow_not_found', async () => {
  const s = await scenario({ enableScheduling: true });
  await seedWorkflow(s.tenantId, s.clientId, 'wf-1'); // connection A
  const { connectionId: connB } = await seedWorkflow(s.tenantId, s.otherClientId, 'wf-2'); // connection B
  // Ask for wf-1 (connection A) using connection B's id.
  const r = await resolveMachineSchedulingScope({ tenantId: s.tenantId, connectionId: connB, workflowRef: 'wf-1' });
  assert.ok(!r.ok && r.reason === 'workflow_not_found');
});

test('workflow of ANOTHER tenant → workflow_not_found', async () => {
  const a = await scenario({ enableScheduling: true });
  const b = await scenario({ enableScheduling: true });
  const { connectionId: connA } = await seedWorkflow(a.tenantId, a.clientId, 'wf-A');
  await seedWorkflow(b.tenantId, b.clientId, 'wf-B');
  // Tenant B's workflow ref, but tenant A's tenantId+connection → not found.
  const r = await resolveMachineSchedulingScope({ tenantId: a.tenantId, connectionId: connA, workflowRef: 'wf-B' });
  assert.ok(!r.ok && r.reason === 'workflow_not_found');
});

test('nonexistent workflow ref → workflow_not_found', async () => {
  const s = await scenario({ enableScheduling: true });
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, 'wf-1');
  const r = await resolveMachineSchedulingScope({ tenantId: s.tenantId, connectionId, workflowRef: 'nope' });
  assert.ok(!r.ok && r.reason === 'workflow_not_found');
});

test('workflow assigned to the DEFAULT client → module_disabled', async () => {
  const s = await scenario({ enableScheduling: true });
  const { connectionId } = await seedWorkflow(s.tenantId, s.defaultClientId, 'wf-def');
  const r = await resolveMachineSchedulingScope({ tenantId: s.tenantId, connectionId, workflowRef: 'wf-def' });
  assert.ok(!r.ok && r.reason === 'module_disabled', 'default client is never bookable');
});

test('scheduling ABSENT for the workflow client → module_disabled', async () => {
  const s = await scenario(); // modules OFF
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, 'wf-1');
  const r = await resolveMachineSchedulingScope({ tenantId: s.tenantId, connectionId, workflowRef: 'wf-1' });
  assert.ok(!r.ok && r.reason === 'module_disabled');
});

test('scheduling enabled → ok; disabling again → rejected; re-enable → ok', async () => {
  const s = await scenario(); // start OFF
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, 'wf-1');
  const params = { tenantId: s.tenantId, connectionId, workflowRef: 'wf-1' };

  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'scheduling', enabled: true });
  assert.ok((await resolveMachineSchedulingScope(params)).ok);

  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'scheduling', enabled: false });
  const off = await resolveMachineSchedulingScope(params);
  assert.ok(!off.ok && off.reason === 'module_disabled');

  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'scheduling', enabled: true });
  assert.ok((await resolveMachineSchedulingScope(params)).ok);
});

test('reassigning the workflow to another client changes the resolved scope', async () => {
  const s = await scenario({ enableScheduling: true });
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, 'wf-move');
  const params = { tenantId: s.tenantId, connectionId, workflowRef: 'wf-move' };

  const before = await resolveMachineSchedulingScope(params);
  assert.ok(before.ok && before.clientId === s.clientId);

  await reassignWorkflow(s.tenantId, 'wf-move', s.otherClientId);
  const after = await resolveMachineSchedulingScope(params);
  assert.ok(after.ok && after.clientId === s.otherClientId, 'scope follows the workflow to its new client');
});

test('resolveWorkflowForConnection requires tenant AND connection AND ref together', async () => {
  const s = await scenario();
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, 'wf-1');
  // Right triple resolves; wrong connection/tenant/ref → null.
  assert.ok(await resolveWorkflowForConnection(s.tenantId, connectionId, 'wf-1'));
  assert.equal(await resolveWorkflowForConnection(s.tenantId, connectionId, 'other'), null);
  assert.equal(await resolveWorkflowForConnection(s.otherClientId, connectionId, 'wf-1'), null); // bogus tenant
});
