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
  /** Completed appointments for the linked contact — the number the queue prints inside
   *  the avatar disc (§3.1). 0 when the conversation has no contact attributed. */
  contactVisitCount: number;
  channel: string | null;
}

/**
 * A STRUCTURED PAYLOAD attached to a message — the redesign's "SLOTS OFRECIDOS" block
 * inside a bot bubble (§3.3).
 *
 * NO MIGRATION. `handoff_messages.metadata` is a jsonb column that has existed since the
 * table was created and is unused, so this is a documented SHAPE for it rather than a
 * schema change. That also means the reader must be defensive: the column is `unknown`,
 * anything may have written to it, and a malformed payload must degrade to "just a text
 * message" and never break a thread. That is what `parseMessagePayload` below is for.
 *
 * ONE payload kind for now — `offered_slots`, the appointment times the bot proposed and
 * which one the customer took. It is a discriminated union on `kind` so the next kind
 * (an offered service list, a payment link, a form) is an added member rather than a
 * reinterpretation of these fields.
 *
 * The writer is the agent side, not this app: the platform's booking flow records what it
 * offered. Until it does, `metadata` stays null and the thread renders exactly as before,
 * which is the point of shaping it this way rather than inventing a placeholder.
 */
export interface OfferedSlot {
  /** ISO instant of the offered start time. Rendered in the client's timezone. */
  at: string;
  /** Who the slot was with, when the offer named a staff member. */
  staffName?: string | null;
  /** True for the slot the customer actually took ("✓ elegido"). At most one. */
  chosen?: boolean;
}

export type MessagePayload = {
  kind: "offered_slots";
  /** The mono uppercase label above the block. Defaults to "SLOTS OFRECIDOS". */
  label?: string | null;
  slots: OfferedSlot[];
};

/**
 * Read a message's `metadata` as a payload, or null.
 *
 * Deliberately total: every branch returns rather than throws, because this runs on
 * every message of every thread and a single bad row must not blank the transcript.
 * Unknown `kind`s return null (forward compatibility — a newer writer's payload is
 * simply not rendered by an older reader), and a slot without a parseable `at` is
 * dropped rather than rendered as "Invalid Date".
 */
export function parseMessagePayload(metadata: unknown): MessagePayload | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  if (m.kind !== "offered_slots") return null;
  if (!Array.isArray(m.slots)) return null;
  const slots: OfferedSlot[] = [];
  for (const raw of m.slots) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const at = typeof r.at === "string" ? r.at : null;
    if (!at || Number.isNaN(new Date(at).getTime())) continue;
    slots.push({
      at,
      staffName: typeof r.staffName === "string" ? r.staffName : null,
      chosen: r.chosen === true,
    });
  }
  if (slots.length === 0) return null;
  return {
    kind: "offered_slots",
    label: typeof m.label === "string" ? m.label : null,
    slots,
  };
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
  /** A structured block rendered under the message's prose — see MessagePayload. */
  payload: MessagePayload | null;
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
  /** The customer's LAST inbound message time (ISO), authoritative from the conversation
   *  row. Drives the WhatsApp 24h service window; null when they never wrote. Using this
   *  rather than the loaded transcript avoids both a pagination gap and the wrong signal
   *  (the contact's free-text `channel` label) that let expired chats stay writable. */
  lastUserMessageAt: string | null;
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

/**
 * A SCHEDULING turning point inside the thread — the appointment this conversation
 * produced, and what has happened to it since (§3.3).
 *
 * A second event kind beside `ThreadEventView` rather than one union, because the two
 * carry different facts and render as different strips: a mode transition is a bare
 * "who is handling this now" line on a rule, while this one names a service, a time, a
 * staff member and links out to the agenda. Flattening them would give one type half of
 * whose fields are always null.
 *
 * `actor` is what the strip's mono label says did it — "REAGENDADA POR EL BOT" vs
 * "… POR SANTIAGO". The LABEL is composed in the component from these fields, not
 * stored, exactly like the mode transitions.
 */
export interface ThreadSchedulingEventView {
  id: string;
  appointmentId: string;
  /** The stored `appointment_events.event_type` (booked / rescheduled / cancelled / …). */
  eventType: string;
  actorType: string;
  actorName: string | null;
  /** The appointment AS IT STANDS NOW — see the note on the repository function. */
  serviceName: string | null;
  startAt: string; // ISO
  staffName: string | null;
  status: string;
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
  { key: "all", label: "Todas" },
  { key: "pending", label: "Pendientes" },
  { key: "human", label: "Humano" },
  { key: "bot", label: "Bot" },
];

export const ACTIVITY_SEGMENTS: { key: ActivitySegment; label: string }[] = [
  { key: "all", label: "Todas" },
  { key: "active", label: "Activas" },
  { key: "inactive", label: "Inactivas" },
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

// ── WhatsApp's 24-hour customer-service window ────────────────────────────────

/** WhatsApp only accepts free-form replies within this many hours of the customer's
 *  last inbound message. Outside it, the provider rejects anything but an approved
 *  template — so a send that looks fine here comes back as failed. */
export const SERVICE_WINDOW_HOURS = 24;

export type ServiceWindow =
  | { state: "open"; closesAt: string }
  | { state: "never_opened" }
  | { state: "closed"; lastInboundAt: string }
  | { state: "not_applicable" };

/**
 * Whether we may still send a free-form reply on this conversation.
 *
 * The window is measured from the customer's LAST INBOUND message — not from the last
 * message of any kind. Measuring from the last message would keep the window "open"
 * forever on a thread where only the business is talking, which is exactly the case the
 * rule exists to stop.
 *
 * It is CHANNEL-SPECIFIC: only WhatsApp imposes it, so every other channel returns
 * `not_applicable` rather than being quietly restricted by someone else's policy. The
 * channel is matched on the value (it is a free-text label), consistent with how the
 * rest of the platform treats it.
 *
 * PURE, so the rule is unit-testable and the same in every caller. Note the UI is a
 * courtesy, not enforcement: the provider is the real gate, and this only stops an
 * agent from typing a reply that was always going to bounce.
 */
export function serviceWindow(
  channel: string | null | undefined,
  messages: ReadonlyArray<{ sender: InboxSender; occurredAt: string }>,
  now: Date,
): ServiceWindow {
  if (!/whatsapp/i.test(channel ?? "")) return { state: "not_applicable" };

  let lastInbound: number | null = null;
  for (const m of messages) {
    if (m.sender !== "user") continue;
    const t = new Date(m.occurredAt).getTime();
    if (Number.isNaN(t)) continue;
    if (lastInbound === null || t > lastInbound) lastInbound = t;
  }
  // No inbound message at all: the window was never opened, so it is not "closed" —
  // the distinction matters because the two need different wording.
  if (lastInbound === null) return { state: "never_opened" };

  const closes = lastInbound + SERVICE_WINDOW_HOURS * 3600_000;
  if (now.getTime() >= closes) return { state: "closed", lastInboundAt: new Date(lastInbound).toISOString() };
  return { state: "open", closesAt: new Date(closes).toISOString() };
}

/** The quiet one-liner shown under a disabled composer. Null when sending is allowed. */
export function serviceWindowNotice(w: ServiceWindow): string | null {
  switch (w.state) {
    case "closed":
      return `Pasaron más de ${SERVICE_WINDOW_HOURS} h desde su último mensaje. WhatsApp solo permite responder dentro de esa ventana.`;
    case "never_opened":
      return "WhatsApp solo permite escribir después de que la persona te escriba primero.";
    default:
      return null;
  }
}
