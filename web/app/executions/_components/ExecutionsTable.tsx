"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type OnChangeFn,
  type SortingState,
} from "@tanstack/react-table";
import { statusBadgeClasses } from "@/lib/format";

/**
 * Pre-formatted view of one execution row. Dates/durations are formatted on the
 * SERVER and passed as strings, so this client component does no locale work
 * (avoids hydration mismatches).
 */
export interface ExecutionRowView {
  id: string;
  status: string;
  workflowName: string;
  clientName: string | null;
  startedDisplay: string;
  durationDisplay: string;
  executionId: string;
}

const columnHelper = createColumnHelper<ExecutionRowView>();

const columns = [
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
];

interface ExecutionsTableProps {
  rows: ExecutionRowView[];
  sort: { key: string; direction: "asc" | "desc" };
}

export function ExecutionsTable({ rows, sort }: ExecutionsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Controlled sorting state reflecting the URL.
  const sorting: SortingState = [{ id: sort.key, desc: sort.direction === "desc" }];

  // Sorting happens in SQL — clicking a header just rewrites the URL.
  const handleSortingChange: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page"); // filters/sort changes reset to page 1
    const first = next[0];
    if (first) {
      params.set("sort", first.id);
      params.set("dir", first.desc ? "desc" : "asc");
    } else {
      params.delete("sort");
      params.delete("dir");
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
                colSpan={columns.length}
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
