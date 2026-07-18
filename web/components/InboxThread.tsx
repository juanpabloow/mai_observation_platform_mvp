"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModeBadge } from "./ModeBadge";
import { ThreadActions } from "./ThreadActions";
import { Composer } from "./Composer";
import { formatChatTime, formatDayLabel, localDayKey } from "@/lib/format";
import type { InboxHeaderView, InboxMessageView } from "@/lib/inboxView";
import type { InboxActionResult } from "@/lib/inboxActions";
import { sendMessageAction, retrySendAction } from "@/lib/sendActions";

interface ThreadPayload {
  header: InboxHeaderView;
  messages: InboxMessageView[];
  asOf: string;
}

/** A brand-new send not yet confirmed present in the server list. */
interface PendingSend {
  tempId: string;
  realId: string | null; // set once the action returns the inserted row's id
  view: InboxMessageView;
}

const POLL_MS = 4000;

/**
 * Thread view with the ACTIVE composer (H-3). Optimistic sends: a 'sending' bubble
 * appears immediately, then resolves to sent or failed (+detail+Retry). Reconciliation
 * with the ~4s poll is by message id — a pending bubble is dropped once its real id
 * appears in the server list, and a retry is shown as 'sending' via a per-id override
 * until the poll catches up. No duplicate bubbles.
 */
