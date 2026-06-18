import Link from "next/link";
import { connection } from "next/server";
import { countActiveConnectionsForTenant } from "@worker/db/repositories/stats.js";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import { listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import {
  coerceRangeDays,
  getTenantConversationSummary,
  getTenantExecutionDailySeries,
  getTenantExecutionSummary,
  getTopClientsByExecutions,
  type TopClient,
} from "@worker/db/repositories/analytics.js";
import { getCurrentTenantId } from "@/lib/tenant";
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
 * The Hub — tenant lobby + operations dashboard (the header logo links here).
 * Aggregates the CL-5a analytics across ALL the tenant's workflows/clients
 * (getTenant* helpers) plus tenant-specific metrics (active workflows, clients,
 * top clients). Soft-gates onboarding when no n8n is connected; shows a graceful
 * empty state when connected but no executions exist yet.
 */
export default async function HubPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await connection();
  const sp = await searchParams;
  const days = coerceRangeDays(first(sp.range));
  const tenantId = await getCurrentTenantId();

  const activeConnections = await countActiveConnectionsForTenant(tenantId);

  // Soft-gate: no connection → prompt to connect, not an empty dashboard.
  if (activeConnections === 0) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-20">
        <header className="space-y-3">
          <p className="text-sm font-medium uppercase tracking-widest text-faint">Hub</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Connect your n8n to start monitoring
          </h1>
          <p className="text-muted">
            Add your n8n instance and API key — we&rsquo;ll begin ingesting its
            executions automatically and reconstruct your conversations here.
          </p>
        </header>
        <div>
          <Link
            href="/settings/connections"
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
          >
            Connect n8n
            <span aria-hidden>&rarr;</span>
          </Link>
        </div>
      </main>
    );
  }

  const [summary, series, convSummary, topClients, clients, workflows] = await Promise.all([
    getTenantExecutionSummary({ tenantId, days }),
    getTenantExecutionDailySeries({ tenantId, days }),
    getTenantConversationSummary({ tenantId, days }),
    getTopClientsByExecutions({ tenantId, days, limit: 5 }),
    listClientsForTenant(tenantId),
    listWorkflowsWithClientForTenant(tenantId),
  ]);

  // "Clients" = named (non-default) clients; the default holds unassigned workflows.
  const clientCount = clients.filter((c) => !c.is_default).length;
  const activeWorkflows = workflows.filter((w) => w.active).length;
  const completed = summary.success + summary.error;
  const successRate = completed > 0 ? Math.round((summary.success / completed) * 100) : null;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-widest text-faint">Hub</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Workspace overview</h1>
        </div>
        <RangeSelector basePath="/" current={days} />
      </header>

      {summary.allTimeTotal === 0 ? (
        <div className="rounded-2xl border border-dashed border-line px-6 py-16 text-center">
          <p className="text-sm text-muted">Not enough data yet.</p>
          <p className="mt-1 text-sm text-faint">
            Once your workflows run, tenant-wide analytics will appear here.
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
              label="Active workflows"
              value={activeWorkflows.toLocaleString()}
              sub={`of ${workflows.length.toLocaleString()} total`}
            />
            <StatCard label="Clients" value={clientCount.toLocaleString()} sub="excl. Unassigned" />
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
              <h3 className="mb-3 text-sm font-medium">Top clients · {days}d</h3>
              <TopClients clients={topClients} />
            </div>
          </div>
        </>
      )}
    </main>
  );
}

/** Ranked horizontal-bar list of clients by execution count (server-rendered). */
function TopClients({ clients }: { clients: TopClient[] }) {
  if (clients.length === 0) {
    return <p className="py-8 text-center text-sm text-faint">No attributable executions in this range.</p>;
  }
  const max = Math.max(1, ...clients.map((c) => c.executions));
  return (
    <ul className="flex flex-col gap-3">
      {clients.map((c) => {
        const label = c.isDefault ? "Unassigned" : c.name;
        return (
          <li key={c.id} className="flex items-center gap-3">
            <ClientBadge label={label} logoUrl={c.logoUrl} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm">{label}</span>
                <span className="shrink-0 text-sm font-medium tabular-nums">
                  {c.executions.toLocaleString()}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${(c.executions / max) * 100}%`, background: "var(--accent)" }}
                />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ClientBadge({ label, logoUrl }: { label: string; logoUrl: string | null }) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- tiny external logo from R2
    return <img src={logoUrl} alt="" aria-hidden className="size-7 shrink-0 rounded-md border border-line object-cover" />;
  }
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-subtle text-xs font-semibold text-muted"
    >
      {label.trim()[0]?.toUpperCase() ?? "?"}
    </span>
  );
}
