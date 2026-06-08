import Link from "next/link";
import { connection } from "next/server";
import {
  isExecutionSortKey,
  listExecutionsPage,
  type ExecutionFilters,
  type ExecutionListItem,
  type ExecutionSortKey,
} from "@worker/db/repositories/executions.js";
import { listWorkflowsForTenant } from "@worker/db/repositories/workflows.js";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { FilterBar } from "./_components/FilterBar";
import { ExecutionsTable, type ExecutionRowView } from "./_components/ExecutionsTable";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseIntParam(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function formatStarted(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

export default async function ExecutionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await connection();
  const sp = await searchParams;

  // --- pagination params ---
  const pageSize = Math.min(
    Math.max(parseIntParam(first(sp.pageSize), DEFAULT_PAGE_SIZE), 1),
    MAX_PAGE_SIZE,
  );
  const page = Math.max(parseIntParam(first(sp.page), 1), 1);

  // --- sort params (validated against the whitelist) ---
  const sortRaw = first(sp.sort);
  const sortKey: ExecutionSortKey =
    sortRaw && isExecutionSortKey(sortRaw) ? sortRaw : "started_at";
  const direction: "asc" | "desc" = first(sp.dir) === "asc" ? "asc" : "desc";

  // --- filter params ---
  const statusRaw = first(sp.status);
  const filters: ExecutionFilters = {
    status: statusRaw && statusRaw !== "all" ? statusRaw : undefined,
    workflowId: first(sp.workflow) || undefined,
    clientId: first(sp.client) || undefined,
    fromDate: first(sp.from) || undefined,
    toDate: first(sp.to) || undefined,
  };

  const tenantId = await getCurrentTenantId();
  const [{ rows, total }, workflows, clients] = await Promise.all([
    listExecutionsPage({
      tenantId,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      filters,
      sort: { key: sortKey, direction },
    }),
    listWorkflowsForTenant(tenantId),
    listClientsForTenant(tenantId),
  ]);

  const view: ExecutionRowView[] = rows.map((r: ExecutionListItem) => ({
    id: r.id,
    status: r.status,
    workflowName: r.workflow_name,
    clientName: r.client_name,
    startedDisplay: formatStarted(r.started_at),
    durationDisplay: formatDuration(r.duration_ms),
    executionId: r.n8n_execution_id,
  }));

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  // Preserve filters + sort in pagination links.
  const baseParams = new URLSearchParams();
  if (filters.status) baseParams.set("status", filters.status);
  if (filters.workflowId) baseParams.set("workflow", filters.workflowId);
  if (filters.clientId) baseParams.set("client", filters.clientId);
  if (filters.fromDate) baseParams.set("from", filters.fromDate);
  if (filters.toDate) baseParams.set("to", filters.toDate);
  if (sortKey !== "started_at" || direction !== "desc") {
    baseParams.set("sort", sortKey);
    baseParams.set("dir", direction);
  }
  if (pageSize !== DEFAULT_PAGE_SIZE) baseParams.set("pageSize", String(pageSize));

  const pageHref = (target: number): string => {
    const params = new URLSearchParams(baseParams);
    params.set("page", String(target));
    return `/executions?${params.toString()}`;
  };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-12">
      <header className="space-y-2">
        <Link
          href="/"
          className="text-sm text-neutral-500 transition-colors hover:text-neutral-300"
        >
          &larr; Overview
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Executions
        </h1>
        <p className="text-sm text-neutral-500">
          {total.toLocaleString()} matching
        </p>
      </header>

      <FilterBar
        status={filters.status ?? "all"}
        workflow={filters.workflowId ?? ""}
        client={filters.clientId ?? ""}
        from={filters.fromDate ?? ""}
        to={filters.toDate ?? ""}
        workflows={workflows}
        clients={clients}
      />

      <ExecutionsTable rows={view} sort={{ key: sortKey, direction }} />

      <nav className="flex items-center justify-between text-sm">
        <span className="text-neutral-500">
          Page {page} of {totalPages} · {total.toLocaleString()} total
        </span>
        <div className="flex items-center gap-2">
          {hasPrev ? (
            <Link
              href={pageHref(page - 1)}
              className="rounded-lg border border-black/10 px-3 py-1.5 transition-colors hover:bg-black/[0.04] dark:border-white/15 dark:hover:bg-white/[0.06]"
            >
              &larr; Previous
            </Link>
          ) : (
            <span className="cursor-not-allowed rounded-lg border border-black/5 px-3 py-1.5 text-neutral-600 dark:border-white/5">
              &larr; Previous
            </span>
          )}
          {hasNext ? (
            <Link
              href={pageHref(page + 1)}
              className="rounded-lg border border-black/10 px-3 py-1.5 transition-colors hover:bg-black/[0.04] dark:border-white/15 dark:hover:bg-white/[0.06]"
            >
              Next &rarr;
            </Link>
          ) : (
            <span className="cursor-not-allowed rounded-lg border border-black/5 px-3 py-1.5 text-neutral-600 dark:border-white/5">
              Next &rarr;
            </span>
          )}
        </div>
      </nav>
    </main>
  );
}
