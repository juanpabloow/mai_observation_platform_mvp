"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModeBadge } from "./ModeBadge";
import { ThreadActions } from "./ThreadActions";
import { Composer } from "./Composer";
import { formatChatTime, formatDayLabel, localDayKey } from "@/lib/format";
import type { HistoryTurnView, InboxHeaderView, InboxMessageView } from "@/lib/inboxView";
import type { InboxActionResult } from "@/lib/inboxActions";
import { sendMessageAction, retrySendAction } from "@/lib/sendActions";

interface ThreadPayload {
  header: InboxHeaderView;
  messages: InboxMessageView[];
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
const GROUP_GAP_MS = 3 * 60_000; // same sender within 3min stacks into one group
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
}: {
  clientId: string;
  initial: ThreadPayload;
  viewerUserId: string;
  viewerName: string | null;
  viewerIsFullAccess: boolean;
  onClose: () => void;
}) {
  const [header, setHeader] = useState(initial.header);
  const [serverMessages, setServerMessages] = useState(initial.messages);
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
      {/* Compact header */}
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <ModeBadge mode={header.mode} />
            <span className="truncate font-semibold">{header.conversationRef}</span>
            <ActivityTag active={header.active} windowHours={initial.activityWindowHours} />
          </div>
          <div className="truncate text-xs text-faint">
            {header.workflowName ?? "Unknown workflow"}
            {header.mode === "human" && header.assignedAgentName ? (
              <span className="text-emerald-700 dark:text-emerald-400"> · ● {header.assignedAgentName}</span>
            ) : null}
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
          <button
            type="button"
            onClick={onClose}
            aria-label="Close conversation"
            className="rounded-lg border border-black/10 px-2 py-1 text-xs text-muted transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-line-strong dark:hover:bg-subtle"
          >
            ✕
          </button>
        </div>
      </div>

      {notice ? (
        <p
          className={`shrink-0 px-4 py-2 text-sm ${
            notice.kind === "error" ? "text-danger" : "text-amber-700 dark:text-amber-400"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      {/* Messages (scrolls) */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-black/[0.02] px-4 py-3 dark:bg-card">
        {history.length > 0 ? <HistoryDisclosure turns={history} /> : null}
        <MessageTranscript messages={merged} now={now} onRetry={handleRetry} />
      </div>

      {/* Composer (pinned) */}
      <div className="shrink-0 px-4 pb-3">
        <Composer mode={header.mode} onSend={handleSend} />
      </div>
    </div>
  );
}

function ActivityTag({ active, windowHours }: { active: boolean; windowHours: number }) {
  return active ? (
    <span
      title={`Active — the customer wrote within the last ${windowHours}h`}
      className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400"
    >
      Active
    </span>
  ) : (
    <span
      title={`Inactive — no customer message in the last ${windowHours}h`}
      className="rounded-full bg-subtle px-1.5 py-0.5 text-[11px] font-medium text-faint"
    >
      Inactive
    </span>
  );
}

/** Collapsed pre-handoff history at the top (read-only derived turns). */
function HistoryDisclosure({ turns }: { turns: HistoryTurnView[] }) {
  return (
    <details className="mb-3 rounded-xl border border-black/10 dark:border-line">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted hover:text-foreground">
        History before handoff · {turns.length} {turns.length === 1 ? "turn" : "turns"}
      </summary>
      <div className="flex flex-col gap-2 border-t border-line px-3 py-3">
        <p className="text-[11px] text-faint">
          Reconstructed from executions before live handoff was wired (read-only).
        </p>
        {turns.map((t) => (
          <div key={t.id} className="flex flex-col gap-1">
            {t.userText ? (
              <div className="flex justify-start">
                <div className="max-w-[70%] rounded-xl bg-black/5 px-3 py-2 text-sm text-foreground dark:bg-white/10">
                  {t.userText}
                </div>
              </div>
            ) : null}
            {t.aiText ? (
              <div className="flex justify-end">
                <div className="max-w-[70%] rounded-xl bg-emerald-700/80 px-3 py-2 text-sm text-emerald-50">
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

function MessageTranscript({
  messages,
  now,
  onRetry,
}: {
  messages: InboxMessageView[];
  now: Date;
  onRetry: (messageId: string) => void;
}) {
  if (messages.length === 0) {
    return <p className="py-8 text-center text-sm text-faint">No messages yet.</p>;
  }
  // Build date separators + consecutive-sender runs.
  const blocks: (Run | DateSep)[] = [];
  let lastDay: string | null = null;
  let run: Run | null = null;
  for (const m of messages) {
    const d = new Date(m.occurredAt);
    const day = localDayKey(d);
    if (day !== lastDay) {
      blocks.push({ type: "date", key: `date-${day}`, label: formatDayLabel(d, now) });
      lastDay = day;
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

  return (
    <div className="flex flex-col gap-3">
      {blocks.map((b) =>
        b.type === "date" ? (
          <div key={b.key} className="my-1 flex justify-center">
            <span className="rounded-full bg-black/5 px-2.5 py-0.5 text-[11px] text-neutral-500 dark:bg-white/10 dark:text-muted">
              {b.label}
            </span>
          </div>
        ) : (
          <MessageRun key={b.key} run={b} onRetry={onRetry} />
        ),
      )}
    </div>
  );
}

/** One consecutive-sender group: name once at the top, bubbles stacked tightly. */
function MessageRun({ run, onRetry }: { run: Run; onRetry: (id: string) => void }) {
  const isUser = run.sender === "user";
  const isAgent = run.sender === "human_agent";
  const agentName = isAgent ? run.items.find((m) => m.agentName)?.agentName ?? null : null;
  return (
    <div className={`flex flex-col gap-0.5 ${isUser ? "items-start" : "items-end"}`}>
      {isAgent && agentName ? (
        <span className="px-1 text-[11px] font-medium text-faint">{agentName}</span>
      ) : null}
      {run.items.map((m) => (
        <Bubble key={m.id} msg={m} onRetry={onRetry} />
      ))}
    </div>
  );
}

/**
 * A single bubble. user → left neutral; bot → right emerald; human_agent → right
 * indigo (failed → red). Timestamp in-bubble bottom-right, small + muted.
 */
function Bubble({ msg, onRetry }: { msg: InboxMessageView; onRetry: (id: string) => void }) {
  const isUser = msg.sender === "user";
  const isAgent = msg.sender === "human_agent";
  const sending = msg.status === "sending";
  const failed = msg.status === "failed";
  const time = formatChatTime(new Date(msg.occurredAt));

  const bubbleClass = isUser
    ? "bg-black/5 text-foreground dark:bg-white/10"
    : isAgent
      ? failed
        ? "bg-red-600/90 text-red-50"
        : "bg-indigo-600 text-indigo-50"
      : "bg-emerald-700 text-emerald-50";
  const metaClass = isUser
    ? "text-faint"
    : isAgent
      ? failed
        ? "text-red-100/80"
        : "text-indigo-100/80"
      : "text-emerald-100/80";

  const body =
    msg.text && msg.text.trim() !== ""
      ? msg.text
      : msg.contentType && msg.contentType !== "text"
        ? `[${msg.contentType}]`
        : "…";

  return (
    <div className={`max-w-[70%] rounded-xl px-3 py-2 text-sm leading-snug shadow-sm ${bubbleClass} ${sending ? "opacity-70" : ""}`}>
      <span className="whitespace-pre-wrap break-words align-middle">{body}</span>
      {failed && msg.failureDetail ? (
        <span className="mt-1 block rounded bg-black/20 px-1.5 py-1 text-[11px] text-red-50">
          {msg.failureDetail}
        </span>
      ) : null}
      <span className={`ml-2 inline-flex items-center gap-1.5 align-middle text-[10px] ${metaClass}`}>
        {sending ? <span>sending…</span> : null}
        {failed ? (
          <button
            type="button"
            onClick={() => onRetry(msg.id)}
            className="rounded bg-white/20 px-1 text-[10px] font-medium text-white hover:bg-white/30"
          >
            Retry
          </button>
        ) : null}
        <span>{time}</span>
      </span>
    </div>
  );
}
