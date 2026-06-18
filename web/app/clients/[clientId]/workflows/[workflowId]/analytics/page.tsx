import Link from "next/link";
import { connection } from "next/server";
import { getCurrentTenantId } from "@/lib/tenant";
import { requireWorkflowUnderClient } from "@/lib/clientWorkflow";
import { formatDuration } from "@/lib/format";
import {
  ANALYTICS_RANGE_DAYS,
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

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const SUCCESS = "#22c55e";
const ERROR = "#ef4444";

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
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
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
            <StatCard label="Status" value={<StatusValue active={workflow.active} />} />
          </div>

          <div className="rounded-2xl border border-line bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Executions over time</h3>
              <div className="flex items-center gap-3 text-xs text-muted">
                <LegendDot color={SUCCESS} label="Success" />
                <LegendDot color={ERROR} label="Error" />
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

function RangeSelector({ basePath, current }: { basePath: string; current: number }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-line p-0.5 text-sm">
      {ANALYTICS_RANGE_DAYS.map((d) => (
        <Link
          key={d}
          href={`${basePath}?range=${d}`}
          scroll={false}
          aria-current={d === current ? "page" : undefined}
          className={`rounded-md px-2.5 py-1 transition-colors ${
            d === current ? "bg-subtle font-medium text-foreground" : "text-muted hover:text-foreground"
          }`}
        >
          {d}d
        </Link>
      ))}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight sm:text-3xl">{value}</div>
      {sub ? <div className="mt-1 text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

function SuccessRateCard({
  rate,
  success,
  error,
}: {
  rate: number | null;
  success: number;
  error: number;
}) {
  const completed = success + error;
  const sPct = completed > 0 ? (success / completed) * 100 : 0;
  const ePct = completed > 0 ? (error / completed) * 100 : 0;
  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-faint">Success rate</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight sm:text-3xl">
        {rate === null ? "—" : `${rate}%`}
      </div>
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-subtle">
        <div style={{ width: `${sPct}%`, background: SUCCESS }} />
        <div style={{ width: `${ePct}%`, background: ERROR }} />
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-full" style={{ background: SUCCESS }} />
          {success.toLocaleString()} ok
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-full" style={{ background: ERROR }} />
          {error.toLocaleString()} err
        </span>
      </div>
    </div>
  );
}

function StatusValue({ active }: { active: boolean | null }) {
  if (active === null) return <span className="text-faint">Unknown</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="size-2.5 rounded-full" style={{ background: active ? SUCCESS : "#a3a3a3" }} />
      {active ? "Active" : "Inactive"}
    </span>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function NoDataInRange({ days }: { days: number }) {
  return (
    <div className="flex h-60 items-center justify-center text-sm text-faint">
      No executions in the last {days} days.
    </div>
  );
}
