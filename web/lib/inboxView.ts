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
  /** The linked contact's name + channel, when the conversation is attributed to a
   *  contact OF THIS CLIENT (the repository re-scopes the FK). Null otherwise, and
   *  the surface falls back to the conversation identifier. */
  contactName: string | null;
  channel: string | null;
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
  contactName: string | null;
  channel: string | null;
  mode: InboxMode;
  /** ACTIVE iff the customer wrote within the activity window (for the drawer's tag). */
  active: boolean;
  assignedAgentUserId: string | null;
  assignedAgentName: string | null;
}

/**
 * A turning point in the thread: the bot escalating, a person taking over, the
 * conversation going back to the bot. Persisted all along in
 * `conversation_mode_transitions` — the thread just never read them. The LABEL is
 * built in the component from these fields, not stored.
 */
export interface ThreadEventView {
  id: string;
  fromMode: InboxMode;
  toMode: InboxMode;
  /** The agent who acted, when a person did. */
  agentName: string | null;
  at: string; // ISO
}

/** A pre-handoff derived turn (read-only history disclosure at the top of a thread). */
export interface HistoryTurnView {
  id: string;
  userText: string | null;
  aiText: string | null;
  at: string; // ISO
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

/**
 * DISPLAY form of a conversation identifier. The stored ref is whatever the channel
 * gave us — for WhatsApp that is a bare E.164 digit string like "573043906303",
 * which is unreadable in a list. This groups it the way a person reads a phone
 * number ("+57 304 390 6303") and leaves anything that is NOT a phone untouched.
 *
 * Presentation only: the stored value never changes, and the queue's search still
 * matches the raw digits as well as this form.
 *
 * The surfaces show the contact's NAME when there is one and fall back to this.
 */
export function formatConversationRef(ref: string): string {
  const digits = ref.replace(/\D/g, "");
  // Only touch things that are plausibly a phone number and nothing else (an
  // instagram handle or an opaque external id must survive verbatim).
  if (!/^[+\d\s().-]+$/.test(ref) || digits.length < 10 || digits.length > 15) return ref;
  const national = digits.slice(-10);
  const country = digits.slice(0, -10);
  const grouped = `${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
  return country ? `+${country} ${grouped}` : grouped;
}

/**
 * The two characters on a conversation's avatar disc — SHARED by the queue row and
 * the thread transcript, so the same person never wears two different discs.
 *
 * A conversation identifier is usually a PHONE NUMBER, and every phone in a
 * Colombian shop starts "+57…" — taking the first character gave every row the same
 * "5". The LAST two digits are the part a person actually recognises, so a
 * phone-shaped ref uses those; anything else falls back to its first letter.
 *
 * When the conversation is attributed to a contact, its INITIALS are used instead;
 * the digits stay as the fallback for an unattributed conversation.
 */
export function conversationAvatarLabel(ref: string, name?: string | null): string {
  // A real name wins: two initials ("CR" for Camila Reyes) is what a person actually
  // recognises. One-word names give one letter rather than an invented second.
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    return words
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  }
  const digits = ref.replace(/\D/g, "");
  const looksLikePhone = digits.length >= 7 && digits.length / Math.max(1, ref.length) > 0.5;
  if (looksLikePhone) return digits.slice(-2);
  return (ref.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
}

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
