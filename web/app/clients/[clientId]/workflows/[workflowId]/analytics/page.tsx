import { redirect } from "next/navigation";
import { requireWorkflowInsights } from "@/lib/clientWorkflow";

/**
 * «Analíticas técnicas» was folded into COSTOS DE IA → Ejecuciones (the business view): same
 * numbers (executions, errors, by workflow, duration, Inbox sends) with periods and comparison.
 * Kept as a redirect so old links still land — behind the same gate it always had (a login
 * without analytics.view gets a 404 here, not a redirect); the target re-checks access.
 */
export default async function LegacyWorkflowAnalyticsPage({ params }: { params: Promise<{ clientId: string }> }) {
  await requireWorkflowInsights((await params).clientId, "analytics.view");
  const { clientId } = await params;
  redirect(`/clients/${encodeURIComponent(clientId)}/costos-ia?vista=ejecuciones`);
}
