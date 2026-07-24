import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient } from './fixtures.js';

/**
 * SCHED-3 migration BACKFILL logic, proven behaviorally against PostgreSQL. Since the
 * migrated column is NOT NULL we can't recreate a literal NULL-client service in the
 * live table; instead we exercise the EXACT SQL the migration uses to (a) resolve
 * ownership from the three real relations, (b) clone + re-point a service shared by
 * two clients, and (c) decide an orphan's fate. These run against a crafted, real
 * (deliberately inconsistent) dataset — not string inspection.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

/** The migration's ownership-evidence UNION, scoped to one service. */
async function ownersOf(serviceId: string): Promise<string[]> {
  const r = await query<{ client_id: string }>(
    `SELECT DISTINCT client_id FROM (
        SELECT ss.service_id, si.client_id FROM site_services ss JOIN sites si ON si.id = ss.site_id
        UNION SELECT sts.service_id, si.client_id FROM staff_services sts JOIN staff st ON st.id = sts.staff_id JOIN sites si ON si.id = st.site_id
        UNION SELECT a.service_id, a.client_id FROM appointments a
      ) ev WHERE service_id = $1 ORDER BY client_id`,
    [serviceId],
  );
  return r.rows.map((x) => x.client_id).sort();
}

test('(11) a service related to exactly ONE client resolves to that single owner', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  // serviceHaircut is enabled at s.siteId (client A) + assigned to A's staff.
  const owners = await ownersOf(s.serviceHaircut);
  assert.deepEqual(owners, [s.clientId], 'single owner = client A');
});

