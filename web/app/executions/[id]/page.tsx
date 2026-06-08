import Link from "next/link";
import { notFound } from "next/navigation";
import { getExecutionByIdForTenant } from "@worker/db/repositories/executions.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { parseExecution } from "@/lib/executionDetail";
import { formatDateTime, formatDuration, statusBadgeClasses } from "@/lib/format";
import { NodeSections, type NodeView } from "./_components/NodeSections";

function SummaryField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
        {label}
      </dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

export default async function ExecutionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tenantId = await getCurrentTenantId();

  const execution = await getExecutionByIdForTenant({ tenantId, id });
  if (!execution) {
    notFound(); // not found OR another tenant's — indistinguishable on purpose
  }

  const parsed = parseExecution(execution.raw_data);

  const nodeViews: NodeView[] = parsed.nodes.map((node, i) => ({
    name: node.name,
    status: node.status,
    durationDisplay: formatDuration(node.totalTimeMs),
    hasError: node.hasError,
    // Expand error nodes plus the first and last node by default.
    defaultOpen: node.hasError || i === 0 || i === parsed.nodes.length - 1,
    runs: node.runs.map((run) => ({
      status: run.status,
      durationDisplay: formatDuration(run.executionTimeMs),
      output: run.output,
      input: run.input,
      error: run.error,
    })),
  }));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-12">
      <div>
        <Link
          href="/executions"
          className="text-sm text-neutral-500 transition-colors hover:text-neutral-300"
        >
          &larr; Back to executions
        </Link>
      </div>

      {/* Summary header */}
      <header className="space-y-4 rounded-2xl border border-black/10 bg-black/[0.02] p-5 dark:border-white/10 dark:bg-white/[0.03]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {execution.workflow_name}
          </h1>
          <span className={statusBadgeClasses(execution.status)}>{execution.status}</span>
        </div>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <SummaryField
            label="Client"
            value={
              execution.client_name ?? (
                <span className="text-neutral-600">Unassigned</span>
              )
            }
          />
          <SummaryField
            label="Execution ID"
            value={<span className="font-mono text-xs">{execution.n8n_execution_id}</span>}
          />
          <SummaryField label="Mode" value={execution.mode ?? "—"} />
          <SummaryField label="Duration" value={formatDuration(execution.duration_ms)} />
          <SummaryField label="Started" value={formatDateTime(execution.started_at)} />
          <SummaryField
            label="Stopped"
            value={execution.stopped_at ? formatDateTime(execution.stopped_at) : "—"}
          />
        </dl>
      </header>

      {/* Node timeline */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
            Nodes
          </h2>
          {parsed.hasRunData ? (
            <span className="text-xs text-neutral-500">
              {parsed.nodes.length} executed · in execution order
            </span>
          ) : null}
        </div>

        {parsed.hasRunData ? (
          <NodeSections nodes={nodeViews} />
        ) : (
          <div className="rounded-2xl border border-black/10 bg-black/[0.02] p-6 text-sm text-neutral-500 dark:border-white/10 dark:bg-white/[0.03]">
            No node-level data captured for this execution.
          </div>
        )}
      </section>
    </main>
  );
}
