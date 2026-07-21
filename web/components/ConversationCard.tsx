import Link from "next/link";
import { ModeBadge } from "./ModeBadge";
import { formatAgeShort } from "@/lib/format";
import { conversationPreview, type InboxConversationView } from "@/lib/inboxView";

function firstName(name: string | null): string {
  const n = (name ?? "").trim().split(/\s+/)[0];
  return n || "Agent";
}

function relTime(iso: string, now: Date): string {
  const r = formatAgeShort(new Date(iso), now);
  return r === "now" ? "just now" : `${r} ago`;
}

function ActivityTag({ active, windowHours }: { active: boolean; windowHours: number }) {
  return active ? (
    <span
      title={`Active — the customer wrote within the last ${windowHours}h`}
      className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-medium text-emerald-700 dark:text-emerald-400"
    >
      Active
    </span>
  ) : (
    <span
      title={`Inactive — no customer message in the last ${windowHours}h`}
      className="rounded-full bg-subtle px-1.5 py-0.5 font-medium text-faint"
    >
      Inactive
    </span>
  );
}

/**
 * One conversation card in the grid (H-7). The WHOLE card is the link to the thread.
 *   - human mode → a 4px LEFT accent strip in the Human-badge emerald + elevated shadow
 *     (H-8: was a full ring, which read as "selected").
 *   - pending mode → a 4px amber left strip + a subtle amber tint so the eye finds it
 *     first, plus pending-age and the latest escalation reason.
 *   - bot mode → no strip (the silent default).
 */
export function ConversationCard({
  view,
  href,
  now,
  activityWindowHours,
}: {
  view: InboxConversationView;
  href: string;
  now: Date;
  activityWindowHours: number;
}) {
  const human = view.mode === "human";
  const pending = view.mode === "pending";

  // H-8: the mode signal is a 4px LEFT accent strip (not a full ring, which read as
  // "selected"): human = the Human-badge emerald, pending = the pending amber, bot =
  // none. Human keeps a subtle elevation; pending keeps its faint amber tint so it
  // still draws the eye first.
  const cardClass = [
    "flex h-full flex-col gap-2 rounded-xl border border-black/10 bg-card p-4 transition-shadow dark:border-line",
    human ? "border-l-4 border-l-emerald-500 shadow-md dark:border-l-emerald-400" : "",
    pending ? "border-l-4 border-l-amber-500 bg-amber-500/[0.06] dark:border-l-amber-400" : "",
    !human && !pending ? "hover:shadow-sm" : "",
  ].join(" ");

  const reasonLine = pending
    ? view.escalationDetail
      ? `Escalated: “${view.escalationDetail}”`
      : view.escalationReasonCode
        ? `Escalated: ${view.escalationReasonCode}`
        : null
    : null;

  return (
    <Link href={href} className={cardClass}>
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate font-semibold text-foreground">{view.conversationRef}</span>
        <ModeBadge mode={view.mode} className="shrink-0" />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <ActivityTag active={view.active} windowHours={activityWindowHours} />
        {view.lastMessageAt ? (
          <span className="text-faint">{relTime(view.lastMessageAt, now)}</span>
        ) : null}
      </div>

      <p className="line-clamp-2 text-sm text-muted">{conversationPreview(view)}</p>

      {human && view.assignedAgentName ? (
        <div className="mt-auto text-xs font-medium text-emerald-700 dark:text-emerald-400">
          ● {firstName(view.assignedAgentName)}
        </div>
      ) : null}

      {pending ? (
        <div className="mt-auto flex flex-col gap-0.5 text-xs">
          <span className="font-medium text-amber-700 dark:text-amber-400">
            Pending {view.pendingSince ? formatAgeShort(new Date(view.pendingSince), now) : ""}
          </span>
          {reasonLine ? <span className="truncate text-faint">{reasonLine}</span> : null}
        </div>
      ) : null}
    </Link>
  );
}
