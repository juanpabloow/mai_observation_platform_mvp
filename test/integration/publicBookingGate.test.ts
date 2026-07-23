import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { getPublicBookingSiteBySlug } from '../../src/db/repositories/scheduling/sites.js';
import { listServicesForSite, setSiteService, setStaffService } from '../../src/db/repositories/scheduling/services.js';
import { listStaffForService } from '../../src/db/repositories/scheduling/staff.js';
import { loadAvailability, resolveEffectivePrice } from '../../src/db/repositories/scheduling/availabilityData.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { createAppointment } from '../../src/scheduling/booking.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { OPEN_9_18, cleanupTenant, closeDb } from './fixtures.js';

/**
 * Phase 3B — public booking gated by client_modules. The single gate is
 * getPublicBookingSiteBySlug (active site + non-default client + scheduling
 * enabled); every public surface uses it, so these resolver-level tests cover
 * what all five surfaces share. Plus: site/service/staff relation hardening and
 * the createAppointment scopeClientId defense the public POST relies on.
 */

const TZ = 'America/Bogota';
const NOW = zonedPartsToUtc(2026, 8, 1, 0, 0, TZ);
const wed = (h: number): Date => zonedPartsToUtc(2026, 8, 5, h, 0, TZ);

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

async function mkTenant(): Promise<string> {
  const id = randomUUID();
  await query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [id, `T ${id.slice(0, 8)}`]);
  tenants.push(id);
  return id;
}

interface BookingSite {
  clientId: string;
  siteId: string;
  slug: string;
  serviceId: string;
  staffId: string;
}

/** A client (non-default by default) with a site (unique slug), one service
 * enabled at the site, and one staff able to perform it. */
async function mkBookingSite(tenantId: string, opts: { isDefault?: boolean } = {}): Promise<BookingSite> {
  const isDefault = opts.isDefault ?? false;
  const client = await query<{ id: string }>(
    `INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, isDefault ? 'Default Biz' : `Biz ${randomUUID().slice(0, 6)}`, isDefault],
  );
  const clientId = client.rows[0].id;
  const slug = `book-${randomUUID().slice(0, 8)}`;
  const site = await query<{ id: string }>(
    `INSERT INTO sites (tenant_id, client_id, slug, name, timezone, opening_hours, scheduling_config)
       VALUES ($1, $2, $3, 'Booking Site', 'America/Bogota', $4,
         '{"slot_interval_min":30,"min_notice_min":0,"booking_horizon_days":365,"default_buffer_before_min":0,"default_buffer_after_min":0}'::jsonb)
     RETURNING id`,
    [tenantId, clientId, slug, JSON.stringify(OPEN_9_18)],
  );
  const siteId = site.rows[0].id;
  const svc = await query<{ id: string }>(
    `INSERT INTO services (tenant_id, name, duration_min, price) VALUES ($1, 'Haircut', 60, 30) RETURNING id`,
    [tenantId],
  );
  const serviceId = svc.rows[0].id;
  await query(`INSERT INTO site_services (tenant_id, site_id, service_id) VALUES ($1, $2, $3)`, [tenantId, siteId, serviceId]);
  const staff = await query<{ id: string }>(
    `INSERT INTO staff (tenant_id, site_id, name, working_hours) VALUES ($1, $2, 'Ana', '{}'::jsonb) RETURNING id`,
    [tenantId, siteId],
  );
  const staffId = staff.rows[0].id;
  await query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3)`, [tenantId, staffId, serviceId]);
  return { clientId, siteId, slug, serviceId, staffId };
}

const enableScheduling = (tenantId: string, clientId: string, enabled = true) =>
  setClientModuleEnabled({ tenantId, clientId, moduleKey: 'scheduling', enabled });

