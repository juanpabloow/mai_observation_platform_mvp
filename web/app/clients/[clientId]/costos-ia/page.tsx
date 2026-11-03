import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { buildAiCosts } from "@/lib/aiCosts";
import { periodInputFrom } from "@/lib/valueDashboard";
import { baselineInputFrom } from "@worker/analytics/aiCostPeriods.js";
import { AiCostsView } from "@/components/aiCosts/AiCostsView";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * /clients/{id}/costos-ia — COSTOS DE IA for ONE business: what its bots spent, for its owner
 * (and the agency). Same screen as the agency's, limited to this business (no per-business
 * views). Access is decided in the layout and re-checked here.
 */
export default async function ClientAiCostsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await connection();
  const { clientId } = await params;
  const sp = await searchParams;
  const input = periodInputFrom({ periodo: first(sp.periodo), desde: first(sp.desde), hasta: first(sp.hasta) });
  let result: Awaited<ReturnType<typeof buildAiCosts>> | null = null;
  try {
    result = await buildAiCosts(input, baselineInputFrom({ comparar: first(sp.comparar), cdesde: first(sp.cdesde), chasta: first(sp.chasta) }), { clientId });
  } catch {
    result = null; // a failed query is an ERROR state with «Reintentar», never "no data"
  }
  if (result && !result.ok && result.status === 401) redirect("/login");
  if (result && !result.ok && result.status === 404) notFound();
  return (
    <AiCostsView
      clientId={clientId}
      initial={result?.ok ? result.data : null}
      initialError={result && !result.ok && result.status === 400 ? result.error : null}
    />
  );
}
