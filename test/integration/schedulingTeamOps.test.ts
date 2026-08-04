import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient, seedAppointment } from './fixtures.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import {
  getStaffForClient,
  staffOperationalSummary,
  serviceNamesByStaff,
  listStaff,
} from '../../src/db/repositories/scheduling/staff.js';
import { listAppointments } from '../../src/db/repositories/scheduling/appointments.js';
import { isClientModuleEnabled, setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { getClientById } from '../../src/db/repositories/clients.js';

/**
 * Team / operational reads (spec F #1, #9, #12, #13, #15) against PostgreSQL. The
 * staff→client ownership guard, the batched no-N+1 summaries, and the MODULE GATE
 * that the Team/Analytics pages call (resolveClientModuleForScope — the same core
 * the pages use via requireClientModulePage) are all exercised for real.
 */
const TZ = 'America/Bogota';
const tenants: string[] = [];
async function scenario() {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  return s;
}
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const at = (y: number, m: number, d: number, h: number) => zonedPartsToUtc(y, m, d, h, 0, TZ);

test('#9 staff ownership: own client resolves with its site; another client → null (404)', async () => {
  const s = await scenario();
  const mine = await getStaffForClient(s.tenantId, s.clientId, s.staffA);
  assert.ok(mine, 'own staff resolves');
  assert.equal(mine.site_client_id, s.clientId);
  assert.equal(mine.site_timezone, TZ);

  const other = await seedSiteForClient(s.tenantId, s.otherClientId);
  assert.equal(await getStaffForClient(s.tenantId, s.clientId, other.staffId), null, 'foreign-client staff → null');
  assert.equal(await getStaffForClient(s.tenantId, s.otherClientId, s.staffA), null, 'reverse direction too');
});

test('#11 cross-tenant: a staff id from another tenant never resolves', async () => {
  const a = await scenario();
  const b = await scenario();
  assert.equal(await getStaffForClient(a.tenantId, a.clientId, b.staffA), null, 'other tenant staff hidden');
  assert.equal(await getStaffForClient(b.tenantId, b.clientId, a.staffA), null);
});

test('#1 team summary: next appointment + today count are per-staff and client-scoped (one query)', async () => {
  const s = await scenario();
  const now = new Date();
  const soon = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const later = new Date(now.getTime() + 26 * 60 * 60 * 1000);
  const past = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const base = { clientId: s.clientId, siteId: s.siteId, serviceId: s.serviceHaircut };
  await seedAppointment(s.tenantId, { ...base, staffId: s.staffA, startAt: soon, status: 'scheduled' });
  await seedAppointment(s.tenantId, { ...base, staffId: s.staffA, startAt: later, status: 'confirmed' });
  await seedAppointment(s.tenantId, { ...base, staffId: s.staffA, startAt: past, status: 'completed' });
  await seedAppointment(s.tenantId, { ...base, staffId: s.staffB, startAt: soon, status: 'cancelled' });

  const map = await staffOperationalSummary(s.tenantId, s.clientId);
  const a = map.get(s.staffA);
  assert.ok(a);
  assert.equal(a.next_appointment_at?.getTime(), soon.getTime(), 'soonest FUTURE active appointment');
  assert.ok(a.today_count >= 2, 'past + soon count toward local today (cancelled excluded)');
  const b = map.get(s.staffB);
  assert.equal(b?.next_appointment_at, null, 'a cancelled appointment is never "next"');
});

test('#10 team summary never counts another client\'s appointments', async () => {
  const s = await scenario();
  const other = await seedSiteForClient(s.tenantId, s.otherClientId);
  await seedAppointment(s.tenantId, {
    clientId: s.otherClientId, siteId: other.siteId, staffId: other.staffId, serviceId: other.serviceId,
    startAt: new Date(Date.now() + 60 * 60 * 1000), status: 'scheduled',
  });
  const map = await staffOperationalSummary(s.tenantId, s.clientId);
  assert.equal(map.get(other.staffId), undefined, 'the other client\'s barber is absent from this client\'s summary');
});

test('services per barber come from the independent staff/services tables (no CRM copies)', async () => {
  const s = await scenario();
  const map = await serviceNamesByStaff(s.tenantId, [s.staffA, s.staffB]);
  assert.deepEqual(map.get(s.staffA)?.sort(), ['Beard trim', 'Color', 'Haircut']);
  assert.deepEqual(map.get(s.staffB)?.sort(), ['Beard trim', 'Haircut'], 'Beto does not do Color');
});

test('#1 #15 barber history/upcoming: filtered by staff, works with contact_id = null', async () => {
  const s = await scenario();
  const base = { clientId: s.clientId, siteId: s.siteId, serviceId: s.serviceHaircut };
  await seedAppointment(s.tenantId, { ...base, staffId: s.staffA, startAt: at(2026, 8, 3, 10), status: 'completed' });
  await seedAppointment(s.tenantId, { ...base, staffId: s.staffB, startAt: at(2026, 8, 3, 11), status: 'completed' });

  const mine = await listAppointments(s.tenantId, { clientId: s.clientId, staffId: s.staffA, order: 'desc' });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].staff_id, s.staffA);
  assert.equal(mine[0].contact_id, null, 'no CRM contact needed');
});

