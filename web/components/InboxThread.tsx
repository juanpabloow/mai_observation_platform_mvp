"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ThreadActions } from "./ThreadActions";
import { Composer } from "./Composer";
import { MessageTranscript } from "./MessageTranscript";
import { InboxAvatar, InboxConfirm, StateChip, IconAlert, IconArrowDown, IconBack, IconBot, IconPerson } from "./inbox/InboxUi";
import {
  formatConversationRef,
  type ThreadEventView,
  type ThreadSchedulingEventView,
  type HistoryTurnView,
  type InboxHeaderView,
  type InboxMessageView,
} from "@/lib/inboxView";
import {
  avatarText,
  confirmCopy,
  conversationTitle,
  isPhoneRef,
  responder,
  threadActionPlan,
  windowChip,
  windowClosedLine,
  windowState,
  type ThreadActionKind,
} from "@/lib/inboxPresent";
import {
  dismissConversationAction,
  returnConversationToBotAction,
  takeConversationAction,
  type InboxActionResult,
} from "@/lib/inboxActions";
import { sendMessageAction, retrySendAction } from "@/lib/sendActions";

interface ThreadPayload {
  header: InboxHeaderView;
  /** PL-2 §6 — read-only origin + opportunity-stage context for the header. */
  pipeline?: { contactId: string | null; origin: { label: string; tone: string; detail: string | null } | null; oppStage: string | null };
  messages: InboxMessageView[];
  events?: ThreadEventView[];
  /** Scheduling turning points — see MessageTranscript. Polled alongside the messages. */
  schedulingEvents?: ThreadSchedulingEventView[];
  history?: HistoryTurnView[];
  activityWindowHours: number;
  asOf: string;
}

interface PendingSend {
  tempId: string;
  realId: string | null;
  view: InboxMessageView;
}

const POLL_MS = 4000;
const NEAR_BOTTOM_PX = 90;

/**
 * The live conversation (inbox redesign, frames 1c–1l / 2c–2j).
 *
 *   HEADER   identity (avatar, name or phone or "Contacto sin nombre", phone · workflow),
 *            the ONE possible action (Tomar / Devolver al bot, with a confirmation) and
 *            "Ficha"; a second row with WHO ANSWERS and the 24 h WINDOW. On the phone the
 *            first row is only back · identity · ficha — the state and the action move to
 *            the second row, so nothing is clipped at 360 px.
 *   THREAD   opens at the last message; what came BEFORE the latest escalation is folded
 *            under "Historial antes del escalado · N mensajes" and opens on demand.
 *            "Ir al último mensaje" appears when you scroll up — it never forces the scroll.
 *   COMPOSER in flow, with a draft per conversation (see Composer).
 *
 * Optimistic sends + the ~4 s poll (paused while the tab is hidden) are unchanged. Take /
 * return go through the SAME server actions, which re-check every permission. Outcomes are
 * announced in a permanent aria-live region.
 */
