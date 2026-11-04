import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import {
  countProductionExecutions,
  listConnectionPlans,
  listExecutionDays,
  listExecutionEndings,
  listExecutionUsage,
  setConnectionPlan,
} from '../../src/db/repositories/n8nExecutionsUsage.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * COSTOS DE IA → Ejecuciones — the screen's reads against a real schema: categories (with AI,
 * error, unknown, the rest), manual runs apart, the business filter, tenant isolation, and the
 * plan columns (tenant-scoped update, CHECK limits).
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

async function exec(
  tenantId: string,
  connectionId: string,
  wf: string,
  o: { at?: string; status?: string; mode?: string; calls?: number | null; hasData?: boolean; lastNode?: string } = {},
) {
  const r = await query<{ id: string }>(
    `INSERT INTO executions (tenant_id, n8n_connection_id, n8n_execution_id, n8n_workflow_id, status, mode, started_at, raw_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      tenantId,
      connectionId,
      randomUUID(),
      wf,
      o.status ?? 'success',
      o.mode ?? 'webhook',
      o.at ?? '2026-10-10T15:00:00Z',
      JSON.stringify({ resultData: { lastNodeExecuted: o.lastNode ?? 'Respond' } }),
    ],
  );
  const id = r.rows[0].id;
  if (o.calls !== null && o.calls !== undefined) {
    await query(`INSERT INTO execution_llm_scans (execution_id, tenant_id, has_run_data, llm_calls) VALUES ($1, $2, $3, $4)`, [
      id,
      tenantId,
      o.hasData ?? true,
      o.calls,
    ]);
  }
  return id;
}

test('days by category, manual apart, business filter, endings, tenant-isolated', async () => {
  const s = await seedScenario();
  const other = await seedScenario();
  tenants.push(s.tenantId, other.tenantId);
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, 'wf-a');
  await seedWorkflow(s.tenantId, s.otherClientId, 'wf-b', connectionId);
  const { connectionId: otherConn } = await seedWorkflow(other.tenantId, other.clientId, 'wf-x');

  await exec(s.tenantId, connectionId, 'wf-a', { calls: 2, lastNode: 'Send reply' }); // with AI
  await exec(s.tenantId, connectionId, 'wf-a', { calls: 0, lastNode: 'Is status?' }); // no AI
  await exec(s.tenantId, connectionId, 'wf-a', { calls: 0, lastNode: 'Is status?' }); // no AI
  await exec(s.tenantId, connectionId, 'wf-a', { status: 'error', calls: 0 }); // error
  await exec(s.tenantId, connectionId, 'wf-a', { calls: null }); // not read yet
  await exec(s.tenantId, connectionId, 'wf-a', { calls: 0, hasData: false }); // n8n kept nothing
  await exec(s.tenantId, connectionId, 'wf-a', { mode: 'manual', calls: 1 }); // editor test
  await exec(s.tenantId, connectionId, 'wf-b', { calls: 1, at: '2026-10-11T15:00:00Z' });
  await exec(other.tenantId, otherConn, 'wf-x', { calls: 1 }); // another tenant

  const period = { tenantId: s.tenantId, from: new Date('2026-10-01T05:00:00Z'), to: new Date('2026-11-01T05:00:00Z'), timeZone: 'America/Bogota' };
  assert.deepEqual(await listExecutionDays(period), [
    { day: '2026-10-10', production: 6, manual: 1, with_ai: 1, errors: 1, unread: 2, duration_ms_sum: 0, duration_n: 0 },
    { day: '2026-10-11', production: 1, manual: 0, with_ai: 1, errors: 0, unread: 0, duration_ms_sum: 0, duration_n: 0 },
  ]);
  assert.deepEqual(await listExecutionDays({ ...period, clientId: s.otherClientId }), [
    { day: '2026-10-11', production: 1, manual: 0, with_ai: 1, errors: 0, unread: 0, duration_ms_sum: 0, duration_n: 0 },
  ]);

  const byClient = await listExecutionUsage(period, 'client');
  assert.deepEqual(
    byClient.map((c) => [c.day, c.key, c.name, c.production, c.with_ai, c.unread]),
    [
      ['2026-10-10', s.clientId, 'Business A', 6, 1, 2],
      ['2026-10-11', s.otherClientId, 'Business B', 1, 1, 0],
    ],
  );
  const byWorkflow = await listExecutionUsage({ ...period, clientId: s.clientId }, 'workflow');
  assert.deepEqual(
    byWorkflow.map((w) => [w.key, w.name, w.production]),
    [[`${connectionId}:wf-a`, 'wf-a', 6]],
    'a business sees only its own workflows; manual runs are not counted',
  );

  const endings = await listExecutionEndings(period);
  const statusEnd = endings.find((e) => e.last_node === 'Is status?');
  assert.equal(statusEnd?.executions, 2);
  assert.equal(statusEnd?.client_name, 'Business A');
  assert.ok(endings.some((e) => e.manual), 'manual runs are listed apart');
  assert.ok(!endings.some((e) => e.workflow === 'wf-x'), 'another tenant never shows');
  assert.equal((await listExecutionEndings({ ...period, clientId: s.otherClientId })).length, 1);

  assert.equal(await countProductionExecutions(s.tenantId, connectionId, new Date('2026-10-01T00:00:00Z')), 7);
  assert.equal(await countProductionExecutions(other.tenantId, connectionId, new Date('2026-10-01T00:00:00Z')), 0);
});

test('plan: saved per connection of the tenant only, limits enforced by the schema', async () => {
  const s = await seedScenario();
  const other = await seedScenario();
  tenants.push(s.tenantId, other.tenantId);
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, 'wf-a');

  assert.equal(await setConnectionPlan({ tenantId: other.tenantId, connectionId, monthlyExecutions: 1, resetDay: 1 }), false, 'another tenant cannot change it');
  assert.equal(await setConnectionPlan({ tenantId: s.tenantId, connectionId, monthlyExecutions: 8000, resetDay: 15 }), true);
  const plans = await listConnectionPlans(s.tenantId);
  assert.deepEqual(
    plans.filter((p) => p.id === connectionId).map((p) => [p.plan_monthly_executions, p.plan_reset_day]),
    [[8000, 15]],
  );
  await assert.rejects(setConnectionPlan({ tenantId: s.tenantId, connectionId, monthlyExecutions: 8000, resetDay: 31 }), /plan_reset_day_check/);
  assert.equal(await setConnectionPlan({ tenantId: s.tenantId, connectionId, monthlyExecutions: null, resetDay: null }), true);
});
