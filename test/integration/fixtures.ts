import { randomUUID } from 'node:crypto';
import { query, pool } from '../../src/db/client.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
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
  /** The tenant's real default/"Unassigned" client (is_default = true). */
  defaultClientId: string;
  /** A real NON-DEFAULT client that owns the seeded site. */
  clientId: string;
  /** A second real NON-DEFAULT client in the SAME tenant (client-isolation tests). */
  otherClientId: string;
  siteId: string;
  siteSlug: string;
  staffA: string;
  staffB: string;
  serviceHaircut: string; // 60 min
  serviceBeard: string; // 30 min
  serviceColor: string; // 90 min
}

/**
 * Seed a tenant with a SEPARATE default client plus two real non-default clients
 * (clientId owns the site; otherClientId is for isolation). Modules are OFF by
 * default so the "module absent" tests stay valid; a booking suite opts in with
 * `enableScheduling` (enabled for BOTH non-default clients, since some tests book
 * at otherClientId's site) and/or `enableCrm`.
 */
export async function seedScenario(
  opts: { openingHours?: WeeklyHours; enableScheduling?: boolean; enableCrm?: boolean } = {},
): Promise<Scenario> {
  const tenantId = randomUUID();
  await query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `Test Tenant ${tenantId.slice(0, 8)}`]);

  const mkClient = async (name: string, isDefault: boolean): Promise<string> => {
    const r = await query<{ id: string }>(
      `INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, name, isDefault],
    );
    return r.rows[0].id;
  };
  const defaultClientId = await mkClient('Unassigned', true);
  const clientId = await mkClient('Business A', false);
  const otherClientId = await mkClient('Business B', false);

  const slug = `shop-${tenantId.slice(0, 8)}`;
  const site = await query<{ id: string }>(
    `INSERT INTO sites (tenant_id, client_id, slug, name, timezone, opening_hours, scheduling_config)
       VALUES ($1, $2, $3, 'Test Barbershop', 'America/Bogota', $4,
         '{"slot_interval_min":30,"min_notice_min":0,"booking_horizon_days":365,"default_buffer_before_min":0,"default_buffer_after_min":0}'::jsonb)
     RETURNING id`,
    [tenantId, clientId, slug, JSON.stringify(opts.openingHours ?? OPEN_9_18)],
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
    // Services are per-CLIENT — the seeded site belongs to `clientId` (Business A).
    const r = await query<{ id: string }>(
      `INSERT INTO services (tenant_id, client_id, name, duration_min, price) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, clientId, name, dur, price],
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

  // Opt-in module enablement (only booking suites need it) — enabled for BOTH
  // non-default clients so tests that book at otherClientId's site work too.
  if (opts.enableScheduling) {
    for (const c of [clientId, otherClientId]) {
      await setClientModuleEnabled({ tenantId, clientId: c, moduleKey: 'scheduling', enabled: true });
    }
  }
  if (opts.enableCrm) {
    for (const c of [clientId, otherClientId]) {
      await setClientModuleEnabled({ tenantId, clientId: c, moduleKey: 'crm', enabled: true });
    }
  }

  return { tenantId, defaultClientId, clientId, otherClientId, siteId, siteSlug: slug, staffA, staffB, serviceHaircut, serviceBeard, serviceColor };
}

