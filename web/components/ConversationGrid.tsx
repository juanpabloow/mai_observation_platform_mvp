"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationCard } from "./ConversationCard";
import {
  ACTIVITY_SEGMENTS,
  INBOX_FILTERS,
  type ActivitySegment,
  type InboxConversationView,
  type InboxFilter,
} from "@/lib/inboxView";

interface GridPayload {
  conversations: InboxConversationView[];
  activityWindowHours: number;
  asOf: string;
}

const POLL_MS = 5000;

/**
 * The per-workflow conversation GRID (H-7) — the single conversations surface for a
 * handoff-active workflow. Server-rendered once, then light-polls the workflow list
 * route every ~5s (visibility-paused). ALL filtering is client-side over the loaded
 * page: mode chips (with live counts) AND an Activity segment AND a conversation_ref
 * search — combinable. Server sort (pending-first, recent) is preserved.
 */
export function ConversationGrid({
  clientId,
  initial,
  endpoint,
}: {
  clientId: string;
  initial: GridPayload;
  endpoint: string;
}) {
  const [data, setData] = useState<GridPayload>(initial);
  const [stale, setStale] = useState(false);
  const [mode, setMode] = useState<InboxFilter>("all");
  const [activity, setActivity] = useState<ActivitySegment>("all");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(endpoint, { cache: "no-store" });
      if (!res.ok) {
        setStale(true);
        return;
      }
      setData(await res.json());
      setStale(false);
    } catch {
      setStale(true);
    }
  }, [endpoint]);

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

  const now = new Date(data.asOf);
  const all = data.conversations;

  // Live mode counts from the full payload (independent of the active/search filters,
  // so the chip numbers reflect the whole workflow).
  const counts = useMemo(() => {
    const c = { all: all.length, pending: 0, human: 0, bot: 0 };
    for (const v of all) c[v.mode] += 1;
    return c;
  }, [all]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all.filter((v) => {
      if (mode !== "all" && v.mode !== mode) return false;
      if (activity === "active" && !v.active) return false;
      if (activity === "inactive" && v.active) return false;
      if (needle && !v.conversationRef.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [all, mode, activity, search]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {/* Mode chips with live counts */}
        <div className="flex flex-wrap items-center gap-2">
          {INBOX_FILTERS.map((f) => {
            const active = mode === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setMode(f.key)}
                aria-pressed={active}
                className={`rounded-full px-3 py-1 text-sm transition-colors ${
                  active
                    ? "bg-foreground text-background"
                    : "border border-black/10 text-muted hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
                }`}
              >
                {f.label} <span className="tabular-nums opacity-70">{counts[f.key]}</span>
              </button>
            );
          })}
          {stale ? <span className="text-xs text-faint">Reconnecting…</span> : null}
        </div>

        {/* Activity segment + search */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex overflow-hidden rounded-lg border border-black/10 text-sm dark:border-line-strong">
            {ACTIVITY_SEGMENTS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setActivity(s.key)}
                aria-pressed={activity === s.key}
                className={`px-3 py-1 transition-colors ${
                  activity === s.key
                    ? "bg-foreground text-background"
                    : "text-muted hover:bg-black/[0.04] dark:hover:bg-subtle"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search number…"
            className="w-full max-w-xs rounded-lg border border-line bg-transparent px-3 py-1.5 text-sm outline-none focus:border-line-strong"
          />
        </div>
      </div>

      {all.length === 0 ? (
        <EmptyState firstRun />
      ) : visible.length === 0 ? (
        <EmptyState mode={mode} activity={activity} search={search} />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {visible.map((v) => (
            <ConversationCard
              key={v.id}
              view={v}
              href={`/clients/${encodeURIComponent(clientId)}/workflows/${encodeURIComponent(v.workflowId)}/inbox/${encodeURIComponent(v.id)}`}
              now={now}
              activityWindowHours={data.activityWindowHours}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({
  firstRun,
  mode,
  activity,
  search,
}: {
  firstRun?: boolean;
  mode?: InboxFilter;
  activity?: ActivitySegment;
  search?: string;
}) {
  let message: string;
  if (firstRun) {
    message =
      "No conversations yet. When this workflow posts messages or an agent takes one over, they'll appear here.";
  } else if (search && search.trim()) {
    message = `No conversations match “${search.trim()}”.`;
  } else {
    const parts: string[] = [];
    if (activity && activity !== "all") parts.push(activity);
    if (mode && mode !== "all") parts.push(mode);
    const label = parts.length ? parts.join(" ") : "matching";
    message = `No ${label} conversations right now.`;
  }
  return (
    <div className="rounded-2xl border border-dashed border-line px-6 py-12 text-center">
      <p className="text-sm font-medium text-muted">Inbox</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-faint">{message}</p>
    </div>
  );
}
