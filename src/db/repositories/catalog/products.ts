import { query, firstRowOrThrow } from '../../client.js';

/**
 * CATALOG-2 repository — a client's PRODUCT catalogue (what the business sells,
 * beyond its services). Every function is scoped by tenant_id AND client_id: a
 * product belongs to exactly one client and is never shared or reachable across
 * clients. INFORM ONLY — there is no stock quantity, no order, no reservation here.
 *
 * `price` comes back from pg as a STRING (numeric), exactly like services.price, so
 * the one money helper (priceLabelCOP) formats both the same way. Soft delete only
 * (is_active) — a future sales phase references products, so rows are archived, never
 * dropped; `in_stock` is the separate manual availability switch.
 */

export interface ProductRow {
  id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  description: string | null;
  price: string; // numeric(10,2) comes back as a string from pg
  category: string | null;
  in_stock: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface CreateProductInput {
  tenantId: string;
  clientId: string;
  name: string;
  description?: string | null;
  price: number;
  category?: string | null;
  inStock?: boolean;
  sortOrder?: number;
}

export interface UpdateProductInput {
  name?: string;
  description?: string | null;
  price?: number;
  category?: string | null;
  inStock?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

/** All products for a client, newest ordering first by (sort_order, name). Active
 *  only unless `includeInactive` (the management list shows archived rows too). */
export async function listProducts(
  tenantId: string,
  clientId: string,
  includeInactive = false,
): Promise<ProductRow[]> {
  const r = await query<ProductRow>(
    `SELECT * FROM products
      WHERE tenant_id = $1 AND client_id = $2 ${includeInactive ? '' : 'AND is_active = true'}
      ORDER BY sort_order, name`,
    [tenantId, clientId],
  );
  return r.rows;
}

/** The machine-API read: ACTIVE products of a client, optional case-insensitive
 *  exact category filter, ordered by (sort_order, name). Out-of-stock rows are
 *  INCLUDED (in_stock = false) so the bot can say "lo tenemos, pero está agotado"
 *  rather than "no existe". Name search (accent-insensitive) is applied in the route
 *  over this bounded list — Postgres can't fold accents without an extension, and the
 *  catalogue is small. */
export async function listActiveProducts(
  tenantId: string,
  clientId: string,
  opts: { category?: string | null } = {},
): Promise<ProductRow[]> {
  const params: unknown[] = [tenantId, clientId];
  let categoryClause = '';
  if (opts.category && opts.category.trim() !== '') {
    params.push(opts.category.trim());
    categoryClause = `AND lower(btrim(category)) = lower(btrim($${params.length}))`;
  }
  const r = await query<ProductRow>(
    `SELECT * FROM products
      WHERE tenant_id = $1 AND client_id = $2 AND is_active = true ${categoryClause}
      ORDER BY sort_order, name`,
    params,
  );
  return r.rows;
}

export async function getProductById(
  tenantId: string,
  clientId: string,
  id: string,
): Promise<ProductRow | null> {
  const r = await query<ProductRow>(
    `SELECT * FROM products WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [id, tenantId, clientId],
  );
  return r.rows[0] ?? null;
}

/** Create a product. A duplicate ACTIVE name (case/whitespace-folded) in the same
 *  client raises a unique-violation (SQLSTATE 23505) from products_client_active_name_unique;
 *  the caller (the server action) maps it to a human message. */
export async function createProduct(input: CreateProductInput): Promise<ProductRow> {
  const r = await query<ProductRow>(
    `INSERT INTO products (tenant_id, client_id, name, description, price, category, in_stock, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      input.tenantId,
      input.clientId,
      input.name,
      input.description ?? null,
      input.price,
      input.category ?? null,
      input.inStock ?? true,
      input.sortOrder ?? 0,
    ],
  );
  return firstRowOrThrow(r, 'createProduct');
}

/** Patch a product; dynamic SET, always pinned to (id, tenant_id, client_id). A
 *  name collision with another ACTIVE product raises 23505 (caller maps it). */
export async function updateProduct(
  tenantId: string,
  clientId: string,
  id: string,
  patch: UpdateProductInput,
): Promise<ProductRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id, tenantId, clientId];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.description !== undefined) add('description', patch.description);
  if (patch.price !== undefined) add('price', patch.price);
  if (patch.category !== undefined) add('category', patch.category);
  if (patch.inStock !== undefined) add('in_stock', patch.inStock);
  if (patch.isActive !== undefined) add('is_active', patch.isActive);
  if (patch.sortOrder !== undefined) add('sort_order', patch.sortOrder);
  if (sets.length === 0) return getProductById(tenantId, clientId, id);
  sets.push('updated_at = now()');
  const r = await query<ProductRow>(
    `UPDATE products SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 AND client_id = $3 RETURNING *`,
    params,
  );
  return r.rows[0] ?? null;
}

/** Flip the manual availability switch. Returns false if no such product for this
 *  client. Allowed for the Setter (the counter sees a product run out). */
export async function setProductStock(
  tenantId: string,
  clientId: string,
  id: string,
  inStock: boolean,
): Promise<boolean> {
  const r = await query(
    `UPDATE products SET in_stock = $4, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [id, tenantId, clientId, inStock],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Archive (soft delete). Returns false if already archived or not this client's. */
export async function archiveProduct(tenantId: string, clientId: string, id: string): Promise<boolean> {
  const r = await query(
    `UPDATE products SET is_active = false, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND is_active = true`,
    [id, tenantId, clientId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Restore an archived product. Returns false if already active or not this client's.
 *  Can raise 23505 if restoring would collide with a live product of the same name. */
export async function restoreProduct(tenantId: string, clientId: string, id: string): Promise<boolean> {
  const r = await query(
    `UPDATE products SET is_active = true, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND is_active = false`,
    [id, tenantId, clientId],
  );
  return (r.rowCount ?? 0) > 0;
}
