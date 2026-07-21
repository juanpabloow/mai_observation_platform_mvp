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
  LegendDot,
  NoDataInRange,
  RangeSelector,
  RATE_ERROR,
  RATE_SUCCESS,
  StatCard,
  SuccessRateCard,
} from "@/components/analytics-ui";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

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
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Analytics</h2>
        <RangeSelector basePath={basePath} current={days} />
      </div>

      {summary.allTimeTotal === 0 ? (
        <div className="rounded-2xl border border-dashed border-line px-6 py-16 text-center">
          <p className="text-sm text-muted">Not enough data yet.</p>
          <p className="mt-1 text-sm text-faint">
            Once this workflow runs, its execution analytics will appear here.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <SuccessRateCard rate={successRate} success={summary.success} error={summary.error} />
            <StatCard
              label={`Executions · ${days}d`}
              value={summary.total.toLocaleString()}
              sub={`${summary.allTimeTotal.toLocaleString()} all-time`}
            />
            <StatCard
              label="Errors"
              value={summary.error.toLocaleString()}
              sub={summary.other > 0 ? `${summary.other} other` : "in range"}
            />
            <StatCard
              label="Avg duration"
              value={formatDuration(summary.avgDurationMs != null ? Math.round(summary.avgDurationMs) : null)}
              sub="per execution"
            />
          </div>

          <div className="rounded-2xl border border-line bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Executions over time</h3>
              <div className="flex items-center gap-3 text-xs text-muted">
                <LegendDot color={RATE_SUCCESS} label="Success" />
                <LegendDot color={RATE_ERROR} label="Error" />
              </div>
            </div>
            {summary.total === 0 ? (
              <NoDataInRange days={days} />
            ) : (
              <ExecutionsByStatusChart data={series} />
            )}
          </div>

          {hasConversations ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <StatCard
                  label={`Turns · ${days}d`}
                  value={convSummary.totalTurns.toLocaleString()}
                  sub={`${convSummary.allTimeTurns.toLocaleString()} all-time`}
                />
                <StatCard
                  label="Conversations"
                  value={convSummary.distinctConversations.toLocaleString()}
                  sub="distinct in range"
                />
              </div>
              <div className="rounded-2xl border border-line bg-card p-4">
                <h3 className="mb-3 text-sm font-medium">Conversation turns over time</h3>
                {convSummary.totalTurns === 0 ? (
                  <NoDataInRange days={days} />
                ) : (
                  <ConversationTurnsChart data={convSeries} />
                )}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
