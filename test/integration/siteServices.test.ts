import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import {
  createService,
  listServicesForSite,
  setSiteService,
} from '../../src/db/repositories/scheduling/services.js';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient } from './fixtures.js';

/**
 * Per-site service enablement — the exact path the Scheduling admin UI now uses
 * (createServiceAction with siteIds → setSiteService, and the per-site chips →
 * setSiteService toggle). A service is only bookable/visible where a site_services
 * row enables it: listServicesForSite is what the public /book/{slug} page and the
 * availability engine read.
 */

const tenants: string[] = [];

after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

test('a service enabled at site A appears in listServicesForSite(A) and NOT at site B', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  // A second site in the same tenant (other client — the isolation-hardest case).
  const other = await seedSiteForClient(s.tenantId, s.otherClientId);

  // Create a service and enable it ONLY at site A (what the create form does).
  const svc = await createService({ tenantId: s.tenantId, name: 'Hot towel shave', durationMin: 40, price: 25 });
  await setSiteService(s.tenantId, s.siteId, svc.id);

  const atA = await listServicesForSite(s.tenantId, s.siteId);
  const atB = await listServicesForSite(s.tenantId, other.siteId);
  assert.ok(atA.some((x) => x.id === svc.id), 'enabled service is offered at site A');
  assert.ok(!atB.some((x) => x.id === svc.id), 'service is NOT offered at site B');
});

test('toggling a site chip off removes the service from that site only', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const other = await seedSiteForClient(s.tenantId, s.otherClientId);

  // Enable at BOTH sites, then disable at A (the chip-off path: active=false).
  const svc = await createService({ tenantId: s.tenantId, name: 'Kids cut', durationMin: 30 });
  await setSiteService(s.tenantId, s.siteId, svc.id);
  await setSiteService(s.tenantId, other.siteId, svc.id);
  await setSiteService(s.tenantId, s.siteId, svc.id, { active: false });

  const atA = await listServicesForSite(s.tenantId, s.siteId);
  const atB = await listServicesForSite(s.tenantId, other.siteId);
  assert.ok(!atA.some((x) => x.id === svc.id), 'disabled at A → gone from A');
  assert.ok(atB.some((x) => x.id === svc.id), 'still offered at B');
});

test('cross-tenant guard: enabling against another tenant\'s site is a no-op', async () => {
  const a = await seedScenario();
  const b = await seedScenario();
  tenants.push(a.tenantId, b.tenantId);

  // Tenant B tries to enable ITS service at tenant A's site — the repo's EXISTS
  // guards must make this a silent no-op (no row, no cross-tenant write).
  const svcB = await createService({ tenantId: b.tenantId, name: 'Foreign svc', durationMin: 30 });
  await setSiteService(b.tenantId, a.siteId, svcB.id);

  const atA = await listServicesForSite(a.tenantId, a.siteId);
  assert.ok(!atA.some((x) => x.id === svcB.id), 'no cross-tenant enablement');
});
