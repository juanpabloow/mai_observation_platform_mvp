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

export interface InboxConversationView {
  id: string;
  conversationRef: string;
  workflowName: string | null;
  mode: InboxMode;
  assignedAgentName: string | null;
  lastMessageText: string | null;
  lastMessageSender: InboxSender | null;
  lastMessageContentType: string | null;
  lastMessageAt: string | null; // ISO
  createdAt: string; // ISO
  pendingSince: string | null; // ISO
}

export interface InboxMessageView {
  id: string;
  sender: InboxSender;
  agentName: string | null;
  text: string | null;
  contentType: string;
  status: string;
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

export const INBOX_FILTERS: { key: InboxFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "human", label: "Human" },
  { key: "bot", label: "Bot" },
];

export function isInboxFilter(value: string | null): value is InboxFilter {
  return value === "all" || value === "pending" || value === "human" || value === "bot";
}

/** A one-line preview for a conversation row's last message. */
export function conversationPreview(view: InboxConversationView): string {
  if (view.lastMessageSender === null) return "No messages yet";
  const text = view.lastMessageText;
  if (text && text.trim() !== "") {
    const prefix = view.lastMessageSender === "user" ? "" : view.lastMessageSender === "bot" ? "Bot: " : "Agent: ";
    return `${prefix}${text}`;
  }
  // Non-text content (image/file/etc.) has no text body.
  const ct = view.lastMessageContentType;
  return ct && ct !== "text" ? `[${ct}]` : "…";
}
