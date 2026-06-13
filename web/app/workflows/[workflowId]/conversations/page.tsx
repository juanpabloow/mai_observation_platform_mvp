import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listConversationMappings } from "@worker/db/repositories/fieldMappings.js";
import { listConversations } from "@worker/db/repositories/conversationTurns.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { getWorkflowForCurrentTenant } from "@/lib/workflow";
import { formatListTimestamp } from "@/lib/format";
import { ConversationList, type ConversationListItem } from "@/components/ConversationList";

/** Cap the number of threads loaded into the list (most recently active first). */
const LIST_CAP = 500;
const PREVIEW_MAX = 120;

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}

export default async function ConversationsPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  await connection();
  const { workflowId } = await params;

  const workflow = await getWorkflowForCurrentTenant(workflowId);
  if (!workflow) {
    notFound();
  }

  const tenantId = await getCurrentTenantId();
  const [mappings, conversations] = await Promise.all([
    listConversationMappings({ tenantId, n8nWorkflowId: workflowId }),
    listConversations({ tenantId, n8nWorkflowId: workflowId, limit: LIST_CAP }),
  ]);

  // A workflow can only produce turns once the two derivation-required roles are
  // mapped — that's what gates "configured" vs "needs setup".
  const roles = new Set(mappings.map((m) => m.role));
  const configured = roles.has("conversation_id") && roles.has("user_message");

  const settingsHref = `/workflows/${encodeURIComponent(workflowId)}/conversations/settings`;
  const now = new Date();

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold tracking-tight">Conversations</h2>
      <Link
        href={settingsHref}
        className="rounded-lg border border-black/10 px-3 py-1.5 text-sm text-neutral-400 transition-colors hover:bg-black/[0.04] hover:text-neutral-200 dark:border-white/15 dark:hover:bg-white/[0.06]"
      >
        ⚙ Conversation settings
      </Link>
    </div>
  );

  // Not configured → prompt to set up the mapping (never an empty chat list).
  if (!configured) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-black/15 px-6 py-14 text-center dark:border-white/15">
          <p className="text-sm text-neutral-400">
            This workflow doesn&rsquo;t have a conversation mapping yet.
          </p>
          <p className="max-w-md text-sm text-neutral-500">
            Tell the platform which fields hold the conversation id, the user
            message, and the AI response, and chats will be reconstructed here.
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

  // Configured but nothing derived yet → friendly empty state.
  if (conversations.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-black/15 px-6 py-14 text-center dark:border-white/15">
          <p className="text-sm text-neutral-400">No conversations yet.</p>
          <p className="max-w-md text-sm text-neutral-500">
            Once this workflow processes messages, reconstructed chats will appear
            here automatically.
          </p>
        </div>
      </div>
    );
  }

  const items: ConversationListItem[] = conversations.map((c) => ({
    conversationId: c.conversation_id,
    contactName: c.contact_name,
    displayName: c.contact_name ?? c.conversation_id,
    // Preview = the most recent message: the latest turn's AI reply if any,
    // else its user message.
    preview: truncate(c.last_ai_response ?? c.last_user_message ?? ""),
    timestamp: formatListTimestamp(c.last_activity, now),
    turnCount: c.turn_count,
  }));

  const capped = conversations.length >= LIST_CAP;

  return (
    <div className="flex flex-col gap-4">
      {header}
      <ConversationList workflowId={workflowId} conversations={items} />
      {capped ? (
        <p className="text-center text-xs text-neutral-600">
          Showing the {LIST_CAP} most recently active conversations.
        </p>
      ) : null}
    </div>
  );
}
