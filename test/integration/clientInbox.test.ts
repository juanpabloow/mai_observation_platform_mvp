import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import {
  countPendingForClient,
  getConversationForClient,
  listConversationsForClient,
} from '../../src/db/repositories/handoff.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * Phase 4A — the CLIENT-level UNIFIED inbox reads. listConversationsForClient must
 * gather the live/handoff conversations of ALL a client's canonical workflows into
 * ONE tray, while excluding every OTHER client (same tenant) and every OTHER tenant
 * at the SQL layer. countPendingForClient (the aggregated badge) and
 * getConversationForClient (the drawer / direct-URL guard) enforce the same isolation.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const ref = (): string => `ref-${randomUUID().slice(0, 8)}`;

/** Insert a conversation row on a workflow, with an explicit mode. */
async function seedConversation(
  tenantId: string,
  n8nWorkflowId: string,
  mode: 'bot' | 'pending' | 'human',
): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref, mode, last_message_at)
       VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [tenantId, n8nWorkflowId, ref(), mode],
  );
  return r.rows[0].id;
}

test('the client tray unifies ALL the client\'s workflows and excludes other clients + tenants', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);

  // Two workflows under client A (share one connection), one under client B.
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, 'wf-A1');
  await seedWorkflow(s.tenantId, s.clientId, 'wf-A2', connectionId);
  await seedWorkflow(s.tenantId, s.otherClientId, 'wf-B1', connectionId);

  const a1 = await seedConversation(s.tenantId, 'wf-A1', 'bot');
  const a2 = await seedConversation(s.tenantId, 'wf-A2', 'human');
  const bConv = await seedConversation(s.tenantId, 'wf-B1', 'pending');

  // A SECOND tenant with its own client + workflow + conversation.
  const s2 = await seedScenario();
  tenants.push(s2.tenantId);
  await seedWorkflow(s2.tenantId, s2.clientId, 'wf-A1'); // same n8n id, different tenant
  await seedConversation(s2.tenantId, 'wf-A1', 'bot');

  const list = await listConversationsForClient(s.tenantId, s.clientId);
  const ids = list.map((r) => r.id).sort();
  assert.deepEqual(ids, [a1, a2].sort(), 'exactly client A\'s two conversations, across both its workflows');

  // Both client-A workflows are represented, and each row carries its workflow name.
  assert.deepEqual(
    [...new Set(list.map((r) => r.n8n_workflow_id))].sort(),
    ['wf-A1', 'wf-A2'],
    'conversations from BOTH of the client\'s workflows appear in the one tray',
  );
  for (const row of list) assert.ok(row.workflow_name, 'each conversation keeps its workflow association (name)');

  // Client B's conversation and the other tenant's conversation never leak in.
  assert.ok(!ids.includes(bConv), 'another client\'s conversation is excluded (same tenant)');
});

test('countPendingForClient counts ONLY this client\'s pending conversations', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  await seedWorkflow(s.tenantId, s.clientId, 'wf-A');
  await seedWorkflow(s.tenantId, s.otherClientId, 'wf-B');

  await seedConversation(s.tenantId, 'wf-A', 'bot');
  await seedConversation(s.tenantId, 'wf-A', 'human');
  await seedConversation(s.tenantId, 'wf-A', 'pending'); // the only client-A pending
  await seedConversation(s.tenantId, 'wf-B', 'pending'); // client B — must NOT count

  assert.equal(await countPendingForClient(s.tenantId, s.clientId), 1, 'only client A\'s single pending');
  assert.equal(await countPendingForClient(s.tenantId, s.otherClientId), 1, 'client B counts its own only');
});

test('getConversationForClient refuses a cross-client conversation (direct-URL probe → not found)', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  await seedWorkflow(s.tenantId, s.clientId, 'wf-A');
  await seedWorkflow(s.tenantId, s.otherClientId, 'wf-B');

  const aConv = await seedConversation(s.tenantId, 'wf-A', 'pending');
  const bConv = await seedConversation(s.tenantId, 'wf-B', 'pending');

  // Positive controls: each conversation resolves under its OWN client.
  assert.ok(await getConversationForClient(s.tenantId, s.clientId, aConv), 'own conversation resolves');
  assert.ok(await getConversationForClient(s.tenantId, s.otherClientId, bConv), 'B\'s resolves for B');

  // Cross-client: client A asking for client B's conversation id → null (→ caller 404s).
  assert.equal(
    await getConversationForClient(s.tenantId, s.clientId, bConv),
    null,
    'client A can never open client B\'s conversation',
  );
});
