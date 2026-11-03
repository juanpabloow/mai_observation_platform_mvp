import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { encrypt } from '../../src/crypto.js';
import { syncOpenAiForTenant } from '../../src/analytics/syncOpenAi.js';
import {
  getOpenAiConnectionStatus,
  listBilledDays,
  listBilledModels,
  listClientProjectMap,
  listOpenAiConnectionsDue,
  listOpenAiProjects,
  setClientOpenAiProject,
  upsertOpenAiConnection,
} from '../../src/db/repositories/openaiBilling.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

/**
 * COSTOS DE IA — OpenAI billing sync against a real schema, with OpenAI itself faked (no network,
 * no real key). Proves: encrypted key round-trip, window replacement (re-sync does not duplicate),
 * tenant isolation, error state + attempt time (no retry storm), and the screen's reads.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const NOW = new Date('2026-11-03T15:00:00Z');
const D = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

function fakeOpenAi(amountByDay: Record<string, number>) {
  return (async (input: URL | RequestInfo) => {
    const url = String(input);
    const days = Object.keys(amountByDay);
    if (url.includes('/organization/costs')) {
      return Response.json({
        object: 'page',
        data: days.map((d) => ({ start_time: D(d), results: [{ amount: { value: amountByDay[d], currency: 'usd' }, line_item: 'gpt-5.6-terra, output', project_id: 'proj_1' }] })),
        has_more: false,
      });
    }
    return Response.json({
      object: 'page',
      data: days.map((d) => ({ start_time: D(d), results: [{ input_tokens: 1000, input_cached_tokens: 250, output_tokens: 300, num_model_requests: 4, model: 'gpt-5.6-terra', project_id: 'proj_1' }] })),
      has_more: false,
    });
  }) as typeof fetch;
}

test('sync stores what OpenAI billed, replaces its window, and records failures without hammering', async () => {
  const s = await seedScenario();
  const other = await seedScenario();
  tenants.push(s.tenantId, other.tenantId);
  await upsertOpenAiConnection({ tenantId: s.tenantId, keyEncrypted: encrypt('sk-admin-' + 'x'.repeat(40)), keyHint: 'xxxx', userId: null });

  const ok = await syncOpenAiForTenant(s.tenantId, NOW, fakeOpenAi({ '2026-11-01': 1.5, '2026-11-02': 2.25 }));
  assert.deepEqual(ok, { ok: true, costs: 2, usage: 2, skipped: 0 });
  // Re-sync with new numbers for the same days: replaced, not added.
  await syncOpenAiForTenant(s.tenantId, NOW, fakeOpenAi({ '2026-11-01': 1.75, '2026-11-02': 2.25 }));
  const days = await listBilledDays(s.tenantId, '2026-10-01', '2026-11-03');
  assert.deepEqual(days, [
    { day: '2026-11-01', amount_usd: 1.75 },
    { day: '2026-11-02', amount_usd: 2.25 },
  ]);
  const models = await listBilledModels(s.tenantId, '2026-10-01', '2026-11-03');
  assert.deepEqual(models, [{ model: 'gpt-5.6-terra', requests: 8, input_tokens: 2000, cached_input_tokens: 500, output_tokens: 600 }]);
  assert.deepEqual(await listBilledDays(other.tenantId, '2026-10-01', '2026-11-03'), [], 'another tenant sees nothing');

  const status = await getOpenAiConnectionStatus(s.tenantId);
  assert.equal(status?.key_hint, 'xxxx');
  assert.ok(status?.last_synced_at);
  const stored = await query<{ k: string }>(`SELECT admin_key_encrypted AS k FROM openai_connections WHERE tenant_id = $1`, [s.tenantId]);
  assert.ok(!stored.rows[0].k.includes('sk-admin'), 'the key is stored encrypted');

  // A rejected key: error recorded, last good data kept, and not "due" again right away.
  const denied = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  const bad = await syncOpenAiForTenant(s.tenantId, NOW, denied);
  assert.equal(bad.ok, false);
  assert.match((await getOpenAiConnectionStatus(s.tenantId))?.last_sync_error ?? '', /rechazó la clave/);
  assert.equal((await listBilledDays(s.tenantId, '2026-10-01', '2026-11-03')).length, 2, 'a failed sync keeps the stored figures');
  assert.ok(!(await listOpenAiConnectionsDue(6 * 3600_000)).includes(s.tenantId), 'a failed attempt waits like a good one');
});

test('project → business: one project per business, moved not duplicated, never on the default client', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  await query(`INSERT INTO openai_projects (tenant_id, project_id, name, status) VALUES ($1, 'proj_g', 'Gallery', 'active'), ($1, 'proj_d', 'Default project', 'active')`, [s.tenantId]);

  assert.equal(await setClientOpenAiProject({ tenantId: s.tenantId, clientId: s.clientId, projectId: 'proj_g' }), true);
  // Assigning the same project to another business MOVES it.
  assert.equal(await setClientOpenAiProject({ tenantId: s.tenantId, clientId: s.otherClientId, projectId: 'proj_g' }), true);
  const projects = await listOpenAiProjects(s.tenantId);
  assert.deepEqual(projects.map((p) => [p.name, p.client_id]), [
    ['Default project', null],
    ['Gallery', s.otherClientId],
  ]);
  assert.deepEqual(await listClientProjectMap(s.tenantId), [{ client_id: s.otherClientId, openai_project_id: 'proj_g' }]);
  assert.equal(await setClientOpenAiProject({ tenantId: s.tenantId, clientId: s.defaultClientId, projectId: 'proj_d' }), false, 'the default client has no project');
  assert.equal(await setClientOpenAiProject({ tenantId: s.tenantId, clientId: s.otherClientId, projectId: null }), true);
  assert.deepEqual(await listClientProjectMap(s.tenantId), []);
});
