"use client";

import { useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
} from "@tanstack/react-table";
import { statusBadgeClasses } from "@/lib/format";
import type { CustomCell } from "@/lib/fieldCatalog";

/**
 * Pre-formatted view of one execution row. Dates/durations are formatted on the
 * SERVER and passed as strings (no client locale work → no hydration drift).
 * `custom` holds pre-extracted, pre-formatted values for the workflow's custom
 * columns, keyed by mapping id.
 */
export interface ExecutionRowView {
  id: string;
  status: string;
  workflowName: string;
  clientName: string | null;
  startedDisplay: string;
  durationDisplay: string;
  executionId: string;
  custom: Record<string, CustomCell>;
}

export interface CustomColumnDef {
  id: string;
  label: string;
}

const columnHelper = createColumnHelper<ExecutionRowView>();

// Fixed columns (DB-backed; sortable where supported in SQL).
const FIXED_COLUMNS = [
  columnHelper.accessor("status", {
    id: "status",
    header: "Status",
    cell: (info) => (
      <span className={statusBadgeClasses(info.getValue())}>{info.getValue()}</span>
    ),
  }),
  columnHelper.accessor("workflowName", {
    id: "workflow",
    header: "Workflow",
    enableSorting: false,
    cell: (info) => (
      <span className="block max-w-[18rem] truncate font-medium" title={info.getValue()}>
        {info.getValue()}
      </span>
    ),
  }),
  columnHelper.accessor("clientName", {
    id: "client",
    header: "Client",
    enableSorting: false,
    cell: (info) =>
      info.getValue() ? (
        <span className="text-neutral-400">{info.getValue()}</span>
      ) : (
        <span className="text-neutral-600">Unassigned</span>
      ),
  }),
  columnHelper.accessor("startedDisplay", {
    id: "started_at",
    header: "Started",
    cell: (info) => <span className="text-neutral-400">{info.getValue()}</span>,
  }),
  columnHelper.accessor("durationDisplay", {
    id: "duration_ms",
    header: "Duration",
    cell: (info) => (
      <span className="tabular-nums text-neutral-400">{info.getValue()}</span>
    ),
  }),
  columnHelper.accessor("executionId", {
    id: "execution_id",
    header: "Execution ID",
    enableSorting: false,
    cell: (info) => (
      <span className="font-mono text-xs text-neutral-500">{info.getValue()}</span>
    ),
  }),
] as ColumnDef<ExecutionRowView>[];

interface ExecutionsTableProps {
  rows: ExecutionRowView[];
  sort: { key: string; direction: "asc" | "desc" };
  /** Active custom-field sort (cf_sort), if any — takes precedence over `sort`. */
  customSort?: { mappingId: string; direction: "asc" | "desc" };
  customColumns: CustomColumnDef[];
}

export function ExecutionsTable({ rows, sort, customSort, customColumns }: ExecutionsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Fixed columns + the workflow's custom columns (sortable via the cf_sort seam).
  const columns = useMemo<ColumnDef<ExecutionRowView>[]>(
    () => [
      ...FIXED_COLUMNS,
      ...customColumns.map(
        (col): ColumnDef<ExecutionRowView> =>
          // accessor (not display) so the column is SORTABLE — getCanSort() needs
          // an accessorFn. Actual sorting is server-side (cf_sort); the accessor's
          // value is only used to enable the header's sort toggle.
          columnHelper.accessor((row) => row.custom[col.id]?.display ?? "", {
            id: `custom_${col.id}`,
            header: col.label,
            enableSorting: true,
            cell: ({ row }) => {
              const cell = row.original.custom[col.id];
              return (
                <span className="block max-w-[16rem] truncate" title={cell?.title}>
                  {cell?.display ?? "—"}
                </span>
              );
            },
          }) as ColumnDef<ExecutionRowView>,
      ),
    ],
    [customColumns],
  );

  // The active sort drives the indicator. A custom-field sort (cf_sort) is shown
  // on its column (id `custom_<mappingId>`); otherwise the fixed column.
  const sorting: SortingState = customSort
    ? [{ id: `custom_${customSort.mappingId}`, desc: customSort.direction === "desc" }]
    : [{ id: sort.key, desc: sort.direction === "desc" }];

  // Sorting happens in SQL — clicking a header just rewrites the URL. Fixed columns
  // use sort/dir; custom columns use cf_sort. Only ONE sort is active at a time, so
  // setting one clears the other (matching the backend).
  const handleSortingChange: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page"); // filters/sort changes reset to page 1
    const first = next[0];
    if (!first) {
      params.delete("sort");
      params.delete("dir");
      params.delete("cf_sort");
    } else if (first.id.startsWith("custom_")) {
      params.set("cf_sort", `${first.id.slice("custom_".length)}:${first.desc ? "desc" : "asc"}`);
      params.delete("sort");
      params.delete("dir");
    } else {
      params.set("sort", first.id);
      params.set("dir", first.desc ? "desc" : "asc");
      params.delete("cf_sort");
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualFiltering: true,
    manualSorting: true,
    enableSortingRemoval: false,
    sortDescFirst: true,
    state: { sorting },
    onSortingChange: handleSortingChange,
  });

  return (
    <div className="overflow-x-auto rounded-2xl border border-black/10 dark:border-white/10">
      <table className="w-full min-w-[60rem] border-collapse">
        <thead className="bg-black/[0.02] dark:bg-white/[0.03]">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-neutral-500"
                  >
                    {canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 uppercase transition-colors hover:text-neutral-300"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <span className="text-[10px] leading-none">
                          {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : "↕"}
                        </span>
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={FIXED_COLUMNS.length + customColumns.length}
                className="px-4 py-12 text-center text-sm text-neutral-500"
              >
                No executions match these filters.
              </td>
            </tr>
          ) : (
            table.getRowModel().rows.map((row) => {
              const href = `/executions/${row.original.id}`;
              return (
                <tr
                  key={row.id}
                  tabIndex={0}
                  role="link"
                  onClick={() => router.push(href)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      router.push(href);
                    }
                  }}
                  className="cursor-pointer border-t border-black/5 outline-none transition-colors hover:bg-black/[0.03] focus:bg-black/[0.04] dark:border-white/5 dark:hover:bg-white/[0.04] dark:focus:bg-white/[0.06]"
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3 text-sm">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
