import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { createServiceWithSites, ServiceSiteLinkError } from '../../src/db/repositories/scheduling/services.js';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient } from './fixtures.js';

/**
 * createServiceWithSites — what createServiceAction runs — writes the service and its
 * initial site links in ONE transaction. A link that cannot be written (here: a site of
 * ANOTHER client, which the guarded same-client upsert refuses — a controlled failure
 * of the link step itself) rolls the service back, so the editor's retry creates it
 * exactly once instead of leaving an orphan behind and then a duplicate.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const servicesNamed = async (tenantId: string, name: string) =>
  (await query<{ id: string }>('SELECT id FROM services WHERE tenant_id = $1 AND name = $2', [tenantId, name])).rows;

test('a failed site link rolls the whole create back; the retry creates exactly one service', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const foreign = await seedSiteForClient(s.tenantId, s.otherClientId); // client B's site
  const name = `Servicio atómico ${randomUUID().slice(0, 8)}`;
  const input = { tenantId: s.tenantId, clientId: s.clientId, name, durationMin: 30 };

  // 1st attempt: the valid site links first, then the foreign one fails.
  await assert.rejects(createServiceWithSites(input, [s.siteId, foreign.siteId]), (err: unknown) => {
    assert.ok(err instanceof ServiceSiteLinkError);
    assert.equal(err.siteId, foreign.siteId);
    return true;
  });
  assert.equal((await servicesNamed(s.tenantId, name)).length, 0, 'no orphan service survives the failure');
  const strayLinks = await query('SELECT 1 FROM site_services ss JOIN services sv ON sv.id = ss.service_id WHERE sv.tenant_id = $1 AND sv.name = $2', [
    s.tenantId,
    name,
  ]);
  assert.equal(strayLinks.rowCount, 0, 'the link written before the failure was rolled back too');

  // A site that does not exist at all fails the same way.
  await assert.rejects(createServiceWithSites(input, [randomUUID()]), ServiceSiteLinkError);
  assert.equal((await servicesNamed(s.tenantId, name)).length, 0);

  // Retry with the valid site: exactly one service, linked once.
  const created = await createServiceWithSites(input, [s.siteId, s.siteId]);
  const rows = await servicesNamed(s.tenantId, name);
  assert.deepEqual(rows.map((r) => r.id), [created.id], 'one service, the one returned');
  const links = await query<{ site_id: string; active: boolean }>('SELECT site_id, active FROM site_services WHERE service_id = $1', [created.id]);
  assert.deepEqual(links.rows, [{ site_id: s.siteId, active: true }], 'linked to its site exactly once, enabled');
  assert.equal(created.client_id, s.clientId, 'owned by the validated client');
});

test('creating with no sites is still a single service row', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const name = `Sin sede ${randomUUID().slice(0, 8)}`;
  const created = await createServiceWithSites({ tenantId: s.tenantId, clientId: s.clientId, name, durationMin: 45 }, []);
  assert.equal((await servicesNamed(s.tenantId, name)).length, 1);
  assert.equal((await query('SELECT 1 FROM site_services WHERE service_id = $1', [created.id])).rowCount, 0);
});
