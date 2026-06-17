"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * The conversation side panel on the execution-detail page: a header (contact +
 * link to the full thread + collapse toggle) over a chat transcript. Collapsible
 * so someone deep in node debugging can hide it; default open. The transcript
 * (server-rendered ChatScroll + ChatTranscript) is passed as children — when
 * collapsed it unmounts, so reopening re-centers on this execution's turn.
 */
export function ConversationPanel({
  contactName,
  conversationId,
  clientId,
  workflowId,
  turnCount,
  children,
}: {
  contactName: string | null;
  conversationId: string;
  clientId: string;
  workflowId: string;
  turnCount: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const displayName = contactName ?? conversationId;
  const fullHref = `/clients/${encodeURIComponent(clientId)}/workflows/${encodeURIComponent(workflowId)}/conversations/${encodeURIComponent(conversationId)}`;

  return (
    <aside className="flex flex-col gap-3 lg:sticky lg:top-6 lg:self-start">
      <div className="flex flex-col gap-2 rounded-2xl border border-black/10 bg-black/[0.02] p-4 dark:border-line dark:bg-card">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-medium text-accent">
              💬
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{displayName}</div>
              <div className="truncate text-xs text-neutral-500">
                {contactName ? `${conversationId} · ` : ""}
                {turnCount} {turnCount === 1 ? "turn" : "turns"}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 rounded-lg border border-black/10 px-2 py-1 text-xs text-muted transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-line-strong dark:hover:bg-subtle"
            aria-expanded={open}
          >
            {open ? "Hide" : "Show"}
          </button>
        </div>
        <Link
          href={fullHref}
          className="text-xs text-accent transition-colors hover:opacity-80"
        >
          Open full conversation →
        </Link>
      </div>

      {open ? children : null}
    </aside>
  );
}