export function InboxThread({
  clientId,
  initial,
  viewerUserId,
  viewerName,
  viewerIsFullAccess,
  onBack,
  onOpenDetails,
  detailsOpen = false,
  onModeChanged,
}: {
  clientId: string;
  initial: ThreadPayload;
  viewerUserId: string;
  viewerName: string | null;
  viewerIsFullAccess: boolean;
  /** Phone/tablet: back to the list (client→client callback). */
  onBack?: () => void;
  /** Opens the customer's ficha. */
  onOpenDetails?: () => void;
  detailsOpen?: boolean;
  /** Take / return changed who answers — the list refreshes now, not on its next poll. */
  onModeChanged?: () => void;
}) {
  const [header, setHeader] = useState(initial.header);
  const [serverMessages, setServerMessages] = useState(initial.messages);
  const [events, setEvents] = useState<ThreadEventView[]>(initial.events ?? []);
  const [schedulingEvents, setSchedulingEvents] = useState<ThreadSchedulingEventView[]>(initial.schedulingEvents ?? []);
  const [pending, setPending] = useState<PendingSend[]>([]);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => new Date(initial.asOf));
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [announce, setAnnounce] = useState("");
  const [confirm, setConfirm] = useState<ThreadActionKind | null>(null);
  const [busy, startTransition] = useTransition();
  const [showEarlier, setShowEarlier] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const history = initial.history ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const tempCounter = useRef(0);
  const wasNearBottom = useRef(true);
  const forceScroll = useRef(true); // open at the last message

  const nearBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  const load = useCallback(async () => {
    wasNearBottom.current = nearBottom(); // capture BEFORE the DOM grows
    try {
      const res = await fetch(`/api/inbox/${clientId}/conversations/${header.id}/messages`, { cache: "no-store" });
      if (!res.ok) return;
      const p: ThreadPayload = await res.json();
      setHeader(p.header);
      setServerMessages(p.messages);
      setEvents(p.events ?? []);
      setSchedulingEvents(p.schedulingEvents ?? []);
      setNow(new Date(p.asOf));
    } catch {
      /* keep last-known state */
    }
  }, [clientId, header.id]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!timer) timer = setInterval(() => void load(), POLL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else {
        void load();
        start();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  // Merge server + optimistic (server wins once a pending's realId lands).
  const serverIds = new Set(serverMessages.map((m) => m.id));
  const merged: InboxMessageView[] = serverMessages.map((m) =>
    retrying.has(m.id) ? { ...m, status: "sending", failureCode: null, failureDetail: null } : m,
  );
  for (const p of pending) {
    if (p.realId && serverIds.has(p.realId)) continue;
    merged.push(p.view);
  }
  merged.sort((a, b) => {
    const t = a.occurredAt.localeCompare(b.occurredAt);
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });

  // What came before the LATEST escalation is folded while someone has to act on it.
  const lastEscalation = header.mode === "bot" ? null : [...events].reverse().find((e) => e.toMode === "pending") ?? null;
  const earlier = lastEscalation ? merged.filter((m) => m.occurredAt < lastEscalation.at) : [];
  // Fold only when something remains to read after the escalation — folding everything
  // would leave an empty thread with the context hidden behind a button.
  const afterCount = merged.length - earlier.length;
  const folded = earlier.length > 0 && afterCount > 0 && !showEarlier;
  const visible = folded ? merged.filter((m) => m.occurredAt >= lastEscalation!.at) : merged;
  const visibleEvents = folded ? events.filter((e) => e.at >= lastEscalation!.at) : events;

  // Auto-scroll: forced on open / own send; otherwise only if the reader was near the bottom.
  const renderedCount = visible.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (forceScroll.current || wasNearBottom.current) {
      el.scrollTop = el.scrollHeight;
      forceScroll.current = false;
    }
  }, [renderedCount]);

  const onScroll = () => setShowJump(!nearBottom());
  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const onActionResult = (r: InboxActionResult, done: string) => {
    if (r.header) setHeader(r.header);
    if (r.ok) {
      setNotice(null);
      setAnnounce(done);
      onModeChanged?.();
    } else {
      const text = r.error ?? "No se pudo completar la acción.";
      setNotice({ kind: r.conflict ? "info" : "error", text });
      setAnnounce(text);
    }
    void load();
  };

  const runAction = (kind: ThreadActionKind) =>
    startTransition(async () => {
      const r =
        kind === "take"
          ? await takeConversationAction(clientId, header.id)
          : kind === "dismiss"
            ? await dismissConversationAction(clientId, header.id)
            : await returnConversationToBotAction(clientId, header.id);
      setConfirm(null);
      onActionResult(r, kind === "take" ? "Tomaste la conversación. Ahora respondes tú." : "La conversación volvió al bot.");
    });

  const win = windowState(header.lastUserMessageAt, now);
  const chip = windowChip(win);
  const who = responder(header.mode, header.assignedAgentUserId, header.assignedAgentName, viewerUserId);
  const plan = threadActionPlan({
    mode: header.mode,
    assignedUserId: header.assignedAgentUserId,
    assignedName: header.assignedAgentName,
    viewerUserId,
    viewerIsFullAccess,
  });
  const title = conversationTitle(header.contactName, header.conversationRef);
  const whatsapp = /whats\s*app/i.test(header.channel ?? "");
  const sub = [
    isPhoneRef(header.conversationRef) ? formatConversationRef(header.conversationRef) : `Sin número visible${whatsapp ? "" : " · WhatsApp"}`,
    header.workflowName,
    whatsapp ? "WhatsApp" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const copy = confirm ? confirmCopy(confirm, title.kind === "unknown" ? "este contacto" : title.text, header.assignedAgentName, header.assignedAgentUserId === viewerUserId) : null;

  const handleSend = (text: string) => {
    const tempId = `optimistic-${tempCounter.current++}`;
    const optimistic: InboxMessageView = {
      id: tempId,
      sender: "human_agent",
      agentName: viewerName,
      agentUserId: viewerUserId,
      text,
      contentType: "text",
      status: "sending",
      failureCode: null,
      failureDetail: null,
      occurredAt: new Date().toISOString(),
      payload: null,
    };
    forceScroll.current = true; // your own message → jump to bottom
    setPending((prev) => [...prev, { tempId, realId: null, view: optimistic }]);
    void (async () => {
      const r = await sendMessageAction(clientId, header.id, text);
      if (r.ok) {
        setPending((prev) => prev.map((p) => (p.tempId === tempId ? { tempId, realId: r.message.id, view: r.message } : p)));
        void load();
      } else {
        setPending((prev) => prev.filter((p) => p.tempId !== tempId));
        if (r.code === "mode_changed" && r.header) setHeader(r.header);
        setNotice({ kind: r.code === "mode_changed" ? "info" : "error", text: r.error });
        setAnnounce(r.error);
      }
    })();
  };

  const handleRetry = (messageId: string) => {
    setRetrying((prev) => new Set(prev).add(messageId));
    void (async () => {
      const r = await retrySendAction(clientId, header.id, messageId);
      await load();
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      });
      if (r.ok) setPending((prev) => prev.map((p) => (p.realId === messageId ? { ...p, view: r.message } : p)));
      else {
        if (r.code === "mode_changed" && r.header) setHeader(r.header);
        setNotice({ kind: r.code === "mode_changed" ? "info" : "error", text: r.error });
        setAnnounce(r.error);
      }
    })();
  };

  const pipeline = initial.pipeline;
  const chips = (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span data-ib-who-text="" className="contents">
        <StateChip kind={who.kind}>{who.label}</StateChip>
      </span>
      {chip ? <StateChip kind={chip.open ? "open" : "closed"}>{chip.label}</StateChip> : null}
      {pipeline?.origin ? (
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ${pipeline.origin.tone}`} title="De dónde vino este contacto">
          {pipeline.origin.label}
          {pipeline.origin.detail ? <span className="font-normal opacity-80">· {pipeline.origin.detail}</span> : null}
        </span>
      ) : null}
      {pipeline?.oppStage ? (
        <span className="inline-flex items-center rounded-full bg-chip px-2 py-0.5 text-[0.6875rem] font-medium text-muted" title="Etapa de la oportunidad">
          {pipeline.oppStage}
        </span>
      ) : null}
      {pipeline?.contactId ? (
        <Link href={`/clients/${clientId}/contacts/${pipeline.contactId}`} className="u-focus text-[0.6875rem] text-accent hover:underline">
          Ver ficha ↗
        </Link>
      ) : null}
    </div>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Permanent live region: take / return / send outcomes are announced here. */}
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>

      <header data-ib-thread-head="" className="flex min-h-[var(--topbar-height)] shrink-0 flex-col gap-2 border-b border-line px-3 py-2.5 md:gap-1.5 md:px-4 md:py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Volver a las conversaciones"
              className="-ml-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-subtle md:hidden"
            >
              <IconBack />
            </button>
          ) : null}
          <InboxAvatar text={avatarText(header.contactName, header.conversationRef)} toneKey={header.conversationRef} />
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 data-ib-title="" className={`truncate text-[1.0625rem] font-semibold leading-tight tracking-[-0.01em] text-foreground md:text-[0.9375rem] ${title.kind === "phone" ? "tabular-nums" : ""}`}>
              {title.text}
            </h2>
            <span className="truncate text-xs text-muted">{sub}</span>
          </div>
          {/* Grafito: who answers as a round icon chip (the text chip steps aside there). */}
          <span data-ib-who-icon="" data-kind={who.kind} role="img" aria-label={who.label} title={who.label}>
            {who.kind === "bot" ? <IconBot /> : who.kind === "pending" ? <IconAlert /> : <IconPerson />}
          </span>
          <div className="hidden lg:flex">
            <ThreadActions plan={plan} busy={busy} onRequest={setConfirm} />
          </div>
          {onOpenDetails ? (
            <button
              type="button"
              onClick={onOpenDetails}
              aria-pressed={detailsOpen}
              aria-label="Ficha del cliente"
              data-ib-pill=""
              data-ib-outline=""
              className={`inline-flex size-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border text-sm font-medium transition-colors md:h-8 md:w-auto md:px-2.5 md:text-[0.8125rem] ${
                detailsOpen ? "border-ink text-foreground" : "border-line-strong text-foreground hover:bg-subtle"
              }`}
            >
              <IconPerson />
              <span className="hidden md:inline">Ficha</span>
            </button>
          ) : null}
        </div>
        {/* Phone: the chips get their own row and the action the next, right-aligned (3a);
            tablet: side by side; desktop: the action lives in the first row. */}
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {chips}
          <div className="self-end lg:hidden">
            <ThreadActions plan={plan} busy={busy} onRequest={setConfirm} compact />
          </div>
        </div>
        {plan.primary?.disabledReason ? <p className="text-xs text-faint">{plan.primary.disabledReason}</p> : null}
      </header>

      {notice ? (
        <p role={notice.kind === "error" ? "alert" : "status"} className={`shrink-0 px-4 py-2 text-sm ${notice.kind === "error" ? "text-danger" : "text-warn"}`}>
          {notice.text}
        </p>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto bg-[var(--thread-bg)] px-3 pb-3 pt-4 md:px-5 md:pt-3">
          {history.length > 0 ? <HistoryDisclosure turns={history} /> : null}
          {folded ? (
            <button
              type="button"
              onClick={() => setShowEarlier(true)}
              data-ib-history=""
              className="mb-3 flex min-h-[44px] w-full items-center justify-center rounded-xl border border-line bg-surface px-3 text-sm text-muted transition-colors hover:text-foreground md:min-h-8 md:text-[0.8125rem]"
            >
              Historial antes del escalado · {earlier.length} {earlier.length === 1 ? "mensaje" : "mensajes"}
            </button>
          ) : null}
          <MessageTranscript
            messages={visible}
            now={now}
            onRetry={handleRetry}
            events={visibleEvents}
            schedulingEvents={schedulingEvents}
            agendaHref={(appointmentId) => `/clients/${clientId}/scheduling/agenda?appt=${appointmentId}`}
            viewerUserId={viewerUserId}
          />
        </div>
        {showJump ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 inline-flex min-h-[40px] -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-xs font-medium text-foreground shadow-[var(--shadow-float)]"
          >
            <IconArrowDown />
            Ir al último mensaje
          </button>
        ) : null}
      </div>

      <div data-ib-composer-band="" className="shrink-0 border-t border-line bg-[var(--thread-bg)] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5 md:px-4">
        <Composer
          key={header.id}
          clientId={clientId}
          conversationId={header.id}
          mode={header.mode}
          onSend={handleSend}
          blockedReason={windowClosedLine(win, now)}
          onTake={plan.primary?.kind === "take" ? () => setConfirm("take") : undefined}
        />
      </div>

      <InboxConfirm
        open={copy !== null}
        title={copy?.title ?? ""}
        body={copy?.body ?? ""}
        confirmLabel={copy?.confirm ?? ""}
        pending={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && runAction(confirm)}
      />
    </div>
  );
}

/** Reconstructed pre-handoff history (executions before live handoff was wired), read-only. */
function HistoryDisclosure({ turns }: { turns: HistoryTurnView[] }) {
  return (
    <details className="mb-3 rounded-xl border border-line bg-surface">
      <summary className="flex min-h-[44px] cursor-pointer items-center justify-center px-3 text-sm text-muted hover:text-foreground md:min-h-8 md:text-[0.8125rem]">
        Historial anterior · {turns.length} {turns.length === 1 ? "turno" : "turnos"}
      </summary>
      <div className="flex flex-col gap-2 border-t border-line px-3 py-3">
        <p className="text-xs text-faint">Reconstruido a partir de ejecuciones anteriores al handoff (solo lectura).</p>
        {turns.map((t) => (
          <div key={t.id} className="flex flex-col gap-1">
            {t.userText ? (
              <div className="flex justify-start">
                <div className="max-w-[70%] rounded-bubble border border-bubble-in-border bg-bubble-in px-3 py-2 text-sm text-bubble-in-fg">{t.userText}</div>
              </div>
            ) : null}
            {t.aiText ? (
              <div className="flex justify-end">
                <div className="max-w-[70%] rounded-bubble bg-bubble-bot px-3 py-2 text-sm text-bubble-bot-fg">{t.aiText}</div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  );
}
