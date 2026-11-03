import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { buildAiCosts } from "@/lib/aiCosts";
import { periodInputFrom } from "@/lib/valueDashboard";
import { baselineInputFrom } from "@worker/analytics/aiCostPeriods.js";
import { AiCostsView } from "@/components/aiCosts/AiCostsView";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * /costos-ia — COSTOS DE IA: tokens the bots and the meetings module spent, what that is in money,
 * and how it changed against the previous period, across ALL the agency's businesses. Agency only
 * (lib/aiCosts.ts): anyone else gets the same 404 as a page that does not exist.
 * `?periodo=7|30|custom&desde&hasta&comparar=anterior|mes|custom&cdesde&chasta` is bookmarkable.
 */
export default async function AiCostsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await connection();
  const sp = await searchParams;
  const input = periodInputFrom({ periodo: first(sp.periodo), desde: first(sp.desde), hasta: first(sp.hasta) });
  let result: Awaited<ReturnType<typeof buildAiCosts>> | null = null;
  try {
    result = await buildAiCosts(input, baselineInputFrom({ comparar: first(sp.comparar), cdesde: first(sp.cdesde), chasta: first(sp.chasta) }));
  } catch {
    result = null; // a failed query is an ERROR state with «Reintentar», never "no data"
  }
  if (result && !result.ok && result.status === 401) redirect("/login");
  if (result && !result.ok && result.status === 404) notFound();
  return (
    <AiCostsView
      initial={result?.ok ? result.data : null}
      initialError={result && !result.ok && result.status === 400 ? result.error : null}
    />
  );
}
