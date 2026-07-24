"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
 * The conversation GRID — the shared conversations surface for BOTH a single
 * handoff-active workflow AND the client-level UNIFIED inbox (Phase 4A). Server-
 * rendered once, then light-polls `endpoint` every ~5s (visibility-paused). ALL
 * filtering is client-side over the loaded page: mode chips (with live counts), an
 * Activity segment, a conversation_ref search, and — when `workflows` is provided
 * (the client-level tray) — a workflow filter. Combinable; server sort preserved.
 *
 * `settingsHref` is optional (the client tray has no single per-workflow settings).
 * `conversationRoute` picks the drawer deep-link SHAPE (a serializable string, never
 * a function — server pages can't pass callbacks to a client component): "client" →
 * /clients/{c}/inbox?c=…; "workflow" (default) → the workflow-scoped route.
 */
export function ConversationGrid({
  clientId,
  initial,
  endpoint,
  settingsHref,
  workflows,
  conversationRoute = "workflow",
}: {
  clientId: string;
  initial: GridPayload;
  endpoint: string;
  settingsHref?: string;
  /** When given (client tray), renders a workflow filter dropdown. */
  workflows?: Array<{ id: string; name: string | null }>;
  /** Which ?c= drawer deep-link to build (serializable — no callback crosses the RSC
   * boundary): "client" (the unified tray) or "workflow" (per-workflow inbox, default). */
  conversationRoute?: "client" | "workflow";
}) {
  const [data, setData] = useState<GridPayload>(initial);
  const [stale, setStale] = useState(false);
  const [mode, setMode] = useState<InboxFilter>("all");
  const [activity, setActivity] = useState<ActivitySegment>("all");
  const [search, setSearch] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState<string>("all");

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
      if (workflowFilter !== "all" && v.workflowId !== workflowFilter) return false;
      if (needle && !v.conversationRef.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [all, mode, activity, search, workflowFilter]);

  return (
    <div className="flex flex-col gap-4">
      {/* ONE coherent toolbar row (H-8): [mode chips] [activity segment] ····· [search]
          [settings]. Consistent control height; wraps gracefully (the search+settings
          group drops to its own row on narrow widths via ml-auto + flex-wrap). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {INBOX_FILTERS.map((f) => {
            const active = mode === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setMode(f.key)}
                aria-pressed={active}
                className={`h-8 rounded-full px-3 text-sm transition-colors ${
                  active
                    ? "bg-foreground text-background"
                    : "border border-black/10 text-muted hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
                }`}
              >
                {f.label} <span className="tabular-nums opacity-70">{counts[f.key]}</span>
              </button>
            );
          })}
        </div>

        <div className="inline-flex h-8 overflow-hidden rounded-lg border border-black/10 text-sm dark:border-line-strong">
          {ACTIVITY_SEGMENTS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setActivity(s.key)}
              aria-pressed={activity === s.key}
              className={`px-3 transition-colors ${
                activity === s.key
                  ? "bg-foreground text-background"
                  : "text-muted hover:bg-black/[0.04] dark:hover:bg-subtle"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Client-tray only: filter by workflow (no full reload — client-side). */}
        {workflows && workflows.length > 0 ? (
          <select
            value={workflowFilter}
            onChange={(e) => setWorkflowFilter(e.target.value)}
            aria-label="Filter by workflow"
            className="h-8 rounded-lg border border-black/10 bg-transparent px-2 text-sm text-muted dark:border-line-strong"
          >
            <option value="all">All workflows</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name ?? w.id}
              </option>
            ))}
          </select>
        ) : null}

        {stale ? <span className="text-xs text-faint">Reconnecting…</span> : null}

        <div className="ml-auto flex items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search number…"
            className="h-8 w-[240px] max-w-[55vw] rounded-lg border border-line bg-transparent px-3 text-sm outline-none focus:border-line-strong"
          />
          {settingsHref ? (
            <Link
              href={settingsHref}
              className="flex h-8 shrink-0 items-center rounded-lg border border-black/10 px-3 text-sm text-muted transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-line-strong dark:hover:bg-subtle"
            >
              ⚙ Settings
            </Link>
          ) : null}
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
              // Open the drawer via ?c= (same route — no full navigation; grid stays
              // live). "client" → the unified tray; "workflow" → the per-workflow inbox.
              // Every dynamic segment is encodeURIComponent'd.
              href={
                conversationRoute === "client"
                  ? `/clients/${encodeURIComponent(clientId)}/inbox?c=${encodeURIComponent(v.id)}`
                  : `/clients/${encodeURIComponent(clientId)}/workflows/${encodeURIComponent(v.workflowId)}/inbox?c=${encodeURIComponent(v.id)}`
              }
              now={now}
              activityWindowHours={data.activityWindowHours}
              // Label each card with its workflow only in the unified client tray.
              showWorkflow={Boolean(workflows)}
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
