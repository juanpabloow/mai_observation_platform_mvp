import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listTurnsForConversation, type ConversationTurnRow } from "@worker/db/repositories/conversationTurns.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { getWorkflowForCurrentTenant } from "@/lib/workflow";
import { formatChatTime, formatDayLabel, localDayKey } from "@/lib/format";
import { ChatScroll } from "@/components/ChatScroll";

function hasText(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}

/** One chat bubble: inbound (user, left, gray) or outbound (AI, right, green). */
function Bubble({ side, text, time }: { side: "in" | "out"; text: string; time: string }) {
  const out = side === "out";
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[78%] rounded-2xl px-3 py-2 shadow-sm ${
          out
            ? "rounded-br-sm bg-emerald-700/90 text-emerald-50"
            : "rounded-bl-sm bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
        }`}
      >
        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed">
          {text}
        </div>
        <div className={`mt-1 text-right text-[10px] ${out ? "text-emerald-100/70" : "text-neutral-500"}`}>
          {time}
        </div>
      </div>
    </div>
  );
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

  // Group consecutive turns by calendar day for date dividers.
  const now = new Date();
  const groups: { key: string; label: string; turns: ConversationTurnRow[] }[] = [];
  for (const t of turns) {
    const key = localDayKey(t.turn_timestamp);
    const last = groups[groups.length - 1];
    if (!last || last.key !== key) {
      groups.push({ key, label: formatDayLabel(t.turn_timestamp, now), turns: [t] });
    } else {
      last.turns.push(t);
    }
  }

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
        <div className="flex flex-col gap-2">
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-2">
              <div className="my-2 flex justify-center">
                <span className="rounded-full bg-black/5 px-3 py-1 text-xs text-neutral-500 dark:bg-white/5 dark:text-neutral-400">
                  {group.label}
                </span>
              </div>
              {group.turns.map((t) => {
                const time = formatChatTime(t.turn_timestamp);
                return (
                  <div key={t.id} className="flex flex-col gap-1">
                    {hasText(t.user_message) ? (
                      <Bubble side="in" text={t.user_message} time={time} />
                    ) : null}
                    {hasText(t.ai_response) ? (
                      <Bubble side="out" text={t.ai_response} time={time} />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </ChatScroll>
    </div>
  );
}
