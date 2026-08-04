import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { listServices, listServicesForSite, updateService, getServiceById } from '../../src/db/repositories/scheduling/services.js';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient } from './fixtures.js';

/**
 * Featured services: the flag persists, featured come FIRST, and it never crosses clients.
 * (The machine route's ?featured filter + empty-fallback is proven by the live smoke.)
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});
async function scenario() {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  return s;
}

test('all services default to featured=false; nothing is featured until the operator marks it', async () => {
  const s = await scenario();
  const rows = await listServices(s.tenantId, s.clientId, true);
  assert.ok(rows.length >= 3);
  assert.ok(rows.every((r) => r.featured === false), 'default false — the operator opts in');
});

test('marking a service featured persists and sorts it FIRST (site + admin lists)', async () => {
  const s = await scenario();
  // Feature "Color" (which sorts LAST by name) so first-ness can't be a name-order accident.
  const updated = await updateService(s.tenantId, s.clientId, s.serviceColor, { featured: true });
  assert.equal(updated?.featured, true, 'persisted');
  assert.equal((await getServiceById(s.tenantId, s.clientId, s.serviceColor))?.featured, true);

  const site = await listServicesForSite(s.tenantId, s.siteId);
  assert.equal(site[0].id, s.serviceColor, 'featured service comes first even though its name sorts last');
  assert.ok(site.slice(1).every((r) => !r.featured), 'the rest are not featured');
  // Within groups, still name-ordered (Beard trim before Haircut among the non-featured).
  const rest = site.slice(1).map((r) => r.name);
  assert.deepEqual(rest, [...rest].sort((a, b) => a.localeCompare(b)), 'non-featured stay name-ordered');

  const admin = await listServices(s.tenantId, s.clientId, true);
  assert.equal(admin[0].id, s.serviceColor, 'admin list is also featured-first');
});

test('CROSS-CLIENT: featuring a service in one client never marks another client', async () => {
  const s = await scenario();
  const other = await seedSiteForClient(s.tenantId, s.otherClientId); // its own site + "Other Svc"
  await updateService(s.tenantId, s.clientId, s.serviceHaircut, { featured: true });

  // The other client's catalogue is untouched.
  const otherSite = await listServicesForSite(s.tenantId, other.siteId);
  assert.ok(otherSite.length > 0 && otherSite.every((r) => !r.featured), 'other client has no featured services');

  // And a client-scoped update cannot flip a service that belongs to another client.
  const foreign = await updateService(s.tenantId, s.clientId, other.serviceId, { featured: true });
  assert.equal(foreign, null, 'updating a foreign-client service id is a no-op (client-scoped)');
  assert.equal((await getServiceById(s.tenantId, s.otherClientId, other.serviceId))?.featured, false, 'still not featured');
});
