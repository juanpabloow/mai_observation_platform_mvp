import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getAccessScope } from "@/lib/access";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";

/**
 * LEGACY route (Phase 3A): the canonical Agenda is client-scoped at
 * /clients/{clientId}/scheduling/agenda. This no longer renders data:
 * - member with Scheduling enabled → their client's agenda (preserving ONLY the
 *   known params site, date, and from — never arbitrary input)
 * - member with Scheduling disabled → 404
 * - owner/admin → /clients (they pick a client there)
 */
export default async function LegacyAgendaPage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string; date?: string; from?: string }>;
}) {
  await connection();
  const scope = await getAccessScope();
  if (scope.memberClientId) {
    const enabled = await isClientModuleEnabled(scope.tenantId, scope.memberClientId, "scheduling");
    if (!enabled) notFound();
    const sp = await searchParams;
    const qs = new URLSearchParams();
    if (sp.site) qs.set("site", sp.site);
    if (sp.date) qs.set("date", sp.date);
    if (sp.from) qs.set("from", sp.from);
    const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
    redirect(`/clients/${scope.memberClientId}/scheduling/agenda${suffix}`);
  }
  redirect("/clients");
}
