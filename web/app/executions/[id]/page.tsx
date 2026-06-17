import Link from "next/link";
import { notFound } from "next/navigation";
import { getExecutionByIdForTenant } from "@worker/db/repositories/executions.js";
import {
  getTurnByExecution,
  listTurnsForConversation,
} from "@worker/db/repositories/conversationTurns.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { getWorkflowForCurrentTenant } from "@/lib/workflow";
import { parseExecution } from "@/lib/executionDetail";
import { formatDateTime, formatDuration, statusBadgeClasses } from "@/lib/format";
import { ChatScroll } from "@/components/ChatScroll";
import { ChatTranscript } from "@/components/ChatTranscript";
import { ConversationPanel } from "@/components/ConversationPanel";
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

function hasText(value: string | null): value is string {
  return value !== null && value.trim() !== "";
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

  // Resolve the execution's workflow → its client (tenant-scoped) so links point
  // at the nested client/workflow URLs. /executions/[id] itself stays global
  // (keyed by execution UUID); only the links OUT of it are nested.
  const workflow = await getWorkflowForCurrentTenant(execution.n8n_workflow_id);
  const workflowClientId = workflow?.client_id ?? null;
  const backHref = workflowClientId
    ? `/clients/${workflowClientId}/workflows/${encodeURIComponent(execution.n8n_workflow_id)}/executions`
    : "/clients";

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

  // Conversation context: a turn exists for THIS execution only when its workflow
  // has a (complete) conversation mapping AND this was a real message turn (not a
  // skipped status callback). One indexed lookup gates the whole panel; the
  // thread is loaded only when that turn exists.
  const turn = await getTurnByExecution({ tenantId, executionId: id });
  let conversationPanel: React.ReactNode = null;
  if (turn) {
    const thread = await listTurnsForConversation({
      tenantId,
      n8nWorkflowId: turn.n8n_workflow_id,
      conversationId: turn.conversation_id,
    });
    // Most recent non-null contact name (turns are chronological ASC).
    let contactName: string | null = null;
    for (const t of thread) {
      if (hasText(t.contact_name)) contactName = t.contact_name;
    }
    const now = new Date();
    conversationPanel = (
      <ConversationPanel
        contactName={contactName}
        conversationId={turn.conversation_id}
        clientId={workflowClientId ?? ""}
        workflowId={turn.n8n_workflow_id}
        turnCount={thread.length}
      >
        <ChatScroll
          focusSelector='[data-focus="true"]'
          className="h-[60vh] overflow-y-auto rounded-2xl border border-black/10 bg-black/[0.02] px-3 py-3 lg:h-[70vh] dark:border-line dark:bg-card"
        >
          {/* Highlight + center THIS execution's turn (use the canonical DB id). */}
          <ChatTranscript turns={thread} now={now} highlightExecutionId={execution.id} />
        </ChatScroll>
      </ConversationPanel>
    );
  }

  const nodesSection = (
    <section className="min-w-0 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">Nodes</h2>
        {parsed.hasRunData ? (
          <span className="text-xs text-neutral-500">
            {parsed.nodes.length} executed · in execution order
          </span>
        ) : null}
      </div>

      {parsed.hasRunData ? (
        <NodeSections nodes={nodeViews} />
      ) : (
        <div className="rounded-2xl border border-black/10 bg-black/[0.02] p-6 text-sm text-neutral-500 dark:border-line dark:bg-card">
          No node-level data captured for this execution.
        </div>
      )}
    </section>
  );

  const hasPanel = conversationPanel !== null;

  return (
    <main
      className={`mx-auto flex w-full flex-1 flex-col gap-6 px-6 py-12 ${
        hasPanel ? "max-w-7xl" : "max-w-5xl"
      }`}
    >
      <div>
        <Link
          href={backHref}
          className="text-sm text-neutral-500 transition-colors hover:text-foreground"
        >
          &larr; Back to {execution.workflow_name}
        </Link>
      </div>

      {/* Summary header (full width) */}
      <header className="space-y-4 rounded-2xl border border-black/10 bg-black/[0.02] p-5 dark:border-line dark:bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {execution.workflow_name}
          </h1>
          <span className={statusBadgeClasses(execution.status)}>{execution.status}</span>
        </div>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <SummaryField
            label="Client"
            value={execution.client_name ?? <span className="text-faint">Unassigned</span>}
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

      {/* Two columns when this execution is part of a conversation; otherwise the
          detail view is unchanged (single column, full width). On narrow screens
          the conversation panel stacks above the nodes. */}
      {hasPanel ? (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
          <div className="order-last min-w-0 lg:order-none">{nodesSection}</div>
          <div className="order-first lg:order-none">{conversationPanel}</div>
        </div>
      ) : (
        nodesSection
      )}
    </main>
  );
}
