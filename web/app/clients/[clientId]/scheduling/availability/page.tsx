import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { legacyAvailabilityDestination } from "@/lib/schedulingNav";

/**
 * LEGACY «Disponibilidad» (`?tab=sede|profesionales|excepciones`). It is now Agenda →
 * Horarios y ausencias (closures at its «Ausencias» section). Same gate as the destination;
 * the redirect never tells a refused user where the settings live.
 */
export default async function LegacyAvailabilityPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const { clientId } = await params;
  const { client } = await requireClientModulePage(clientId, "scheduling", "hours.manage");
  redirect(legacyAvailabilityDestination(client.id, await searchParams));
}
