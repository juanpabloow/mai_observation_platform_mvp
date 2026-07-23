import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getAccessScope, canAccessClient } from "@/lib/access";
import { isUuid } from "@/lib/clientModuleValidation";
import { getContactById } from "@worker/db/repositories/contacts.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";

/**
 * LEGACY route (Phase 3A): redirects an old /contacts/{id} link to the contact's
 * canonical client-scoped route. The contact resolves under tenant + RBAC (a
 * member can only reach their own client's contacts), its client must have CRM
 * enabled, and safe query params (from, tab) are preserved. Invalid UUID → 404
 * before any query.
 */
export default async function LegacyContactDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ contactId: string }>;
  searchParams: Promise<{ from?: string; tab?: string }>;
}) {
  await connection();
  const { contactId } = await params;
  if (!isUuid(contactId)) notFound();
  const scope = await getAccessScope();
  const sp = await searchParams;

  // Tenant + RBAC scoping: members only resolve their own client's contacts.
  const contact = await getContactById(scope.tenantId, contactId, scope.memberClientId);
  if (!contact) notFound();
  if (!canAccessClient(scope, contact.client_id)) notFound();
  if (!(await isClientModuleEnabled(scope.tenantId, contact.client_id, "crm"))) notFound();

  // Preserve the SAFE, known query params only (never arbitrary input).
  const qs = new URLSearchParams();
  if (sp.from) qs.set("from", sp.from);
  if (sp.tab) qs.set("tab", sp.tab);
  const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
  redirect(`/clients/${contact.client_id}/contacts/${contact.id}${suffix}`);
}
