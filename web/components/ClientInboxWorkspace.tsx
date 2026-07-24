"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { InboxThread } from "./InboxThread";
import { CustomerDetailsPanel } from "./CustomerDetailsPanel";
import { formatAgeShort } from "@/lib/format";
import {
  conversationPreview,
  type HistoryTurnView,
  type InboxConversationView,
  type InboxHeaderView,
  type InboxMessageView,
} from "@/lib/inboxView";
import { groupConversations, pendingCount, type InboxGroupMeta } from "@/lib/inboxGroups";

interface GridPayload {
  conversations: InboxConversationView[];
  activityWindowHours: number;
  asOf: string;
}
interface ThreadPayload {
  header: InboxHeaderView;
  messages: InboxMessageView[];
  history?: HistoryTurnView[];
  activityWindowHours: number;
  asOf: string;
}

const POLL_MS = 5000;

/**
 * The unified client inbox as a THREE-COLUMN operative workspace (WhatsApp-Web-like):
 *   LEFT   — grouped conversation list (Needs human attention / Human / Bot), search,
 *            workflow filter, pending counter. Light-polls `endpoint` (visibility-
 *            paused), exactly like the old grid.
 *   CENTER — the live chat (reuses <InboxThread/>: header, real handoff actions,
 *            composer if available, ~4s poll, near-bottom autoscroll). Empty state
 *            when nothing is selected.
 *   RIGHT  — customer details (real payload fields only), collapsible on desktop,
 *            a slide-over drawer on tablet/mobile.
 *
 * Selection is the EXISTING `?c=<id>` query param (deep-links preserved); selecting a
 * row is a same-route Link that only sets `c`, so the client-side workflow filter +
 * search survive. All props are serializable — no function crosses from the server
 * page into this client component.
 */
