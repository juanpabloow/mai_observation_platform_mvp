import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import {
  createService,
  listServicesForSite,
  setSiteService,
} from '../../src/db/repositories/scheduling/services.js';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient } from './fixtures.js';

/**
 * Per-site service enablement — the path the Scheduling admin UI uses
 * (createServiceAction with siteIds → setSiteService, and the per-site chips →
 * setSiteService toggle). A service is only bookable/visible where a site_services
 * row enables it: listServicesForSite is what /book/{slug} + the availability engine
 * read. Services are per-CLIENT now, so these use TWO sites of the SAME client to
 * exercise site-level (not client-level) enablement; cross-client isolation lives in
 * servicesPerClient.test.ts.
 */

const tenants: string[] = [];

after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

test('a service enabled at site A appears in listServicesForSite(A) and NOT at a second site of the same client', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  // A SECOND site of the SAME client (site-level enablement, not client isolation).
  const siteA2 = await seedSiteForClient(s.tenantId, s.clientId);

  const svc = await createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Hot towel shave', durationMin: 40, price: 25 });
  await setSiteService(s.tenantId, s.siteId, svc.id);

  const atA = await listServicesForSite(s.tenantId, s.siteId);
  const atA2 = await listServicesForSite(s.tenantId, siteA2.siteId);
  assert.ok(atA.some((x) => x.id === svc.id), 'enabled service is offered at site A');
  assert.ok(!atA2.some((x) => x.id === svc.id), 'service is NOT offered at the other site');
});

test('toggling a site chip off removes the service from that site only', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const siteA2 = await seedSiteForClient(s.tenantId, s.clientId);

  // Enable at BOTH of the client's sites, then disable at A (chip-off: active=false).
  const svc = await createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Kids cut', durationMin: 30 });
  await setSiteService(s.tenantId, s.siteId, svc.id);
  await setSiteService(s.tenantId, siteA2.siteId, svc.id);
  await setSiteService(s.tenantId, s.siteId, svc.id, { active: false });

  const atA = await listServicesForSite(s.tenantId, s.siteId);
  const atA2 = await listServicesForSite(s.tenantId, siteA2.siteId);
  assert.ok(!atA.some((x) => x.id === svc.id), 'disabled at A → gone from A');
  assert.ok(atA2.some((x) => x.id === svc.id), 'still offered at the other site');
});

test("cross-tenant guard: enabling against another tenant's site is a no-op", async () => {
  const a = await seedScenario();
  const b = await seedScenario();
  tenants.push(a.tenantId, b.tenantId);

  // Tenant B tries to enable ITS service at tenant A's site — the repo's structural
  // guard must make this a silent no-op (no row, no cross-tenant write).
  const svcB = await createService({ tenantId: b.tenantId, clientId: b.clientId, name: 'Foreign svc', durationMin: 30 });
  await setSiteService(b.tenantId, a.siteId, svcB.id);

  const atA = await listServicesForSite(a.tenantId, a.siteId);
  assert.ok(!atA.some((x) => x.id === svcB.id), 'no cross-tenant enablement');
});
