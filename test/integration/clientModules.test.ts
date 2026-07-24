import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import {
  isClientModuleEnabled,
  listClientModules,
  listClientModulesForTenant,
  setClientModuleEnabled,
} from '../../src/db/repositories/clientModules.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

/**
 * client_modules (Phase 1 of the modular system): per-client enablement with
 * tenant isolation, upsert semantics, settings preservation, cascade, and the
 * DB-level CHECKs. Uses the shared per-test tenant fixtures (a fresh tenant per
 * scenario → no cross-test interference).
 */

const tenants: string[] = [];
async function scenario() {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  return s;
}

after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

test('#1 no row → isClientModuleEnabled returns false', async () => {
  const s = await scenario();
  assert.equal(await isClientModuleEnabled(s.tenantId, s.otherClientId, 'crm'), false);
  assert.equal(await isClientModuleEnabled(s.tenantId, s.otherClientId, 'scheduling'), false);
});

test('#2 + #3 crm and scheduling can each be enabled', async () => {
  const s = await scenario();
  const crm = await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'crm', enabled: true });
  const sched = await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'scheduling', enabled: true });
  assert.ok(crm && crm.enabled && crm.module_key === 'crm');
  assert.ok(sched && sched.enabled && sched.module_key === 'scheduling');
  assert.equal(await isClientModuleEnabled(s.tenantId, s.clientId, 'crm'), true);
  assert.equal(await isClientModuleEnabled(s.tenantId, s.clientId, 'scheduling'), true);
});

test('#4 an enabled module appears when listing the client\'s modules', async () => {
  const s = await scenario();
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'crm', enabled: true });
  const rows = await listClientModules(s.tenantId, s.clientId);
  assert.ok(rows.some((r) => r.module_key === 'crm' && r.enabled));
});

test('#5 disabling updates the SAME row (no duplicates, row survives)', async () => {
  const s = await scenario();
  const created = await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'crm', enabled: true });
  const disabled = await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'crm', enabled: false });
  assert.ok(created && disabled);
  assert.equal(disabled.id, created.id, 'same row updated');
  assert.equal(disabled.enabled, false);
  assert.equal(await isClientModuleEnabled(s.tenantId, s.clientId, 'crm'), false);
  const count = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM client_modules WHERE tenant_id = $1 AND client_id = $2 AND module_key = 'crm'`,
    [s.tenantId, s.clientId],
  );
  assert.equal(count.rows[0].n, 1, 'exactly one row');
});

test('#6 settings survive an enabled-only toggle; supplied settings replace', async () => {
  const s = await scenario();
  await setClientModuleEnabled({
    tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'scheduling', enabled: true,
    settings: { default_view: 'day', reminder_min: 60 },
  });
  // Toggle enabled WITHOUT settings → settings preserved.
  const off = await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'scheduling', enabled: false });
  assert.ok(off);
  assert.deepEqual(off.settings, { default_view: 'day', reminder_min: 60 });
  // Supplying settings replaces them.
  const on = await setClientModuleEnabled({
    tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'scheduling', enabled: true, settings: { default_view: 'week' },
  });
  assert.ok(on);
  assert.deepEqual(on.settings, { default_view: 'week' });
});

test('#7 a tenant cannot enable a module on another tenant\'s client (null, no write)', async () => {
  const a = await scenario();
  const b = await scenario();
  const result = await setClientModuleEnabled({ tenantId: b.tenantId, clientId: a.clientId, moduleKey: 'crm', enabled: true });
  assert.equal(result, null, 'cross-tenant write returns null');
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM client_modules WHERE client_id = $1`,
    [a.clientId],
  );
  assert.equal(rows.rows[0].n, 0, 'nothing was written for the foreign client');
});

test('#8 listing never leaks another tenant\'s modules', async () => {
  const a = await scenario();
  const b = await scenario();
  await setClientModuleEnabled({ tenantId: a.tenantId, clientId: a.clientId, moduleKey: 'crm', enabled: true });
  assert.equal((await listClientModulesForTenant(b.tenantId)).length, 0);
  assert.equal((await listClientModules(b.tenantId, a.clientId)).length, 0, 'foreign (tenant,client) pair lists nothing');
  const mine = await listClientModulesForTenant(a.tenantId);
  assert.ok(mine.every((r) => r.tenant_id === a.tenantId));
  assert.ok(mine.some((r) => r.client_id === a.clientId && r.module_key === 'crm'));
});

test('#9 deleting a client cascades its module rows', async () => {
  const s = await scenario();
  // A fresh client with no contacts/sites/workflows so the delete isn't blocked
  // by other NO ACTION FKs — we're testing the client_modules cascade.
  const c = await query<{ id: string }>(
    `INSERT INTO clients (tenant_id, name) VALUES ($1, 'Disposable') RETURNING id`,
    [s.tenantId],
  );
  const clientId = c.rows[0].id;
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId, moduleKey: 'crm', enabled: true });
  assert.equal((await listClientModules(s.tenantId, clientId)).length, 1);
  await query(`DELETE FROM clients WHERE id = $1 AND tenant_id = $2`, [clientId, s.tenantId]);
  const left = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM client_modules WHERE client_id = $1`, [clientId]);
  assert.equal(left.rows[0].n, 0, 'module rows removed by ON DELETE CASCADE');
});

test('#10 DB rejects unknown module_key and non-object settings', async () => {
  const s = await scenario();
  await assert.rejects(
    query(`INSERT INTO client_modules (tenant_id, client_id, module_key) VALUES ($1, $2, 'payments')`, [s.tenantId, s.clientId]),
    (err: unknown) => (err as { code?: string }).code === '23514', // check_violation
    'unknown module_key violates the CHECK',
  );
  await assert.rejects(
    query(`INSERT INTO client_modules (tenant_id, client_id, module_key, settings) VALUES ($1, $2, 'crm', '[1,2]'::jsonb)`, [s.tenantId, s.clientId]),
    (err: unknown) => (err as { code?: string }).code === '23514',
    'array settings violate the jsonb_typeof CHECK',
  );
});
