import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getCurrentTenantId } from "@/lib/tenant";
import { getClientForTenant } from "@/lib/clientWorkflow";
import {
  coerceRangeDays,
  getTenantConversationSummary,
  getTenantExecutionDailySeries,
  getTenantExecutionSummary,
  getTopWorkflowsByExecutions,
  type TopWorkflow,
} from "@worker/db/repositories/analytics.js";
import { countPendingForClient } from "@worker/db/repositories/handoff.js";
import { ExecutionsByStatusChart } from "@/components/WorkflowAnalyticsCharts";
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
 * Client-aggregate analytics — the Analytics surface at scope = "All workflows" for
 * ONE client (the `all` sentinel in the workflow slot, valid only for analytics).
 * Reuses the CL-5b client-scoped helpers (getTenant*({clientId})). Renders through the
 * SAME AnalyticsShell + KpiCard/PanelCard primitives as the single-workflow view, so
 * the two are consistent by construction. The clientId is validated tenant-scoped — a
 * foreign client 404s. `?from` (the workflow the user came from) is preserved on the
 * range links so the sidebar's Executions/Conversations keep targeting it.
 */
export default async function AllWorkflowsAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await connection();
  const { clientId } = await params;
  const sp = await searchParams;
  const days = coerceRangeDays(first(sp.range));
  const from = first(sp.from);

  const client = await getClientForTenant(clientId);
  if (!client) notFound(); // tenant-scoped: foreign/bogus client → 404

  const scope = { tenantId: await getCurrentTenantId(), days, clientId };
  const [summary, series, convSummary, topWorkflows, pendingAcross] = await Promise.all([
    getTenantExecutionSummary(scope),
    getTenantExecutionDailySeries(scope),
    getTenantConversationSummary(scope),
    getTopWorkflowsByExecutions({ tenantId: scope.tenantId, clientId, days, limit: 5 }),
    // A small static aggregate (H-7): pending across the client's workflows. NOT an
    // attention surface — open a workflow's Inbox to act on its pending conversations.
    countPendingForClient(scope.tenantId, clientId),
  ]);

  const completed = summary.success + summary.error;
  const successRate = completed > 0 ? Math.round((summary.success / completed) * 100) : null;
  const clientLabel = client.is_default ? "Unassigned" : client.name;
  const basePath = `/clients/${clientId}/workflows/all/analytics`;
  const fromQuery = from ? `&from=${encodeURIComponent(from)}` : "";

  return (
    <AnalyticsShell
      scopeLabel="All workflows"
      rangeBasePath={basePath}
      rangeCurrent={days}
      rangeExtraQuery={fromQuery}
      banner={
        pendingAcross > 0 ? (
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {pendingAcross} pending across workflows — open a workflow&rsquo;s Inbox to reply.
          </p>
        ) : undefined
      }
    >
      {summary.allTimeTotal === 0 ? (
        <AnalyticsEmpty
          hint={`Once ${clientLabel}'s workflows run, their combined analytics will appear here.`}
        />
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
              label={`Turns · ${days}d`}
              value={convSummary.totalTurns.toLocaleString()}
              sub={`${convSummary.distinctConversations.toLocaleString()} conversations`}
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
              <PanelCard title={`Top workflows · ${days}d`}>
                <TopWorkflows clientId={clientId} workflows={topWorkflows} />
              </PanelCard>
            }
          />
        </>
      )}
    </AnalyticsShell>
  );
}

/** Per-workflow breakdown within the client; each row drills into that workflow's analytics. */
function TopWorkflows({ clientId, workflows }: { clientId: string; workflows: TopWorkflow[] }) {
  if (workflows.length === 0) {
    return <PanelEmpty>No executions in this range.</PanelEmpty>;
  }
  const max = Math.max(1, ...workflows.map((w) => w.executions));
  return (
    <ul className="flex flex-col gap-3">
      {workflows.map((w) => (
        <li key={w.id}>
          <Link
            href={`/clients/${clientId}/workflows/${encodeURIComponent(w.id)}/analytics`}
            className="block rounded-lg px-1 py-0.5 transition-colors hover:bg-subtle"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm">{w.name ?? w.id}</span>
              <span className="shrink-0 text-sm font-medium tabular-nums">
                {w.executions.toLocaleString()}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle">
              <div
                className="h-full rounded-full"
                style={{ width: `${(w.executions / max) * 100}%`, background: "var(--accent)" }}
              />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
