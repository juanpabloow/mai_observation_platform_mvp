import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getAccessScope } from "@/lib/access";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";

/**
 * LEGACY route (Phase 3A): the canonical Contacts list is client-scoped at
 * /clients/{clientId}/contacts. This no longer renders aggregated data:
 * - member with CRM enabled → their client's contacts (preserving ONLY the
 *   known params q and from — never arbitrary input)
 * - member with CRM disabled → 404
 * - owner/admin → /clients (they pick a client there)
 */
export default async function LegacyContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; from?: string }>;
}) {
  await connection();
  const scope = await getAccessScope();
  if (scope.memberClientId) {
    const enabled = await isClientModuleEnabled(scope.tenantId, scope.memberClientId, "crm");
    if (!enabled) notFound();
    const sp = await searchParams;
    const qs = new URLSearchParams();
    if (sp.q) qs.set("q", sp.q);
    if (sp.from) qs.set("from", sp.from);
    const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
    redirect(`/clients/${scope.memberClientId}/contacts${suffix}`);
  }
  redirect("/clients");
}
