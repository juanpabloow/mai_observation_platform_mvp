"use server";

import { revalidatePath } from "next/cache";
import { NO_PERMISSION } from "./access";
import { resolveClientModuleContext } from "./clientModuleAccess";
import {
  normalizeProductCategory,
  normalizeProductDescription,
  normalizeProductName,
  normalizeProductPrice,
} from "./catalogValidation";
import {
  archiveProduct,
  createProduct,
  restoreProduct,
  setProductStock,
  updateProduct,
} from "@worker/db/repositories/catalog/products.js";

/**
 * CLIENT-ADMIN CRUD for a single client's PRODUCT catalogue. Two authorization tiers,
 * both enforced server-side (the UI only hides controls — it never substitutes for this):
 *
 *   MANAGE  (create / edit / archive / restore / reorder, i.e. anything that changes a
 *            name, price or existence) — the agency OR this client's OWNER (canManageCatalog).
 *   READ+toggle availability (in_stock) — also the SETTER (canReadCatalog): they answer
 *            customers about products and flip a product to "agotado" when it runs out,
 *            but never touch prices or names.
 *
 * Every action resolves the route clientId against the session scope first
 * (resolveClientModuleContext: valid UUID, in-tenant, non-default, catalog module ON) —
 * so a forged clientId or a disabled module is an indistinguishable generic refusal — and
 * then the role predicate. The clientId used for the write is always the VALIDATED route
 * client, never a form field, so an action can't cross into another client.
 */

export type CatalogResult = { ok: true; id?: string } | { ok: false; error: string };

const UNAVAILABLE = "El catálogo no está disponible para este cliente.";
const DUPLICATE = "Ya existe un producto activo con ese nombre.";

/** MANAGE tier — products.manage (agency, Dueño). Returns the validated tenantId or an error. */
async function requireCatalogManager(
  clientId: string,
): Promise<{ ok: true; tenantId: string } | { ok: false; error: string }> {
  const res = await resolveClientModuleContext(clientId, "catalog", "products.manage");
  if (!res.ok) {
    return { ok: false, error: res.forbidden ? NO_PERMISSION : UNAVAILABLE };
  }
  return { ok: true, tenantId: res.context.scope.tenantId };
}

/** STOCK tier — products.stock (agency, Dueño, Recepción): the in_stock toggle. */
async function requireCatalogStock(
  clientId: string,
): Promise<{ ok: true; tenantId: string } | { ok: false; error: string }> {
  const res = await resolveClientModuleContext(clientId, "catalog", "products.stock");
  if (!res.ok) {
    return { ok: false, error: res.forbidden ? NO_PERMISSION : UNAVAILABLE };
  }
  return { ok: true, tenantId: res.context.scope.tenantId };
}

/** Postgres unique_violation — a duplicate active name hit products_client_active_name_unique. */
function isDuplicate(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}

export async function createProductAction(input: {
  clientId: string;
  name: string;
  description?: string;
  price: number | string;
  category?: string | null;
  inStock?: boolean;
}): Promise<CatalogResult> {
  const auth = await requireCatalogManager(input.clientId);
  if (!auth.ok) return auth;

  const name = normalizeProductName(input.name);
  if (!name.ok) return { ok: false, error: name.error };
  const desc = normalizeProductDescription(input.description);
  if (!desc.ok) return { ok: false, error: desc.error };
  const price = normalizeProductPrice(input.price);
  if (!price.ok) return { ok: false, error: price.error };
  const category = normalizeProductCategory(input.category);
  if (!category.ok) return { ok: false, error: category.error };

  try {
    const product = await createProduct({
      tenantId: auth.tenantId,
      clientId: input.clientId, // the VALIDATED route client — the product's owner
      name: name.value,
      description: desc.value,
      price: price.value,
      category: category.value,
      inStock: input.inStock ?? true,
    });
    revalidateCatalog(input.clientId);
    return { ok: true, id: product.id };
  } catch (err) {
    if (isDuplicate(err)) return { ok: false, error: DUPLICATE };
    return { ok: false, error: "No se pudo crear el producto." };
  }
}

export async function updateProductAction(
  clientId: string,
  id: string,
  patch: {
    name?: string;
    description?: string;
    price?: number | string;
    category?: string | null;
    inStock?: boolean;
  },
): Promise<CatalogResult> {
  const auth = await requireCatalogManager(clientId);
  if (!auth.ok) return auth;

  const built: {
    name?: string;
    description?: string | null;
    price?: number;
    category?: string | null;
    inStock?: boolean;
  } = {};
  if (patch.name !== undefined) {
    const name = normalizeProductName(patch.name);
    if (!name.ok) return { ok: false, error: name.error };
    built.name = name.value;
  }
  if (patch.description !== undefined) {
    const desc = normalizeProductDescription(patch.description);
    if (!desc.ok) return { ok: false, error: desc.error };
    built.description = desc.value;
  }
  if (patch.price !== undefined) {
    const price = normalizeProductPrice(patch.price);
    if (!price.ok) return { ok: false, error: price.error };
    built.price = price.value;
  }
  if (patch.category !== undefined) {
    const category = normalizeProductCategory(patch.category);
    if (!category.ok) return { ok: false, error: category.error };
    built.category = category.value;
  }
  if (patch.inStock !== undefined) built.inStock = patch.inStock;

  try {
    const row = await updateProduct(auth.tenantId, clientId, id, built);
    if (!row) return { ok: false, error: "Producto no encontrado." };
    revalidateCatalog(clientId);
    return { ok: true, id };
  } catch (err) {
    if (isDuplicate(err)) return { ok: false, error: DUPLICATE };
    return { ok: false, error: "No se pudo guardar el producto." };
  }
}

/** The one mutation a SETTER may run — flip "disponible / agotado". */
export async function setProductStockAction(
  clientId: string,
  id: string,
  inStock: boolean,
): Promise<CatalogResult> {
  const auth = await requireCatalogStock(clientId);
  if (!auth.ok) return auth;
  const ok = await setProductStock(auth.tenantId, clientId, id, inStock);
  if (!ok) return { ok: false, error: "Producto no encontrado." };
  revalidateCatalog(clientId);
  return { ok: true, id };
}

export async function archiveProductAction(clientId: string, id: string): Promise<CatalogResult> {
  const auth = await requireCatalogManager(clientId);
  if (!auth.ok) return auth;
  const ok = await archiveProduct(auth.tenantId, clientId, id);
  if (!ok) return { ok: false, error: "Producto no encontrado o ya archivado." };
  revalidateCatalog(clientId);
  return { ok: true, id };
}

export async function restoreProductAction(clientId: string, id: string): Promise<CatalogResult> {
  const auth = await requireCatalogManager(clientId);
  if (!auth.ok) return auth;
  try {
    const ok = await restoreProduct(auth.tenantId, clientId, id);
    if (!ok) return { ok: false, error: "Producto no encontrado o ya activo." };
    revalidateCatalog(clientId);
    return { ok: true, id };
  } catch (err) {
    // Restoring collides with a live product of the same name.
    if (isDuplicate(err)) return { ok: false, error: DUPLICATE };
    return { ok: false, error: "No se pudo restaurar el producto." };
  }
}

function revalidateCatalog(clientId: string): void {
  revalidatePath(`/clients/${clientId}/catalog`);
}
