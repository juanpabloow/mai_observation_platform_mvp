import { formatChatTime, formatDayLabel, localDayKey } from "@/lib/format";
import type { InboxMessageView, ThreadEventView } from "@/lib/inboxView";

const GROUP_GAP_MS = 3 * 60_000; // same sender within 3min stacks into one group

/**
 * The shared chat transcript used by BOTH the inbox thread drawer and the
 * execution-detail pane (H-8.2). Renders WhatsApp-style bubbles from
 * InboxMessageView[]: customer left (white surface), bot right (grey fill),
 * human_agent right (solid inverse) — name once per consecutive-sender run,
 * in-bubble bottom-right
 * timestamps, and date separators on day change.
 *
 * `onRetry` is optional — the inbox passes it (a failed own-send can be retried);
 * the read-only execution-detail transcript omits it. `highlightIds` marks the
 * messages that belong to a specific execution ("THIS EXECUTION"): those bubbles
 * get an amber ring, and — when `highlightLabel` is set (an id-precise match, not
 * the silent time-window fallback) — a centered "this execution" divider is shown
 * before the first highlighted message.
 */
export function MessageTranscript({
  messages,
  now,
  onRetry,
  highlightIds,
  highlightLabel = false,
  incomingAvatar,
  events,
}: {
  messages: InboxMessageView[];
  now: Date;
  onRetry?: (messageId: string) => void;
  highlightIds?: ReadonlySet<string>;
  highlightLabel?: boolean;
  /**
   * The disc to draw beside the CUSTOMER's message groups: its two characters plus
   * the palette class for this contact (see lib/conversationAvatarLabel +
   * lib/avatarColor — the queue row derives both from the same identifier, so one
   * person is one colour across the whole surface). Omitted by the read-only
   * execution transcript, which has no conversation identity in hand and therefore
   * keeps its current, avatar-less layout.
   */
  incomingAvatar?: { label: string; toneClass: string } | null;
  /**
   * Mode turning points, interleaved with the messages by timestamp — "Santiago took
   * over", "Escalated to a human", "Returned to the bot". They break the sender run
   * on purpose: the bubbles above and below a takeover came from different people.
   *
   * TODO(inbox): the design also opens the thread with "BOT PICKED UP 10:28". A
   *   conversation STARTS in bot mode with no transition row, so there is nothing to
   *   read for it — it would need a row written at creation (or to be inferred from
   *   the first bot message, which is a guess, not a fact).
   */
  events?: ThreadEventView[];
}) {
  if (messages.length === 0) {
    return <p className="py-8 text-center text-sm text-faint">No messages yet.</p>;
  }
  const firstHighlightId =
    highlightIds && highlightIds.size > 0
      ? messages.find((m) => highlightIds.has(m.id))?.id ?? null
      : null;

  // Build date separators + consecutive-sender runs; a "this execution" marker
  // (when labeled) breaks the run before the first highlighted message. Mode
  // transitions are merged into the same pass, in timestamp order, so a takeover
  // lands exactly between the messages it separates.
  const pending = [...(events ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  const blocks: (Run | DateSep | Marker)[] = [];
  let lastDay: string | null = null;
  let run: Run | null = null;
  const flushEventsBefore = (iso: string | null) => {
    while (pending.length > 0 && (iso === null || pending[0].at <= iso)) {
      const e = pending.shift()!;
      blocks.push({ type: "marker", key: `event-${e.id}`, label: eventLabel(e), tone: "event" });
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
      blocks.push({ type: "marker", key: `marker-${m.id}`, label: "this execution" });
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
    <div className="flex flex-col gap-3">
      {blocks.map((b) =>
        b.type === "date" ? (
          // A centred label between two hairlines — the day is a SEAM in the thread,
          // not a floating chip, which is what the redesign's separator reads as.
          <div key={b.key} className="my-1 flex items-center gap-3">
            <span aria-hidden className="h-px flex-1 bg-line" />
            <span className="u-mono text-[0.625rem] font-medium uppercase tracking-wider text-faint">{b.label}</span>
            <span aria-hidden className="h-px flex-1 bg-line" />
          </div>
        ) : b.type === "marker" ? (
          b.tone === "event" ? (
            // A change of WHO is answering — same shape as the day seam, so the thread
            // has one vocabulary for "something structural happened here".
            <div key={b.key} className="my-1 flex items-center gap-3">
              <span aria-hidden className="h-px flex-1 bg-line" />
              <span className="u-mono rounded-full bg-brand-soft px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-brand">
                {b.label}
              </span>
              <span aria-hidden className="h-px flex-1 bg-line" />
            </div>
          ) : (
            <div key={b.key} className="my-1 flex justify-center">
              <span className="rounded-full bg-amber-400/15 px-2.5 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wider text-amber-600 dark:text-amber-400">
                {b.label}
              </span>
            </div>
          )
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
interface DateSep {
  type: "date";
  key: string;
  label: string;
}
interface Marker {
  type: "marker";
  key: string;
  label: string;
  /** "execution" is the amber this-execution highlight; "event" is a mode change. */
  tone?: "execution" | "event";
}

/** The words for a turning point. Built here, never stored. */
function eventLabel(e: ThreadEventView): string {
  if (e.toMode === "human") {
    const who = (e.agentName ?? "").trim().split(/\s+/)[0];
    return who ? `${who} took over` : "A teammate took over";
  }
  if (e.toMode === "pending") return "Escalated to a human";
  return e.fromMode === "human" ? "Returned to the bot" : "Back to the bot";
}

/**
 * One consecutive-sender group: name once at the top, bubbles stacked tightly.
 *
 * The CUSTOMER's group carries an avatar disc on its left — once per group, aligned
 * with the first bubble, so a burst of three messages doesn't stack three identical
 * discs down the margin. The outgoing side (bot / human agent, dark on the right)
 * deliberately has none: the business is the constant in every thread, and a second
 * column of discs would only take width from the bubbles.
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
    <div className={`flex min-w-0 flex-col gap-0.5 ${isUser ? "items-start" : "items-end"}`}>
      {isAgent && agentName ? (
        <span className="px-1 text-[0.6875rem] font-medium text-faint">{agentName}</span>
      ) : null}
      {run.items.map((m) => (
        <Bubble key={m.id} msg={m} onRetry={onRetry} highlighted={highlightIds?.has(m.id) ?? false} />
      ))}
    </div>
  );

  if (!isUser) {
    // The OUTGOING side is signed too: a dark disc saying who answered — "BOT" for
    // the automation, the agent's initials for a person. It sits on the right, once
    // per group, mirroring the customer's disc on the left.
    const sig = isAgent ? initialsOf(agentName) : "BOT";
    return (
      <div className="flex items-start justify-end gap-2">
        {bubbles}
        <span
          aria-hidden
          title={isAgent ? (agentName ?? "Agent") : "Sent by the bot"}
          className="u-mono mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-[0.5rem] font-semibold tracking-tight text-background"
        >
          {sig}
        </span>
      </div>
    );
  }
  if (!incomingAvatar) return bubbles;
  return (
    <div className="flex items-start gap-2">
      <span
        aria-hidden
        className={`u-mono mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-[0.625rem] font-semibold ${incomingAvatar.toneClass}`}
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
  if (words.length === 0) return "YOU";
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/**
 * A single bubble on the grey transcript. customer → left, WHITE + hairline; bot →
 * right, dark fill; human_agent → right, faint brand tint (failed → outlined red). The
 * sender reads from side + fill, never from colour alone. Timestamp bottom-right, tucked
 * against the last line as WhatsApp does. A highlighted (this-execution) bubble gets an
 * amber ring.
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
  // Only a plain, settled message gets the tucked stamp — see the note on the layout.
  const tucked = !sending && !failed;

  // THREE distinct senders (H.6), each carrying shape + fill, never color alone:
  //   customer  → left, a bordered neutral surface;
  //   bot       → right, a quiet filled surface (the automation "voice");
  //   human age → right, the solid inverse fill (a person typed this).
  const bubbleClass = isUser
    ? "border border-bubble-in-border bg-bubble-in text-bubble-in-fg"
    : isAgent
      ? failed
        ? "border border-danger bg-danger/12 text-danger"
        : "border border-line-strong bg-bubble-agent text-bubble-agent-fg"
      : "border border-bubble-bot-border bg-bubble-bot text-bubble-bot-fg";
  const metaClass = isUser
    ? "text-bubble-in-fg/60"
    : isAgent
      ? failed
        ? "text-danger/80"
        : "text-bubble-agent-fg/55"
      : "text-bubble-bot-fg/65";

  const body =
    msg.text && msg.text.trim() !== ""
      ? msg.text
      : msg.contentType && msg.contentType !== "text"
        ? `[${msg.contentType}]`
        : "…";

  return (
    // WHATSAPP'S ARRANGEMENT. The text flows at the FULL bubble width and an invisible
    // copy of the stamp reserves room for it on the LAST line only; the real stamp is
    // absolutely positioned into that gap. This matters: making the stamp a flex sibling
    // (the obvious approach) takes its width from EVERY line, so a two-line message
    // wrapped into three and the bubble looked crushed.
    //
    // `sending` and `failed` keep the plain inline layout instead: their meta is not a
    // timestamp but a status and a Retry button, whose width the invisible spacer cannot
    // predict — reserving the wrong gap would let the button sit on top of the text.
    <div
      className={`max-w-[70%] rounded-bubble px-3.5 py-2 text-sm leading-snug ${bubbleClass} ${
        sending ? "opacity-70" : ""
      } ${highlighted ? "ring-2 ring-[var(--warn-rule)]" : ""}`}
    >
      {tucked ? (
        <div className="relative">
          <span className="whitespace-pre-wrap break-words">
            {body}
            <span aria-hidden className="invisible ml-2 select-none whitespace-nowrap text-[0.625rem]">
              {time}
            </span>
          </span>
          <span className={`absolute bottom-0 right-0 whitespace-nowrap text-[0.625rem] ${metaClass}`}>{time}</span>
        </div>
      ) : (
        <>
          <span className="whitespace-pre-wrap break-words align-middle">{body}</span>
          {/* The FAILED bubble is an outlined red (a normal agent message is tinted), so
              its inner detail + Retry must read on a LIGHT fill. */}
          {failed && msg.failureDetail ? (
            <span className="mt-1 block rounded bg-danger/12 px-1.5 py-1 text-[0.6875rem] text-danger">
              {msg.failureDetail}
            </span>
          ) : null}
          <span className={`ml-2 inline-flex items-center gap-1.5 align-middle text-[0.625rem] ${metaClass}`}>
            {sending ? <span>enviando…</span> : null}
            {failed && onRetry ? (
              <button
                type="button"
                onClick={() => onRetry(msg.id)}
                className="rounded border border-danger/40 px-1 text-[0.625rem] font-medium text-danger transition-colors hover:bg-danger/12"
              >
                Reintentar
              </button>
            ) : null}
            <span>{time}</span>
          </span>
        </>
      )}
    </div>
  );
}
