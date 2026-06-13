import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listTurnsForConversation } from "@worker/db/repositories/conversationTurns.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { getWorkflowForCurrentTenant } from "@/lib/workflow";
import { ChatScroll } from "@/components/ChatScroll";
import { ChatTranscript } from "@/components/ChatTranscript";

function hasText(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}

export default async function ConversationThreadPage({
  params,
}: {
  params: Promise<{ workflowId: string; conversationId: string }>;
}) {
  await connection();
  const { workflowId, conversationId: rawConversationId } = await params;
  const conversationId = decodeURIComponent(rawConversationId);

  // The workflow layout already 404s if the workflow isn't this tenant's.
  const workflow = await getWorkflowForCurrentTenant(workflowId);
  if (!workflow) {
    notFound();
  }

  const tenantId = await getCurrentTenantId();
  const turns = await listTurnsForConversation({ tenantId, n8nWorkflowId: workflowId, conversationId });

  // No turns for this (tenant, workflow, conversation) → it isn't ours: 404.
  if (turns.length === 0) {
    notFound();
  }

  // Most recent non-null contact name (turns are chronological ASC).
  let contactName: string | null = null;
  for (const t of turns) {
    if (hasText(t.contact_name)) contactName = t.contact_name;
  }
  const displayName = contactName ?? conversationId;
  const now = new Date();
  const listHref = `/workflows/${encodeURIComponent(workflowId)}/conversations`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Link href={listHref} className="text-sm text-neutral-500 transition-colors hover:text-neutral-300">
          &larr; Conversations
        </Link>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold tracking-tight">{displayName}</h2>
          {contactName ? <span className="font-mono text-xs text-neutral-500">{conversationId}</span> : null}
          <span className="text-sm text-neutral-500">
            · {turns.length} {turns.length === 1 ? "turn" : "turns"}
          </span>
        </div>
      </div>

      <ChatScroll className="h-[70vh] overflow-y-auto rounded-xl border border-black/10 bg-black/[0.02] px-4 py-4 dark:border-white/10 dark:bg-white/[0.02]">
        <ChatTranscript turns={turns} now={now} />
      </ChatScroll>
    </div>
  );
}
