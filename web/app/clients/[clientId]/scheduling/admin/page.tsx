import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { can } from "@/lib/access";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { legacyAdminDestination } from "@/lib/schedulingNav";
import type { PermissionKey } from "@/lib/permissions/catalog";

/** The permission each settings page gates on — the redirect only goes where the login
 *  will be admitted (otherwise the indistinguishable 404, as before). */
const PAGE_PERMISSION: Record<string, PermissionKey> = {
  sites: "settings.sites",
  rules: "settings.rules",
  hours: "hours.manage",
  services: "services.manage",
  promotions: "promotions.manage",
  "booking-page": "booking_page.manage",
  staff: "team.manage",
};

/**
 * LEGACY «Configuración de agenda» (/clients/[clientId]/scheduling/admin). Its functions
 * now live on their own pages (lib/schedulingNav.ts): Sedes, Reglas de reserva,
 * Horarios y ausencias, Servicios, Promociones and Página de reservas. Old links keep working:
 * the phone's `?m=` screens map to the page that owns them (keeping `id`, `cat`, …), and
 * anything else lands on Sedes, which carries the setup summary this screen opened on.
 *
 * Gate: the scheduling module + ANY settings permission, and then the permission of the
 * page it redirects to — so the redirect never tells a refused user where the settings
 * live, and never sends a custom role to a page that would 404.
 */
export default async function ClientSchedulingAdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "scheduling", ["team.manage", "hours.manage", "services.manage", "promotions.manage", "booking_page.manage", "reviews.moderate", "settings.sites", "settings.rules"]);
  const destination = legacyAdminDestination(client.id, await searchParams);
  const page = /\/scheduling\/([a-z-]+)/.exec(destination)?.[1] ?? "";
  if (!PAGE_PERMISSION[page] || !can(scope, PAGE_PERMISSION[page], client.id)) notFound();
  redirect(destination);
}
