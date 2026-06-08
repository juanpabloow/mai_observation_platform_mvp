import Link from "next/link";
import { connection } from "next/server";
import {
  listExecutionsPage,
  type ExecutionListItem,
} from "@worker/db/repositories/executions.js";
import { getCurrentTenantId } from "@/lib/tenant";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

type SearchParams = Record<string, string | string[] | undefined>;

function parseIntParam(value: string | string[] | undefined, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/** Tailwind classes for a status badge. */
function statusBadgeClasses(status: string): string {
  const base =
    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset";
  switch (status) {
    case "success":
      return `${base} bg-green-500/15 text-green-400 ring-green-500/30`;
    case "error":
    case "crashed":
      return `${base} bg-red-500/15 text-red-400 ring-red-500/30`;
    default:
      return `${base} bg-white/10 text-neutral-300 ring-white/15`;
  }
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
  if (ms === null) {
    return "—";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  return `${(seconds / 60).toFixed(1)}m`;
}

// Shared grid template so the header and every row align.
const GRID_COLS =
  "grid-cols-[7rem_minmax(12rem,1.6fr)_minmax(8rem,1fr)_11rem_6rem_8rem]";

export default async function ExecutionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await connection();

  const sp = await searchParams;
  const pageSize = Math.min(
    Math.max(parseIntParam(sp.pageSize, DEFAULT_PAGE_SIZE), 1),
    MAX_PAGE_SIZE,
  );
  const page = Math.max(parseIntParam(sp.page, 1), 1);

  const tenantId = await getCurrentTenantId();
  const { rows, total } = await listExecutionsPage({
    tenantId,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  const pageHref = (target: number): string =>
    `/executions?page=${target}&pageSize=${pageSize}`;

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
          {total.toLocaleString()} total · newest first
        </p>
      </header>

      <div className="overflow-x-auto rounded-2xl border border-black/10 dark:border-white/10">
        <div className="min-w-[60rem]">
          {/* Header row */}
          <div
            className={`grid ${GRID_COLS} gap-3 border-b border-black/10 bg-black/[0.02] px-4 py-3 text-xs font-medium uppercase tracking-wider text-neutral-500 dark:border-white/10 dark:bg-white/[0.03]`}
          >
            <div>Status</div>
            <div>Workflow</div>
            <div>Client</div>
            <div>Started</div>
            <div>Duration</div>
            <div>Execution ID</div>
          </div>

          {/* Data rows — each row links to its detail page */}
          {rows.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-neutral-500">
              No executions on this page.
            </div>
          ) : (
            rows.map((row: ExecutionListItem) => (
              <Link
                key={row.id}
                href={`/executions/${row.id}`}
                className={`grid ${GRID_COLS} items-center gap-3 border-b border-black/5 px-4 py-3 text-sm transition-colors last:border-b-0 hover:bg-black/[0.03] dark:border-white/5 dark:hover:bg-white/[0.04]`}
              >
                <div>
                  <span className={statusBadgeClasses(row.status)}>
                    {row.status}
                  </span>
                </div>
                <div className="truncate font-medium" title={row.workflow_name}>
                  {row.workflow_name}
                </div>
                <div className="truncate text-neutral-400">
                  {row.client_name ?? (
                    <span className="text-neutral-600">Unassigned</span>
                  )}
                </div>
                <div className="text-neutral-400">
                  {formatStarted(row.started_at)}
                </div>
                <div className="tabular-nums text-neutral-400">
                  {formatDuration(row.duration_ms)}
                </div>
                <div className="truncate font-mono text-xs text-neutral-500">
                  {row.n8n_execution_id}
                </div>
              </Link>
            ))
          )}
        </div>
      </div>

      {/* Pagination */}
      <nav className="flex items-center justify-between text-sm">
        <span className="text-neutral-500">
          Page {page} of {totalPages}
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
