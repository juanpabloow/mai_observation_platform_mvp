import { connection } from "next/server";
import Link from "next/link";
import { listConversationMappings } from "@worker/db/repositories/fieldMappings.js";
import { listConversations } from "@worker/db/repositories/conversationTurns.js";
import { isWorkflowHandoffActive } from "@worker/db/repositories/handoff.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { requireWorkflowUnderClient } from "@/lib/clientWorkflow";
import { loadWorkflowInboxList } from "@/lib/inboxData";
import { formatListTimestamp } from "@/lib/format";
import { ConversationGrid } from "@/components/ConversationGrid";
import { ConversationList, type ConversationListItem } from "@/components/ConversationList";
import { EnableHandoffCallout } from "@/components/EnableHandoffCallout";

/**
 * Per-workflow INBOX (H-6) — replaces the old per-workflow "Conversations" section.
 *
 *  - HANDOFF-ACTIVE workflow (has a webhook OR any handoff_messages): the live inbox
 *    (conversations table) — reuses the H-2 list; the thread is the H-2/H-3 live thread.
 *  - NON-handoff workflow: the Phase-3 execution-derived Conversations view, unchanged
 *    and read-only, plus a dismissible callout to enable handoff.
 *
 * The field-mapping settings surface stays where it lives (/conversations/settings) —
 * it feeds the derived renderer and future platform-side escalation rules.
 */
const LIST_CAP = 500;
const PREVIEW_MAX = 120;
function truncate(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}

export default async function WorkflowInboxPage({
  params,
}: {
  params: Promise<{ clientId: string; workflowId: string }>;
}) {
  await connection();
  const { clientId, workflowId } = await params;

  const workflow = await requireWorkflowUnderClient(clientId, workflowId, "inbox");
  const linkClientId = workflow.client_id ?? clientId;
  const tenantId = await getCurrentTenantId();

  const inboxBase = `/clients/${encodeURIComponent(linkClientId)}/workflows/${encodeURIComponent(workflowId)}/inbox`;
  const settingsHref = `/clients/${encodeURIComponent(linkClientId)}/workflows/${encodeURIComponent(workflowId)}/conversations/settings`;

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold tracking-tight">Inbox</h2>
      <Link
        href={settingsHref}
        className="rounded-lg border border-black/10 px-3 py-1.5 text-sm text-muted transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-line-strong dark:hover:bg-subtle"
      >
        ⚙ Handoff &amp; mapping settings
      </Link>
    </div>
  );

  const handoffActive = await isWorkflowHandoffActive(tenantId, workflowId);

  // ── HANDOFF-ACTIVE: the live conversation GRID (conversations table) ──
  if (handoffActive) {
    const initial = await loadWorkflowInboxList(tenantId, workflowId);
    return (
      <div className="flex flex-col gap-4">
        {header}
        <ConversationGrid
          clientId={linkClientId}
          initial={initial}
          endpoint={`/api/inbox/${encodeURIComponent(linkClientId)}/workflows/${encodeURIComponent(workflowId)}/conversations`}
        />
      </div>
    );
  }

  // ── NON-handoff: the derived (Phase-3) conversations view, read-only + a callout ──
  const [mappings, conversations] = await Promise.all([
    listConversationMappings({ tenantId, n8nWorkflowId: workflowId }),
    listConversations({ tenantId, n8nWorkflowId: workflowId, limit: LIST_CAP }),
  ]);
  const roles = new Set(mappings.map((m) => m.role));
  const configured = roles.has("conversation_id") && roles.has("user_message");

  const callout = <EnableHandoffCallout workflowId={workflowId} settingsHref={settingsHref} />;

  if (!configured) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        {callout}
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-black/15 px-6 py-14 text-center dark:border-line-strong">
          <p className="text-sm text-muted">
            This workflow doesn&rsquo;t have a conversation mapping yet.
          </p>
          <p className="max-w-md text-sm text-neutral-500">
            Tell the platform which fields hold the conversation id, the user message,
            and the AI response, and chats will be reconstructed here.
          </p>
          <Link
            href={settingsHref}
            className="mt-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
          >
            Configure conversation mapping
          </Link>
        </div>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        {callout}
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-black/15 px-6 py-14 text-center dark:border-line-strong">
          <p className="text-sm text-muted">No conversations yet.</p>
          <p className="max-w-md text-sm text-neutral-500">
            Once this workflow processes messages, reconstructed chats will appear here
            automatically.
          </p>
        </div>
      </div>
    );
  }

  const now = new Date();
  const items: ConversationListItem[] = conversations.map((c) => ({
    conversationId: c.conversation_id,
    contactName: c.contact_name,
    displayName: c.contact_name ?? c.conversation_id,
    preview: truncate(c.last_ai_response ?? c.last_user_message ?? ""),
    timestamp: formatListTimestamp(c.last_activity, now),
    turnCount: c.turn_count,
  }));
  const capped = conversations.length >= LIST_CAP;

  return (
    <div className="flex flex-col gap-4">
      {header}
      {callout}
      <ConversationList
        clientId={linkClientId}
        workflowId={workflowId}
        conversations={items}
        basePath={inboxBase}
      />
      {capped ? (
        <p className="text-center text-xs text-faint">
          Showing the {LIST_CAP} most recently active conversations.
        </p>
      ) : null}
    </div>
  );
}
