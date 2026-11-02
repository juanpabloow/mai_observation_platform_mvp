import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedMember, seedScenario } from './fixtures.js';
import { zonedPartsToUtc, utcToZonedParts } from '../../src/scheduling/timezone.js';
import { recomputeStaffDays } from '../../src/occupancy/compute.js';

/**
 * JP-8 §4 — the occupancy PERMISSION MATRIX, by hitting the server loader directly (real scope,
 * stubbed session + Next boundaries, mirrors pipelineActions.test.ts). Owner/agency + Setter see
 * every professional; a Staff login sees ONLY its own row and never a site total. Money (collected +
 * sales/hour) is owner/agency only — a Setter and a Staff payload carry none. Isolation holds.
 */
let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: { getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null) },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), { namedExports: { redirect: () => { throw new Error('redirect'); }, notFound: () => { throw new Error('notFound'); } } });
mock.module(urlOf('next/headers'), { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) } });
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
const asUser = (id: string) => { CURRENT = { id, email: `${id.slice(0, 8)}@test.local` }; };

const { loadOccupancyView } = await import('../../web/lib/occupancyData.js');

const TZ = 'America/Bogota';
const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

/** A client STAFF login bound to a site + staff resource (the binding `scheduling_staff_id`). */
async function seedStaffLogin(tenantId: string, clientId: string, siteId: string, staffId: string): Promise<string> {
  const userId = randomUUID();
  await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1,$2,$3,true)`, [userId, `S ${userId.slice(0, 6)}`, `${userId.slice(0, 8)}@test.local`]);
  await query(
    `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role, scheduling_site_id, scheduling_staff_id)
       VALUES ($1,$2,'member',$3,'staff',$4,$5)`,
    [tenantId, userId, clientId, siteId, staffId],
  );
  return userId;
}

const dayAt = (day: string, h: number): Date => { const [y, m, d] = day.split('-').map(Number); return zonedPartsToUtc(y, m, d, h, 0, TZ); };
function anOpenDay(): string {
  const base = new Date(Date.UTC(2026, 5, 1, 12));
  for (let i = 0; i < 7; i++) {
    const u = new Date(base.getTime() + i * 86400000);
    const day = `${u.getUTCFullYear()}-${String(u.getUTCMonth() + 1).padStart(2, '0')}-${String(u.getUTCDate()).padStart(2, '0')}`;
    if (utcToZonedParts(dayAt(day, 12), TZ).weekday !== 'sun') return day;
  }
  return '2026-06-01';
}

async function fixture() {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const day = anOpenDay();
  // staffA: a completed 10:00–11:00 with a recorded payment; staffB: just capacity.
  const end = new Date(dayAt(day, 10).getTime() + 60 * 60000);
  const ap = await query<{ id: string }>(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id, start_at, service_end_at, blocked_from, blocked_until, service_name_snapshot, duration_min_snapshot, price_snapshot, buffer_before_min_snapshot, buffer_after_min_snapshot, status, origin, created_by_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$7,'Haircut',60,'50000',0,0,'completed','internal','system') RETURNING id`,
    [s.tenantId, s.clientId, s.siteId, s.staffA, s.serviceHaircut, dayAt(day, 10), end],
  );
  const pay = await query<{ id: string }>(`INSERT INTO payments (tenant_id, client_id, appointment_id, method_key, total, recorded_by) VALUES ($1,$2,$3,'efectivo','50000','seed') RETURNING id`, [s.tenantId, s.clientId, ap.rows[0].id]);
  await query(`INSERT INTO payment_lines (tenant_id, client_id, payment_id, kind, service_id, staff_id, description, quantity, unit_list_price, unit_charged, line_total, commission_pct, commission_amount) VALUES ($1,$2,$3,'service',$4,$5,'Haircut',1,'50000','50000','50000',20,'10000')`, [s.tenantId, s.clientId, pay.rows[0].id, s.serviceHaircut, s.staffA]);
  await recomputeStaffDays(s.tenantId, s.clientId, s.siteId, s.staffA, [day]);
  await recomputeStaffDays(s.tenantId, s.clientId, s.siteId, s.staffB, [day]);
  return { ...s, day };
}

test('owner & agency: every professional + money; setter: every professional, NO money', async () => {
  const s = await fixture();
  const agency = await seedMember(s.tenantId, { role: 'owner' });
  const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
  const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });

  for (const uid of [agency, owner]) {
    asUser(uid);
    const r = await loadOccupancyView(s.clientId, { g: 'dia', d: s.day });
    assert.ok(r.ok, 'owner/agency admitted');
    if (!r.ok) return;
    assert.equal(r.view.canMoney, true, 'owner/agency sees money');
    assert.equal(r.view.rows.length, 2, 'both professionals');
    const a = r.view.rows.find((x) => x.staffId === s.staffA)!;
    assert.equal(a.reservadaPct, Math.round((60 / 540) * 100));
    assert.equal(Number(a.collectedAmount), 50000, 'collected present');
    assert.ok(a.salesPerAvailableHour != null, 'sales/hour present');
    assert.ok(r.view.siteTotal && r.view.siteTotal.collectedAmount != null, 'site total carries money');
  }

  asUser(setter);
  const r = await loadOccupancyView(s.clientId, { g: 'dia', d: s.day });
  assert.ok(r.ok, 'setter admitted');
  if (!r.ok) return;
  assert.equal(r.view.canMoney, false, 'setter has no money tier');
  assert.equal(r.view.rows.length, 2, 'setter still sees every professional');
  for (const row of r.view.rows) {
    assert.equal(row.collectedAmount, undefined, 'a setter payload carries no collected amount');
    assert.equal(row.salesPerAvailableHour, undefined, 'and no sales/hour');
  }
  assert.ok(r.view.siteTotal && r.view.siteTotal.collectedAmount === undefined, 'site total has no money for a setter');
});

test('staff: only their OWN row, no site total, no money; cannot see other professionals', async () => {
  const s = await fixture();
  const staffA = await seedStaffLogin(s.tenantId, s.clientId, s.siteId, s.staffA);
  asUser(staffA);
  const r = await loadOccupancyView(s.clientId, { g: 'dia', d: s.day });
  assert.ok(r.ok, 'staff admitted to its own occupancy');
  if (!r.ok) return;
  assert.equal(r.view.isStaff, true);
  assert.equal(r.view.rows.length, 1, 'only one row');
  assert.equal(r.view.rows[0].staffId, s.staffA, 'their own');
  assert.equal(r.view.siteTotal, null, 'no site total for a staff login');
  assert.equal(r.view.canMoney, false, 'no money');
  assert.equal(r.view.rows[0].collectedAmount, undefined);
  // Even if a staff asks for another professional in the heatmap, it stays on themselves.
  const r2 = await loadOccupancyView(s.clientId, { g: 'dia', d: s.day, staff: s.staffB });
  assert.ok(r2.ok && r2.view.heatmapStaffId === s.staffA, 'heatmap focus forced to own staff id');
});

test('isolation: a setter of one client cannot load another client; a non-member is refused', async () => {
  const s = await fixture();
  const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  asUser(setter);
  const cross = await loadOccupancyView(s.otherClientId, { g: 'dia', d: s.day });
  assert.equal(cross.ok, false, 'cross-client refused');

  const outsider = await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'owner' });
  asUser(outsider);
  const r = await loadOccupancyView(s.clientId, { g: 'dia', d: s.day });
  assert.equal(r.ok, false, 'a login with no scope on this client is refused');
});
