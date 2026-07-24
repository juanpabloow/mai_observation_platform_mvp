import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { listWorkflowsWithClientForTenant } from '../../src/db/repositories/workflows.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * Final-design Workflows page / header switcher data isolation. Both surfaces list
 * `listWorkflowsWithClientForTenant(tenant)` filtered to ONE client
 * (`w.client_id === client.id`). These tests prove that filter yields exactly the
 * target client's workflows and never another client's (same tenant) or another
 * tenant's — so a member can never receive a foreign client's workflow ids/names.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

/** Give a seeded workflow an active flag + display name (the page shows both). */
async function setWorkflowMeta(
  tenantId: string,
  n8nWorkflowId: string,
  name: string,
  active: boolean,
): Promise<void> {
  await query(`UPDATE workflows SET name = $3, active = $4 WHERE tenant_id = $1 AND n8n_workflow_id = $2`, [
    tenantId,
    n8nWorkflowId,
    name,
    active,
  ]);
}

test('the per-client workflow filter returns ONLY that client\'s workflows', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);

  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, 'wf-a1');
  await seedWorkflow(s.tenantId, s.clientId, 'wf-a2', connectionId);
  await seedWorkflow(s.tenantId, s.otherClientId, 'wf-b1', connectionId);
  await setWorkflowMeta(s.tenantId, 'wf-a1', 'Alpha', true);
  await setWorkflowMeta(s.tenantId, 'wf-a2', 'Beta', false);
  await setWorkflowMeta(s.tenantId, 'wf-b1', 'Foreign', true);

  const all = await listWorkflowsWithClientForTenant(s.tenantId);
  const forClientA = all.filter((w) => w.client_id === s.clientId);
  assert.deepEqual(
    forClientA.map((w) => w.n8n_workflow_id).sort(),
    ['wf-a1', 'wf-a2'],
    'client A sees exactly its two workflows',
  );
  assert.ok(!forClientA.some((w) => w.n8n_workflow_id === 'wf-b1'), "client B's workflow is excluded");
  // The active flag + name the list renders survive the round-trip.
  const alpha = forClientA.find((w) => w.n8n_workflow_id === 'wf-a1');
  assert.equal(alpha?.active, true);
  assert.equal(alpha?.name, 'Alpha');
});

test('another tenant\'s workflows never appear in this tenant\'s list', async () => {
  const s = await seedScenario();
  const s2 = await seedScenario();
  tenants.push(s.tenantId, s2.tenantId);

  await seedWorkflow(s.tenantId, s.clientId, 'wf-own');
  await seedWorkflow(s2.tenantId, s2.clientId, 'wf-own'); // same n8n id, other tenant

  const mine = await listWorkflowsWithClientForTenant(s.tenantId);
  assert.equal(mine.length, 1, 'only this tenant\'s single workflow');
  assert.equal(mine[0].client_id, s.clientId, 'and it belongs to this tenant\'s client');
});