export function ClientInboxWorkspace({
  clientId,
  clientName,
  initial,
  endpoint,
  workflows,
  viewerUserId,
  viewerName,
  viewerIsFullAccess,
}: {
  clientId: string;
  clientName: string;
  initial: GridPayload;
  endpoint: string;
  workflows: Array<{ id: string; name: string | null }>;
  viewerUserId: string;
  viewerName: string | null;
  viewerIsFullAccess: boolean;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selectedId = searchParams.get("c");

  // ── List state + polling (same contract as the old grid) ──
  const [data, setData] = useState<GridPayload>(initial);
  const [stale, setStale] = useState(false);
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

  // Search over the REAL fields: identifier (ref / phone), last message content, workflow.
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all.filter((v) => {
      if (workflowFilter !== "all" && v.workflowId !== workflowFilter) return false;
      if (!needle) return true;
      return (
        v.conversationRef.toLowerCase().includes(needle) ||
        (v.lastMessageText ?? "").toLowerCase().includes(needle) ||
        (v.workflowName ?? "").toLowerCase().includes(needle)
      );
    });
  }, [all, search, workflowFilter]);

  const groups = useMemo(() => groupConversations(filtered), [filtered]);
  const pending = pendingCount(all);
  const selectedView = selectedId ? all.find((v) => v.id === selectedId) ?? null : null;

  // ── Selection helpers (preserve every other query param) ──
  const hrefFor = useCallback(
    (id: string) => {
      const p = new URLSearchParams(searchParams.toString());
      p.set("c", id);
      return `${pathname}?${p.toString()}`;
    },
    [searchParams, pathname],
  );
  const close = useCallback(() => {
    const p = new URLSearchParams(searchParams.toString());
    p.delete("c");
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

  // ── Center: thread payload for the selected conversation (same fetch as the drawer) ──
  const [thread, setThread] = useState<ThreadPayload | null>(null);
  const [threadError, setThreadError] = useState(false);
  useEffect(() => {
    if (!selectedId) {
      // Reset the thread state when the selection clears (intentional sync reset of
      // this fetch effect's own state; the real load below is async, after await).
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setThread(null);
      setThreadError(false);
      return;
    }
    let cancelled = false;
    setThreadError(false);
    void (async () => {
      try {
        const res = await fetch(`/api/inbox/${clientId}/conversations/${selectedId}/messages?history=1`, {
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setThreadError(true);
          return;
        }
        const p = (await res.json()) as ThreadPayload;
        if (!cancelled) setThread(p);
      } catch {
        if (!cancelled) setThreadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, clientId]);

  // ── Details panel: inline (desktop) collapse + mobile/tablet drawer ──
  const [detailsInline, setDetailsInline] = useState(true);
  const [detailsDrawer, setDetailsDrawer] = useState(false);
  useEffect(() => {
    if (!detailsDrawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailsDrawer(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [detailsDrawer]);
  // The drawer only ever renders while a conversation is selected (see the render
  // guard below), so no effect is needed to dismiss it when the selection clears.

  const detailsToggle = (
    <>
      {/* Desktop: collapse/expand the inline column. */}
      <button
        type="button"
        onClick={() => setDetailsInline((o) => !o)}
        aria-label={detailsInline ? "Hide customer details" : "Show customer details"}
        aria-pressed={detailsInline}
        className="hidden rounded-lg border border-black/10 px-2 py-1 text-xs text-muted transition-colors hover:bg-black/[0.04] hover:text-foreground xl:inline-flex dark:border-line-strong dark:hover:bg-subtle"
      >
        Details
      </button>
      {/* Tablet/mobile: open the details drawer. */}
      <button
        type="button"
        onClick={() => setDetailsDrawer(true)}
        aria-label="Show customer details"
        className="inline-flex rounded-lg border border-black/10 px-2 py-1 text-xs text-muted transition-colors hover:bg-black/[0.04] hover:text-foreground xl:hidden dark:border-line-strong dark:hover:bg-subtle"
      >
        Details
      </button>
    </>
  );

  return (
    <div className="flex min-h-0 flex-1">
      {/* ── LEFT — conversation list ── */}
      <aside
        aria-label="Conversations"
        className={`min-h-0 w-full shrink-0 flex-col border-r border-line lg:flex lg:w-[320px] ${
          selectedId ? "hidden lg:flex" : "flex"
        }`}
      >
        <div className="flex shrink-0 flex-col gap-2 border-b border-line px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-semibold tracking-tight">Inbox</h1>
            <span
              className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 tabular-nums dark:text-amber-400"
              title="Conversations awaiting a human"
            >
              {pending} pending
            </span>
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, number, or message…"
            aria-label="Search conversations"
            className="h-9 w-full rounded-lg border border-line bg-transparent px-3 text-sm outline-none focus:border-line-strong"
          />
          {workflows.length > 0 ? (
            <select
              value={workflowFilter}
              onChange={(e) => setWorkflowFilter(e.target.value)}
              aria-label="Filter by workflow"
              className="h-9 w-full rounded-lg border border-black/10 bg-transparent px-2 text-sm text-muted dark:border-line-strong"
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
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {all.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-faint">
              No conversations yet. They appear here when a workflow posts messages or an agent takes one over.
            </p>
          ) : groups.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-faint">No conversations match your filters.</p>
          ) : (
            groups.map((g) => (
              <div key={g.key} role="group" aria-label={g.meta.label}>
                <div className="flex items-center gap-2 px-4 pb-1 pt-3">
                  <GroupDot tone={g.meta.tone} />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">{g.meta.label}</span>
                  <span className="text-[11px] tabular-nums text-faint">{g.items.length}</span>
                </div>
                <ul>
                  {g.items.map((v) => (
                    <li key={v.id}>
                      <ConversationRow
                        view={v}
                        href={hrefFor(v.id)}
                        selected={v.id === selectedId}
                        now={now}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ── CENTER — chat ── */}
      <section
        aria-label="Conversation"
        className={`min-h-0 flex-1 flex-col ${selectedId ? "flex" : "hidden lg:flex"}`}
      >
        {!selectedId ? (
          <EmptyChat />
        ) : threadError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-muted">This conversation isn&rsquo;t available.</p>
            <button
              type="button"
              onClick={close}
              className="rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
            >
              Close
            </button>
          </div>
        ) : thread ? (
          <InboxThread
            key={thread.header.id}
            clientId={clientId}
            initial={thread}
            viewerUserId={viewerUserId}
            viewerName={viewerName}
            viewerIsFullAccess={viewerIsFullAccess}
            onClose={close}
            onBack={close}
            headerExtra={detailsToggle}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-faint">Loading…</div>
        )}
      </section>

      {/* ── RIGHT — customer details (inline on xl) ── */}
      {selectedId && selectedView && detailsInline ? (
        <aside aria-label="Customer details" className="hidden w-[300px] shrink-0 flex-col border-l border-line xl:flex">
          <CustomerDetailsPanel
            view={selectedView}
            clientName={clientName}
            activityWindowHours={data.activityWindowHours}
            now={now}
            onClose={() => setDetailsInline(false)}
          />
        </aside>
      ) : null}

      {/* ── RIGHT (tablet/mobile) — customer details drawer ── */}
      {selectedId && selectedView && detailsDrawer ? (
        <div className="xl:hidden">
          <button
            type="button"
            aria-label="Close customer details"
            onClick={() => setDetailsDrawer(false)}
            className="fixed inset-0 z-40 bg-black/40"
          />
          <aside
            aria-label="Customer details"
            className="fixed inset-y-0 right-0 z-50 flex w-[300px] max-w-[85vw] flex-col border-l border-line bg-background shadow-xl"
          >
            <CustomerDetailsPanel
              view={selectedView}
              clientName={clientName}
              activityWindowHours={data.activityWindowHours}
              now={now}
              onClose={() => setDetailsDrawer(false)}
            />
          </aside>
        </div>
      ) : null}
    </div>
  );
}

/** A colored+shaped status dot for a group header (color is NOT the only signal — it
 * sits beside the group's text label). */
function GroupDot({ tone }: { tone: InboxGroupMeta["tone"] }) {
  const cls =
    tone === "attention"
      ? "bg-amber-500"
      : tone === "human"
        ? "bg-emerald-500"
        : "bg-neutral-400 dark:bg-neutral-500";
  return <span aria-hidden className={`size-2 shrink-0 rounded-full ${cls}`} />;
}

function relTime(iso: string, now: Date): string {
  const r = formatAgeShort(new Date(iso), now);
  return r === "now" ? "now" : `${r}`;
}

function ConversationRow({
  view,
  href,
  selected,
  now,
}: {
  view: InboxConversationView;
  href: string;
  selected: boolean;
  now: Date;
}) {
  const initial = (view.conversationRef.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
  const stateLabel =
    view.mode === "pending" ? "Needs attention" : view.mode === "human" ? "Human" : "Bot";
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={selected ? "page" : undefined}
      aria-label={`${view.conversationRef} — ${stateLabel}`}
      className={`flex items-center gap-3 border-b border-line/60 px-4 py-3 transition-colors ${
        selected ? "bg-subtle" : "hover:bg-black/[0.03] dark:hover:bg-card"
      }`}
    >
      <span
        aria-hidden
        className={`relative flex size-9 shrink-0 items-center justify-center rounded-full border text-sm font-semibold ${
          view.mode === "pending"
            ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
            : view.mode === "human"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "border-line-strong bg-subtle text-foreground"
        }`}
      >
        {initial}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">{view.conversationRef}</span>
          {view.lastMessageAt ? (
            <span className="shrink-0 text-[11px] text-faint">{relTime(view.lastMessageAt, now)}</span>
          ) : null}
        </span>
        <span className="truncate text-xs text-muted">{conversationPreview(view)}</span>
        {view.workflowName ? (
          <span className="mt-0.5 w-fit max-w-full truncate rounded bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-faint">
            {view.workflowName}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function EmptyChat() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <span aria-hidden className="text-3xl opacity-40">💬</span>
      <p className="text-sm font-medium text-muted">Select a conversation</p>
      <p className="max-w-xs text-sm text-faint">
        Pick a conversation from the list to read the thread and take action.
      </p>
    </div>
  );
}
