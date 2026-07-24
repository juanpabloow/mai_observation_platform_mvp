import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import {
  createService,
  deactivateService,
  getServiceById,
  isServiceEnabledAtSite,
  listServices,
  listServicesForSite,
  listStaffServices,
  setSiteService,
  setStaffService,
  updateService,
} from '../../src/db/repositories/scheduling/services.js';
import { createAppointment } from '../../src/scheduling/booking.js';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient } from './fixtures.js';

/**
 * Per-CLIENT service catalogue isolation (SCHED-3), proven behaviorally against
 * PostgreSQL. Client A = the scenario's `clientId` (has the seeded site + staff);
 * Client B = `otherClientId` (given its own site + staff via seedSiteForClient).
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const future = () => new Date(Date.now() + 3 * 24 * 3600 * 1000);

test('two clients of one tenant each own an independent "Haircut" (distinct id/price/duration)', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);

  const aCut = await createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Haircut', durationMin: 30, price: 20 });
  const bCut = await createService({ tenantId: s.tenantId, clientId: s.otherClientId, name: 'Haircut', durationMin: 60, price: 45 });

  assert.notEqual(aCut.id, bCut.id, 'independent rows');
  assert.equal(aCut.client_id, s.clientId);
  assert.equal(bCut.client_id, s.otherClientId);
  assert.equal(aCut.name, bCut.name, 'same name allowed across clients');
  assert.equal(aCut.duration_min, 30);
  assert.equal(bCut.duration_min, 60);
  assert.equal(aCut.price, '20.00');
  assert.equal(bCut.price, '45.00');
});

test('editing client A\'s service never touches client B\'s', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const aCut = await createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Haircut', durationMin: 30, price: 20 });
  const bCut = await createService({ tenantId: s.tenantId, clientId: s.otherClientId, name: 'Haircut', durationMin: 60, price: 45 });

  const updated = await updateService(s.tenantId, s.clientId, aCut.id, { price: 99, durationMin: 15 });
  assert.equal(updated?.price, '99.00');

  const bStill = await getServiceById(s.tenantId, s.otherClientId, bCut.id);
  assert.equal(bStill?.price, '45.00', "B's price unchanged");
  assert.equal(bStill?.duration_min, 60, "B's duration unchanged");

  // Cross-client update is a no-op (A's client can't edit B's service).
  const crossed = await updateService(s.tenantId, s.clientId, bCut.id, { price: 1 });
  assert.equal(crossed, null, 'updating B via A returns null');
  assert.equal((await getServiceById(s.tenantId, s.otherClientId, bCut.id))?.price, '45.00');
});

test('listServices(A) never returns B\'s services (and cross-tenant blocked)', async () => {
  const s = await seedScenario({ enableScheduling: true });
  const other = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId, other.tenantId);

  const aCut = await createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Haircut', durationMin: 30, price: 20 });
  const bCut = await createService({ tenantId: s.tenantId, clientId: s.otherClientId, name: 'Haircut', durationMin: 60, price: 45 });

  const aList = await listServices(s.tenantId, s.clientId, true);
  const aIds = aList.map((x) => x.id);
  assert.ok(aIds.includes(aCut.id), "A sees A's service");
  assert.ok(!aIds.includes(bCut.id), "A never sees B's service");

  // getServiceById is client-scoped: B's id resolves only under B.
  assert.equal(await getServiceById(s.tenantId, s.clientId, bCut.id), null, "A can't read B's service by id");
  assert.ok(await getServiceById(s.tenantId, s.otherClientId, bCut.id), "B reads its own");
  // Cross-tenant: another tenant never sees this tenant's service.
  assert.equal(await getServiceById(other.tenantId, other.clientId, aCut.id), null, 'cross-tenant blocked');
});

test("service A cannot be enabled at client B's site (structural no-op)", async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const bSite = await seedSiteForClient(s.tenantId, s.otherClientId); // client B's site
  const aCut = await createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Fade', durationMin: 30, price: 20 });

  await setSiteService(s.tenantId, bSite.siteId, aCut.id); // cross-client → no-op

  const atB = await listServicesForSite(s.tenantId, bSite.siteId);
  assert.ok(!atB.some((x) => x.id === aCut.id), "A's service is NOT offered at B's site");
  assert.equal(await isServiceEnabledAtSite(s.tenantId, bSite.siteId, aCut.id), false, 'isServiceEnabledAtSite false');
  // And enabling at A's OWN site works (positive control).
  await setSiteService(s.tenantId, s.siteId, aCut.id);
  assert.ok((await listServicesForSite(s.tenantId, s.siteId)).some((x) => x.id === aCut.id));
});

test("service A cannot be assigned to client B's staff (structural no-op)", async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const bSite = await seedSiteForClient(s.tenantId, s.otherClientId);
  const aCut = await createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Fade', durationMin: 30, price: 20 });

  await setStaffService(s.tenantId, bSite.staffId, aCut.id); // cross-client → no-op

  const bStaffSvcs = await listStaffServices(s.tenantId, bSite.staffId);
  assert.ok(!bStaffSvcs.some((x) => x.service_id === aCut.id), "A's service not assignable to B's staff");
  // Positive control: assign to A's own staff.
  await setStaffService(s.tenantId, s.staffA, aCut.id);
  await setSiteService(s.tenantId, s.siteId, aCut.id);
  assert.ok((await listStaffServices(s.tenantId, s.staffA)).some((x) => x.service_id === aCut.id));
});

test("service A cannot be used to book at client B's site (not_found, zero writes)", async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const bSite = await seedSiteForClient(s.tenantId, s.otherClientId);
  const aCut = await createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Fade', durationMin: 30, price: 20 });
  await setSiteService(s.tenantId, s.siteId, aCut.id);

  const before = await apptCount(s.tenantId);
  // Book B's site with A's service (scope = B): availability can't resolve the
  // cross-client (site B, service A) pair → not_found, nothing written.
  const r = await createAppointment({
    tenantId: s.tenantId,
    siteId: bSite.siteId,
    serviceId: aCut.id,
    startAt: future(),
    origin: 'n8n',
    createdByType: 'n8n',
    scopeClientId: s.otherClientId,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, 'not_found');
  assert.equal(await apptCount(s.tenantId), before, 'zero writes');
});

test('deleting a client with services is FK-restricted and never touches another client', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const aCut = await createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'A svc', durationMin: 30, price: 20 });
  const bCut = await createService({ tenantId: s.tenantId, clientId: s.otherClientId, name: 'B svc', durationMin: 30, price: 20 });

  // The composite FK (client_id, tenant_id) → clients has NO ON DELETE (NO ACTION),
  // matching sites: a client with services can't be hard-deleted.
  await assert.rejects(
    () => query(`DELETE FROM clients WHERE id = $1 AND tenant_id = $2`, [s.otherClientId, s.tenantId]),
    /foreign key|violates/i,
    'deleting a client with services is restricted',
  );
  // A's and B's services are both intact — no cascade, no cross-client effect.
  assert.ok(await getServiceById(s.tenantId, s.clientId, aCut.id), "A's service intact");
  assert.ok(await getServiceById(s.tenantId, s.otherClientId, bCut.id), "B's service intact");

  // Deactivate is client-scoped: A's client can't deactivate B's service.
  assert.equal(await deactivateService(s.tenantId, s.clientId, bCut.id), false, "A can't deactivate B's service");
  assert.equal((await getServiceById(s.tenantId, s.otherClientId, bCut.id))?.active, true);
});

async function apptCount(tenantId: string): Promise<number> {
  const r = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM appointments WHERE tenant_id = $1`, [tenantId]);
  return r.rows[0].n;
}