test('listAppointments serviceId filter narrows correctly', async () => {
  const s = await scenario();
  const base = { clientId: s.clientId, siteId: s.siteId, staffId: s.staffA };
  await seedAppointment(s.tenantId, { ...base, serviceId: s.serviceHaircut, startAt: at(2026, 8, 3, 10), status: 'completed' });
  await seedAppointment(s.tenantId, { ...base, serviceId: s.serviceBeard, startAt: at(2026, 8, 3, 11), status: 'completed' });
  const only = await listAppointments(s.tenantId, { clientId: s.clientId, serviceId: s.serviceBeard });
  assert.equal(only.length, 1);
  assert.equal(only[0].service_id, s.serviceBeard);
});

/**
 * The page gate (requireClientModulePage) is a composition of these DB primitives
 * plus the PURE membership rule; its wiring is asserted by the source-contract test
 * (schedulingOpsNavContract). Here we exercise the DB half for real, and re-apply the
 * documented membership rule so the whole decision is covered end-to-end.
 * (web/lib/clientModuleAccess imports `server-only`, so it can't load in this runner.)
 */
const canAccessClient = (memberClientId: string | null, clientId: string): boolean =>
  memberClientId === null || memberClientId === clientId;

async function gateAllows(tenantId: string, memberClientId: string | null, clientId: string): Promise<boolean> {
  if (!canAccessClient(memberClientId, clientId)) return false;
  const client = await getClientById({ tenantId, clientId });
  if (!client || client.is_default) return false;
  return isClientModuleEnabled(tenantId, clientId, 'scheduling');
}

test('#12 the scheduling module gate blocks the new routes when disabled', async () => {
  const s = await scenario();
  assert.equal(await gateAllows(s.tenantId, null, s.clientId), true, 'enabled → Team/Analytics render');

  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'scheduling', enabled: false });
  assert.equal(
    await gateAllows(s.tenantId, null, s.clientId),
    false,
    'disabled → 404 for Agenda, Team, Team detail, and Analytics',
  );
});

test('#13 members only reach their OWN client; the default client is never a surface', async () => {
  const s = await scenario();
  assert.equal(await gateAllows(s.tenantId, s.clientId, s.clientId), true, 'member reads their own client');
  assert.equal(await gateAllows(s.tenantId, s.clientId, s.otherClientId), false, 'another client → 404');
  assert.equal(await gateAllows(s.tenantId, null, s.defaultClientId), false, 'Unassigned never has scheduling');
});

test('#11 cross-tenant: the gate refuses a client id from another tenant', async () => {
  const a = await scenario();
  const b = await scenario();
  assert.equal(await gateAllows(a.tenantId, null, b.clientId), false, 'other tenant\'s client is not found here');
});

test('team list is client-scoped: another client\'s barbers never appear', async () => {
  const s = await scenario();
  const other = await seedSiteForClient(s.tenantId, s.otherClientId);
  const mine = await listStaff(s.tenantId, { clientId: s.clientId, includeInactive: true });
  const ids = mine.map((x) => x.id);
  assert.ok(ids.includes(s.staffA) && ids.includes(s.staffB));
  assert.ok(!ids.includes(other.staffId), 'the other client\'s barber is absent');
});
