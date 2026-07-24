import type { PoolClient } from 'pg';
import { query } from '../client.js';
import type { ClientModuleKey } from '../../modules/registry.js';

/**
 * client_modules repository — which modules a CLIENT has enabled (Phase 1 of the
 * modular system). Plain parameterized SQL, EVERY query tenant-scoped. The
 * ABSENCE of a row means disabled; disabling flips `enabled` on the existing row
 * and never deletes it (settings survive an off/on cycle).
 *
 * Cross-tenant safety: setClientModuleEnabled writes via INSERT … SELECT guarded
 * by an EXISTS over clients (id, tenant_id) — a client id from another tenant
 * (or a nonexistent one) selects zero rows, so NOTHING is written and the caller
 * gets null. Reads all filter by tenant_id. The DB composite FK is the belt to
 * this suspender.
 */

export interface ClientModuleRow {
  id: string;
  tenant_id: string;
  client_id: string;
  module_key: ClientModuleKey;
  enabled: boolean;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/** All module rows (enabled or not) for one client of this tenant. */
export async function listClientModules(tenantId: string, clientId: string): Promise<ClientModuleRow[]> {
  const r = await query<ClientModuleRow>(
    `SELECT * FROM client_modules
      WHERE tenant_id = $1 AND client_id = $2
      ORDER BY module_key`,
    [tenantId, clientId],
  );
  return r.rows;
}

/** All module rows across the tenant's clients — ONE query (no N+1); callers
 * group by client_id as needed. */
export async function listClientModulesForTenant(tenantId: string): Promise<ClientModuleRow[]> {
  const r = await query<ClientModuleRow>(
    `SELECT * FROM client_modules
      WHERE tenant_id = $1
      ORDER BY client_id, module_key`,
    [tenantId],
  );
  return r.rows;
}

/** True iff an ENABLED row exists. No row (or enabled=false) → false. */
export async function isClientModuleEnabled(
  tenantId: string,
  clientId: string,
  moduleKey: ClientModuleKey,
): Promise<boolean> {
  const r = await query<{ enabled: boolean }>(
    `SELECT enabled FROM client_modules
      WHERE tenant_id = $1 AND client_id = $2 AND module_key = $3`,
    [tenantId, clientId, moduleKey],
  );
  return r.rows[0]?.enabled ?? false;
}

/**
 * Is `scheduling` bookable for this client? True iff the client is a NON-DEFAULT
 * client of the tenant AND has an enabled scheduling row. Non-transactional —
 * used for read-only checks (e.g. the idempotent-replay gate). A default client
 * can never be bookable even with a forced row.
 */
export async function isSchedulingBookable(tenantId: string, clientId: string): Promise<boolean> {
  const r = await query<{ ok: boolean }>(
    `SELECT true AS ok
       FROM client_modules cm
       JOIN clients c ON c.id = cm.client_id AND c.tenant_id = cm.tenant_id AND c.is_default = false
      WHERE cm.tenant_id = $1 AND cm.client_id = $2
        AND cm.module_key = 'scheduling' AND cm.enabled = true`,
    [tenantId, clientId],
  );
  return r.rows.length > 0;
}

/**
 * TRANSACTION-AWARE scheduling gate for the booking write path. Runs on the txn
 * client and takes `FOR SHARE OF cm` on the client_modules row, so a concurrent
 * setClientModuleEnabled (which UPDATEs that row, needing FOR UPDATE) SERIALIZES
 * with the booking: either the disable commits first (this sees enabled=false →
 * false) or the booking commits first (the disable waits). Also requires a
 * NON-DEFAULT client. Absent row → false (nothing to lock; absent = disabled).
 */
export async function isSchedulingEnabledForUpdate(
  client: PoolClient,
  tenantId: string,
  clientId: string,
): Promise<boolean> {
  const r = await client.query<{ ok: boolean }>(
    `SELECT true AS ok
       FROM client_modules cm
       JOIN clients c ON c.id = cm.client_id AND c.tenant_id = cm.tenant_id AND c.is_default = false
      WHERE cm.tenant_id = $1 AND cm.client_id = $2
        AND cm.module_key = 'scheduling' AND cm.enabled = true
      FOR SHARE OF cm`,
    [tenantId, clientId],
  );
  return r.rows.length > 0;
}

export interface SetClientModuleEnabledInput {
  tenantId: string;
  clientId: string;
  moduleKey: ClientModuleKey;
  enabled: boolean;
  /** Optional: when omitted, an UPDATE keeps the row's existing settings and an
   * INSERT starts from {}. When given, it must be a JSON object (DB CHECK). */
  settings?: Record<string, unknown>;
}

/**
 * Upsert on (tenant_id, client_id, module_key). The INSERT is an
 * INSERT … SELECT that requires the client to exist IN THIS TENANT — a foreign
 * or unknown client writes nothing and returns null. On conflict, `enabled`
 * (and `settings` only when supplied) are updated on the SAME row.
 */
export async function setClientModuleEnabled(
  input: SetClientModuleEnabledInput,
): Promise<ClientModuleRow | null> {
  const hasSettings = input.settings !== undefined;
  const r = await query<ClientModuleRow>(
    `INSERT INTO client_modules (tenant_id, client_id, module_key, enabled, settings)
       SELECT $1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb)
        WHERE EXISTS (SELECT 1 FROM clients WHERE id = $2 AND tenant_id = $1)
     ON CONFLICT (tenant_id, client_id, module_key) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           -- Omitted settings ($5 NULL) preserve the row's current settings.
           settings = CASE WHEN $5::jsonb IS NULL THEN client_modules.settings
                           ELSE EXCLUDED.settings END,
           updated_at = now()
     RETURNING *`,
    [
      input.tenantId,
      input.clientId,
      input.moduleKey,
      input.enabled,
      hasSettings ? JSON.stringify(input.settings) : null,
    ],
  );
  return r.rows[0] ?? null;
}
