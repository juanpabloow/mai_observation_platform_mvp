import Link from "next/link";
import { formatChatTime, formatDayLabel, localDayKey } from "@/lib/format";
import type {
  InboxMessageView,
  MessagePayload,
  ThreadEventView,
  ThreadSchedulingEventView,
} from "@/lib/inboxView";

const GROUP_GAP_MS = 3 * 60_000; // same sender within 3min stacks into one group

/**
 * The shared chat transcript used by BOTH the inbox thread and the execution-detail pane.
 *
 * Restyled to the redesign (docs/ui-redesign-crm-inbox.md §3.3). Three voices, each
 * carrying SHAPE + FILL and never colour alone:
 *
 *   customer    → left,  white + hairline,  tail bottom-LEFT
 *   bot         → right, near-black fill,   tail bottom-RIGHT
 *   human agent → right, white + INK border, tail bottom-RIGHT
 *
 * THE TIMESTAMP MOVED OUT. It used to be tucked inside the bubble bottom-right, which
 * needed an invisible copy of the stamp to reserve room on the last line only — because
 * making it a flex sibling took its width from EVERY line and wrapped two-line messages
 * into three. The design puts it below the bubble, outside, which deletes that entire
 * mechanism: the text now flows at the full bubble width with nothing to route around.
 * The `sending` / `failed` states keep their meta inline because it is a status and a
 * Retry button, not a stamp.
 *
 * `onRetry` is optional — the inbox passes it (a failed own-send can be retried); the
 * read-only execution-detail transcript omits it. `highlightIds` marks the messages that
 * belong to a specific execution ("esta ejecución").
 */
