"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

interface FilterBarProps {
  status: string; // 'all' | 'success' | 'error'
  workflow: string; // n8n_workflow_id or ''
  client: string; // client id, 'unassigned', or ''
  from: string; // 'YYYY-MM-DD' or ''
  to: string; // 'YYYY-MM-DD' or ''
  workflows: { n8n_workflow_id: string; name: string | null }[];
  clients: { id: string; name: string }[];
}

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "success", label: "Success" },
  { value: "error", label: "Error" },
];

const controlClasses =
  "rounded-lg border border-black/10 bg-white/60 px-3 py-1.5 text-sm text-neutral-800 outline-none focus:border-black/30 dark:border-white/15 dark:bg-white/[0.04] dark:text-neutral-200 dark:focus:border-white/30";

export function FilterBar({
  status,
  workflow,
  client,
  from,
  to,
  workflows,
  clients,
}: FilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Apply param updates and always reset to page 1 (filters changed).
  const update = (changes: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    params.delete("page");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  const hasActiveFilters =
    (status && status !== "all") || workflow || client || from || to;

  return (
    <div className="flex flex-wrap items-end gap-4 rounded-2xl border border-black/10 bg-black/[0.02] p-4 dark:border-white/10 dark:bg-white/[0.03]">
      {/* Status segmented control */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Status
        </span>
        <div className="inline-flex overflow-hidden rounded-lg border border-black/10 dark:border-white/15">
          {STATUS_OPTIONS.map((opt) => {
            const active = (status || "all") === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  update({ status: opt.value === "all" ? null : opt.value })
                }
                className={`px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-neutral-200 font-medium text-neutral-900 dark:bg-white/15 dark:text-white"
                    : "text-neutral-500 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Workflow dropdown */}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Workflow
        </span>
        <select
          value={workflow}
          onChange={(e) => update({ workflow: e.target.value || null })}
          className={controlClasses}
        >
          <option value="">All workflows</option>
          {workflows.map((wf) => (
            <option key={wf.n8n_workflow_id} value={wf.n8n_workflow_id}>
              {wf.name ?? wf.n8n_workflow_id}
            </option>
          ))}
        </select>
      </label>

      {/* Client dropdown */}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Client
        </span>
        <select
          value={client}
          onChange={(e) => update({ client: e.target.value || null })}
          className={controlClasses}
        >
          <option value="">All clients</option>
          <option value="unassigned">Unassigned</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {/* Date range */}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          From
        </span>
        <input
          type="date"
          value={from}
          onChange={(e) => update({ from: e.target.value || null })}
          className={controlClasses}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          To
        </span>
        <input
          type="date"
          value={to}
          onChange={(e) => update({ to: e.target.value || null })}
          className={controlClasses}
        />
      </label>

      {hasActiveFilters ? (
        <button
          type="button"
          onClick={() => router.push(pathname)}
          className="ml-auto self-end rounded-lg px-3 py-1.5 text-sm text-neutral-500 transition-colors hover:text-neutral-300"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
