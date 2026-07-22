import { query, firstRowOrThrow } from '../../client.js';
import type { SchedulingConfig, WeeklyHours } from '../../../scheduling/types.js';

/**
 * Sites repository — physical locations, each with an IANA timezone, weekly
 * opening hours, and scheduling_config. Tenant-scoped. slug is globally unique so
 * the public /book/{slug} page resolves without a tenant in the URL.
 */

export interface SiteRow {
  id: string;
  tenant_id: string;
  client_id: string;
  slug: string;
  name: string;
  address: string | null;
  timezone: string;
  opening_hours: WeeklyHours;
  scheduling_config: SchedulingConfig;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function listSites(
  tenantId: string,
  opts: { includeInactive?: boolean; clientId?: string | null } = {},
): Promise<SiteRow[]> {
  const params: unknown[] = [tenantId];
  const where = ['tenant_id = $1'];
  if (opts.clientId) {
    params.push(opts.clientId);
    where.push(`client_id = $${params.length}`);
  }
  if (!opts.includeInactive) where.push('active = true');
  const r = await query<SiteRow>(`SELECT * FROM sites WHERE ${where.join(' AND ')} ORDER BY name`, params);
  return r.rows;
}

export async function getSiteById(tenantId: string, id: string): Promise<SiteRow | null> {
  const r = await query<SiteRow>(`SELECT * FROM sites WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return r.rows[0] ?? null;
}

/** PUBLIC resolver: by slug, across tenants, ACTIVE only. Returns the site (incl.
 * its tenant_id) — the only place a slug crosses the tenant boundary, and it never
 * exposes other tenants' data (just the one matching active site). */
export async function getActiveSiteBySlug(slug: string): Promise<SiteRow | null> {
  const r = await query<SiteRow>(`SELECT * FROM sites WHERE slug = $1 AND active = true`, [slug]);
  return r.rows[0] ?? null;
}

export interface CreateSiteInput {
  tenantId: string;
  clientId: string;
  slug: string;
  name: string;
  address?: string | null;
  timezone: string;
  openingHours: WeeklyHours;
  schedulingConfig: SchedulingConfig;
}

export async function createSite(input: CreateSiteInput): Promise<SiteRow> {
  // The composite FK guarantees the client belongs to the tenant, but validate up
  // front for a clean error rather than an FK violation.
  const r = await query<SiteRow>(
    `INSERT INTO sites (tenant_id, client_id, slug, name, address, timezone, opening_hours, scheduling_config)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8
        WHERE EXISTS (SELECT 1 FROM clients WHERE id = $2 AND tenant_id = $1)
     RETURNING *`,
    [
      input.tenantId,
      input.clientId,
      input.slug,
      input.name,
      input.address ?? null,
      input.timezone,
      JSON.stringify(input.openingHours),
      JSON.stringify(input.schedulingConfig),
    ],
  );
  if (!r.rows[0]) throw new Error('createSite: client not found for tenant');
  return firstRowOrThrow(r, 'createSite');
}

export interface UpdateSiteInput {
  slug?: string;
  name?: string;
  address?: string | null;
  timezone?: string;
  openingHours?: WeeklyHours;
  schedulingConfig?: SchedulingConfig;
  active?: boolean;
}

export async function updateSite(tenantId: string, id: string, patch: UpdateSiteInput): Promise<SiteRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id, tenantId];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.slug !== undefined) add('slug', patch.slug);
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.address !== undefined) add('address', patch.address);
  if (patch.timezone !== undefined) add('timezone', patch.timezone);
  if (patch.openingHours !== undefined) add('opening_hours', JSON.stringify(patch.openingHours));
  if (patch.schedulingConfig !== undefined) add('scheduling_config', JSON.stringify(patch.schedulingConfig));
  if (patch.active !== undefined) add('active', patch.active);
  if (sets.length === 0) return getSiteById(tenantId, id);
  sets.push('updated_at = now()');
  const r = await query<SiteRow>(
    `UPDATE sites SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    params,
  );
  return r.rows[0] ?? null;
}

/** Soft-delete: sites are deactivated, never physically removed (they anchor
 * appointment history). Returns true if a site was deactivated. */
export async function deactivateSite(tenantId: string, id: string): Promise<boolean> {
  const r = await query(
    `UPDATE sites SET active = false, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND active = true`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}
