import { randomUUID } from 'node:crypto';
import { query, pool } from '../../src/db/client.js';
import type { WeeklyHours } from '../../src/scheduling/types.js';

/**
 * Integration-test fixtures. Each test creates its OWN tenant (unique id) so tests
 * are isolated without truncating shared tables — a tenant is the isolation
 * boundary, which is exactly what several tests assert. cleanupTenant removes a
 * tenant (CASCADE takes its scheduling data with it).
 */

const OPEN_9_18: WeeklyHours = {
  mon: [{ start: '09:00', end: '18:00' }],
  tue: [{ start: '09:00', end: '18:00' }],
  wed: [{ start: '09:00', end: '18:00' }],
  thu: [{ start: '09:00', end: '18:00' }],
  fri: [{ start: '09:00', end: '18:00' }],
  sat: [{ start: '09:00', end: '18:00' }],
};

export interface Scenario {
  tenantId: string;
  siteId: string;
  siteSlug: string;
  staffA: string;
  staffB: string;
  serviceHaircut: string; // 60 min
  serviceBeard: string; // 30 min
  serviceColor: string; // 90 min
}

export async function seedScenario(opts: { openingHours?: WeeklyHours } = {}): Promise<Scenario> {
  const tenantId = randomUUID();
  await query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `Test Tenant ${tenantId.slice(0, 8)}`]);

  const slug = `shop-${tenantId.slice(0, 8)}`;
  const site = await query<{ id: string }>(
    `INSERT INTO sites (tenant_id, slug, name, timezone, opening_hours, scheduling_config)
       VALUES ($1, $2, 'Test Barbershop', 'America/Bogota', $3,
         '{"slot_interval_min":30,"min_notice_min":0,"booking_horizon_days":365,"default_buffer_before_min":0,"default_buffer_after_min":0}'::jsonb)
     RETURNING id`,
    [tenantId, slug, JSON.stringify(opts.openingHours ?? OPEN_9_18)],
  );
  const siteId = site.rows[0].id;

  const mkStaff = async (name: string): Promise<string> => {
    const r = await query<{ id: string }>(
      `INSERT INTO staff (tenant_id, site_id, name, working_hours) VALUES ($1, $2, $3, '{}'::jsonb) RETURNING id`,
      [tenantId, siteId, name],
    );
    return r.rows[0].id;
  };
  const staffA = await mkStaff('Ana');
  const staffB = await mkStaff('Beto');

  const mkService = async (name: string, dur: number, price: number): Promise<string> => {
    const r = await query<{ id: string }>(
      `INSERT INTO services (tenant_id, name, duration_min, price) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, name, dur, price],
    );
    const id = r.rows[0].id;
    await query(`INSERT INTO site_services (tenant_id, site_id, service_id) VALUES ($1, $2, $3)`, [tenantId, siteId, id]);
    return id;
  };
  const serviceHaircut = await mkService('Haircut', 60, 30);
  const serviceBeard = await mkService('Beard trim', 30, 15);
  const serviceColor = await mkService('Color', 90, 80);

  // Both staff perform haircut + beard; only Ana does color.
  for (const svc of [serviceHaircut, serviceBeard]) {
    for (const st of [staffA, staffB]) {
      await query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3)`, [tenantId, st, svc]);
    }
  }
  await query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3)`, [tenantId, staffA, serviceColor]);

  return { tenantId, siteId, siteSlug: slug, staffA, staffB, serviceHaircut, serviceBeard, serviceColor };
}

export async function cleanupTenant(tenantId: string): Promise<void> {
  await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

/** A UTC instant for a local Bogota wall-clock time on 2026-08-05 (a Wednesday). */
export { OPEN_9_18 };
