import { connection } from "next/server";
import { getCurrentTenantId } from "@/lib/tenant";
import { requireWorkflowUnderClient } from "@/lib/clientWorkflow";
import { formatDuration } from "@/lib/format";
import {
  coerceRangeDays,
  getConversationDailySeries,
  getConversationSummary,
  getExecutionDailySeries,
  getExecutionSummary,
} from "@worker/db/repositories/analytics.js";
import {
  ConversationTurnsChart,
  ExecutionsByStatusChart,
} from "@/components/WorkflowAnalyticsCharts";
import {
  AnalyticsColumns,
  AnalyticsEmpty,
  AnalyticsShell,
  KpiCard,
  KpiGrid,
  LegendDot,
  NoDataInRange,
  PanelCard,
  PanelEmpty,
  RATE_ERROR,
  RATE_SUCCESS,
  SuccessRateCard,
} from "@/components/analytics-ui";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Single-workflow analytics — the Analytics surface at scope = one workflow. Renders
 * through the SAME AnalyticsShell + KpiCard/PanelCard primitives as the all-workflows
 * aggregate (workflows/all/analytics), so the two views share one container, header
 * and KPI/chart skeleton by construction. Only the KPI set (Avg duration here) and
 * the side panel (this workflow's conversation stats) differ. Lives OUTSIDE the
 * (padded) group so AnalyticsShell is the sole container (the aggregate has no padded
 * ancestor either) — same URL, same padded-column result in both.
 */
export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string; workflowId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await connection();
  const { clientId, workflowId } = await params;
  const sp = await searchParams;
  const days = coerceRangeDays(first(sp.range));

  // Tenant-scoped resolve (404 / canonical redirect, preserving the range param).
  const workflow = await requireWorkflowUnderClient(clientId, workflowId, "analytics", `?range=${days}`);
  const linkClientId = workflow.client_id ?? clientId;
  const basePath = `/clients/${linkClientId}/workflows/${encodeURIComponent(workflowId)}/analytics`;

  const tenantId = await getCurrentTenantId();
  const scope = { tenantId, n8nWorkflowId: workflowId, days };
  const [summary, series, convSummary, convSeries] = await Promise.all([
    getExecutionSummary(scope),
    getExecutionDailySeries(scope),
    getConversationSummary(scope),
    getConversationDailySeries(scope),
  ]);

  const completed = summary.success + summary.error;
  const successRate = completed > 0 ? Math.round((summary.success / completed) * 100) : null;
  const hasConversations = convSummary.allTimeTurns > 0;

  return (
    <AnalyticsShell
      scopeLabel={workflow.name ?? workflowId}
      rangeBasePath={basePath}
      rangeCurrent={days}
    >
      {summary.allTimeTotal === 0 ? (
        <AnalyticsEmpty hint="Once this workflow runs, its execution analytics will appear here." />
      ) : (
        <>
          <KpiGrid>
            <SuccessRateCard rate={successRate} success={summary.success} error={summary.error} />
            <KpiCard
              label={`Executions · ${days}d`}
              value={summary.total.toLocaleString()}
              sub={`${summary.allTimeTotal.toLocaleString()} all-time`}
            />
            <KpiCard
              label="Errors"
              value={summary.error.toLocaleString()}
              sub={summary.other > 0 ? `${summary.other} other` : "in range"}
            />
            <KpiCard
              label="Avg duration"
              value={formatDuration(summary.avgDurationMs != null ? Math.round(summary.avgDurationMs) : null)}
              sub="per execution"
            />
          </KpiGrid>

          <AnalyticsColumns
            primary={
              <PanelCard
                title="Executions over time"
                aside={
                  <>
                    <LegendDot color={RATE_SUCCESS} label="Success" />
                    <LegendDot color={RATE_ERROR} label="Error" />
                  </>
                }
              >
                {summary.total === 0 ? (
                  <NoDataInRange days={days} />
                ) : (
                  <ExecutionsByStatusChart data={series} />
                )}
              </PanelCard>
            }
            side={
              hasConversations ? (
                <>
                  <KpiCard
                    label={`Turns · ${days}d`}
                    value={convSummary.totalTurns.toLocaleString()}
                    sub={`${convSummary.allTimeTurns.toLocaleString()} all-time`}
                  />
                  <KpiCard
                    label="Conversations"
                    value={convSummary.distinctConversations.toLocaleString()}
                    sub="distinct in range"
                  />
                  <PanelCard title="Conversation turns over time">
                    {convSummary.totalTurns === 0 ? (
                      <NoDataInRange days={days} />
                    ) : (
                      <ConversationTurnsChart data={convSeries} />
                    )}
                  </PanelCard>
                </>
              ) : (
                <PanelCard title="Conversations">
                  <PanelEmpty>No conversation activity yet.</PanelEmpty>
                </PanelCard>
              )
            }
          />
        </>
      )}
    </AnalyticsShell>
  );
}
