import { connection } from "next/server";
import { notFound } from "next/navigation";
import { loadOccupancyView } from "@/lib/occupancyData";
import { OccupancyPanel } from "@/components/scheduling/OccupancyPanel";

/**
 * JP-8 §3 — the Ocupación screen (client level, in the Agenda area). Gating + the whole payload come
 * from `loadOccupancyView`: `agenda.view` under the scheduling module (indistinguishable 404 on
 * failure), a staff login sees only its own site + row, and money is attached only for a viewer with
 * `analytics.view`. Every number traces to the rollup, which traces to the availability engine.
 */
export default async function OcupacionPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await connection();
  const { clientId } = await params;
  const sp = await searchParams;
  const res = await loadOccupancyView(clientId, { g: sp.g, d: sp.d, site: sp.site, staff: sp.staff });
  if (!res.ok) notFound();
  return <OccupancyPanel clientName={res.clientName} view={res.view} />;
}
