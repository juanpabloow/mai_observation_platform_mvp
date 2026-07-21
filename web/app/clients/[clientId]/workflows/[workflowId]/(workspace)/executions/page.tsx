import Link from "next/link";
import { connection } from "next/server";
import {
  getExecutionByIdForTenant,
  getRawDataByIds,
  isExecutionSortKey,
  listExecutionsPage,
  type CustomFieldFilter,
  type CustomFieldSort,
  type ExecutionFilters,
  type ExecutionListItem,
  type ExecutionSortKey,
} from "@worker/db/repositories/executions.js";
import { isCustomFilterOperator } from "@worker/db/customFieldSql.js";
import {
  listColumnMappings,
  type ColumnMappingRow,
} from "@worker/db/repositories/fieldMappings.js";
import { config } from "@worker/config.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { requireWorkflowUnderClient } from "@/lib/clientWorkflow";
import { formatDateTime, formatDuration } from "@/lib/format";
import {
  buildExecutionResolver,
  extractMapping,
  formatCellValue,
  type CustomCell,
} from "@/lib/fieldCatalog";
import { FilterMenu, type FilterableField } from "@/components/FilterMenu";
import { FilterChips, type FilterChip } from "@/components/FilterChips";
import {
  ExecutionsTable,
  type CustomColumnDef,
  type ExecutionRowView,
} from "@/components/ExecutionsTable";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ColumnsMenu, type DefinedColumn } from "@/components/ColumnsMenu";
import { ExecutionPane } from "@/components/ExecutionPane";
import { ExecutionDetailPanel } from "@/components/ExecutionDetailPanel";

/**
 * Extract + format each custom column's value for one execution. Null-safe: if
 * the node didn't run, output is missing, or the path doesn't resolve, the cell
 * is "—" (the normal case — different executions run different nodes).
 */
