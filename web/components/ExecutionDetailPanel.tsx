import {
  getTurnByExecution,
  listTurnsForConversation,
} from "@worker/db/repositories/conversationTurns.js";
import {
  getHandoffConversationIdByRef,
  listThreadMessages,
} from "@worker/db/repositories/handoff.js";
import { parseExecution } from "@/lib/executionDetail";
import { formatDateTime, formatDuration, statusBadgeClasses } from "@/lib/format";
import { toMessageView } from "@/lib/inboxData";
import { ChatScroll } from "@/components/ChatScroll";
import { ChatTranscript } from "@/components/ChatTranscript";
import { ConversationPanel } from "@/components/ConversationPanel";
import { MessageTranscript } from "@/components/MessageTranscript";
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

/**
 * Collect WhatsApp wamids anywhere in the execution's raw_data (best-effort deep scan
 * of the n8n runData JSON). These are the id-precise link between an execution and the
 * live handoff_messages (inbound wamid from the trigger payload; the outbound send
 * wamid). When none are found we fall back to the execution's time window (H-8.2 §3).
 */
function extractWamids(rawData: unknown): Set<string> {
  const out = new Set<string>();
  const RE = /^wamid\.[A-Za-z0-9+/=_-]+$/;
  // n8n runData nests deeply: resultData.runData.<node>[run].data.main[out][item].json
  // .<field> is ~10 levels down, so the guard has to allow for that (it only exists to
  // stop pathological/very deep JSON, not to bound normal payloads).
  const walk = (v: unknown, depth: number): void => {
    if (v == null || depth > 16) return;
    if (typeof v === "string") {
      if (RE.test(v)) out.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
    }
  };
  walk(rawData, 0);
  return out;
}

/**
 * Execution detail rendered INSIDE the shared SidePane (H-8.2). SERVER component. The
 * chrome is FLAT + dense per the pane's sharp-corner language: a full-width summary
 * header (status + id on one line, the timing facts as a compact grid), the
 * conversation, and the node list (joined divide-y rows). No card-in-card insets.
 *
 * CONVERSATION (H-8.2 §3):
 *  - handoff-active conversation (a live handoff record exists for this ref) → the
 *    transcript renders from handoff_messages with the SAME bubbles as the inbox thread
 *    (grouping, in-bubble timestamps, date separators). The messages belonging to THIS
 *    execution are highlighted: id-precise via wamid (external_message_id) when the
 *    raw_data carries them (labeled "this execution"), else a silent time-window match.
 *  - otherwise (non-handoff) → the derived conversation_turns transcript, unchanged,
 *    with this execution's turn ringed + centered.
 *
 * Keyed by execution id upstream, so swapping rows remounts it (fresh node collapse).
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
  // mapping AND this was a real message turn. One indexed lookup gates the section.
  const turn = await getTurnByExecution({ tenantId, executionId: execution.id });
  let conversation: React.ReactNode = null;
  if (turn) {
    const now = new Date();
    const inboxBase = `/clients/${encodeURIComponent(clientId)}/workflows/${encodeURIComponent(turn.n8n_workflow_id)}/inbox`;
    // A live handoff conversation for this ref → unified bubbles + the inbox pane link.
    const handoffId = await getHandoffConversationIdByRef(
      tenantId,
      turn.n8n_workflow_id,
      turn.conversation_id,
    );

    if (handoffId) {
      const messages = await listThreadMessages(tenantId, handoffId);
      // THIS-EXECUTION highlight: id-precise (wamid) first, else the time window.
      const wamids = extractWamids(execution.raw_data);
      const highlight = new Set<string>();
      for (const m of messages) {
        if (m.external_message_id && wamids.has(m.external_message_id)) highlight.add(m.id);
      }
      let labeled = highlight.size > 0;
      if (!labeled) {
        const start = execution.started_at.getTime();
        const end = (execution.stopped_at ?? execution.started_at).getTime();
        for (const m of messages) {
          const t = m.occurred_at.getTime();
          if (t >= start && t <= end) highlight.add(m.id);
        }
        labeled = false; // silent best-effort — no "this execution" label on time matches
      }
      const views = messages.map(toMessageView);
      conversation = (
        <ConversationPanel
          conversationRef={turn.conversation_id}
          turnCount={views.length}
          openHref={`${inboxBase}?c=${encodeURIComponent(handoffId)}`}
        >
          <div className="bg-black/[0.02] px-4 py-3 dark:bg-card">
            <MessageTranscript
              messages={views}
              now={now}
              highlightIds={highlight}
              highlightLabel={labeled}
            />
          </div>
        </ConversationPanel>
      );
    } else {
      const thread = await listTurnsForConversation({
        tenantId,
        n8nWorkflowId: turn.n8n_workflow_id,
        conversationId: turn.conversation_id,
      });
      conversation = (
        <ConversationPanel
          conversationRef={turn.conversation_id}
          turnCount={thread.length}
          openHref={`${inboxBase}/${encodeURIComponent(turn.conversation_id)}`}
        >
          <ChatScroll
            focusSelector='[data-focus="true"]'
            className="max-h-[55vh] overflow-y-auto bg-black/[0.02] px-4 py-3 dark:bg-card"
          >
            {/* Highlight + center THIS execution's turn (canonical DB id). */}
            <ChatTranscript turns={thread} now={now} highlightExecutionId={execution.id} />
          </ChatScroll>
        </ConversationPanel>
      );
    }
  }

  return (
    <div className="flex flex-col">
      {/* Summary — FLAT, full-width: status + id on one line, facts as a compact grid. */}
      <section className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={statusBadgeClasses(execution.status)}>{execution.status}</span>
          <span className="font-mono text-[11px] text-faint">{execution.n8n_execution_id}</span>
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
          <Field label="Started" value={formatDateTime(execution.started_at)} />
          <Field label="Duration" value={formatDuration(execution.duration_ms)} />
          <Field label="Mode" value={execution.mode ?? "—"} />
          <Field
            label="Stopped"
            value={execution.stopped_at ? formatDateTime(execution.stopped_at) : "—"}
          />
        </dl>
      </section>

      {/* Conversation (only when a mapped turn exists). */}
      {conversation ? <section className="border-b border-line py-2">{conversation}</section> : null}

      {/* Nodes — joined flat rows. */}
      <section className="px-4 py-3">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">Nodes</h3>
          {parsed.hasRunData ? (
            <span className="text-[11px] text-neutral-500">{parsed.nodes.length} executed</span>
          ) : null}
        </div>
        {parsed.hasRunData ? (
          <NodeSections nodes={nodeViews} />
        ) : (
          <p className="text-sm text-neutral-500">No node-level data captured for this execution.</p>
        )}
      </section>
    </div>
  );
}
