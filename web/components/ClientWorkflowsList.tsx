"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

export interface ClientWorkflowRow {
  /** n8n workflow id — the URL segment + the mono id shown on the row. */
  n8nWorkflowId: string;
  name: string | null;
  active: boolean | null;
}

/**
 * The client's WORKFLOWS list (final-design page at /clients/<c>/workflows). A
 * searchable list of the workflows assigned to this client: status dot, name,
 * active/inactive label, and the mono workflow id. The whole row links to that
 * workflow's Executions. Search filters client-side over name + id; an empty client
 * and a no-match search each get their own empty state.
 */
export function ClientWorkflowsList({
  clientId,
  workflows,
}: {
  clientId: string;
  workflows: ClientWorkflowRow[];
}) {
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return workflows;
    return workflows.filter(
      (w) =>
        (w.name ?? "").toLowerCase().includes(needle) ||
        w.n8nWorkflowId.toLowerCase().includes(needle),
    );
  }, [workflows, search]);

  const href = (w: ClientWorkflowRow): string =>
    `/clients/${encodeURIComponent(clientId)}/workflows/${encodeURIComponent(w.n8nWorkflowId)}/executions`;

  // Empty client (nothing assigned) — distinct from a no-match search below.
  if (workflows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-line px-6 py-14 text-center">
        <p className="text-sm font-medium text-muted">No workflows yet</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-faint">
          Workflows assigned to this client will appear here. Assign one from{" "}
          <span className="text-muted">Clients &amp; Workflows</span>.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search workflows…"
        aria-label="Search workflows"
        className="h-9 w-full max-w-sm rounded-lg border border-black/10 bg-transparent px-3 text-sm outline-none focus:border-line-strong dark:border-line-strong"
      />

      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-faint">
          No workflows match &ldquo;{search.trim()}&rdquo;.
        </p>
      ) : (
        <ul className="divide-y divide-black/5 overflow-hidden rounded-2xl border border-black/10 dark:divide-white/5 dark:border-line">
          {visible.map((w) => (
            <li key={w.n8nWorkflowId}>
              <Link
                href={href(w)}
                className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-black/[0.03] dark:hover:bg-card"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      w.active ? "bg-green-400" : "bg-neutral-500"
                    }`}
                    title={w.active ? "Active" : "Inactive"}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {w.name ?? w.n8nWorkflowId}
                    </span>
                    <span className="block truncate font-mono text-xs text-neutral-500">
                      {w.n8nWorkflowId}
                    </span>
                  </span>
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                    w.active
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                      : "bg-subtle text-faint"
                  }`}
                >
                  {w.active ? "Active" : "Inactive"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