function computeCustomCells(
  rawData: unknown,
  columns: ColumnMappingRow[],
): Record<string, CustomCell> {
  // Resolver handles both node-output and execution-metadata paths; null-safe.
  const resolver = buildExecutionResolver(rawData);
  const cells: Record<string, CustomCell> = {};
  for (const col of columns) {
    cells[col.id] = formatCellValue(extractMapping(resolver, col.node_name, col.json_path));
  }
  return cells;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** All values of a (possibly repeated) query param, as an array. */
function all(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : value != null ? [value] : [];
}

function parseIntParam(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/** Re-serialize the parsed searchParams into a "?a=1&b=2" string (preserving
 * repeated keys), used to carry filters across a canonical-client redirect. */
function serializeSearch(sp: SearchParams): string {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    for (const v of all(value)) p.append(key, v);
  }
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

export default async function WorkflowExecutionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string; workflowId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await connection();
  const { clientId, workflowId } = await params;
  const sp = await searchParams;

  // Tenant-scoped resolution (deduped with the layout via React cache). 404s a
  // missing/bogus workflow|client; redirects a stale clientId to the canonical
  // URL, preserving the current filters/sort/page query string.
  const workflow = await requireWorkflowUnderClient(
    clientId,
    workflowId,
    "executions",
    serializeSearch(sp),
  );
  // The workflow's REAL client — all links below are canonical, never the URL's.
  const linkClientId = workflow.client_id ?? clientId;

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

  // Custom-field filters/sort (F1). URL form:
  //   cf=<mappingId>:<operator>[:<value>]   (repeatable; ANDed)
  //   cf_sort=<mappingId>:<asc|desc>
  // The operator/direction are validated against their whitelists HERE; the
  // mappingId is resolved tenant+workflow-scoped inside listExecutionsPage (a
  // foreign/bogus id is ignored there — defense in depth, no SQL built from it).
  const customFilters: CustomFieldFilter[] = [];
  for (const raw of all(sp.cf)) {
    const i1 = raw.indexOf(":");
    if (i1 <= 0) continue;
    const mappingId = raw.slice(0, i1);
    const rest = raw.slice(i1 + 1);
    const i2 = rest.indexOf(":");
    const operator = i2 < 0 ? rest : rest.slice(0, i2);
    const value = i2 < 0 ? undefined : rest.slice(i2 + 1);
    if (!isCustomFilterOperator(operator)) continue;
    if ((operator === "equals" || operator === "contains") && !value) continue;
    customFilters.push({ mappingId, operator, value });
  }

  const cfSortRaw = first(sp.cf_sort);
  let customSort: CustomFieldSort | undefined;
  if (cfSortRaw) {
    const i = cfSortRaw.lastIndexOf(":");
    if (i > 0) {
      const mappingId = cfSortRaw.slice(0, i);
      const dir = cfSortRaw.slice(i + 1);
      if (dir === "asc" || dir === "desc") customSort = { mappingId, direction: dir };
    }
  }

  // ?execution=<id> opens the detail PANEL (master-detail). Loaded by id + tenant;
  // the malformed-id case is handled in the repo (UUID-validated → null). We then
  // require it to belong to THIS workflow — so a foreign/other-workflow/other-tenant
  // id simply doesn't open a panel (no leak). This is the same scope already proven
  // for the page (a member only reaches their client's workflow here).
  const executionParam = first(sp.execution);

  const tenantId = await getCurrentTenantId();
  const [{ rows, total }, columnMappings, detailExecutionRaw] = await Promise.all([
    listExecutionsPage({
      tenantId,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      filters,
      sort: { key: sortKey, direction },
      customFilters,
      customSort,
    }),
    listColumnMappings({ tenantId, n8nWorkflowId: workflowId }),
    executionParam
      ? getExecutionByIdForTenant({ tenantId, id: executionParam })
      : Promise.resolve(null),
  ]);

  const detailExecution =
    detailExecutionRaw && detailExecutionRaw.n8n_workflow_id === workflowId
      ? detailExecutionRaw
      : null;

  const definedColumns: DefinedColumn[] = columnMappings.map((c) => ({
    id: c.id,
    nodeName: c.node_name,
    columnLabel: c.column_label,
    jsonPath: c.json_path,
    dataType: c.data_type,
  }));

  const customColumns: CustomColumnDef[] = columnMappings.map((c) => ({
    id: c.id,
    label: c.column_label ?? c.json_path,
  }));

  // Fields the Filter menu can target (tenant+workflow-scoped = this workflow's
  // own column mappings); referenced by id only. + a label lookup for chips.
  const filterableFields: FilterableField[] = columnMappings.map((c) => ({
    id: c.id,
    label: c.column_label ?? c.json_path,
  }));
  const columnLabelById = new Map(columnMappings.map((c) => [c.id, c.column_label ?? c.json_path]));
  // Show the custom-sort indicator only when cf_sort resolves to a real column.
  const resolvedCustomSort =
    customSort && columnLabelById.has(customSort.mappingId) ? customSort : undefined;

  // Extract custom-column values server-side for ONLY the current page's rows
  // (fetch raw_data just for these ids — never the whole table).
  const customByRow = new Map<string, Record<string, CustomCell>>();
  if (columnMappings.length > 0 && rows.length > 0) {
    const raws = await getRawDataByIds({ tenantId, ids: rows.map((r) => r.id) });
    const rawById = new Map(raws.map((r) => [r.id, r.raw_data]));
    for (const r of rows) {
      customByRow.set(r.id, computeCustomCells(rawById.get(r.id), columnMappings));
    }
  }

  const view: ExecutionRowView[] = rows.map((r: ExecutionListItem) => ({
    id: r.id,
    status: r.status,
    workflowName: r.workflow_name,
    clientName: r.client_name,
    startedDisplay: formatDateTime(r.started_at),
    durationDisplay: formatDuration(r.duration_ms),
    executionId: r.n8n_execution_id,
    custom: customByRow.get(r.id) ?? {},
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
  // Preserve custom-field filters/sort across pagination.
  for (const raw of all(sp.cf)) baseParams.append("cf", raw);
  if (cfSortRaw) baseParams.set("cf_sort", cfSortRaw);
  // Keep an open detail panel open across pagination + filter/chip changes (the
  // panel is independent of which rows are listed — it renders by id).
  if (executionParam) baseParams.set("execution", executionParam);

  const basePath = `/clients/${linkClientId}/workflows/${encodeURIComponent(workflowId)}/executions`;
  const pageHref = (target: number): string => {
    const p = new URLSearchParams(baseParams);
    p.set("page", String(target));
    return `${basePath}?${p.toString()}`;
  };

  // Active-filter chips, server-rendered from the URL. Each removeHref is the
  // current params minus that one filter (page reset by omission).
  const hrefWithout = (mutate: (p: URLSearchParams) => void): string => {
    const p = new URLSearchParams(baseParams);
    mutate(p);
    const qs = p.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const opText = (op: string, val?: string) =>
    op === "not_empty" ? "is not empty" : op === "contains" ? `contains "${val}"` : `equals ${val}`;

  const chips: FilterChip[] = [];
  if (filters.status) {
    chips.push({ label: `Status: ${filters.status}`, removeHref: hrefWithout((p) => p.delete("status")) });
  }
  if (filters.fromDate) {
    chips.push({ label: `Started ≥ ${filters.fromDate}`, removeHref: hrefWithout((p) => p.delete("from")) });
  }
  if (filters.toDate) {
    chips.push({ label: `Started ≤ ${filters.toDate}`, removeHref: hrefWithout((p) => p.delete("to")) });
  }
  for (const raw of [...new Set(all(sp.cf))]) {
    const i1 = raw.indexOf(":");
    if (i1 <= 0) continue;
    const id = raw.slice(0, i1);
    const rest = raw.slice(i1 + 1);
    const i2 = rest.indexOf(":");
    const op = i2 < 0 ? rest : rest.slice(0, i2);
    const val = i2 < 0 ? undefined : rest.slice(i2 + 1);
    const label = columnLabelById.get(id);
    if (!label || !isCustomFilterOperator(op)) continue;
    if ((op === "equals" || op === "contains") && !val) continue;
    chips.push({
      label: `${label} ${opText(op, val)}`,
      removeHref: hrefWithout((p) => {
        const remaining = all(sp.cf).filter((x) => x !== raw);
        p.delete("cf");
        for (const x of remaining) p.append("cf", x);
      }),
    });
  }
  const clearAllHref = hrefWithout((p) => {
    p.delete("status");
    p.delete("from");
    p.delete("to");
    p.delete("cf");
  });

  return (
    // H-8.2: full-width, edge-to-edge in the (workspace) slot (no centered container).
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ONE toolbar line: count + Filter + Add column (left) · auto-refresh (right). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-2 pt-4">
        <p className="text-sm text-neutral-500">{total.toLocaleString()} matching</p>
        <FilterMenu customFields={filterableFields} />
        <ColumnsMenu workflowId={workflowId} columns={definedColumns} />
        <div className="ml-auto">
          <AutoRefresh intervalSeconds={config.POLL_INTERVAL_SECONDS} />
        </div>
      </div>

      {/* Active-filter chips on their own row (only when present). */}
      {chips.length > 0 ? (
        <div className="px-4 pb-2">
          <FilterChips chips={chips} clearAllHref={clearAllHref} />
        </div>
      ) : null}

      {/* The table scrolls; it's edge-to-edge (flat borders) within this padded slot. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        <ExecutionsTable
          rows={view}
          sort={{ key: sortKey, direction }}
          customSort={resolvedCustomSort}
          customColumns={customColumns}
        />

        <nav className="mt-4 flex items-center justify-between text-sm">
          <span className="text-neutral-500">
            Page {page} of {totalPages} · {total.toLocaleString()} total
          </span>
          <div className="flex items-center gap-2">
            {hasPrev ? (
              <Link
                href={pageHref(page - 1)}
                className="rounded-lg border border-black/10 px-3 py-1.5 transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
              >
                &larr; Previous
              </Link>
            ) : (
              <span className="cursor-not-allowed rounded-lg border border-black/5 px-3 py-1.5 text-faint dark:border-line">
                &larr; Previous
              </span>
            )}
            {hasNext ? (
              <Link
                href={pageHref(page + 1)}
                className="rounded-lg border border-black/10 px-3 py-1.5 transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
              >
                Next &rarr;
              </Link>
            ) : (
              <span className="cursor-not-allowed rounded-lg border border-black/5 px-3 py-1.5 text-faint dark:border-line">
                Next &rarr;
              </span>
            )}
          </div>
        </nav>
      </div>

      {/* Execution detail — the shared non-modal SidePane, deep-linked via ?execution=.
          Keyed by id so swapping rows remounts the detail (fresh node collapse); the
          pane wrapper stays mounted, so the swap is in place. */}
      {detailExecution ? (
        <ExecutionPane>
          <ExecutionDetailPanel
            key={detailExecution.id}
            execution={detailExecution}
            tenantId={tenantId}
            clientId={linkClientId}
          />
        </ExecutionPane>
      ) : null}
    </div>
  );
}
