import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { loadSchedulingSettings } from "@/lib/schedulingSettingsData";
import { SchedulingSettings } from "@/components/scheduling/AdminPanel";

/**
 * «Reglas de reserva» — one of the scheduling settings pages that replaced the single
 * «Configuración de agenda» screen (lib/schedulingNav.ts). SAME gate as that screen, in
 * order: the scheduling module page gate (URL client validated against the session's
 * tenant + scope, non-default, module enabled — any failure is an indistinguishable 404),
 * then agency or this client's OWNER (setters and staff 404). All data is loaded with the
 * VALIDATED client id.
 */
export default async function SchedulingRulesPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "scheduling", "settings.rules");
  const data = await loadSchedulingSettings(scope.tenantId, client);
  return <SchedulingSettings page="rules" {...data} />;
}
