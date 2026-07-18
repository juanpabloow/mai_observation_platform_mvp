"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModeBadge } from "./ModeBadge";
import { ThreadActions } from "./ThreadActions";
import { Composer } from "./Composer";
import { formatChatTime, formatDayLabel, localDayKey } from "@/lib/format";
import type { InboxHeaderView, InboxMessageView } from "@/lib/inboxView";
import type { InboxActionResult } from "@/lib/inboxActions";

interface ThreadPayload {
  header: InboxHeaderView;
  messages: InboxMessageView[];
  asOf: string;
}

const POLL_MS = 4000;

/**
 * The thread view: header (mode + assigned agent + actions), the message transcript,
 * and the composer shell. Light-polls the session-authed messages route every ~4s
 * (paused while hidden), appending new messages and reconciling the header (so mode
 * changes made elsewhere — e.g. someone else takes it — reflect here). Action results
 * update the header immediately, then a poll confirms.
 */
export function InboxThread({
  clientId,
  initial,
  viewerUserId,
  viewerIsFullAccess,
}: {
  clientId: string;
  initial: ThreadPayload;
  viewerUserId: string;
  viewerIsFullAccess: boolean;
}) {
  const [header, setHeader] = useState(initial.header);
  const [messages, setMessages] = useState(initial.messages);
  const [now, setNow] = useState(() => new Date(initial.asOf));
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastCountRef = useRef(initial.messages.length);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/inbox/${clientId}/conversations/${header.id}/messages`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const p: ThreadPayload = await res.json();
      setHeader(p.header);
      setMessages(p.messages);
      setNow(new Date(p.asOf));
    } catch {
      /* keep last-known state on a transient failure */
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

  // Jump to the newest message on mount and whenever the count grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && messages.length !== lastCountRef.current) {
      lastCountRef.current = messages.length;
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onResult = (r: InboxActionResult) => {
    if (r.header) setHeader(r.header);
    setNotice(r.ok ? null : { kind: r.conflict ? "info" : "error", text: r.error ?? "Something went wrong." });
    void load();
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
          onResult={onResult}
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
        className="h-[60vh] overflow-y-auto rounded-xl border border-black/10 bg-black/[0.02] px-4 py-4 dark:border-line dark:bg-card"
      >
        <MessageTranscript messages={messages} now={now} />
      </div>

      <Composer mode={header.mode} />
    </div>
  );
}

function MessageTranscript({ messages, now }: { messages: InboxMessageView[]; now: Date }) {
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
            <Bubble key={m.id} msg={m} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A message bubble. user → left (gray); bot → right (emerald); human_agent → right
 * (indigo, visually distinct from the bot, with the agent's name on the bubble).
 */
function Bubble({ msg }: { msg: InboxMessageView }) {
  const isUser = msg.sender === "user";
  const isAgent = msg.sender === "human_agent";
  const time = formatChatTime(new Date(msg.occurredAt));

  const bubbleClass = isUser
    ? "rounded-bl-sm bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-foreground"
    : isAgent
      ? "rounded-br-sm bg-indigo-600/90 text-indigo-50"
      : "rounded-br-sm bg-emerald-700/90 text-emerald-50";
  const timeClass = isUser
    ? "text-neutral-500"
    : isAgent
      ? "text-indigo-100/70"
      : "text-emerald-100/70";

  const body =
    msg.text && msg.text.trim() !== ""
      ? msg.text
      : msg.contentType && msg.contentType !== "text"
        ? `[${msg.contentType}]`
        : "…";

  return (
    <div className={`flex ${isUser ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[78%] rounded-2xl px-3 py-2 shadow-sm ${bubbleClass}`}>
        {isAgent && msg.agentName ? (
          <div className="mb-0.5 text-[11px] font-medium text-indigo-100">{msg.agentName}</div>
        ) : null}
        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed">
          {body}
        </div>
        <div className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${timeClass}`}>
          {msg.status === "failed" ? <span className="text-red-200">failed ·</span> : null}
          {msg.status === "sending" ? <span>sending… ·</span> : null}
          {time}
        </div>
      </div>
    </div>
  );
}
