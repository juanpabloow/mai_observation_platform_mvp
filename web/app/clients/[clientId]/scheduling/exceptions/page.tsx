import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { ABSENCES_ANCHOR, schedulingHref } from "@/lib/schedulingNav";

/**
 * «Excepciones» became the «Ausencias» section of Horarios y ausencias (lib/schedulingNav.ts).
 * Same gate as that page before redirecting, so a refused user learns nothing from the link.
 */
export default async function SchedulingExceptionsPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const { clientId } = await params;
  const { client } = await requireClientModulePage(clientId, "scheduling", "hours.manage");
  redirect(schedulingHref(client.id, "hours", undefined, ABSENCES_ANCHOR));
}
