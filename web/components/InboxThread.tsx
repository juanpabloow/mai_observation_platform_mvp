"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModeBadge } from "./ModeBadge";
import { ThreadActions } from "./ThreadActions";
import { Composer } from "./Composer";
import { MessageTranscript } from "./MessageTranscript";
import { avatarColor } from "@/lib/avatarColor";
import {
  conversationAvatarLabel,
  formatConversationRef,
  type ThreadEventView,
  type ThreadSchedulingEventView,
  type HistoryTurnView,
  type InboxHeaderView,
  type InboxMessageView,
} from "@/lib/inboxView";
import type { InboxActionResult } from "@/lib/inboxActions";
import { sendMessageAction, retrySendAction } from "@/lib/sendActions";
import { serviceWindow, serviceWindowNotice } from "@/lib/inboxView";

interface ThreadPayload {
  header: InboxHeaderView;
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
 * The live conversation thread, rendered INSIDE the inbox drawer (H-8). Fills the
 * drawer as a flex column: compact header → scrolling messages → pinned composer.
 * Optimistic sends + ~4s poll (visibility-paused) are preserved. Messages are grouped
 * by consecutive sender (name once per group), timestamps sit in-bubble bottom-right,
 * date separators mark day changes, and the pre-handoff history is a collapsed
 * disclosure at the TOP. Auto-scrolls to the newest on open and on your own send; a
 * polled message only auto-scrolls when you're already near the bottom.
 */
export function InboxThread({
  clientId,
  initial,
  viewerUserId,
  viewerName,
  viewerIsFullAccess,
  onClose,
  onBack,
  headerExtra,
}: {
  clientId: string;
  initial: ThreadPayload;
  viewerUserId: string;
  viewerName: string | null;
  viewerIsFullAccess: boolean;
  onClose: () => void;
  /** Optional: a mobile "back to list" control (client→client callback). */
  onBack?: () => void;
  /** Optional: extra header controls (e.g. a Details toggle) — client→client node. */
  headerExtra?: React.ReactNode;
}) {
  const [header, setHeader] = useState(initial.header);
  const [serverMessages, setServerMessages] = useState(initial.messages);
  // Turning points come back on every poll, so a colleague taking the conversation
  // over shows up in your open thread without a reload.
  const [events, setEvents] = useState<ThreadEventView[]>(initial.events ?? []);
  const [schedulingEvents, setSchedulingEvents] = useState<ThreadSchedulingEventView[]>(
    initial.schedulingEvents ?? [],
  );
  const [pending, setPending] = useState<PendingSend[]>([]);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => new Date(initial.asOf));
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const history = initial.history ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const tempCounter = useRef(0);
  const wasNearBottom = useRef(true);
  const forceScroll = useRef(true); // scroll on first paint

