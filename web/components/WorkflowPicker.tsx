"use client";

import { useState } from "react";
import Link from "next/link";

export interface WorkflowListItem {
  n8n_workflow_id: string;
  name: string | null;
  active: boolean | null;
  execution_count: number;
}

/**
 * Searchable list of the tenant's workflows. The workflow list is small (unlike
 * executions), so client-side filtering over the already-loaded list is fine.
 * Selecting one navigates to /workflows/<id>/executions.
 */
export function WorkflowPicker({ workflows }: { workflows: WorkflowListItem[] }) {
  const [search, setSearch] = useState("");

  const q = search.trim().toLowerCase();
  const filtered = q
    ? workflows.filter(
        (w) =>
          (w.name ?? "").toLowerCase().includes(q) ||
          w.n8n_workflow_id.toLowerCase().includes(q),
      )
    : workflows;

  return (
    <div className="flex flex-col gap-4">
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search workflows…"
        className="w-full rounded-lg border border-black/10 bg-white/60 px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:bg-white/[0.04] dark:text-neutral-200 dark:focus:border-white/30"
      />

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-black/10 p-8 text-center text-sm text-neutral-500 dark:border-white/10">
          No workflows match “{search}”.
        </div>
      ) : (
        <ul className="overflow-hidden rounded-2xl border border-black/10 dark:border-white/10">
          {filtered.map((w) => (
            <li key={w.n8n_workflow_id}>
              <Link
                href={`/workflows/${encodeURIComponent(w.n8n_workflow_id)}/executions`}
                className="flex items-center justify-between gap-4 border-b border-black/5 px-4 py-3 transition-colors last:border-b-0 hover:bg-black/[0.03] dark:border-white/5 dark:hover:bg-white/[0.04]"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      w.active ? "bg-green-400" : "bg-neutral-600"
                    }`}
                    title={w.active ? "Active" : "Inactive"}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {w.name ?? w.n8n_workflow_id}
                    </span>
                    <span className="block truncate font-mono text-xs text-neutral-500">
                      {w.n8n_workflow_id}
                    </span>
                  </span>
                </span>
                <span className="shrink-0 text-sm tabular-nums text-neutral-500">
                  {w.execution_count.toLocaleString()} exec
                  {w.execution_count === 1 ? "" : "s"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