export function MessageTranscript({
  messages,
  now,
  onRetry,
  highlightIds,
  highlightLabel = false,
  incomingAvatar,
  events,
  schedulingEvents,
  agendaHref,
}: {
  messages: InboxMessageView[];
  now: Date;
  onRetry?: (messageId: string) => void;
  highlightIds?: ReadonlySet<string>;
  highlightLabel?: boolean;
  /**
   * The disc to draw beside the CUSTOMER's message groups: its two characters plus the
   * palette class for this contact (see lib/conversationAvatarLabel + lib/avatarColor —
   * the queue row derives both from the same identifier, so one person is one colour
   * across the whole surface). Omitted by the read-only execution transcript, which has
   * no conversation identity in hand.
   */
  incomingAvatar?: { label: string; toneClass: string } | null;
  /**
   * Mode turning points, interleaved with the messages by timestamp — "Santiago entró al
   * chat", "Escalado a una persona", "Volvió al bot". They break the sender run on
   * purpose: the bubbles above and below a takeover came from different people.
   *
   * The design also opens the thread with "el bot tomó la conversación 10:28". A
   * conversation STARTS in bot mode with no transition row, so there is nothing to read
   * for it — it would need a row written at creation, or to be inferred from the first
   * bot message, which is a guess rather than a fact. Deliberately absent.
   */
  events?: ThreadEventView[];
  /**
   * SCHEDULING turning points — the appointment this conversation booked and what has
   * happened to it since ("REAGENDADA POR EL BOT · Keratina movida a … · Ver en agenda").
   * Backed by `appointments.source_conversation_id` + `appointment_events`; see
   * listConversationSchedulingEvents.
   */
  schedulingEvents?: ThreadSchedulingEventView[];
  /** Where "Ver en agenda ↗" points. Omitted ⇒ the strip renders without the link. */
  agendaHref?: (appointmentId: string) => string;
}) {
  if (messages.length === 0) {
    return <p className="py-8 text-center text-sm text-faint">Todavía no hay mensajes.</p>;
  }
  const firstHighlightId =
    highlightIds && highlightIds.size > 0
      ? messages.find((m) => highlightIds.has(m.id))?.id ?? null
      : null;

  // Build date separators + consecutive-sender runs; a "this execution" marker (when
  // labeled) breaks the run before the first highlighted message. BOTH kinds of event are
  // merged into the same pass, in timestamp order, so a takeover or a reschedule lands
  // exactly between the messages it separates.
  type Pending =
    | { at: string; kind: "mode"; e: ThreadEventView }
    | { at: string; kind: "scheduling"; e: ThreadSchedulingEventView };
  const pending: Pending[] = [
    // "X entró al chat" (a human took over) is DROPPED: the bubbles beneath it are already
    // signed with who sent them, so the strip is redundant. Escalations ("Escalado a una
    // persona") and returns to the bot ("Devuelta al bot") are kept — they change WHO is
    // answering without a bubble to announce it.
    ...(events ?? []).filter((e) => e.toMode !== "human").map((e) => ({ at: e.at, kind: "mode" as const, e })),
    ...(schedulingEvents ?? []).map((e) => ({ at: e.at, kind: "scheduling" as const, e })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const blocks: Block[] = [];
  let lastDay: string | null = null;
  let run: Run | null = null;
  const flushEventsBefore = (iso: string | null) => {
    while (pending.length > 0 && (iso === null || pending[0].at <= iso)) {
      const p = pending.shift()!;
      if (p.kind === "mode") {
        blocks.push({ type: "mode", key: `event-${p.e.id}`, event: p.e });
      } else {
        blocks.push({ type: "scheduling", key: `sched-${p.e.id}`, event: p.e });
      }
      run = null; // the run cannot continue across a change of who is answering
    }
  };
  for (const m of messages) {
    flushEventsBefore(m.occurredAt);
    const d = new Date(m.occurredAt);
    const day = localDayKey(d);
    if (day !== lastDay) {
      blocks.push({ type: "date", key: `date-${day}`, label: formatDayLabel(d, now) });
      lastDay = day;
      run = null;
    }
    if (highlightLabel && firstHighlightId && m.id === firstHighlightId) {
      blocks.push({ type: "marker", key: `marker-${m.id}`, label: "esta ejecución" });
      run = null;
    }
    const prev = run?.items[run.items.length - 1];
    const sameRun =
      run !== null &&
      run.sender === m.sender &&
      prev !== undefined &&
      d.getTime() - new Date(prev.occurredAt).getTime() <= GROUP_GAP_MS;
    if (sameRun && run) {
      run.items.push(m);
    } else {
      run = { type: "run", key: `run-${m.id}`, sender: m.sender, items: [m] };
      blocks.push(run);
    }
  }
  flushEventsBefore(null); // anything after the last message (e.g. a fresh takeover)

  return (
    // gap-4 — the design's 16px. The bubbles carry their own timestamp below them now, so
    // a tighter gap would run one group's stamp into the next group's first bubble.
    <div className="flex flex-col gap-4">
      {blocks.map((b) =>
        b.type === "date" ? (
          <Seam key={b.key} label={b.label} />
        ) : b.type === "mode" ? (
          <ModeStrip key={b.key} event={b.event} />
        ) : b.type === "scheduling" ? (
          <SchedulingStrip key={b.key} event={b.event} agendaHref={agendaHref} />
        ) : b.type === "marker" ? (
          <div key={b.key} className="my-1 flex justify-center">
            <span className="u-mono rounded-sm bg-warn-soft px-2.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wider text-warn">
              {b.label}
            </span>
          </div>
        ) : (
          <MessageRun
            key={b.key}
            run={b}
            onRetry={onRetry}
            highlightIds={highlightIds}
            incomingAvatar={incomingAvatar}
          />
        ),
      )}
    </div>
  );
}

interface Run {
  type: "run";
  key: string;
  sender: InboxMessageView["sender"];
  items: InboxMessageView[];
}
type Block =
  | Run
  | { type: "date"; key: string; label: string }
  | { type: "marker"; key: string; label: string }
  | { type: "mode"; key: string; event: ThreadEventView }
  | { type: "scheduling"; key: string; event: ThreadSchedulingEventView };

/** A DAY seam: a centred caption between two hairlines. */
function Seam({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden className="h-px flex-1 bg-line" />
      <span className="whitespace-nowrap text-[0.6875rem] text-muted">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}

/**
 * A change of WHO is answering — a small bordered pill sitting ON the seam rule.
 *
 * It used to be a brand-red chip. Red is now reserved (see the note on --ink in
 * globals.css) and, more to the point, a takeover is not an alarm: it is a fact about who
 * you are reading. The design gives it an ink dot and a mono label on the panel's own
 * surface, which reads as structural rather than urgent.
 */
function ModeStrip({ event }: { event: ThreadEventView }) {
  // A plain centred caption on a hairline (design image): "ESCALADO A UNA PERSONA · 2:56 PM".
  // No card, no dot — a takeover is structural context, not an alarm.
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden className="h-px flex-1 bg-line" />
      <span className="u-mono flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[0.59375rem] uppercase tracking-[0.09em] text-muted">
        {modeEventLabel(event)}
        <span className="text-faint">· {formatChatTime(new Date(event.at))}</span>
      </span>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}

/**
 * THE appointment this thread produced — centred, self-contained, and linked.
 *
 * A card rather than a pill on a rule (which is what ModeStrip above is): this carries
 * three facts and an action, so it needs a box. It is the one place in the transcript
 * where red appears, on the outbound link, because "go look at the booking" is the one
 * thing a reader might want to do from inside the thread.
 */
function SchedulingStrip({
  event,
  agendaHref,
}: {
  event: ThreadSchedulingEventView;
  agendaHref?: (appointmentId: string) => string;
}) {
  const when = new Date(event.startAt);
  const whenLabel = when.toLocaleString("es", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div className="flex justify-center">
      <span className="flex max-w-full flex-wrap items-center gap-2.5 rounded-sm border border-line-strong bg-surface px-3 py-2 shadow-[var(--shadow-card)]">
        <span className="u-mono shrink-0 text-[0.59375rem] uppercase tracking-[0.09em] text-foreground">
          {schedulingEventLabel(event)}
        </span>
        <span className="min-w-0 text-[0.78125rem] text-muted">
          {event.serviceName ? `${event.serviceName} · ` : ""}
          <span className="font-semibold text-foreground">{whenLabel}</span>
          {event.staffName ? ` con ${event.staffName}` : ""}
        </span>
        {agendaHref ? (
          <Link
            href={agendaHref(event.appointmentId)}
            className="shrink-0 text-[0.75rem] text-brand no-underline hover:underline"
          >
            Ver en agenda ↗
          </Link>
        ) : null}
      </span>
    </div>
  );
}

/** The words for a MODE turning point. Built here, never stored. */
function modeEventLabel(e: ThreadEventView): string {
  if (e.toMode === "human") {
    const who = (e.agentName ?? "").trim().split(/\s+/)[0];
    return who ? `${who} entró al chat` : "Un compañero entró al chat";
  }
  if (e.toMode === "pending") return "Escalado a una persona";
  return e.fromMode === "human" ? "Devuelta al bot" : "De vuelta al bot";
}

/**
 * The words for a SCHEDULING turning point: what happened, and by whom.
 *
 * The actor is part of the label because it is the fact that matters most in a handoff
 * thread — "reagendada por el bot" and "reagendada por Santiago" call for different
 * follow-ups. `event_type` is free-ish text in the schema, so an unmapped value degrades
 * to a readable form of itself rather than being dropped.
 */
function schedulingEventLabel(e: ThreadSchedulingEventView): string {
  const VERB: Record<string, string> = {
    booked: "Agendada",
    created: "Agendada",
    rescheduled: "Reagendada",
    confirmed: "Confirmada",
    cancelled: "Cancelada",
    canceled: "Cancelada",
    completed: "Completada",
    no_show: "No asistió",
  };
  const key = e.eventType.toLowerCase().replace(/^appointment_/, "");
  const verb = VERB[key] ?? key.replace(/[_-]+/g, " ");
  const who =
    e.actorType === "bot"
      ? "el bot"
      : e.actorName?.trim().split(/\s+/)[0] ?? (e.actorType === "system" ? "el sistema" : null);
  return who ? `${verb} por ${who}` : verb;
}

/**
 * One consecutive-sender group: the signature once at the top, bubbles stacked tightly.
 *
 * The CUSTOMER's group carries an avatar disc on its left — once per group, aligned with
 * the first bubble, so a burst of three messages doesn't stack three identical discs down
 * the margin. The OUTGOING side is signed too, on the right: a solid near-black "BOT" for
 * the automation, or a white disc with an ink ring for a person, which is the same
 * distinction the bubbles themselves draw.
 */
function MessageRun({
  run,
  onRetry,
  highlightIds,
  incomingAvatar,
}: {
  run: Run;
  onRetry?: (id: string) => void;
  highlightIds?: ReadonlySet<string>;
  incomingAvatar?: { label: string; toneClass: string } | null;
}) {
  const isUser = run.sender === "user";
  const isAgent = run.sender === "human_agent";
  const agentName = isAgent ? run.items.find((m) => m.agentName)?.agentName ?? null : null;
  const bubbles = (
    <div className={`flex min-w-0 flex-col gap-1 ${isUser ? "items-start" : "items-end"}`}>
      {/* The agent's signature ABOVE their run — mono, tracked, and it says EQUIPO so a
          customer reading a screenshot can tell a colleague from the automation. */}
      {isAgent && agentName ? (
        <span className="u-mono px-0.5 text-[0.5625rem] uppercase tracking-[0.08em] text-faint">
          {agentName.trim().split(/\s+/)[0]} · equipo
        </span>
      ) : null}
      {run.items.map((m) => (
        <Bubble
          key={m.id}
          msg={m}
          onRetry={onRetry}
          highlighted={highlightIds?.has(m.id) ?? false}
        />
      ))}
    </div>
  );

  if (!isUser) {
    const sig = isAgent ? initialsOf(agentName) : "BOT";
    return (
      <div className="flex items-end justify-end gap-2.5">
        {bubbles}
        <span
          aria-hidden
          title={isAgent ? (agentName ?? "Agente") : "Enviado por el bot"}
          className={`u-mono mb-5 flex size-[26px] shrink-0 items-center justify-center rounded-full text-[0.53125rem] font-semibold tracking-tight ${
            isAgent
              ? "border-[1.5px] border-ink bg-surface text-foreground"
              : "bg-bubble-bot text-bubble-bot-fg"
          }`}
        >
          {sig}
        </span>
      </div>
    );
  }
  if (!incomingAvatar) return bubbles;
  return (
    <div className="flex items-start gap-2.5">
      <span
        aria-hidden
        className={`u-mono mt-0.5 flex size-[26px] shrink-0 items-center justify-center rounded-full text-[0.59375rem] font-semibold ${incomingAvatar.toneClass}`}
      >
        {incomingAvatar.label}
      </span>
      {bubbles}
    </div>
  );
}

/** Two initials for the disc that signs a human agent's run. */
function initialsOf(name: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "YO";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/**
 * A single bubble, plus its timestamp below it.
 *
 * THE TAIL is what says who is speaking, alongside the fill: three corners take
 * --radius-bubble and the one pointing at the speaker collapses to --radius-bubble-tail
 * (bottom-left for the customer, bottom-right for the business). Two tokens rather than
 * four literals, so the two sides cannot drift apart.
 */
function Bubble({
  msg,
  onRetry,
  highlighted,
}: {
  msg: InboxMessageView;
  onRetry?: (id: string) => void;
  highlighted: boolean;
}) {
  const isUser = msg.sender === "user";
  const isAgent = msg.sender === "human_agent";
  const sending = msg.status === "sending";
  const failed = msg.status === "failed";
  const time = formatChatTime(new Date(msg.occurredAt));
  // The stamp now sits INSIDE the bubble (design image): light on the dark team/bot fills,
  // faint on the white customer bubble, danger on a failed send.
  const timeColor = failed ? "text-danger/70" : isUser ? "text-faint" : "text-white/55";

  const bubbleClass = isUser
    ? "border border-bubble-in-border bg-bubble-in text-bubble-in-fg rounded-bl-bubble-tail"
    : isAgent
      ? failed
        ? "border border-danger bg-danger/12 text-danger rounded-br-bubble-tail"
        : // The TEAM bubble is a near-black fill with light text (design image); the EQUIPO
          // signature above and the agent's disc distinguish it from the bot beside it.
          "bg-bubble-bot text-bubble-bot-fg rounded-br-bubble-tail"
      : "bg-bubble-bot text-bubble-bot-fg rounded-br-bubble-tail";

  const body =
    msg.text && msg.text.trim() !== ""
      ? msg.text
      : msg.contentType && msg.contentType !== "text"
        ? `[${msg.contentType}]`
        : "…";

  return (
    <div className={`flex min-w-0 max-w-full flex-col gap-1 ${isUser ? "items-start" : "items-end"}`}>
      <div
        className={`max-w-[min(62ch,100%)] rounded-bubble px-3.5 py-2.5 text-[0.8125rem] leading-[1.45] ${bubbleClass} ${
          sending ? "opacity-70" : ""
        } ${highlighted ? "ring-2 ring-[var(--warn-rule)]" : ""}`}
      >
        <span className="whitespace-pre-wrap break-words [text-wrap:pretty]">
          {body}
          {/* THE STAMP, INSIDE the bubble (design image) — it trails the last line, so a
              short message keeps it on the same row and a long one drops it bottom-right. */}
          <span className={`u-mono ml-2 inline whitespace-nowrap align-baseline text-[0.625rem] tabular-nums ${timeColor}`}>
            {time}
          </span>
        </span>
        {/* THE STRUCTURED BLOCK — the slots the bot offered, and which one was taken. */}
        {msg.payload ? <PayloadBlock payload={msg.payload} onDark={!isUser} /> : null}
        {failed && msg.failureDetail ? (
          <span className="mt-1.5 block rounded-sm bg-danger/12 px-1.5 py-1 text-[0.6875rem] text-danger">
            {msg.failureDetail}
          </span>
        ) : null}
      </div>
      {/* A status line BELOW the bubble ONLY while sending or after a failure — the normal
          delivered stamp now lives inside the bubble. */}
      {sending || failed ? (
        <span className="u-mono flex items-center gap-1.5 px-0.5 text-[0.65625rem] text-faint">
          {sending ? <span>enviando…</span> : null}
          {failed && onRetry ? (
            <button
              type="button"
              onClick={() => onRetry(msg.id)}
              className="rounded-sm border border-danger/40 px-1 text-[0.625rem] font-medium text-danger transition-colors hover:bg-danger/12"
            >
              Reintentar
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The offered-slots block inside a bot bubble (§3.3).
 *
 * `onDark` is not a theme flag — it is which SIDE this bubble is on. The bot's bubble is
 * a near-black fill in both light and dark mode, so the block inside it always needs the
 * light-on-dark ramp; an agent's bubble is a white card and needs the opposite. Reading
 * the theme instead would get the bot's bubble wrong in light mode.
 *
 * The CHOSEN slot is marked three ways — a left rule, a weight change, and the words "✓
 * elegido" — so it survives greyscale and does not depend on the reader noticing a 2px
 * bar.
 */
function PayloadBlock({ payload, onDark }: { payload: MessagePayload; onDark: boolean }) {
  if (payload.kind !== "offered_slots") return null;
  return (
    <div
      className={`mt-2.5 flex flex-col gap-1.5 border-t pt-2.5 ${
        onDark ? "border-bubble-bot-rule" : "border-line"
      }`}
    >
      <span
        className={`u-mono text-[0.59375rem] uppercase tracking-[0.09em] ${
          onDark ? "text-bubble-bot-label" : "text-faint"
        }`}
      >
        {payload.label ?? "Slots ofrecidos"}
      </span>
      {payload.slots.map((s, i) => {
        const label = new Date(s.at).toLocaleString("es", {
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "numeric",
          minute: "2-digit",
        });
        return (
          <span
            key={`${s.at}-${i}`}
            className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 ${
              onDark ? "bg-bubble-bot-inset" : "bg-chip"
            } ${s.chosen ? (onDark ? "shadow-[inset_2px_0_0_#fff]" : "shadow-[inset_2px_0_0_var(--ink)]") : ""}`}
          >
            <span
              className={`u-mono text-[0.71875rem] uppercase ${
                s.chosen ? "font-semibold" : ""
              } ${onDark ? "text-bubble-bot-fg" : "text-foreground"}`}
            >
              {label}
            </span>
            <span
              className={`ml-auto shrink-0 text-[0.71875rem] ${
                onDark ? "text-bubble-bot-label" : "text-muted"
              }`}
            >
              {s.chosen ? "✓ elegido" : (s.staffName ?? "")}
            </span>
          </span>
        );
      })}
    </div>
  );
}
