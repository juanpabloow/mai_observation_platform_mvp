import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listTurnsForConversation } from "@worker/db/repositories/conversationTurns.js";
import { getConversationForWorkflow, getAgentSummary } from "@worker/db/repositories/handoff.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { getAccessScope, hasFullAccess } from "@/lib/access";
import { requireWorkflowUnderClient } from "@/lib/clientWorkflow";
import { isUuid, loadInboxThread } from "@/lib/inboxData";
import { InboxThread } from "@/components/InboxThread";
import { ChatScroll } from "@/components/ChatScroll";
import { ChatTranscript } from "@/components/ChatTranscript";

function hasText(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}

/**
 * Per-workflow Inbox thread (H-6). Two renderers over ONE route:
 *  - a handoff conversation (uuid resolves in the conversations table for this
 *    workflow) → the H-2/H-3 LIVE thread, plus a collapsed "History before handoff"
 *    section showing the derived turns for the same conversation_ref (separate,
 *    labeled, never merged/deduped).
 *  - otherwise (a derived conversation_ref) → the Phase-3 read-only transcript.
 */
export default async function WorkflowInboxThreadPage({
  params,
}: {
  params: Promise<{ clientId: string; workflowId: string; conversationId: string }>;
}) {
  await connection();
  const { clientId, workflowId, conversationId: rawId } = await params;
  const conversationId = decodeURIComponent(rawId);

  const workflow = await requireWorkflowUnderClient(clientId, workflowId, `inbox/${rawId}`);
  const linkClientId = workflow.client_id ?? clientId;
  const tenantId = await getCurrentTenantId();
  const inboxHref = `/clients/${encodeURIComponent(linkClientId)}/workflows/${encodeURIComponent(workflowId)}/inbox`;

  const back = (
    <Link href={inboxHref} className="text-sm text-muted transition-colors hover:text-foreground">
      &larr; Inbox
    </Link>
  );

  // Is this a live handoff conversation for THIS workflow?
  const detail = isUuid(conversationId)
    ? await getConversationForWorkflow(tenantId, workflowId, conversationId)
    : null;

  if (detail) {
    const scope = await getAccessScope();
    const [payload, viewer] = await Promise.all([
      loadInboxThread(tenantId, linkClientId, conversationId),
      getAgentSummary(scope.userId),
    ]);
    if (!payload) notFound(); // detail exists → payload should too; defensive
    // Pre-handoff history: derived turns for the SAME conversation_ref (read-only).
    const turns = await listTurnsForConversation({
      tenantId,
      n8nWorkflowId: workflowId,
      conversationId: detail.conversation_ref,
    });
    const now = new Date();

    return (
      <div className="flex flex-col gap-4">
        {back}
        <InboxThread
          clientId={linkClientId}
          initial={payload}
          viewerUserId={scope.userId}
          viewerName={viewer?.name ?? null}
          viewerIsFullAccess={hasFullAccess(scope)}
        />
        {turns.length > 0 ? (
          <details className="rounded-xl border border-black/10 dark:border-line">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted hover:text-foreground">
              History before handoff · {turns.length} {turns.length === 1 ? "turn" : "turns"}
            </summary>
            <div className="max-h-[60vh] overflow-y-auto border-t border-line bg-black/[0.02] px-4 py-4 dark:bg-card">
              <p className="mb-2 text-xs text-faint">
                Reconstructed from executions before live handoff was wired. Read-only; may
                overlap the live messages above around the wiring date.
              </p>
              <ChatTranscript turns={turns} now={now} />
            </div>
          </details>
        ) : null}
      </div>
    );
  }

  // Derived (non-handoff) conversation: the Phase-3 read-only transcript.
  const turns = await listTurnsForConversation({
    tenantId,
    n8nWorkflowId: workflowId,
    conversationId,
  });
  if (turns.length === 0) notFound();

  let contactName: string | null = null;
  for (const t of turns) {
    if (hasText(t.contact_name)) contactName = t.contact_name;
  }
  const displayName = contactName ?? conversationId;
  const now = new Date();

  return (
    <div className="flex flex-col gap-4">
      {back}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{displayName}</h2>
        {contactName ? <span className="font-mono text-xs text-neutral-500">{conversationId}</span> : null}
        <span className="text-sm text-neutral-500">
          · {turns.length} {turns.length === 1 ? "turn" : "turns"} · read-only
        </span>
      </div>
      <ChatScroll className="h-[70vh] overflow-y-auto rounded-xl border border-black/10 bg-black/[0.02] px-4 py-4 dark:border-line dark:bg-card">
        <ChatTranscript turns={turns} now={now} />
      </ChatScroll>
    </div>
  );
}