test('(12) a service SHARED by two clients is cloned + all FKs re-pointed per client', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const bSite = await seedSiteForClient(s.tenantId, s.otherClientId); // client B site + staff

  // The original service belongs to client A.
  const svc = await query<{ id: string }>(
    `INSERT INTO services (tenant_id, client_id, name, description, duration_min, price, buffer_after_min)
       VALUES ($1, $2, 'Shared', 'desc', 45, 33, 5) RETURNING id`,
    [s.tenantId, s.clientId],
  );
  const svcId = svc.rows[0].id;
  // RAW (bypass the hardened repo) pre-migration inconsistency: the SAME service id
  // is used at BOTH clients' sites/staff, and an appointment exists for client B.
  await query(`INSERT INTO site_services (tenant_id, site_id, service_id) VALUES ($1, $2, $3)`, [s.tenantId, s.siteId, svcId]);
  await query(`INSERT INTO site_services (tenant_id, site_id, service_id) VALUES ($1, $2, $3)`, [s.tenantId, bSite.siteId, svcId]);
  await query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3)`, [s.tenantId, s.staffA, svcId]);
  await query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3)`, [s.tenantId, bSite.staffId, svcId]);
  const start = new Date('2027-01-04T15:00:00Z');
  const apptB = await query<{ id: string }>(
    `INSERT INTO appointments
       (tenant_id, client_id, site_id, staff_id, service_id, start_at, service_end_at, blocked_from, blocked_until,
        service_name_snapshot, duration_min_snapshot, origin, created_by_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$7,'Shared',45,'internal','system') RETURNING id`,
    [s.tenantId, s.otherClientId, bSite.siteId, bSite.staffId, svcId, start, new Date(start.getTime() + 45 * 60000)],
  );

  assert.deepEqual(await ownersOf(svcId), [s.clientId, s.otherClientId].sort(), 'detected as shared by A + B');

  // The migration keeps the original for clients[1] (min) and clones for the rest.
  // Run the EXACT clone + re-point SQL for the "other" client (B).
  const copy = await query<{ id: string }>(
    `INSERT INTO services (tenant_id, client_id, name, description, duration_min, price, buffer_before_min, buffer_after_min, active, created_at, updated_at)
     SELECT tenant_id, $2, name, description, duration_min, price, buffer_before_min, buffer_after_min, active, created_at, now()
       FROM services WHERE id = $1 RETURNING id`,
    [svcId, s.otherClientId],
  );
  const copyId = copy.rows[0].id;
  await query(
    `UPDATE site_services ss SET service_id = $3 FROM sites si
      WHERE ss.site_id = si.id AND ss.service_id = $1 AND si.client_id = $2`,
    [svcId, s.otherClientId, copyId],
  );
  await query(
    `UPDATE staff_services sts SET service_id = $3 FROM staff st JOIN sites si ON si.id = st.site_id
      WHERE sts.staff_id = st.id AND sts.service_id = $1 AND si.client_id = $2`,
    [svcId, s.otherClientId, copyId],
  );
  await query(`UPDATE appointments SET service_id = $3 WHERE service_id = $1 AND client_id = $2`, [svcId, s.otherClientId, copyId]);

  // The clone preserved the real fields.
  const copyRow = (await query<{ name: string; price: string; duration_min: number; client_id: string }>(
    `SELECT name, price, duration_min, client_id FROM services WHERE id = $1`,
    [copyId],
  )).rows[0];
  assert.equal(copyRow.name, 'Shared');
  assert.equal(copyRow.price, '33.00');
  assert.equal(copyRow.duration_min, 45);
  assert.equal(copyRow.client_id, s.otherClientId);

  // The SHARED service's B relations now point at the clone; A relations at the
  // original. (B's own seedSiteForClient service is unrelated and left alone.)
  const count = async (sql: string, params: unknown[]): Promise<number> =>
    (await query<{ n: number }>(sql, params)).rows[0].n;
  assert.equal(await count(`SELECT count(*)::int AS n FROM site_services WHERE site_id = $1 AND service_id = $2`, [bSite.siteId, svcId]), 0, "B's site no longer → original");
  assert.equal(await count(`SELECT count(*)::int AS n FROM site_services WHERE site_id = $1 AND service_id = $2`, [bSite.siteId, copyId]), 1, "B's site → clone");
  assert.equal(await count(`SELECT count(*)::int AS n FROM site_services WHERE site_id = $1 AND service_id = $2`, [s.siteId, svcId]), 1, "A's site still → original");
  assert.equal(await count(`SELECT count(*)::int AS n FROM staff_services WHERE staff_id = $1 AND service_id = $2`, [bSite.staffId, copyId]), 1, "B's staff → clone");
  assert.equal(await count(`SELECT count(*)::int AS n FROM staff_services WHERE staff_id = $1 AND service_id = $2`, [s.staffA, svcId]), 1, "A's staff still → original");
  const apptRow = (await query<{ service_id: string }>(`SELECT service_id FROM appointments WHERE id = $1`, [apptB.rows[0].id])).rows[0];
  assert.equal(apptRow.service_id, copyId, "B's appointment → clone");
});

test('(13) orphan-resolution predicate: 1 scheduling client → assign; ≥2 → ambiguous (migration RAISEs)', async () => {
  // A tenant with EXACTLY ONE non-default scheduling client → the migration assigns.
  const one = await seedScenario({ enableScheduling: false });
  tenants.push(one.tenantId);
  await query(`INSERT INTO client_modules (tenant_id, client_id, module_key) VALUES ($1, $2, 'scheduling') ON CONFLICT DO NOTHING`, [one.tenantId, one.clientId]);
  assert.equal(await candidateCount(one.tenantId), 1, 'exactly one → assignable');

  // A tenant with TWO non-default scheduling clients → ambiguous → the migration
  // RAISEs rather than guessing (never assigns to default, never deletes).
  const two = await seedScenario({ enableScheduling: true }); // enables BOTH non-default clients
  tenants.push(two.tenantId);
  assert.equal(await candidateCount(two.tenantId), 2, 'two → ambiguous → migration would stop');
});

/** The migration's orphan-candidate query: non-default clients with scheduling on. */
async function candidateCount(tenantId: string): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM client_modules cm JOIN clients c ON c.id = cm.client_id AND c.tenant_id = cm.tenant_id
      WHERE cm.tenant_id = $1 AND cm.module_key = 'scheduling' AND cm.enabled = true AND c.is_default = false`,
    [tenantId],
  );
  return r.rows[0].n;
}
