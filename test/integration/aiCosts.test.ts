import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { deriveLlmUsageForExecutionIds, backfillLlmUsage } from '../../src/analytics/deriveLlmUsage.js';
import { listAiClientActivity, listAiCoverage, listAiUsageRows } from '../../src/db/repositories/llmUsage.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * COSTOS DE IA — derivation from stored executions + the screen's reads, against a real schema.
 * Synthetic payloads only: no message content is needed, and none is stored by the feature.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const lm = (prompt: number, completion: number, model = 'gpt-5.6-terra') => ({
  data: { ai_languageModel: [[{ json: { tokenUsageEstimate: { promptTokens: prompt, completionTokens: completion } } }]] },
  inputOverride: { ai_languageModel: [[{ json: { options: { model } } }]] },
});

async function insertExecution(tenantId: string, connectionId: string, wf: string, startedAt: string, raw: unknown) {
  const r = await query<{ id: string }>(
    `INSERT INTO executions (tenant_id, n8n_connection_id, n8n_execution_id, n8n_workflow_id, status, started_at, raw_data)
     VALUES ($1, $2, $3, $4, 'success', $5, $6) RETURNING id`,
    [tenantId, connectionId, randomUUID(), wf, startedAt, raw === null ? null : JSON.stringify(raw)],
  );
  return r.rows[0].id;
}

test('derive on ingest: per-client usage, idempotent, coverage tells unknown from zero, tenant-isolated', async () => {
  const s = await seedScenario();
  const other = await seedScenario();
  tenants.push(s.tenantId, other.tenantId);
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, 'wf-bot-a');
  await seedWorkflow(s.tenantId, s.otherClientId, 'wf-bot-b', connectionId);
  const { connectionId: otherConn } = await seedWorkflow(other.tenantId, other.clientId, 'wf-foreign');

  const at = '2026-10-10T15:00:00Z';
  const a1 = await insertExecution(s.tenantId, connectionId, 'wf-bot-a', at, {
    resultData: { runData: { 'OpenAI Chat Model': [lm(1000, 100), lm(2000, 50)], Trigger: [{ data: { main: [[{ json: {} }]] } }] } },
  });
  const a2 = await insertExecution(s.tenantId, connectionId, 'wf-bot-a', at, null); // n8n kept no data
  const b1 = await insertExecution(s.tenantId, connectionId, 'wf-bot-b', at, {
    resultData: { runData: { M: [lm(10, 1, 'modelo-sin-precio')] } },
  });
  const f1 = await insertExecution(other.tenantId, otherConn, 'wf-foreign', at, {
    resultData: { runData: { M: [lm(999, 999)] } },
  });

  // Only the caller's tenant ids are read, even if a foreign id slips into the list.
  const counts = await deriveLlmUsageForExecutionIds({ tenantId: s.tenantId, executionIds: [a1, a2, b1, f1] });
  assert.deepEqual(counts, { processed: 3, withCalls: 2, withoutData: 1, errors: 0 });
  // Re-deriving yields the same rows (replace, not append).
  await deriveLlmUsageForExecutionIds({ tenantId: s.tenantId, executionIds: [a1] });

  const period = { tenantId: s.tenantId, from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z'), timeZone: 'America/Bogota' };
  const rows = await listAiUsageRows(period);
  const a = rows.find((r) => r.n8n_workflow_id === 'wf-bot-a');
  assert.ok(a);
  assert.equal(a.client_id, s.clientId);
  assert.equal(a.client_name, 'Business A');
  assert.equal(a.model, 'gpt-5.6-terra');
  assert.equal(a.usage_source, 'estimate');
  assert.equal(a.day, '2026-10-10');
  assert.deepEqual([a.executions, a.calls, a.input_tokens, a.output_tokens], [1, 2, 3000, 150]);
  assert.equal(rows.find((r) => r.n8n_workflow_id === 'wf-bot-b')?.client_id, s.otherClientId);
  assert.ok(!rows.some((r) => r.n8n_workflow_id === 'wf-foreign'), 'another tenant never shows');

  const unscanned = await insertExecution(s.tenantId, connectionId, 'wf-bot-a', at, { resultData: { runData: {} } });
  const coverage = await listAiCoverage(period);
  assert.deepEqual(coverage.find((c) => c.n8n_workflow_id === 'wf-bot-a'), {
    n8n_workflow_id: 'wf-bot-a', total: 3, scanned: 2, without_data: 1,
  });

  // The backfill picks up only what was never scanned, and the other tenant's execution too.
  const before = await query<{ n: number }>('SELECT count(*)::int AS n FROM execution_llm_scans WHERE execution_id = ANY($1::uuid[])', [[unscanned, f1]]);
  assert.equal(before.rows[0].n, 0);
  await backfillLlmUsage({ rescan: false });
  const scanned = await query<{ n: number }>('SELECT count(*)::int AS n FROM execution_llm_scans WHERE execution_id = ANY($1::uuid[])', [[unscanned, f1]]);
  assert.equal(scanned.rows[0].n, 2);
  assert.ok(!(await listAiUsageRows(period)).some((r) => r.n8n_workflow_id === 'wf-foreign'));
});

test('client activity: conversations with customer messages and appointments booked by the bot', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  await seedWorkflow(s.tenantId, s.clientId, 'wf-chat');
  const conv = await query<{ id: string }>(
    `INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref) VALUES ($1, 'wf-chat', 'ref-1') RETURNING id`,
    [s.tenantId],
  );
  for (const sender of ['user', 'user', 'bot']) {
    await query(
      `INSERT INTO handoff_messages (tenant_id, conversation_id, sender, text, status, occurred_at, created_at)
       VALUES ($1, $2, $3, 'sintético', $4, '2026-10-10T15:00:00Z', '2026-10-10T15:00:00Z')`,
      [s.tenantId, conv.rows[0].id, sender, sender === 'user' ? 'received' : 'sent'],
    );
  }
  const period = { tenantId: s.tenantId, from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z'), timeZone: 'America/Bogota' };
  const act = await listAiClientActivity(period);
  assert.deepEqual(act, [{ client_id: s.clientId, conversations: 1, bot_appointments: 0 }]);
});
