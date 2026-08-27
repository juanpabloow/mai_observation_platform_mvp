import type { InboxConversationView, InboxMode } from "./inboxView";

/**
 * PURE, client-safe state mapping for the unified inbox list (no server imports).
 *
 * REAL states only. A conversation's persisted `mode` is DB CHECK-constrained to
 * exactly `bot | pending | human` — there is NO "resolved"/"closed" state: the
 * resolve/return-to-bot/dismiss actions all set the mode back to `bot`, so a
 * "resolved" conversation is indistinguishable from a bot-active one and is therefore
 * NOT a separate group. The three operative groups map straight from the mode:
 *   - pending → "Necesita a una persona" (escalated, waiting for a human);
 *   - human   → "Un humano atiende" (taken/assigned; assignedAgentName says who);
 *   - bot     → "El bot atiende" (bot active, no human requested).
 */

export type InboxGroupKey = "needs_attention" | "human" | "bot";

export interface InboxGroupMeta {
  key: InboxGroupKey;
  label: string;
  /** Tone token — the UI pairs it with TEXT + an icon, never color alone (a11y). */
  tone: "attention" | "human" | "bot";
}

/** Fixed display order: most-urgent first. */
export const INBOX_GROUP_ORDER: InboxGroupMeta[] = [
  { key: "needs_attention", label: "Necesita a una persona", tone: "attention" },
  { key: "human", label: "Un humano atiende", tone: "human" },
  { key: "bot", label: "El bot atiende", tone: "bot" },
];

/** The operative group for a conversation's REAL mode. Total over the three modes. */
export function conversationGroup(mode: InboxMode): InboxGroupKey {
  switch (mode) {
    case "pending":
      return "needs_attention";
    case "human":
      return "human";
    case "bot":
      return "bot";
  }
}

export interface GroupedConversations {
  key: InboxGroupKey;
  meta: InboxGroupMeta;
  items: InboxConversationView[];
}

/**
 * Group + operatively sort. "Needs human attention": OLDEST pending first (the one
 * waiting longest is the most urgent). "Human"/"Bot": most-recent activity first.
 * Deterministic (stable id tiebreak). Empty groups are omitted.
 */
export function groupConversations(views: InboxConversationView[]): GroupedConversations[] {
  const buckets: Record<InboxGroupKey, InboxConversationView[]> = {
    needs_attention: [],
    human: [],
    bot: [],
  };
  for (const v of views) buckets[conversationGroup(v.mode)].push(v);

  const byOldestPending = (a: InboxConversationView, b: InboxConversationView): number => {
    const ta = a.pendingSince ?? a.createdAt;
    const tb = b.pendingSince ?? b.createdAt;
    const c = ta.localeCompare(tb); // ascending → oldest (longest-waiting) first
    return c !== 0 ? c : a.id.localeCompare(b.id);
  };
  const byRecentActivity = (a: InboxConversationView, b: InboxConversationView): number => {
    const ta = a.lastMessageAt ?? a.createdAt;
    const tb = b.lastMessageAt ?? b.createdAt;
    const c = tb.localeCompare(ta); // descending → most recent first
    return c !== 0 ? c : a.id.localeCompare(b.id);
  };

  buckets.needs_attention.sort(byOldestPending);
  buckets.human.sort(byRecentActivity);
  buckets.bot.sort(byRecentActivity);

  return INBOX_GROUP_ORDER.map((meta) => ({ key: meta.key, meta, items: buckets[meta.key] })).filter(
    (g) => g.items.length > 0,
  );
}

/** The pending (needs-human-attention) count — the operative "pending" counter. */
export function pendingCount(views: InboxConversationView[]): number {
  return views.reduce((n, v) => n + (v.mode === "pending" ? 1 : 0), 0);
}