async function apptCount(tenantId: string): Promise<number> {
  const r = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM appointments WHERE tenant_id = $1`, [tenantId]);
  return r.rows[0].n;
}

test('#1 active site + module ABSENT → resolver returns null', async () => {
  const t = await mkTenant();
  const b = await mkBookingSite(t);
  assert.equal(await getPublicBookingSiteBySlug(b.slug), null);
});

test('#2 scheduling ENABLED → resolver returns the site', async () => {
  const t = await mkTenant();
  const b = await mkBookingSite(t);
  await enableScheduling(t, b.clientId);
  const site = await getPublicBookingSiteBySlug(b.slug);
  assert.ok(site);
  assert.equal(site.id, b.siteId);
  assert.equal(site.client_id, b.clientId);
});

test('#3 disabling again → resolver null, and NO data is deleted', async () => {
  const t = await mkTenant();
  const b = await mkBookingSite(t);
  await enableScheduling(t, b.clientId, true);
  assert.ok(await getPublicBookingSiteBySlug(b.slug));
  await enableScheduling(t, b.clientId, false);
  assert.equal(await getPublicBookingSiteBySlug(b.slug), null);
  // Site, service, staff and the client_modules row all still exist.
  const sites = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM sites WHERE id = $1`, [b.siteId]);
  const svcs = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM services WHERE id = $1`, [b.serviceId]);
  const staff = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM staff WHERE id = $1`, [b.staffId]);
  const cm = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM client_modules WHERE tenant_id = $1 AND client_id = $2 AND module_key = 'scheduling'`,
    [t, b.clientId],
  );
  assert.equal(sites.rows[0].n, 1);
  assert.equal(svcs.rows[0].n, 1);
  assert.equal(staff.rows[0].n, 1);
  assert.equal(cm.rows[0].n, 1, 'the row is kept (disabled), not removed');
  // Re-enabling brings the same site back with its data.
  await enableScheduling(t, b.clientId, true);
  assert.ok(await getPublicBookingSiteBySlug(b.slug));
});

test('#4 inactive site → resolver null (even with scheduling enabled)', async () => {
  const t = await mkTenant();
  const b = await mkBookingSite(t);
  await enableScheduling(t, b.clientId);
  await query(`UPDATE sites SET active = false WHERE id = $1`, [b.siteId]);
  assert.equal(await getPublicBookingSiteBySlug(b.slug), null);
});

test('#5 default client with scheduling force-enabled → resolver null', async () => {
  const t = await mkTenant();
  const b = await mkBookingSite(t, { isDefault: true });
  // Force a client_modules row for the default client (repo doesn't reject it).
  await enableScheduling(t, b.clientId, true);
  assert.equal(await getPublicBookingSiteBySlug(b.slug), null, 'default/Unassigned can never host public booking');
});

test('#6 another tenant does not affect resolution', async () => {
  const tA = await mkTenant();
  const a = await mkBookingSite(tA);
  await enableScheduling(tA, a.clientId);
  const tB = await mkTenant();
  const b = await mkBookingSite(tB);
  await enableScheduling(tB, b.clientId);

  const siteA = await getPublicBookingSiteBySlug(a.slug);
  const siteB = await getPublicBookingSiteBySlug(b.slug);
  assert.equal(siteA?.tenant_id, tA);
  assert.equal(siteB?.tenant_id, tB);
  // Disabling A's module leaves B fully resolvable.
  await enableScheduling(tA, a.clientId, false);
  assert.equal(await getPublicBookingSiteBySlug(a.slug), null);
  assert.ok(await getPublicBookingSiteBySlug(b.slug));
});

test('#7 a service enabled only at site A does not appear or generate availability at site B', async () => {
  const t = await mkTenant();
  const a = await mkBookingSite(t);
  const b = await mkBookingSite(t);
  await enableScheduling(t, a.clientId);
  await enableScheduling(t, b.clientId);

  // A's service is enabled only at site A.
  const aServices = await listServicesForSite(t, a.siteId);
  assert.ok(aServices.some((s) => s.id === a.serviceId), 'offered at A');
  const bServices = await listServicesForSite(t, b.siteId);
  assert.ok(!bServices.some((s) => s.id === a.serviceId), 'NOT offered at B');

  // Availability for A's service at site B resolves to nothing (site/service mismatch).
  const availB = await loadAvailability({ tenantId: t, siteId: b.siteId, serviceId: a.serviceId, from: wed(0), to: wed(23), now: NOW });
  assert.equal(availB, null, 'no availability for a service not enabled at that site');
  // Positive control: A's service at site A does produce slots.
  const availA = await loadAvailability({ tenantId: t, siteId: a.siteId, serviceId: a.serviceId, from: wed(0), to: wed(23), now: NOW });
  assert.ok(availA && availA.slots.length > 0);
});

test('#8 inconsistent site/service/staff relations fail closed', async () => {
  const t = await mkTenant();
  const a = await mkBookingSite(t);
  const b = await mkBookingSite(t);
  await enableScheduling(t, a.clientId);

  // FK-allowed inconsistency: staff at site A linked (staff_services) to a service
  // that is only enabled at site B. listStaffForService(A, serviceB) must be empty
  // because site_services has no (siteA, serviceB) active row.
  await query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3)`, [t, a.staffId, b.serviceId]);
  const staff = await listStaffForService(t, a.siteId, b.serviceId);
  assert.equal(staff.length, 0, 'staff for a service not enabled at the site → none');
  // Effective price over that inconsistent chain → null (no valid site_service).
  assert.equal(await resolveEffectivePrice(t, a.siteId, b.serviceId, a.staffId), null);

  // A deactivated site_service also drops the service from the site's list.
  await setSiteService(t, a.siteId, a.serviceId, { active: false });
  const svcs = await listServicesForSite(t, a.siteId);
  assert.ok(!svcs.some((s) => s.id === a.serviceId), 'deactivated site_service → excluded');
});

