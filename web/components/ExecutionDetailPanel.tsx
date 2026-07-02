import {
  getTurnByExecution,
  listTurnsForConversation,
} from "@worker/db/repositories/conversationTurns.js";
import { parseExecution } from "@/lib/executionDetail";
import { formatDateTime, formatDuration, statusBadgeClasses } from "@/lib/format";
import { ChatScroll } from "@/components/ChatScroll";
import { ChatTranscript } from "@/components/ChatTranscript";
import { ConversationPanel } from "@/components/ConversationPanel";
import { NodeSections, type NodeView } from "@/components/NodeSections";

/** The execution fields the panel needs (a structural subset of ExecutionDetailRow). */
export interface ExecutionDetailData {
  id: string;
  n8n_execution_id: string;
  status: string;
  mode: string | null;
  started_at: Date;
  stopped_at: Date | null;
  duration_ms: number | null;
  n8n_workflow_id: string;
  raw_data: unknown | null;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">{label}</dt>
      <dd className="text-xs">{value}</dd>
    </div>
  );
}

function hasText(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}

/**
 * Execution detail rendered INSIDE the executions-page side panel (replaces the
 * old full-page /executions/[id]). SERVER component: it parses the execution and
 * loads the conversation thread exactly as the old page did — the node history
 * (NodeSections + JsonTree oversized-payload guard), the compact summary, and the
 * C4 conversation (this execution's turn highlighted/centered, link to the full
 * thread) are preserved byte-for-byte in behavior; only the CHROME is compacted
 * for a panel (no big workflow-name h1 / Client field — that context is already in
 * the stable breadcrumb + workflow heading around the panel).
 *
 * RESPONSIVE WITHIN THE PANEL (not the viewport): the wrapper is inside the
 * workspace's `@container`, so when a conversation exists it sits to the RIGHT of
 * the nodes once the PANEL is wide enough (≥ 42rem), and STACKS ABOVE the nodes
 * when the panel is narrower — recomputed by CSS as the user drags the divider.
 *
 * The caller keys this by execution id, so swapping rows remounts it (fresh node
 * collapse + the chat re-centers on the new turn) while an auto-refresh of the
 * table beneath — same id, same key — preserves the open panel's state.
 */
export async function ExecutionDetailPanel({
  execution,
  tenantId,
  clientId,
}: {
  execution: ExecutionDetailData;
  tenantId: string;
  clientId: string;
}) {
  const parsed = parseExecution(execution.raw_data);

  const nodeViews: NodeView[] = parsed.nodes.map((node, i) => ({
    name: node.name,
    status: node.status,
    durationDisplay: formatDuration(node.totalTimeMs),
    hasError: node.hasError,
    // Expand error nodes plus the first and last node by default (unchanged).
    defaultOpen: node.hasError || i === 0 || i === parsed.nodes.length - 1,
    runs: node.runs.map((run) => ({
      status: run.status,
      durationDisplay: formatDuration(run.executionTimeMs),
      output: run.output,
      input: run.input,
      error: run.error,
    })),
  }));

  // Conversation context (C4): a turn exists only when this workflow has a complete
  // mapping AND this was a real message turn. One indexed lookup gates the panel.
  const turn = await getTurnByExecution({ tenantId, executionId: execution.id });
  let conversation: React.ReactNode = null;
  if (turn) {
    const thread = await listTurnsForConversation({
      tenantId,
      n8nWorkflowId: turn.n8n_workflow_id,
      conversationId: turn.conversation_id,
    });
    let contactName: string | null = null;
    for (const t of thread) {
      if (hasText(t.contact_name)) contactName = t.contact_name;
    }
    const now = new Date();
    conversation = (
      <ConversationPanel
        contactName={contactName}
        conversationId={turn.conversation_id}
        clientId={clientId}
        workflowId={turn.n8n_workflow_id}
        turnCount={thread.length}
      >
        <ChatScroll
          focusSelector='[data-focus="true"]'
          className="h-[55vh] overflow-y-auto rounded-2xl border border-black/10 bg-black/[0.02] px-3 py-3 dark:border-line dark:bg-card"
        >
          {/* Highlight + center THIS execution's turn (canonical DB id). */}
          <ChatTranscript turns={thread} now={now} highlightExecutionId={execution.id} />
        </ChatScroll>
      </ConversationPanel>
    );
  }

  const nodesSection = (
    <section className="min-w-0 space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">Nodes</h2>
        {parsed.hasRunData ? (
          <span className="text-[11px] text-neutral-500">{parsed.nodes.length} executed</span>
        ) : null}
      </div>
      {parsed.hasRunData ? (
        <NodeSections nodes={nodeViews} />
      ) : (
        <div className="rounded-xl border border-black/10 bg-black/[0.02] p-5 text-sm text-neutral-500 dark:border-line dark:bg-card">
          No node-level data captured for this execution.
        </div>
      )}
    </section>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Compact summary — status + the essential ids/timings (no workflow-name h1
          or Client: both live in the stable breadcrumb/heading around the panel). */}
      <header className="space-y-3 rounded-2xl border border-black/10 bg-black/[0.02] p-4 dark:border-line dark:bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={statusBadgeClasses(execution.status)}>{execution.status}</span>
          <span className="font-mono text-[11px] text-faint">{execution.n8n_execution_id}</span>
        </div>
        <dl className="grid grid-cols-2 gap-3">
          <Field label="Started" value={formatDateTime(execution.started_at)} />
          <Field label="Duration" value={formatDuration(execution.duration_ms)} />
          <Field label="Mode" value={execution.mode ?? "—"} />
          <Field
            label="Stopped"
            value={execution.stopped_at ? formatDateTime(execution.stopped_at) : "—"}
          />
        </dl>
      </header>

      {/* When a conversation exists: nodes + conversation. Side-by-side once the
          PANEL is wide (@[42rem] container width), stacked (conversation above the
          nodes) when narrow — CSS container query, so dragging the divider changes
          which layout applies. Non-chat executions: nodes take the full width. */}
      {conversation ? (
        <div className="grid grid-cols-1 gap-4 @[42rem]:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="@[42rem]:order-last">{conversation}</div>
          <div className="min-w-0 @[42rem]:order-first">{nodesSection}</div>
        </div>
      ) : (
        nodesSection
      )}
    </div>
  );
}
