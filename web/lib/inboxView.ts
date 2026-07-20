/**
 * CLIENT-SAFE inbox view types + formatters. No server imports (not even type
 * imports from the worker data layer), so client components can import this freely.
 * The wire shapes use ISO-8601 strings for timestamps; the server serializes repo
 * rows into these (see inboxData.ts) and the client formats them for display.
 */

// Mirrors the repo's ConversationMode / MessageSender (kept local so this module has
// zero server coupling). These string sets are stable (DB CHECK-constrained).
export type InboxMode = "bot" | "pending" | "human";
export type InboxSender = "user" | "bot" | "human_agent";
export type InboxFilter = "all" | "pending" | "human" | "bot";
/** The grid's Activity segment (H-7), combined with the mode filter (AND). */
export type ActivitySegment = "all" | "active" | "inactive";

export interface InboxConversationView {
  id: string;
  conversationRef: string;
  /** The conversation's n8n_workflow_id — used to link a row into its workflow inbox. */
  workflowId: string;
  workflowName: string | null;
  mode: InboxMode;
  /** ACTIVE iff the customer wrote within the activity window (SQL-computed). */
  active: boolean;
  assignedAgentName: string | null;
  lastMessageText: string | null;
  lastMessageSender: InboxSender | null;
  lastMessageContentType: string | null;
  lastMessageAt: string | null; // ISO
  createdAt: string; // ISO
  pendingSince: string | null; // ISO
  /** Latest escalation reason — set only on PENDING conversations. */
  escalationReasonCode: string | null;
  escalationDetail: string | null;
}

export interface InboxMessageView {
  id: string;
  sender: InboxSender;
  agentName: string | null;
  text: string | null;
  contentType: string;
  status: string; // received | sending | sent | failed
  failureCode: string | null;
  failureDetail: string | null;
  occurredAt: string; // ISO
}

export interface InboxHeaderView {
  id: string;
  conversationRef: string;
  workflowName: string | null;
  mode: InboxMode;
  assignedAgentUserId: string | null;
  assignedAgentName: string | null;
}

/** Result of a send/retry server action (client-safe shape). */
export type SendErrorCode =
  | "forbidden"
  | "not_found"
  | "mode_changed"
  | "no_webhook"
  | "disabled"
  | "invalid";

export type SendActionResult =
  | { ok: true; message: InboxMessageView }
  | { ok: false; error: string; code: SendErrorCode; header?: InboxHeaderView };

export const INBOX_FILTERS: { key: InboxFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "human", label: "Human" },
  { key: "bot", label: "Bot" },
];

export const ACTIVITY_SEGMENTS: { key: ActivitySegment; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "inactive", label: "Inactive" },
];

function firstName(name: string | null): string {
  const n = (name ?? "").trim().split(/\s+/)[0];
  return n || "Agent";
}

/**
 * A one-line preview for a conversation's last message, sender-prefixed:
 * customer → no prefix; bot → "Bot:"; human_agent → the agent's first name.
 */
export function conversationPreview(view: InboxConversationView): string {
  if (view.lastMessageSender === null) return "No messages yet";
  const text = view.lastMessageText;
  const body =
    text && text.trim() !== ""
      ? text
      : view.lastMessageContentType && view.lastMessageContentType !== "text"
        ? `[${view.lastMessageContentType}]`
        : "…";
  const prefix =
    view.lastMessageSender === "user"
      ? ""
      : view.lastMessageSender === "bot"
        ? "Bot: "
        : `${firstName(view.assignedAgentName)}: `;
  return `${prefix}${body}`;
}
