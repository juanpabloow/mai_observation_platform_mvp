import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { getSiteById, listSites } from '../../src/db/repositories/scheduling/sites.js';
import { getStaffById } from '../../src/db/repositories/scheduling/staff.js';
import { createException, getExceptionById } from '../../src/db/repositories/scheduling/exceptions.js';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient } from './fixtures.js';

/**
 * The per-client Scheduling admin actions reject any resource that belongs to
 * ANOTHER client (siteInClient / staffInClient / exception→site→client). Those
 * checks are web-layer, but they stand on these repo guarantees, proven here:
 *   - getSiteById exposes the owning client_id (so an admin scoped to client A can
 *     tell a client-B site apart) and is tenant-scoped;
 *   - listSites({clientId}) returns ONLY that client's sites;
 *   - getStaffById resolves the staff's site (→ client) and is tenant-scoped;
 *   - getExceptionById is tenant-scoped and carries the site_id used for the check.
 * Together: there is no cross-client scheduling administration.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

test('a site/staff/exception of client B is never mistaken for client A (and stays tenant-scoped)', async () => {
  const s = await seedScenario(); // Business A owns s.siteId; Business B has none yet
  tenants.push(s.tenantId);
  const other = await seedSiteForClient(s.tenantId, s.otherClientId); // a client-B site+staff

  // getSiteById exposes the owning client — the basis of siteInClient(...).
  const aSite = await getSiteById(s.tenantId, s.siteId);
  const bSite = await getSiteById(s.tenantId, other.siteId);
  assert.equal(aSite?.client_id, s.clientId, 'A site → client A');
  assert.equal(bSite?.client_id, s.otherClientId, 'B site → client B');
  assert.notEqual(aSite?.client_id, bSite?.client_id, "the two clients' sites are distinguishable");

  // listSites({clientId}) isolates each client's sites.
  const aSites = await listSites(s.tenantId, { clientId: s.clientId, includeInactive: true });
  const bSites = await listSites(s.tenantId, { clientId: s.otherClientId, includeInactive: true });
  assert.ok(aSites.some((x) => x.id === s.siteId) && !aSites.some((x) => x.id === other.siteId), "A's list excludes B's site");
  assert.ok(bSites.some((x) => x.id === other.siteId) && !bSites.some((x) => x.id === s.siteId), "B's list excludes A's site");

  // getStaffById resolves the staff's site (→ client) — the basis of staffInClient(...).
  const bStaff = await getStaffById(s.tenantId, other.staffId);
  assert.equal(bStaff?.site_id, other.siteId, "B staff belongs to B's site");

  // getExceptionById is tenant-scoped and carries the site_id used for the delete check.
  const exc = await createException({
    tenantId: s.tenantId,
    siteId: other.siteId,
    staffId: null,
    startsAt: new Date('2026-09-01T12:00:00Z'),
    endsAt: new Date('2026-09-01T13:00:00Z'),
  });
  const fetched = await getExceptionById(s.tenantId, exc.id);
  assert.equal(fetched?.site_id, other.siteId, 'exception carries its site (→ client B)');
  assert.equal(await getExceptionById(s.tenantId, randomUUID()), null, 'unknown exception id → null');

  // Cross-TENANT: another tenant can never see this tenant's site.
  const s2 = await seedScenario();
  tenants.push(s2.tenantId);
  assert.equal(await getSiteById(s2.tenantId, s.siteId), null, "another tenant can't read this site");
  assert.equal(await getStaffById(s2.tenantId, other.staffId), null, "another tenant can't read this staff");
  assert.equal(await getExceptionById(s2.tenantId, exc.id), null, "another tenant can't read this exception");
});
