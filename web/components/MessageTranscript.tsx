import Link from "next/link";
import type {
  InboxMessageView,
  MessagePayload,
  ThreadEventView,
  ThreadSchedulingEventView,
} from "@/lib/inboxView";
import { clock24, daySeam, firstName, localDayKey } from "@/lib/inboxPresent";

const GROUP_GAP_MS = 3 * 60_000; // same sender within 3min stacks into one group

/**
 * The shared chat transcript used by BOTH the inbox thread and the execution-detail pane.
 *
 * Inbox redesign ("Inbox de Gallery", S4 · Mensajes). Three voices, each carrying SIDE +
 * FILL + a LABEL, never colour alone:
 *
 *   customer    → left,  white + hairline,           tail bottom-LEFT
 *   bot         → right, near-black fill, "Bot",      tail bottom-RIGHT
 *   human agent → right, LIGHT BLUE + its author ("Tú (Laura)" for you, "Diego" for a
 *                 colleague — the redesign's "Equipo · azul claro + autor"), tail bottom-RIGHT
 *
 * Times are 24 h ("14:02") inside the bubble, on their own line at the bottom-right; days
 * are "Hoy", "Ayer", "Sáb 10 oct". Escalations and takeovers are small pills on the seam
 * ("→ Escalado a una persona · 14:04", "→ Laura tomó la conversación · 14:06").
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
  viewerUserId,
}: {
  messages: InboxMessageView[];
  now: Date;
  onRetry?: (messageId: string) => void;
  highlightIds?: ReadonlySet<string>;
  highlightLabel?: boolean;
  /** Optional disc beside the CUSTOMER's groups (the execution pane omits it; the inbox
   *  redesign does too — the header already says who the person is). */
  incomingAvatar?: { label: string; toneClass: string } | null;
  /** Mode turning points, interleaved by timestamp — escalations, takeovers, returns. */
  events?: ThreadEventView[];
  /** The appointment this conversation produced and what happened to it since. */
  schedulingEvents?: ThreadSchedulingEventView[];
  /** Where "Ver en agenda ↗" points. Omitted ⇒ the strip renders without the link. */
  agendaHref?: (appointmentId: string) => string;
  /** The signed-in operator — their own replies are labelled "Tú (Nombre)". */
  viewerUserId?: string | null;
}) {
  if (messages.length === 0) {
    return <p className="py-8 text-center text-sm text-faint">Todavía no hay mensajes.</p>;
  }
  const firstHighlightId =
    highlightIds && highlightIds.size > 0 ? messages.find((m) => highlightIds.has(m.id))?.id ?? null : null;

  type Pending =
    | { at: string; kind: "mode"; e: ThreadEventView }
    | { at: string; kind: "scheduling"; e: ThreadSchedulingEventView };
  const pending: Pending[] = [
    ...(events ?? []).map((e) => ({ at: e.at, kind: "mode" as const, e })),
    ...(schedulingEvents ?? []).map((e) => ({ at: e.at, kind: "scheduling" as const, e })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const blocks: Block[] = [];
  let lastDay: string | null = null;
  let run: Run | null = null;
  const flushEventsBefore = (iso: string | null) => {
    while (pending.length > 0 && (iso === null || pending[0].at <= iso)) {
      const p = pending.shift()!;
      // A turning point opens its own day too — the seam always comes first.
      const evDay = localDayKey(new Date(p.at));
      if (evDay !== lastDay) {
        blocks.push({ type: "date", key: `date-${evDay}`, label: daySeam(new Date(p.at), now) });
        lastDay = evDay;
      }
      if (p.kind === "mode") blocks.push({ type: "mode", key: `event-${p.e.id}`, event: p.e });
      else blocks.push({ type: "scheduling", key: `sched-${p.e.id}`, event: p.e });
      run = null; // the run cannot continue across a change of who is answering
    }
  };
  for (const m of messages) {
    flushEventsBefore(m.occurredAt);
    const d = new Date(m.occurredAt);
    const day = localDayKey(d);
    if (day !== lastDay) {
      blocks.push({ type: "date", key: `date-${day}`, label: daySeam(d, now) });
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
      (m.sender !== "human_agent" || (prev?.agentUserId ?? prev?.agentName) === (m.agentUserId ?? m.agentName)) &&
      prev !== undefined &&
      d.getTime() - new Date(prev.occurredAt).getTime() <= GROUP_GAP_MS;
    if (sameRun && run) run.items.push(m);
    else {
      run = { type: "run", key: `run-${m.id}`, sender: m.sender, items: [m] };
      blocks.push(run);
    }
  }
  flushEventsBefore(null); // anything after the last message (e.g. a fresh takeover)

  return (
    <div className="flex flex-col gap-3 md:gap-2.5">
      {blocks.map((b) =>
        b.type === "date" ? (
          <Seam key={b.key} label={b.label} />
        ) : b.type === "mode" ? (
          <ModeStrip key={b.key} event={b.event} />
        ) : b.type === "scheduling" ? (
          <SchedulingStrip key={b.key} event={b.event} agendaHref={agendaHref} />
        ) : b.type === "marker" ? (
          <div key={b.key} data-focus="true" className="my-1 flex justify-center">
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
            viewerUserId={viewerUserId ?? null}
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

/** A DAY seam: a centred caption between two hairlines ("Hoy", "Sáb 10 oct"). */
function Seam({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 py-0.5">
      <span aria-hidden className="h-px flex-1 bg-line" />
      <span className="whitespace-nowrap text-xs text-muted">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}

/** A change of WHO is answering — a small pill: "→ Escalado a una persona · 14:04". */
function ModeStrip({ event }: { event: ThreadEventView }) {
  return (
    <div className="flex justify-center">
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-chip px-2.5 py-1 text-xs text-muted">
        <span aria-hidden>→</span>
        <span className="truncate">{modeEventLabel(event)}</span>
        <span className="shrink-0 text-faint">· {clock24(new Date(event.at))}</span>
      </span>
    </div>
  );
}

/** The appointment this thread produced — centred, self-contained, and linked. */
function SchedulingStrip({
  event,
  agendaHref,
}: {
  event: ThreadSchedulingEventView;
  agendaHref?: (appointmentId: string) => string;
}) {
  const when = new Date(event.startAt);
  const whenLabel = `${when.toLocaleDateString("es-CO", { weekday: "short", day: "numeric", month: "short" }).replace(/\./g, "")} · ${clock24(when)}`;
  return (
    <div className="flex justify-center">
      <span className="flex max-w-full flex-wrap items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2">
        <span className="shrink-0 text-xs font-semibold text-foreground">{schedulingEventLabel(event)}</span>
        <span className="min-w-0 text-xs text-muted">
          {event.serviceName ? `${event.serviceName} · ` : ""}
          <span className="font-medium text-foreground">{whenLabel}</span>
          {event.staffName ? ` con ${event.staffName}` : ""}
        </span>
        {agendaHref ? (
          <Link href={agendaHref(event.appointmentId)} className="shrink-0 text-xs font-medium text-foreground underline-offset-2 hover:underline">
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
    const who = firstName(e.agentName);
    return who ? `${who} tomó la conversación` : "Una persona tomó la conversación";
  }
  if (e.toMode === "pending") return "Escalado a una persona";
  return e.fromMode === "human" ? "Devuelta al bot" : "De vuelta al bot";
}

/** The words for a SCHEDULING turning point: what happened, and by whom. */
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
  const who = e.actorType === "bot" ? "el bot" : firstName(e.actorName) ?? (e.actorType === "system" ? "el sistema" : null);
  return who ? `${verb} por ${who}` : verb;
}

/**
 * One consecutive-sender group: the author ONCE above the business side ("Bot",
 * "Tú (Laura)", "Diego"), bubbles stacked tightly. The customer's side carries no label —
 * the header already says who they are.
 */
function MessageRun({
  run,
  onRetry,
  highlightIds,
  incomingAvatar,
  viewerUserId,
}: {
  run: Run;
  onRetry?: (id: string) => void;
  highlightIds?: ReadonlySet<string>;
  incomingAvatar?: { label: string; toneClass: string } | null;
  viewerUserId: string | null;
}) {
  const isUser = run.sender === "user";
  const isAgent = run.sender === "human_agent";
  const first = run.items[0];
  const agentFirst = isAgent ? firstName(run.items.find((m) => m.agentName)?.agentName ?? null) : null;
  const mine = isAgent && viewerUserId !== null && first.agentUserId === viewerUserId;
  // The author label of the business side — "Equipo · azul claro + autor".
  const author = isUser ? null : isAgent ? (mine ? `Tú${agentFirst ? ` (${agentFirst})` : ""}` : agentFirst ?? "Equipo") : "Bot";
  const bubbles = (
    <div className={`flex min-w-0 flex-col gap-1 ${isUser ? "items-start" : "items-end"}`}>
      {author ? <span className="px-0.5 text-[0.6875rem] text-faint">{author}</span> : null}
      {run.items.map((m) => (
        <Bubble key={m.id} msg={m} onRetry={onRetry} highlighted={highlightIds?.has(m.id) ?? false} />
      ))}
    </div>
  );
  if (!isUser) return <div className="flex justify-end">{bubbles}</div>;
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

/**
 * A single bubble. The 24 h time sits on its own line at the bottom-right, inside the
 * bubble; `sending` and `failed` add a status line BELOW it ("Enviando…", "No se envió ·
 * Reintentar"). The tail (one squared corner) points at the speaker.
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
  const time = clock24(new Date(msg.occurredAt));
  const timeColor = failed ? "text-danger/80" : isUser ? "text-faint" : isAgent ? "text-bubble-agent-fg/60" : "text-white/55";

  const bubbleClass = isUser
    ? "border border-bubble-in-border bg-bubble-in text-bubble-in-fg rounded-bl-bubble-tail"
    : isAgent
      ? failed
        ? "border border-danger bg-danger/12 text-danger rounded-br-bubble-tail"
        : "border border-bubble-agent-border bg-bubble-agent text-bubble-agent-fg rounded-br-bubble-tail"
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
        data-sender={msg.sender}
        data-failed={failed ? "" : undefined}
        className={`max-w-[min(62ch,86%)] rounded-bubble px-3.5 pb-1.5 pt-2.5 md:max-w-[min(62ch,100%)] md:px-3 md:pt-2 text-[0.9375rem] leading-[1.45] md:text-[0.875rem] ${bubbleClass} ${
          sending ? "opacity-70" : ""
        } ${highlighted ? "ring-2 ring-[var(--warn-rule)]" : ""}`}
      >
        <span className="block whitespace-pre-wrap break-words [text-wrap:pretty]">{body}</span>
        {msg.payload ? <PayloadBlock payload={msg.payload} onDark={!isUser && !isAgent} /> : null}
        <span data-ib-time="" className={`mt-0.5 block text-right text-[0.6875rem] tabular-nums ${timeColor}`}>{time}</span>
      </div>
      {sending ? <span className="px-0.5 text-xs text-faint">Enviando…</span> : null}
      {failed ? (
        <span className="flex flex-col items-end gap-0.5 px-0.5" role="status">
          <span className="flex items-center gap-2 text-xs text-danger">
            No se envió.
            {onRetry ? (
              <button
                type="button"
                onClick={() => onRetry(msg.id)}
                className="inline-flex min-h-[32px] items-center rounded-md px-1 font-semibold text-danger underline underline-offset-2 hover:opacity-80"
              >
                Reintentar
              </button>
            ) : null}
          </span>
          {msg.failureDetail || msg.failureCode ? (
            <span className="max-w-[min(62ch,100%)] text-right text-[0.6875rem] text-faint">
              {msg.failureDetail}
              {/* The classification code, as stored — evidence to tell a policy rejection
                  from a provider error. */}
              {msg.failureCode ? <span className="u-mono ml-1 opacity-80">[{msg.failureCode}]</span> : null}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The offered-slots block inside a bubble. `onDark` is which SIDE the bubble is on (the
 * bot's near-black fill needs the light-on-dark ramp), not a theme flag.
 */
function PayloadBlock({ payload, onDark }: { payload: MessagePayload; onDark: boolean }) {
  if (payload.kind !== "offered_slots") return null;
  return (
    <div className={`mt-2.5 flex flex-col gap-1.5 border-t pt-2.5 ${onDark ? "border-bubble-bot-rule" : "border-line"}`}>
      <span className={`text-[0.6875rem] font-medium ${onDark ? "text-bubble-bot-label" : "text-faint"}`}>
        {payload.label ?? "Horarios ofrecidos"}
      </span>
      {payload.slots.map((s, i) => {
        const d = new Date(s.at);
        const label = `${d.toLocaleDateString("es-CO", { weekday: "short", day: "numeric", month: "short" }).replace(/\./g, "")} · ${clock24(d)}`;
        return (
          <span
            key={`${s.at}-${i}`}
            data-chosen={s.chosen ? "" : undefined}
            className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 ${onDark ? "bg-bubble-bot-inset" : "bg-chip"} ${
              s.chosen ? (onDark ? "shadow-[inset_2px_0_0_#fff]" : "shadow-[inset_2px_0_0_var(--ink)]") : ""
            }`}
          >
            <span className={`text-[0.8125rem] ${s.chosen ? "font-semibold" : ""} ${onDark ? "text-bubble-bot-fg" : "text-foreground"}`}>{label}</span>
            <span className={`ml-auto shrink-0 text-xs ${onDark ? "text-bubble-bot-label" : "text-muted"}`}>
              {s.chosen ? "✓ elegido" : (s.staffName ?? "")}
            </span>
          </span>
        );
      })}
    </div>
  );
}
