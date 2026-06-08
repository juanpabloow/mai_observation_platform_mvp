import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import {
  isExecutionSortKey,
  listExecutionsPage,
  type ExecutionFilters,
  type ExecutionListItem,
  type ExecutionSortKey,
} from "@worker/db/repositories/executions.js";
import { listColumnMappings } from "@worker/db/repositories/fieldMappings.js";
import { config } from "@worker/config.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { getWorkflowForCurrentTenant } from "@/lib/workflow";
import { formatDateTime, formatDuration } from "@/lib/format";
import { FilterBar } from "@/components/FilterBar";
import { ExecutionsTable, type ExecutionRowView } from "@/components/ExecutionsTable";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ColumnsManager, type DefinedColumn } from "@/components/ColumnsManager";

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

export default async function WorkflowExecutionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workflowId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await connection();
  const { workflowId } = await params;
  const sp = await searchParams;

  // Tenant-scoped workflow resolution (deduped with the layout via React cache).
  const workflow = await getWorkflowForCurrentTenant(workflowId);
  if (!workflow) {
    notFound();
  }

  const pageSize = Math.min(
    Math.max(parseIntParam(first(sp.pageSize), DEFAULT_PAGE_SIZE), 1),
    MAX_PAGE_SIZE,
  );
  const page = Math.max(parseIntParam(first(sp.page), 1), 1);

  const sortRaw = first(sp.sort);
  const sortKey: ExecutionSortKey =
    sortRaw && isExecutionSortKey(sortRaw) ? sortRaw : "started_at";
  const direction: "asc" | "desc" = first(sp.dir) === "asc" ? "asc" : "desc";

  const statusRaw = first(sp.status);
  // Workflow comes from the PATH (not a dropdown); status + date range remain.
  const filters: ExecutionFilters = {
    workflowId,
    status: statusRaw && statusRaw !== "all" ? statusRaw : undefined,
    fromDate: first(sp.from) || undefined,
    toDate: first(sp.to) || undefined,
  };

  const tenantId = await getCurrentTenantId();
  const [{ rows, total }, columnMappings] = await Promise.all([
    listExecutionsPage({
      tenantId,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      filters,
      sort: { key: sortKey, direction },
    }),
    listColumnMappings({ tenantId, n8nWorkflowId: workflowId }),
  ]);

  const definedColumns: DefinedColumn[] = columnMappings.map((c) => ({
    id: c.id,
    nodeName: c.node_name,
    columnLabel: c.column_label,
    jsonPath: c.json_path,
    dataType: c.data_type,
  }));

  const view: ExecutionRowView[] = rows.map((r: ExecutionListItem) => ({
    id: r.id,
    status: r.status,
    workflowName: r.workflow_name,
    clientName: r.client_name,
    startedDisplay: formatDateTime(r.started_at),
    durationDisplay: formatDuration(r.duration_ms),
    executionId: r.n8n_execution_id,
  }));

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  // Preserve filters + sort in pagination links (relative to this workflow path).
  const baseParams = new URLSearchParams();
  if (filters.status) baseParams.set("status", filters.status);
  if (filters.fromDate) baseParams.set("from", filters.fromDate);
  if (filters.toDate) baseParams.set("to", filters.toDate);
  if (sortKey !== "started_at" || direction !== "desc") {
    baseParams.set("sort", sortKey);
    baseParams.set("dir", direction);
  }
  if (pageSize !== DEFAULT_PAGE_SIZE) baseParams.set("pageSize", String(pageSize));

  const basePath = `/workflows/${encodeURIComponent(workflowId)}/executions`;
  const pageHref = (target: number): string => {
    const p = new URLSearchParams(baseParams);
    p.set("page", String(target));
    return `${basePath}?${p.toString()}`;
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">{total.toLocaleString()} matching</p>
        <AutoRefresh intervalSeconds={config.POLL_INTERVAL_SECONDS} />
      </div>

      <FilterBar
        status={filters.status ?? "all"}
        from={filters.fromDate ?? ""}
        to={filters.toDate ?? ""}
      />

      <ColumnsManager workflowId={workflowId} columns={definedColumns} />

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
    </>
  );
}