/** Helpers for the client-scoping tests. */
export async function seedSiteForClient(tenantId: string, clientId: string): Promise<{ siteId: string; staffId: string; serviceId: string }> {
  const slug = `shop-${randomUUID().slice(0, 8)}`;
  const site = await query<{ id: string }>(
    `INSERT INTO sites (tenant_id, client_id, slug, name, timezone, opening_hours, scheduling_config)
       VALUES ($1, $2, $3, 'Other Site', 'America/Bogota', $4,
         '{"slot_interval_min":30,"min_notice_min":0,"booking_horizon_days":365,"default_buffer_before_min":0,"default_buffer_after_min":0}'::jsonb)
     RETURNING id`,
    [tenantId, clientId, slug, JSON.stringify(OPEN_9_18)],
  );
  const siteId = site.rows[0].id;
  const staff = await query<{ id: string }>(
    `INSERT INTO staff (tenant_id, site_id, name, working_hours) VALUES ($1, $2, 'Other Barber', '{}'::jsonb) RETURNING id`,
    [tenantId, siteId],
  );
  const svc = await query<{ id: string }>(
    `INSERT INTO services (tenant_id, client_id, name, duration_min, price) VALUES ($1, $2, 'Other Svc', 30, 10) RETURNING id`,
    [tenantId, clientId],
  );
  await query(`INSERT INTO site_services (tenant_id, site_id, service_id) VALUES ($1, $2, $3)`, [tenantId, siteId, svc.rows[0].id]);
  await query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3)`, [tenantId, staff.rows[0].id, svc.rows[0].id]);
  return { siteId, staffId: staff.rows[0].id, serviceId: svc.rows[0].id };
}

/** Insert an n8n connection + a synced workflow row owned by `clientId`. Returns
 * the connection id (the machine-scope tests need it; older callers ignore it).
 * Pass an existing `connectionId` to add a workflow under the SAME connection. */
export async function seedWorkflow(
  tenantId: string,
  clientId: string,
  n8nWorkflowId: string,
  connectionId?: string,
): Promise<{ connectionId: string }> {
  let connId = connectionId;
  if (!connId) {
    const conn = await query<{ id: string }>(
      `INSERT INTO n8n_connections (tenant_id, name, n8n_base_url, n8n_api_key_encrypted)
         VALUES ($1, 'conn', 'https://n8n.local', 'x') RETURNING id`,
      [tenantId],
    );
    connId = conn.rows[0].id;
  }
  await query(
    `INSERT INTO workflows (tenant_id, n8n_connection_id, n8n_workflow_id, name, client_id, last_synced_at)
       VALUES ($1, $2, $3, $3, $4, now())`,
    [tenantId, connId, n8nWorkflowId, clientId],
  );
  return { connectionId: connId };
}

/** Reassign a synced workflow (by n8n id) to a different client — used to prove
 * the machine scope re-resolves after a workflow moves between clients. */
export async function reassignWorkflow(tenantId: string, n8nWorkflowId: string, newClientId: string): Promise<void> {
  await query(
    `UPDATE workflows SET client_id = $3, updated_at = now()
      WHERE tenant_id = $1 AND n8n_workflow_id = $2`,
    [tenantId, n8nWorkflowId, newClientId],
  );
}

export async function cleanupTenant(tenantId: string): Promise<void> {
  await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

// ── C-3 CRM fixtures (recovered from PR #2) ─────────────────────────────────────
export async function seedContact(
  tenantId: string,
  clientId: string,
  opts: { name?: string; channelUserId?: string } = {},
): Promise<string> {
  const cuid = opts.channelUserId ?? `wa:${randomUUID().slice(0, 10)}`;
  const r = await query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, client_id, channel, channel_user_id, name) VALUES ($1, $2, 'test', $3, $4) RETURNING id`,
    [tenantId, clientId, cuid, opts.name ?? 'Test Person'],
  );
  return r.rows[0].id;
}

export async function seedMember(
  tenantId: string,
  opts: { role?: 'owner' | 'admin' | 'member'; clientId?: string } = {},
): Promise<string> {
  const role = opts.role ?? 'owner';
  const memberClientId = role === 'member' ? opts.clientId ?? null : null;
  if (role === 'member' && !memberClientId) throw new Error('seedMember: role "member" requires a clientId');
  const userId = randomUUID();
  await query(`INSERT INTO "user" ("id", "name", "email", "emailVerified") VALUES ($1, $2, $3, true)`, [
    userId,
    `U ${userId.slice(0, 6)}`,
    `${userId.slice(0, 8)}@test.local`,
  ]);
  await query(`INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id) VALUES ($1, $2, $3, $4)`, [tenantId, userId, role, memberClientId]);
  return userId;
}

export async function removeMember(tenantId: string, userId: string): Promise<void> {
  await query(`DELETE FROM tenant_members WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
}

/** A UTC instant for a local Bogota wall-clock time on 2026-08-05 (a Wednesday). */
export { OPEN_9_18 };
