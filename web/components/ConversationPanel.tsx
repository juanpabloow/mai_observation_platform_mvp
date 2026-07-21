import Link from "next/link";

/**
 * The conversation section header on the execution-detail pane (H-8.2): a COMPACT
 * single-line header (no card/box — flat, to match the pane's sharp-corner language).
 * Left: a small chat icon + the conversation_ref + "· N turns". Right: "Open in Inbox →"
 * (the inbox pane when this is a live handoff conversation, else the derived read-only
 * view). The transcript (handoff bubbles or the derived ChatTranscript) is the children.
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
    <div>
      <div className="flex items-center justify-between gap-2 px-4 py-2 text-xs">
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
  );
}
