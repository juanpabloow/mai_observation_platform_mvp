"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ModeBadge } from "./ModeBadge";
import { formatAgeShort, formatListTimestamp } from "@/lib/format";
import {
  INBOX_FILTERS,
  conversationPreview,
  type InboxConversationView,
  type InboxFilter,
} from "@/lib/inboxView";

interface ListPayload {
  conversations: InboxConversationView[];
  pendingCount: number;
  asOf: string;
}

const POLL_MS = 5000;

/**
 * The per-client inbox list. Server-rendered once (initial), then LIGHT-polls the
 * session-authed JSON route every ~5s — paused while the tab is hidden. Filter chips
 * (All/Pending/Human/Bot) re-query immediately. Rows are sorted pending-first then by
 * recent activity (server-side). Relative times are anchored to the payload's server
 * `asOf`, so SSR and hydration agree and clocks don't drift.
 */
export function InboxList({
  clientId,
  initial,
  initialFilter,
}: {
  clientId: string;
  initial: ListPayload;
  initialFilter: InboxFilter;
}) {
  const [filter, setFilter] = useState<InboxFilter>(initialFilter);
  const [data, setData] = useState<ListPayload>(initial);
  const [stale, setStale] = useState(false);
  // Latest filter for the interval callback without re-arming the timer each change.
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const load = useCallback(
    async (f: InboxFilter) => {
      try {
        const res = await fetch(`/api/inbox/${clientId}/conversations?filter=${f}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          setStale(true);
          return;
        }
        const payload: ListPayload = await res.json();
        // Ignore a response that arrived after the user switched filters.
        if (filterRef.current !== f) return;
        setData(payload);
        setStale(false);
      } catch {
        setStale(true);
      }
    },
    [clientId],
  );

  // Re-query immediately on filter change (skip the very first render — that's the
  // server-provided initial for the default filter).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    void load(filter);
  }, [filter, load]);

  // Light polling, paused while the document is hidden.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => void load(filterRef.current), POLL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        void load(filterRef.current); // catch up immediately on return
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

  const now = new Date(data.asOf);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {INBOX_FILTERS.map((f) => {
          const active = filter === f.key;
          const showCount = f.key === "pending" && data.pendingCount > 0;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={active}
              className={`rounded-full px-3 py-1 text-sm transition-colors ${
                active
                  ? "bg-foreground text-background"
                  : "border border-black/10 text-muted hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
              }`}
            >
              {f.label}
              {showCount ? <span className="ml-1 tabular-nums">· {data.pendingCount}</span> : null}
            </button>
          );
        })}
        {stale ? <span className="text-xs text-faint">Reconnecting…</span> : null}
      </div>

      {data.conversations.length === 0 ? (
        <EmptyState filter={filter} />
      ) : (
        <ul className="divide-y divide-black/5 overflow-hidden rounded-xl border border-black/10 dark:divide-white/5 dark:border-line">
          {data.conversations.map((c) => (
            <li key={c.id}>
              <Link
                href={`/clients/${clientId}/inbox/${c.id}`}
                className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-black/[0.03] dark:hover:bg-card"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <ModeBadge mode={c.mode} />
                    <span className="truncate font-medium">{c.conversationRef}</span>
                    {c.workflowName ? (
                      <span className="truncate text-xs text-faint">· {c.workflowName}</span>
                    ) : null}
                  </div>
                  <div className="truncate text-sm text-muted">{conversationPreview(c)}</div>
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-faint">
                    {c.mode === "human" && c.assignedAgentName ? (
                      <span className="text-emerald-700 dark:text-emerald-400">
                        Taken by {c.assignedAgentName}
                      </span>
                    ) : null}
                    {c.mode === "pending" ? (
                      <span className="text-amber-700 dark:text-amber-400">
                        pending {c.pendingSince ? formatAgeShort(new Date(c.pendingSince), now) : ""}
                      </span>
                    ) : null}
                  </div>
                </div>
                {c.lastMessageAt ? (
                  <time className="shrink-0 text-xs text-faint">
                    {formatListTimestamp(new Date(c.lastMessageAt), now)}
                  </time>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState({ filter }: { filter: InboxFilter }) {
  const message =
    filter === "all"
      ? "No conversations yet. When this client's workflows post messages or request a human handoff, they'll appear here — bot-handled, pending, or taken by an agent."
      : `No ${filter} conversations right now.`;
  return (
    <div className="rounded-2xl border border-dashed border-line px-6 py-12 text-center">
      <p className="text-sm font-medium text-muted">Inbox</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-faint">{message}</p>
    </div>
  );
}
