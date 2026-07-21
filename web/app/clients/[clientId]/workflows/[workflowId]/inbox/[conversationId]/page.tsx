import { connection } from "next/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { listTurnsForConversation } from "@worker/db/repositories/conversationTurns.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { requireWorkflowUnderClient } from "@/lib/clientWorkflow";
import { isUuid } from "@/lib/inboxData";
import { ChatScroll } from "@/components/ChatScroll";
import { ChatTranscript } from "@/components/ChatTranscript";

function hasText(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}

/**
 * Per-workflow Inbox thread route (H-8). The live handoff thread is now a DRAWER over
 * the grid (deep-linked via ?c=), so:
 *  - a handoff conversation (uuid) → 307-redirect to the inbox with ?c=<id> (opens the
 *    drawer); this also carries old thread bookmarks / notification links.
 *  - a derived (non-handoff) conversation_ref → the Phase-3 read-only transcript,
 *    unchanged.
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
  const inboxHref = `/clients/${encodeURIComponent(linkClientId)}/workflows/${encodeURIComponent(workflowId)}/inbox`;

  // Handoff conversations (uuid) open in the drawer via ?c=.
  if (isUuid(conversationId)) {
    redirect(`${inboxHref}?c=${encodeURIComponent(conversationId)}`);
  }

  // Derived (non-handoff) conversation: the Phase-3 read-only transcript.
  const tenantId = await getCurrentTenantId();
  const turns = await listTurnsForConversation({ tenantId, n8nWorkflowId: workflowId, conversationId });
  if (turns.length === 0) notFound();

  let contactName: string | null = null;
  for (const t of turns) {
    if (hasText(t.contact_name)) contactName = t.contact_name;
  }
  const displayName = contactName ?? conversationId;
  const now = new Date();

  return (
    <div className="flex flex-col gap-4">
      <Link href={inboxHref} className="text-sm text-muted transition-colors hover:text-foreground">
        &larr; Inbox
      </Link>
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
