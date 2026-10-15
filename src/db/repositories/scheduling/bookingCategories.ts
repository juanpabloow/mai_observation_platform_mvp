import { query } from '../../client.js';

/**
 * BOOKING PAGE CATALOG (migration 1804) — the business's own groups for the public page
 * and each service's presentation on it. Presentation only: nothing here touches a
 * service's name, duration, price, `active` flag or site enablement, so the agenda and
 * the bot are never affected by how the page shows a service.
 *
 * ISOLATION: every read and write is scoped by (tenant_id, client_id). A category or an
 * upgrade target can only be set when it belongs to the SAME client as the service — the
 * check is in the UPDATE's WHERE, so a forged id from another client matches no row.
 */

export type CategoryLayout = 'list' | 'featured' | 'contact';

export interface BookingCategoryRow {
  id: string;
  name: string;
  tagline: string | null;
  layout: CategoryLayout;
  sort_order: number;
  visible: boolean;
  /** Services of this client currently in the group. */
  service_count: number;
  updated_at: Date;
}

export async function listBookingCategories(tenantId: string, clientId: string): Promise<BookingCategoryRow[]> {
  const r = await query<BookingCategoryRow>(
    `SELECT c.id, c.name, c.tagline, c.layout, c.sort_order, c.visible, c.updated_at,
            (SELECT count(*)::int FROM services s
              WHERE s.public_category_id = c.id AND s.tenant_id = c.tenant_id AND s.client_id = c.client_id) AS service_count
       FROM booking_categories c
      WHERE c.tenant_id = $1 AND c.client_id = $2
      ORDER BY c.sort_order, lower(c.name)`,
    [tenantId, clientId],
  );
  return r.rows;
}

export interface BookingCategoryInput {
  name: string;
  tagline: string | null;
  layout: CategoryLayout;
  sortOrder: number;
  visible: boolean;
}

/** Thrown when the name is already used by another group of the same client. */
export class BookingCategoryNameTaken extends Error {}

function rethrowNameTaken(err: unknown): never {
  if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') throw new BookingCategoryNameTaken('name taken');
  throw err;
}

export async function createBookingCategory(tenantId: string, clientId: string, input: BookingCategoryInput): Promise<string> {
  try {
    const r = await query<{ id: string }>(
      `INSERT INTO booking_categories (tenant_id, client_id, name, tagline, layout, sort_order, visible)
         SELECT $1, $2, $3, $4, $5, $6, $7
          WHERE EXISTS (SELECT 1 FROM clients WHERE id = $2 AND tenant_id = $1)
       RETURNING id`,
      [tenantId, clientId, input.name, input.tagline, input.layout, input.sortOrder, input.visible],
    );
    if (!r.rows[0]) throw new Error('createBookingCategory: client not found for tenant');
    return r.rows[0].id;
  } catch (err) {
    rethrowNameTaken(err);
  }
}

export async function updateBookingCategory(tenantId: string, clientId: string, id: string, input: BookingCategoryInput): Promise<boolean> {
  try {
    const r = await query(
      `UPDATE booking_categories
          SET name = $4, tagline = $5, layout = $6, sort_order = $7, visible = $8, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
      [id, tenantId, clientId, input.name, input.tagline, input.layout, input.sortOrder, input.visible],
    );
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    rethrowNameTaken(err);
  }
}

/** Deleting a group only ungroups its services (FK ON DELETE SET NULL) — none is hidden. */
export async function deleteBookingCategory(tenantId: string, clientId: string, id: string): Promise<boolean> {
  const r = await query(`DELETE FROM booking_categories WHERE id = $1 AND tenant_id = $2 AND client_id = $3`, [id, tenantId, clientId]);
  return (r.rowCount ?? 0) > 0;
}

export interface ServicePresentationInput {
  categoryId: string | null;
  visible: boolean;
  sort: number;
  recommended: boolean;
  includes: string[] | null;
  upgradeServiceId: string | null;
}

/**
 * Set a service's presentation. Returns false — and writes nothing — when the service is
 * not this client's, or the category / upgrade target is not this client's (or is the
 * service itself).
 */
export async function updateServicePresentation(
  tenantId: string,
  clientId: string,
  serviceId: string,
  p: ServicePresentationInput,
): Promise<boolean> {
  const r = await query(
    `UPDATE services s
        SET public_category_id = $4, public_visible = $5, public_sort = $6, public_recommended = $7,
            public_includes = $8, public_upgrade_service_id = $9, updated_at = now()
      WHERE s.id = $1 AND s.tenant_id = $2 AND s.client_id = $3
        AND ($4::uuid IS NULL OR EXISTS (
              SELECT 1 FROM booking_categories c WHERE c.id = $4 AND c.tenant_id = $2 AND c.client_id = $3))
        AND ($9::uuid IS NULL OR EXISTS (
              SELECT 1 FROM services u WHERE u.id = $9 AND u.tenant_id = $2 AND u.client_id = $3 AND u.id <> s.id))`,
    [serviceId, tenantId, clientId, p.categoryId, p.visible, p.sort, p.recommended, p.includes, p.upgradeServiceId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Set (or clear) a service's page image; returns the previous URL for cleanup. */
export async function setServiceImage(
  tenantId: string,
  clientId: string,
  serviceId: string,
  url: string | null,
): Promise<{ ok: boolean; previous: string | null }> {
  const r = await query<{ previous: string | null }>(
    `UPDATE services s SET public_image_url = $4, updated_at = now()
       FROM (SELECT public_image_url AS previous FROM services WHERE id = $1 AND tenant_id = $2 AND client_id = $3) old
      WHERE s.id = $1 AND s.tenant_id = $2 AND s.client_id = $3
      RETURNING old.previous`,
    [serviceId, tenantId, clientId, url],
  );
  return r.rows[0] ? { ok: true, previous: r.rows[0].previous } : { ok: false, previous: null };
}
