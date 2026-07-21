import Link from "next/link";

/**
 * The conversation on the execution-detail panel (H-8): a COMPACT single-line header
 * ON the transcript box itself (no standalone card). Left: a small chat icon + the
 * conversation_ref + "· N turns". Right: "Open in Inbox →" (the inbox drawer when this
 * is a live handoff conversation, else the derived read-only view). The transcript
 * (server-rendered ChatScroll + ChatTranscript) is passed as children, borderless —
 * this box provides the border.
 */
export function ConversationPanel({
  conversationRef,
  turnCount,
  openHref,
  children,
}: {
  conversationRef: string;
  turnCount: number;
  openHref: string;
  children: React.ReactNode;
}) {
  return (
    <aside className="lg:sticky lg:top-6 lg:self-start">
      <div className="overflow-hidden rounded-2xl border border-black/10 dark:border-line">
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 text-xs">
          <span className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden>💬</span>
            <span className="truncate font-medium text-foreground">{conversationRef}</span>
            <span className="shrink-0 text-neutral-500">
              · {turnCount} {turnCount === 1 ? "turn" : "turns"}
            </span>
          </span>
          <Link href={openHref} className="shrink-0 text-accent transition-colors hover:opacity-80">
            Open in Inbox →
          </Link>
        </div>
        {children}
      </div>
    </aside>
  );
}