  const nearBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  const load = useCallback(async () => {
    wasNearBottom.current = nearBottom(); // capture BEFORE the DOM grows
    try {
      const res = await fetch(`/api/inbox/${clientId}/conversations/${header.id}/messages`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const p: ThreadPayload = await res.json();
      setHeader(p.header);
      setServerMessages(p.messages);
      setEvents(p.events ?? []);
      // A customer who reschedules through the bot mid-thread must appear within the poll
      // interval, not on the next full reload.
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

  // Auto-scroll: force on open/own-send; otherwise only if the user was near the bottom.
  const renderedCount = merged.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (forceScroll.current || wasNearBottom.current) {
      el.scrollTop = el.scrollHeight;
      forceScroll.current = false;
    }
  }, [renderedCount]);

  const onActionResult = (r: InboxActionResult) => {
    if (r.header) setHeader(r.header);
    setNotice(r.ok ? null : { kind: r.conflict ? "info" : "error", text: r.error ?? "Something went wrong." });
    void load();
  };

  // WhatsApp's 24-hour service window, from the customer's last INBOUND message. The
  // clock only advances when this component re-renders (the thread already polls), so a
  // tab left open can show the window as open for up to one poll after it closes — the
  // provider is the real gate; this is a courtesy so nobody types a doomed reply.
  const windowNotice = serviceWindowNotice(serviceWindow(header.channel, merged, new Date()));

  const handleSend = (text: string) => {
    const tempId = `optimistic-${tempCounter.current++}`;
    const optimistic: InboxMessageView = {
      id: tempId,
      sender: "human_agent",
      agentName: viewerName,
      text,
      contentType: "text",
      status: "sending",
      failureCode: null,
      failureDetail: null,
      occurredAt: new Date().toISOString(),
      // An outbound human reply is plain text; structured payloads come from the agent
      // side, never from this composer.
      payload: null,
    };
    forceScroll.current = true; // your own message → jump to bottom
    setPending((prev) => [...prev, { tempId, realId: null, view: optimistic }]);
    void (async () => {
      const r = await sendMessageAction(clientId, header.id, text);
      if (r.ok) {
        setPending((prev) =>
          prev.map((p) => (p.tempId === tempId ? { tempId, realId: r.message.id, view: r.message } : p)),
        );
        void load();
      } else {
        setPending((prev) => prev.filter((p) => p.tempId !== tempId));
        if (r.code === "mode_changed" && r.header) setHeader(r.header);
        setNotice({ kind: r.code === "mode_changed" ? "info" : "error", text: r.error });
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
      }
    })();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Compact header — min-h-14 matches the queue header, the customer panel
          header and the app header, so the four strips align across the seams. */}
      <div className="flex min-h-[var(--topbar-height)] shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to conversations"
            className="shrink-0 rounded-md border border-line-strong px-2 py-1 text-xs text-muted transition-colors hover:bg-subtle hover:text-foreground lg:hidden"
          >
            ‹ Back
          </button>
        ) : null}
        {/* TODO(inbox): the design's header shows the customer's NAME above the phone
            number and a live "seen · typing" presence line. This payload has neither —
            `InboxHeaderView` carries the channel identifier only, and no read receipt
            or typing signal is delivered by any channel we ingest. Rendering them would
            mean inventing state, so the header shows the identifier, the real mode
            badge, the workflow and the REAL activity tag (customer wrote inside the
            activity window) instead. */}
        <ModeBadge mode={header.mode} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span
              className={`min-w-0 truncate text-[0.90625rem] tracking-[-0.015em] text-foreground ${
                header.contactName?.trim() ? "" : "u-mono"
              }`}
            >
              {header.contactName?.trim() || formatConversationRef(header.conversationRef)}
            </span>
            {/* When the person has a name, the identifier stays beside it — the agent
                still needs the number to hand, just not as the headline. */}
            {header.contactName?.trim() ? (
              <span className="u-mono shrink-0 text-[0.71875rem] text-muted">
                {formatConversationRef(header.conversationRef)}
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.71875rem]">
            <span className="truncate text-faint">{header.workflowName ?? "Flujo desconocido"}</span>
            {header.mode === "human" && header.assignedAgentName ? (
              <>
                <span aria-hidden className="text-faintest">·</span>
                <span className="flex items-center gap-1.5 whitespace-nowrap text-success">
                  <span aria-hidden className="size-1.5 rounded-full bg-success" />
                  {header.assignedAgentName}
                </span>
              </>
            ) : null}
            <span aria-hidden className="text-faintest">·</span>
            <ActivityTag active={header.active} windowHours={initial.activityWindowHours} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ThreadActions
            clientId={clientId}
            header={header}
            viewerUserId={viewerUserId}
            viewerIsFullAccess={viewerIsFullAccess}
            onResult={onActionResult}
          />
          {headerExtra}
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar la conversación"
            className="inline-flex size-8 items-center justify-center rounded-md border border-line-strong text-xs text-muted transition-colors hover:bg-hover hover:text-foreground"
          >
            &#10005;
          </button>
        </div>
      </div>

      {notice ? (
        <p
          className={`shrink-0 px-4 py-2 text-sm ${
            notice.kind === "error" ? "text-danger" : "text-warn"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      {/*
        Messages (scrolls).

        Of the four blocks the design draws that this thread once could not render, TWO
        are now real reads rather than inventions:

          - "REAGENDADA POR EL BOT … Ver en agenda ↗" — read across
            `appointments.source_conversation_id` + `appointment_events`
            (listConversationSchedulingEvents). No new table; the link had always been
            recorded and the thread simply never read it.
          - "SLOTS OFRECIDOS" — a documented shape for `handoff_messages.metadata`, an
            existing unused jsonb column (see MessagePayload / parseMessagePayload). It
            renders when the agent side writes it and is silently absent until then,
            which is why it is a schema for that column rather than a placeholder.

        Two remain deliberately absent:

          - "hoy · el bot tomó la conversación 10:28". A conversation STARTS in bot mode
            with no transition row, so there is nothing to read. It needs a row written at
            creation, or an inference from the first bot message — which is a guess.
          - "… está escribiendo". No channel we ingest delivers a typing signal, so there
            is no source for it at any layer.
      */}
      {/* The transcript is the BRIGHT surface of the workspace — the queue beside it
          carries the tint. The customer's bubbles are the light-grey objects on it;
          the business answers in near-black. */}
      <div ref={scrollRef} // Padding is the design's 20/24/14 — the transcript needs more side room than a
          // panel because its bubbles cap at ~62% and float away from both edges.
          className="min-h-0 flex-1 overflow-y-auto bg-[var(--thread-bg)] px-6 pb-3.5 pt-5">
        {history.length > 0 ? <HistoryDisclosure turns={history} /> : null}
        <MessageTranscript
          messages={merged}
          now={now}
          onRetry={handleRetry}
          // The SAME disc the queue row shows for this conversation — one helper for
          // the label and one for the tone, so the person can't wear two different
          // avatars across the two columns.
          events={events}
          schedulingEvents={schedulingEvents}
          // "Ver en agenda ↗" — the agenda deep-links to the DAY of the appointment and
          // focuses it, which is the view an operator actually wants from a thread.
          agendaHref={(appointmentId) => `/clients/${clientId}/scheduling/agenda?appt=${appointmentId}`}
          incomingAvatar={{
            label: conversationAvatarLabel(header.conversationRef, header.contactName),
            toneClass: avatarColor(header.conversationRef),
          }}
        />
      </div>

      {/* Composer (pinned) */}
      {/* The composer floats on the same surface as the transcript — its own hairline
          card is what separates it, not a rule across the column. */}
      {/* The composer sits on the TRANSCRIPT's ground, not on the panel — that is what
          lets its shadow read as "this floats over the conversation" instead of as a
          box on a white card. Padding is the design's 10/20/18. */}
      <div className="shrink-0 bg-[var(--thread-bg)] px-5 pb-4 pt-2.5">
        <Composer mode={header.mode} onSend={handleSend} blockedReason={windowNotice} />
      </div>
    </div>
  );
}

/**
 * Whether the customer is still inside the reply window — a dot plus a word on the
 * header's meta line, not a filled pill.
 *
 * The design's equivalent is "● visto · escribiendo", which we cannot render: no channel
 * we ingest delivers read receipts or typing. What IS real is whether they wrote inside
 * the activity window, which is the fact that actually governs whether a reply will
 * deliver — so that is what this says, in the design's shape.
 */
function ActivityTag({ active, windowHours }: { active: boolean; windowHours: number }) {
  return active ? (
    <span
      title={`Activa — el cliente escribió en las últimas ${windowHours} h`}
      className="flex items-center gap-1.5 whitespace-nowrap text-success"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-success" />
      activa
    </span>
  ) : (
    <span
      title={`Inactiva — el cliente no escribe desde hace más de ${windowHours} h`}
      className="flex items-center gap-1.5 whitespace-nowrap text-faint"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-line-strong" />
      inactiva
    </span>
  );
}

/** Collapsed pre-handoff history at the top (read-only derived turns). */
function HistoryDisclosure({ turns }: { turns: HistoryTurnView[] }) {
  return (
    <details className="mb-3 rounded-lg border border-line">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted hover:text-foreground">
        History before handoff · {turns.length} {turns.length === 1 ? "turn" : "turns"}
      </summary>
      <div className="flex flex-col gap-2 border-t border-line px-3 py-3">
        <p className="text-[0.6875rem] text-faint">
          Reconstructed from executions before live handoff was wired (read-only).
        </p>
        {turns.map((t) => (
          <div key={t.id} className="flex flex-col gap-1">
            {/* Same customer/bot treatment as the live transcript — this reconstructed
                history used to render the bot in green, which both clashed with the
                live thread and spent a hue the system reserves for success. */}
            {t.userText ? (
              <div className="flex justify-start">
                <div className="max-w-[70%] rounded-lg border border-bubble-in-border bg-bubble-in px-3 py-2 text-sm text-bubble-in-fg">
                  {t.userText}
                </div>
              </div>
            ) : null}
            {t.aiText ? (
              <div className="flex justify-end">
                <div className="max-w-[70%] rounded-lg border border-bubble-bot-border bg-bubble-bot px-3 py-2 text-sm text-bubble-bot-fg">
                  {t.aiText}
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  );
}
