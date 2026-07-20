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

/**
 * Client-aggregate analytics — "All workflows" for ONE client (the `all` sentinel
 * in the workflow slot, valid only for analytics). Reuses the CL-5b client-scoped
 * helpers (getTenant*({clientId})). The clientId is validated tenant-scoped — a
 * foreign client 404s. `?from` (the workflow the user came from) is preserved on
 * the range links so the sidebar's Executions/Conversations keep targeting it.
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
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-widest text-faint">{clientLabel}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">All workflows</h1>
          {pendingAcross > 0 ? (
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              {pendingAcross} pending across workflows — open a workflow&rsquo;s Inbox to reply.
            </p>
          ) : null}
        </div>
        <RangeSelector basePath={basePath} current={days} extraQuery={fromQuery} />
      </header>

      {summary.allTimeTotal === 0 ? (
        <div className="rounded-2xl border border-dashed border-line px-6 py-16 text-center">
          <p className="text-sm text-muted">Not enough data yet.</p>
          <p className="mt-1 text-sm text-faint">
            Once this client&rsquo;s workflows run, their combined analytics will appear here.
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
              label={`Turns · ${days}d`}
              value={convSummary.totalTurns.toLocaleString()}
              sub={`${convSummary.distinctConversations.toLocaleString()} conversations`}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
            <div className="rounded-2xl border border-line bg-card p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Executions over time · all workflows</h3>
                <div className="flex items-center gap-3 text-xs text-muted">
                  <LegendDot color={RATE_SUCCESS} label="Success" />
                  <LegendDot color={RATE_ERROR} label="Error" />
                </div>
              </div>
              {summary.total === 0 ? <NoDataInRange days={days} /> : <ExecutionsByStatusChart data={series} />}
            </div>

            <div className="rounded-2xl border border-line bg-card p-4">
              <h3 className="mb-3 text-sm font-medium">Top workflows · {days}d</h3>
              <TopWorkflows clientId={clientId} workflows={topWorkflows} />
            </div>
          </div>
        </>
      )}
    </main>
  );
}

/** Per-workflow breakdown within the client; each row drills into that workflow's analytics. */
function TopWorkflows({ clientId, workflows }: { clientId: string; workflows: TopWorkflow[] }) {
  if (workflows.length === 0) {
    return <p className="py-8 text-center text-sm text-faint">No executions in this range.</p>;
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
