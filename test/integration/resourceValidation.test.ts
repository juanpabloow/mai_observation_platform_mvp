import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { isServiceEnabledAtSite, setSiteService } from '../../src/db/repositories/scheduling/services.js';
import { isActiveStaffOfSite } from '../../src/db/repositories/scheduling/staff.js';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient } from './fixtures.js';

/**
 * The DB-level resource guards the machine API uses to turn a foreign / unknown /
 * not-enabled site_id/service_id/staff_id into a generic 404 BEFORE any uuid-typed
 * query (which would otherwise 22P02 → 500) or engine call.
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

test('isServiceEnabledAtSite: enabled → true; not enabled at this site / disabled → false', async () => {
  const s = await scenario();
  // Haircut is enabled at the seeded site.
  assert.equal(await isServiceEnabledAtSite(s.tenantId, s.siteId, s.serviceHaircut), true);

  // A service enabled only at ANOTHER site is not enabled here.
  const other = await seedSiteForClient(s.tenantId, s.otherClientId);
  assert.equal(await isServiceEnabledAtSite(s.tenantId, s.siteId, other.serviceId), false, 'foreign-site service');
  assert.equal(await isServiceEnabledAtSite(s.tenantId, other.siteId, s.serviceHaircut), false);

  // Disabling the site_services row → false (data preserved, just not enabled).
  await setSiteService(s.tenantId, s.siteId, s.serviceHaircut, { active: false });
  assert.equal(await isServiceEnabledAtSite(s.tenantId, s.siteId, s.serviceHaircut), false, 'disabled site_service');
});

test('isActiveStaffOfSite: own active staff → true; staff of another site → false', async () => {
  const s = await scenario();
  assert.equal(await isActiveStaffOfSite(s.tenantId, s.siteId, s.staffA), true);

  // A staff member of another client's site is not a staff of this site.
  const other = await seedSiteForClient(s.tenantId, s.otherClientId);
  assert.equal(await isActiveStaffOfSite(s.tenantId, s.siteId, other.staffId), false, 'foreign-site staff');
  assert.equal(await isActiveStaffOfSite(s.tenantId, other.siteId, s.staffA), false);
});
