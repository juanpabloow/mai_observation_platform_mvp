import { pool, query } from '../db/client.js';
import { issueToken, type Capability } from '../db/repositories/handoffTokens.js';
import { setClientModuleEnabled } from '../db/repositories/clientModules.js';
import { resolveContactByIdentity } from '../db/repositories/contactIdentities.js';
import { createFieldDefinition } from '../db/repositories/clientFieldDefinitions.js';
import type { WeeklyHours } from '../scheduling/types.js';

/**
 * NOT for production. Seeds a self-contained machine-API demo (two tenants, so isolation
 * can be shown) and prints a JSON block of ids + raw tokens for the doc-example curl run
 * (docs/machine-api-v1.md). Re-runnable: it wipes + recreates its two fixed demo tenants.
 *
 * Run against a throwaway DB, e.g.:
 *   DATABASE_URL=$TEST_DATABASE_URL npm run seed:machine-demo
 */
const TENANT_A = '33333333-3333-3333-3333-333333333333';
const TENANT_B = '44444444-4444-4444-4444-444444444444';
const WORKFLOW_REF = 'demo-crm-wf';

const WEEK: WeeklyHours = {
  mon: [{ start: '08:00', end: '20:00' }],
  tue: [{ start: '08:00', end: '20:00' }],
  wed: [{ start: '08:00', end: '20:00' }],
  thu: [{ start: '08:00', end: '20:00' }],
  fri: [{ start: '08:00', end: '20:00' }],
  sat: [{ start: '08:00', end: '20:00' }],
  sun: [{ start: '08:00', end: '20:00' }],
};

async function seedTenant(tenantId: string, name: string, workflowRef: string): Promise<{
  clientId: string;
  connectionId: string;
  siteId: string;
  services: Record<string, string>;
  staff: Record<string, string>;
}> {
  await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  await query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, name]);
  await query(`INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, 'Unassigned', true)`, [tenantId]);
  const client = await query<{ id: string }>(
    `INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, $2, false) RETURNING id`,
    [tenantId, `${name} Barbershop`],
  );
  const clientId = client.rows[0].id;
  await setClientModuleEnabled({ tenantId, clientId, moduleKey: 'scheduling', enabled: true });
  await setClientModuleEnabled({ tenantId, clientId, moduleKey: 'crm', enabled: true });
  await setClientModuleEnabled({ tenantId, clientId, moduleKey: 'inbox', enabled: true });

  const conn = await query<{ id: string }>(
    `INSERT INTO n8n_connections (tenant_id, name, n8n_base_url, n8n_api_key_encrypted)
       VALUES ($1, 'demo-conn', 'https://n8n.local', 'x') RETURNING id`,
    [tenantId],
  );
  const connectionId = conn.rows[0].id;
  await query(
    `INSERT INTO workflows (tenant_id, n8n_connection_id, n8n_workflow_id, name, client_id, last_synced_at)
       VALUES ($1, $2, $3, 'Demo CRM workflow', $4, now())`,
    [tenantId, connectionId, workflowRef, clientId],
  );

  const site = await query<{ id: string }>(
    `INSERT INTO sites (tenant_id, client_id, slug, name, address, timezone, opening_hours, scheduling_config)
       VALUES ($1, $2, $3, 'Demo Barbershop', 'Cra 7 #1-23, Bogotá', 'America/Bogota', $4,
         '{"slot_interval_min":30,"min_notice_min":0,"booking_horizon_days":60,"default_buffer_before_min":0,"default_buffer_after_min":0}'::jsonb)
     RETURNING id`,
    [tenantId, clientId, `demo-${tenantId.slice(0, 8)}`, JSON.stringify(WEEK)],
  );
  const siteId = site.rows[0].id;

  const mkStaff = async (n: string) =>
    (await query<{ id: string }>(`INSERT INTO staff (tenant_id, site_id, name, working_hours) VALUES ($1,$2,$3,'{}'::jsonb) RETURNING id`, [tenantId, siteId, n])).rows[0].id;
  const staff = { ana: await mkStaff('Ana Gómez'), beto: await mkStaff('Beto Ruiz') };

  const mkService = async (n: string, dur: number, price: number) => {
    const id = (await query<{ id: string }>(`INSERT INTO services (tenant_id, client_id, name, duration_min, price) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [tenantId, clientId, n, dur, price])).rows[0].id;
    await query(`INSERT INTO site_services (tenant_id, site_id, service_id) VALUES ($1,$2,$3)`, [tenantId, siteId, id]);
    for (const st of Object.values(staff)) await query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1,$2,$3)`, [tenantId, st, id]);
    return id;
  };
  const services = { haircut: await mkService('Corte de cabello', 45, 35000), combo: await mkService('Corte + barba', 75, 50000) };

  // A "Barbero preferido" client field so field-definitions + custom_fields examples are real.
  await createFieldDefinition({ tenantId, clientId, key: 'barbero_preferido', label: 'Barbero preferido', type: 'text' });

  return { clientId, connectionId, siteId, services, staff };
}

async function main(): Promise<void> {
  const a = await seedTenant(TENANT_A, 'Demo A', WORKFLOW_REF);
  const b = await seedTenant(TENANT_B, 'Demo B', 'demo-b-wf');

  // A contact in tenant B (for the isolation test: a tenant-A token must not read it).
  const foreign = await resolveContactByIdentity({ tenantId: TENANT_B, clientId: b.clientId, channel: 'api', channelUserId: '+573001110000', name: 'Foreign Person' });

  const issue = async (caps: Capability[]) => (await issueToken(TENANT_A, a.connectionId, caps)).rawToken;
  const out = {
    baseUrl: 'http://localhost:3111',
    workflowRef: WORKFLOW_REF,
    foreignWorkflowRef: 'demo-b-wf', // belongs to tenant B's connection → 404 for a tenant-A token
    tokens: {
      full: await issue(['handoff', 'scheduling.read', 'scheduling.write', 'crm.read', 'crm.write']),
      legacy: await issue(['handoff', 'scheduling.read', 'scheduling.write']),
      crmRead: await issue(['crm.read']),
      schedRead: await issue(['scheduling.read']),
    },
    clientId: a.clientId,
    siteId: a.siteId,
    services: a.services,
    staff: a.staff,
    foreignContactId: foreign.contact.id,
  };
  console.log('SEED_JSON=' + JSON.stringify(out));
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