export function InboxThread({
  clientId,
  initial,
  viewerUserId,
  viewerName,
  viewerIsFullAccess,
}: {
  clientId: string;
  initial: ThreadPayload;
  viewerUserId: string;
  viewerName: string | null;
  viewerIsFullAccess: boolean;
}) {
  const [header, setHeader] = useState(initial.header);
  const [serverMessages, setServerMessages] = useState(initial.messages);
  const [pending, setPending] = useState<PendingSend[]>([]);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => new Date(initial.asOf));
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tempCounter = useRef(0);

  const load = useCallback(async () => {
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

  // Poll with visibility pause.
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

  // Merge server + optimistic, keyed by id (server wins once a pending's realId lands).
  const serverIds = new Set(serverMessages.map((m) => m.id));
  const merged: InboxMessageView[] = serverMessages.map((m) =>
    retrying.has(m.id)
      ? { ...m, status: "sending", failureCode: null, failureDetail: null }
      : m,
  );
  for (const p of pending) {
    if (p.realId && serverIds.has(p.realId)) continue; // server caught up → drop optimistic
    merged.push(p.view);
  }
  merged.sort((a, b) => {
    const t = a.occurredAt.localeCompare(b.occurredAt);
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });

  // Auto-scroll to newest when the rendered count grows.
  const renderedCount = merged.length;
  const lastCountRef = useRef(renderedCount);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && renderedCount !== lastCountRef.current) {
      lastCountRef.current = renderedCount;
      el.scrollTop = el.scrollHeight;
    }
  }, [renderedCount]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

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
    setPending((prev) => [...prev, { tempId, realId: null, view: optimistic }]);

    void (async () => {
      const r = await sendMessageAction(clientId, header.id, text);
      if (r.ok) {
        // Keep the bubble (now sent OR failed), keyed by the real id.
        setPending((prev) =>
          prev.map((p) =>
            p.tempId === tempId ? { tempId, realId: r.message.id, view: r.message } : p,
          ),
        );
        void load();
      } else {
        // Guard failed before any row was created → drop the optimistic bubble.
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
      await load(); // pull the final status before dropping the override
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      });
      // Also update any still-pending optimistic entry mirroring this id.
      if (r.ok) {
        setPending((prev) =>
          prev.map((p) => (p.realId === messageId ? { ...p, view: r.message } : p)),
        );
      } else {
        if (r.code === "mode_changed" && r.header) setHeader(r.header);
        setNotice({ kind: r.code === "mode_changed" ? "info" : "error", text: r.error });
      }
    })();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <ModeBadge mode={header.mode} />
            <h2 className="text-lg font-semibold tracking-tight">{header.conversationRef}</h2>
          </div>
          <div className="text-xs text-faint">
            {header.workflowName ?? "Unknown workflow"}
            {header.mode === "human" && header.assignedAgentName
              ? ` · Taken by ${header.assignedAgentName}`
              : ""}
          </div>
        </div>
        <ThreadActions
          clientId={clientId}
          header={header}
          viewerUserId={viewerUserId}
          viewerIsFullAccess={viewerIsFullAccess}
          onResult={onActionResult}
        />
      </div>

      {notice ? (
        <p
          className={
            notice.kind === "error"
              ? "rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-danger"
              : "rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
          }
        >
          {notice.text}
        </p>
      ) : null}

      <div
        ref={scrollRef}
        className="h-[55vh] overflow-y-auto rounded-xl border border-black/10 bg-black/[0.02] px-4 py-4 dark:border-line dark:bg-card"
      >
        <MessageTranscript messages={merged} now={now} onRetry={handleRetry} />
      </div>

      <Composer mode={header.mode} onSend={handleSend} />
    </div>
  );
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
  const groups: { key: string; label: string; items: InboxMessageView[] }[] = [];
  for (const m of messages) {
    const d = new Date(m.occurredAt);
    const key = localDayKey(d);
    const last = groups[groups.length - 1];
    if (!last || last.key !== key) groups.push({ key, label: formatDayLabel(d, now), items: [m] });
    else last.items.push(m);
  }
  return (
    <div className="flex flex-col gap-2">
      {groups.map((g) => (
        <div key={g.key} className="flex flex-col gap-2">
          <div className="my-2 flex justify-center">
            <span className="rounded-full bg-black/5 px-3 py-1 text-xs text-neutral-500 dark:bg-card dark:text-muted">
              {g.label}
            </span>
          </div>
          {g.items.map((m) => (
            <Bubble key={m.id} msg={m} onRetry={onRetry} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A message bubble. user → left (gray); bot → right (emerald); human_agent → right
 * (indigo + agent name). Human-agent sends show status: sending (ghosted), sent, or
 * failed (error style + failure detail + Retry).
 */
function Bubble({ msg, onRetry }: { msg: InboxMessageView; onRetry: (id: string) => void }) {
  const isUser = msg.sender === "user";
  const isAgent = msg.sender === "human_agent";
  const time = formatChatTime(new Date(msg.occurredAt));
  const sending = msg.status === "sending";
  const failed = msg.status === "failed";

  const bubbleClass = isUser
    ? "rounded-bl-sm bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-foreground"
    : isAgent
      ? failed
        ? "rounded-br-sm bg-red-600/90 text-red-50"
        : "rounded-br-sm bg-indigo-600/90 text-indigo-50"
      : "rounded-br-sm bg-emerald-700/90 text-emerald-50";
  const timeClass = isUser
    ? "text-neutral-500"
    : isAgent
      ? failed
        ? "text-red-100/80"
        : "text-indigo-100/70"
      : "text-emerald-100/70";

  const body =
    msg.text && msg.text.trim() !== ""
      ? msg.text
      : msg.contentType && msg.contentType !== "text"
        ? `[${msg.contentType}]`
        : "…";

  return (
    <div className={`flex ${isUser ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[78%] rounded-2xl px-3 py-2 shadow-sm ${bubbleClass} ${sending ? "opacity-70" : ""}`}>
        {isAgent && msg.agentName ? (
          <div className="mb-0.5 text-[11px] font-medium text-white/90">{msg.agentName}</div>
        ) : null}
        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed">
          {body}
        </div>
        {failed && msg.failureDetail ? (
          <div className="mt-1 rounded bg-black/20 px-1.5 py-1 text-[11px] text-red-50">
            {msg.failureDetail}
          </div>
        ) : null}
        <div className={`mt-1 flex items-center justify-end gap-2 text-[10px] ${timeClass}`}>
          {sending ? <span>sending…</span> : null}
          {failed ? (
            <button
              type="button"
              onClick={() => onRetry(msg.id)}
              className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-white/30"
            >
              Retry
            </button>
          ) : null}
          <span>{time}</span>
        </div>
      </div>
    </div>
  );
}
