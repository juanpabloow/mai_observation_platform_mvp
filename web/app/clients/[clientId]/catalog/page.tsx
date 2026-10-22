import { connection } from "next/server";
import { notFound } from "next/navigation";
import { can } from "@/lib/access";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { listProducts } from "@worker/db/repositories/catalog/products.js";
import { CatalogPanel } from "@/components/catalog/CatalogPanel";

/**
 * Per-CLIENT product catalogue ("Productos"). Gating, in order:
 *   1. requireClientModulePage(clientId, "catalog") — the URL clientId is validated
 *      against the session tenant + access scope, the client must exist, be NON-default,
 *      and have the catalog module ENABLED; any failure is an indistinguishable 404.
 *   2. canReadCatalog — the agency, this client's OWNER, or a SETTER. Staff is 404'd.
 * ALL data is loaded with the VALIDATED client id, so this page can't cross into another
 * client. `canManage` (agency/owner) decides whether create/edit/archive controls render;
 * the server actions re-enforce it regardless, so hiding is presentation only.
 */
export default async function ClientCatalogPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "catalog", "products.view");

  const products = await listProducts(scope.tenantId, client.id, true); // include archived
  const canManage = can(scope, "products.manage", clientId);

  return (
    <CatalogPanel
      clientId={client.id}
      clientName={client.name}
      canManage={canManage}
      products={products.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.price,
        category: p.category,
        in_stock: p.in_stock,
        is_active: p.is_active,
      }))}
    />
  );
}
