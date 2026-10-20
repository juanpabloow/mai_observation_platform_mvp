import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { canManageClient } from "@/lib/access";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { loadSchedulingSettings } from "@/lib/schedulingSettingsData";
import { bookingPageAnchor, schedulingHref } from "@/lib/schedulingNav";
import { SchedulingSettings } from "@/components/scheduling/AdminPanel";

/**
 * «Página de reservas» — one of the scheduling settings pages that replaced the single
 * «Configuración de agenda» screen (lib/schedulingNav.ts). SAME gate as that screen, in
 * order: the scheduling module page gate (URL client validated against the session's
 * tenant + scope, non-default, module enabled — any failure is an indistinguishable 404),
 * then agency or this client's OWNER (setters and staff 404). All data is loaded with the
 * VALIDATED client id.
 */
export default async function SchedulingBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "scheduling");
  if (!canManageClient(scope, clientId)) notFound();
  // The interim tabs are sections of this one page now: an old `?tab=` link lands on its
  // section (anchor) instead of a third level of navigation.
  const anchor = bookingPageAnchor((await searchParams).tab);
  if (anchor) redirect(`${schedulingHref(client.id, "booking-page")}#${anchor}`);
  const data = await loadSchedulingSettings(scope.tenantId, client);
  return <SchedulingSettings page="booking-page" {...data} />;
}