test('#9 positive control: effective duration/price + valid staff still work (incl. overrides)', async () => {
  const t = await mkTenant();
  const b = await mkBookingSite(t);
  await enableScheduling(t, b.clientId);

  // Base: 60 min, price 30.
  let svcs = await listServicesForSite(t, b.siteId);
  let row = svcs.find((s) => s.id === b.serviceId);
  assert.ok(row);
  assert.equal(row.effective_duration_min, 60);
  assert.equal(Number(row.effective_price), 30);
  const staff = await listStaffForService(t, b.siteId, b.serviceId);
  assert.deepEqual(staff.map((s) => s.id), [b.staffId]);
  assert.equal(Number(await resolveEffectivePrice(t, b.siteId, b.serviceId, b.staffId)), 30);

  // Site override → 45 min / 25; then staff price override → 20.
  await setSiteService(t, b.siteId, b.serviceId, { active: true, durationOverrideMin: 45, priceOverride: 25 });
  svcs = await listServicesForSite(t, b.siteId);
  row = svcs.find((s) => s.id === b.serviceId)!;
  assert.equal(row.effective_duration_min, 45);
  assert.equal(Number(row.effective_price), 25);
  assert.equal(Number(await resolveEffectivePrice(t, b.siteId, b.serviceId, b.staffId)), 25);
  await setStaffService(t, b.staffId, b.serviceId, { active: true, priceOverride: 20 });
  assert.equal(Number(await resolveEffectivePrice(t, b.siteId, b.serviceId, b.staffId)), 20);
});

test('#10 createAppointment with the correct scopeClientId works', async () => {
  const t = await mkTenant();
  const b = await mkBookingSite(t);
  await enableScheduling(t, b.clientId);
  const r = await createAppointment({
    tenantId: t, siteId: b.siteId, serviceId: b.serviceId, staffId: b.staffId, startAt: wed(10),
    origin: 'public', createdByType: 'public', scopeClientId: b.clientId, now: NOW,
  });
  assert.ok(r.ok, 'booking succeeds within its own client');
  assert.equal(await apptCount(t), 1);
});

test('#11 createAppointment with another client\'s scopeClientId → not_found, ZERO writes', async () => {
  const t = await mkTenant();
  const b = await mkBookingSite(t);
  const other = await mkBookingSite(t); // a different (non-default) client of the same tenant
  await enableScheduling(t, b.clientId);
  const before = await apptCount(t);
  const r = await createAppointment({
    tenantId: t, siteId: b.siteId, serviceId: b.serviceId, staffId: b.staffId, startAt: wed(11),
    origin: 'public', createdByType: 'public', scopeClientId: other.clientId, now: NOW,
  });
  assert.ok(!r.ok && r.error === 'not_found', 'cross-client scope is rejected as not_found');
  assert.equal(await apptCount(t), before, 'no appointment was written');
});

test('resolver-level: disabled → null and no write; re-enabled → bookable (NOT a handler test)', async () => {
  // SCOPE: this exercises the RESOLVER + domain only — it does NOT run the HTTP
  // handlers (their gate ORDER is covered by the handler-source contract test in
  // publicBookingHandlerOrder.test.ts). It proves the resolver's semantics: while
  // scheduling is disabled the gate is null (so every surface 404s and the POST,
  // which returns before createAppointment, writes nothing), and re-enabling makes
  // the same site bookable again with its existing data.
  const t = await mkTenant();
  const b = await mkBookingSite(t); // no module row → disabled
  const before = await apptCount(t);

  const site = await getPublicBookingSiteBySlug(b.slug);
  assert.equal(site, null, 'gate closed while disabled');
  assert.equal(await apptCount(t), before, 'nothing written while the gate is closed');

  // Re-enable → the same site resolves and a booking succeeds (the gate is the
  // only blocker; the underlying data was never deleted).
  await enableScheduling(t, b.clientId);
  const site2 = await getPublicBookingSiteBySlug(b.slug);
  assert.ok(site2);
  const r = await createAppointment({
    tenantId: t, siteId: b.siteId, serviceId: b.serviceId, staffId: b.staffId, startAt: wed(12),
    origin: 'public', createdByType: 'public', scopeClientId: site2.client_id, now: NOW,
  });
  assert.ok(r.ok);
  assert.equal(await apptCount(t), before + 1);
});
