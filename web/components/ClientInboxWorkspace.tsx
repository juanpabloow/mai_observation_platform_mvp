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
import { scopeHref } from "@/lib/scopeSurface";

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
  initial,
  scope,
  workflowHandoffActive,
  viewerUserId,
  viewerName,
  viewerIsFullAccess,
}: {
  clientId: string;
  initial: GridPayload;
  /** The active workflow scope (W-1/W-2): 'all' or a workflow id. Resolved by the page
   *  (URL ?workflow= else cookie); this component is keyed by it, so a change remounts
   *  it with the already-scoped initial payload. */
  scope: "all" | string;
  /** Only meaningful when `scope` is a workflow AND the initial list is empty (H-6): is
   *  the workflow set up for handoff (a registered webhook or any handoff messages)?
   *  Drives the "not set up yet" vs "no conversations yet" empty state. null at 'all'. */
  workflowHandoffActive: boolean | null;
  viewerUserId: string;
  viewerName: string | null;
  viewerIsFullAccess: boolean;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selectedId = searchParams.get("c");
  const showWorkflow = scope === "all"; // per-row workflow chip only makes sense in 'all'

  // ── List state + polling. The poll mirrors the active scope (?workflow=) so its
  // groups/counts stay consistent with the server-scoped initial payload. ──
  const endpoint =
    scope === "all"
      ? `/api/inbox/${encodeURIComponent(clientId)}/conversations`
      : `/api/inbox/${encodeURIComponent(clientId)}/conversations?workflow=${encodeURIComponent(scope)}`;
  const [data, setData] = useState<GridPayload>(initial);
  const [stale, setStale] = useState(false);
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

  // The list is already workflow-scoped at the data layer; here only the keyword search
  // narrows it (identifier / last message / workflow name).
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (v) =>
        v.conversationRef.toLowerCase().includes(needle) ||
        (v.lastMessageText ?? "").toLowerCase().includes(needle) ||
        (v.workflowName ?? "").toLowerCase().includes(needle),
    );
  }, [all, search]);

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

  // W-2: if a conversation is open but falls OUTSIDE the active workflow scope, close
  // the pane cleanly (empty state) — the scoped list wouldn't contain it, so we never
  // render a conversation from another workflow. 'all' never closes.
  useEffect(() => {
    if (scope === "all" || !selectedId) return;
    if (!all.some((v) => v.id === selectedId)) close();
  }, [scope, selectedId, all, close]);

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
        className="hidden h-8 items-center rounded-md border border-line-strong px-2 text-xs text-muted transition-colors hover:bg-subtle hover:text-foreground xl:inline-flex"
      >
        Details
      </button>
      {/* Tablet/mobile: open the details drawer. */}
      <button
        type="button"
        onClick={() => setDetailsDrawer(true)}
        aria-label="Show customer details"
        className="inline-flex h-8 items-center rounded-md border border-line-strong px-2 text-xs text-muted transition-colors hover:bg-subtle hover:text-foreground xl:hidden"
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
        // Desktop queue: 350–390px so the ref + preview + stamp fit without wrapping,
        // and the CENTER column keeps the rest (no dead space beside a thread).
        className={`min-h-0 w-full shrink-0 flex-col border-r border-line lg:flex lg:w-[360px] xl:w-[380px] ${
          selectedId ? "hidden lg:flex" : "flex"
        }`}
      >
        {/* h-14 title strip — the SAME height as the thread header, the customer
            panel header and the app header, so all four line up across the seams. */}
        <div className="flex flex-col border-b border-line">
          <div className="flex h-[var(--topbar-height)] shrink-0 items-center justify-between gap-2 px-3">
            <h1 className="text-sm font-semibold tracking-tight text-foreground">Inbox</h1>
            {/* The pending counter is the REAL count over the scoped list — the same
                number the sidebar badge polls. Amber = needs attention (not an error). */}
            <span
              className={`u-mono rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ${
                pending > 0 ? "bg-warn-soft text-warn" : "text-faint"
              }`}
              title="Conversations awaiting a human"
            >
              {pending} pending
            </span>
          </div>
          <div className="flex shrink-0 flex-col gap-1 px-3 pb-3">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, number, or message…"
              aria-label="Search conversations"
              className="h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-foreground outline-none placeholder:text-faint focus:border-brand"
            />
            {/* No in-panel workflow selector (W-2): the header switcher is the single
                workflow selector; this list follows the active scope. */}
            {stale ? <span className="u-mono text-[0.6875rem] text-faint">Reconnecting…</span> : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {all.length === 0 ? (
            scope !== "all" && workflowHandoffActive === false ? (
              <WorkflowNotSetUp
                settingsHref={viewerIsFullAccess ? scopeHref(clientId, "settings", scope) : null}
              />
            ) : (
              <p className="px-4 py-10 text-center text-sm text-faint">
                No conversations yet. They appear here when a workflow posts messages or an agent takes one over.
              </p>
            )
          ) : groups.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-faint">No conversations match your filters.</p>
          ) : (
            groups.map((g) => (
              <div key={g.key} role="group" aria-label={g.meta.label}>
                {/* Sticky group header so the queue stays legible while scrolling. */}
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line/60 bg-background/95 px-3 py-1.5 backdrop-blur-none">
                  <GroupDot tone={g.meta.tone} />
                  <span className="u-th">{g.meta.label}</span>
                  <span className="u-mono ml-auto text-[0.6875rem] text-faint">{g.items.length}</span>
                </div>
                <ul>
                  {g.items.map((v) => (
                    <li key={v.id}>
                      <ConversationRow
                        view={v}
                        href={hrefFor(v.id)}
                        selected={v.id === selectedId}
                        now={now}
                        showWorkflow={showWorkflow}
                        activityWindowHours={data.activityWindowHours}
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
        // min-w-0 is what actually stops the thread from being squeezed by a long
        // unbroken message and leaving dead space beside the queue.
        className={`min-h-0 min-w-0 flex-1 flex-col ${selectedId ? "flex" : "hidden lg:flex"}`}
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
        <aside aria-label="Customer details" className="hidden w-[320px] shrink-0 flex-col border-l border-line xl:flex 2xl:w-[340px]">
          <CustomerDetailsPanel
            key={selectedView.id}
            clientId={clientId}
            conversationId={selectedView.id}
            conversationRef={selectedView.conversationRef}
            viewerUserId={viewerUserId}
            viewerIsFullAccess={viewerIsFullAccess}
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
            className="fixed inset-y-0 right-0 z-50 flex w-[320px] max-w-[85vw] flex-col border-l border-line-strong bg-surface"
          >
            <CustomerDetailsPanel
              key={selectedView.id}
              clientId={clientId}
              conversationId={selectedView.id}
              conversationRef={selectedView.conversationRef}
              viewerUserId={viewerUserId}
              viewerIsFullAccess={viewerIsFullAccess}
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
  const cls = tone === "attention" ? "bg-warn-rule" : tone === "human" ? "bg-success" : "bg-faint";
  return <span aria-hidden className={`size-2 shrink-0 rounded-full ${cls}`} />;
}

function relTime(iso: string, now: Date): string {
  const r = formatAgeShort(new Date(iso), now);
  return r === "now" ? "now" : `${r}`;
}

/**
 * Activity dot (H-7 dimension ported into the dense row): a filled emerald dot when the
 * customer wrote within the activity window, a hollow muted ring when not. A DOT (not a
 * text pill) is the compact choice the spec sanctions — the row already carries an
 * avatar, ref, timestamp, preview and (in 'all') a workflow chip, so a labeled pill
 * would crowd it; the color + tooltip carry the state, readable in both themes.
 */
function ActivityDot({ active, windowHours }: { active: boolean; windowHours: number }) {
  return active ? (
    <span
      title={`Active — the customer wrote within the last ${windowHours}h`}
      aria-label="Active"
      className="size-1.5 shrink-0 rounded-full bg-emerald-500"
    />
  ) : (
    <span
      title={`Inactive — no customer message in the last ${windowHours}h`}
      aria-label="Inactive"
      className="size-1.5 shrink-0 rounded-full border border-line-strong"
    />
  );
}

function ConversationRow({
  view,
  href,
  selected,
  now,
  showWorkflow,
  activityWindowHours,
}: {
  view: InboxConversationView;
  href: string;
  selected: boolean;
  now: Date;
  showWorkflow: boolean;
  activityWindowHours: number;
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
      // SELECTED = soft brand fill + a 2px LEFT RULE; a row still awaiting a human
      // keeps the amber rule so urgency survives even while another row is selected.
      className={`relative flex min-h-[56px] items-center gap-3 border-b border-line/60 px-3 py-2.5 transition-colors ${
        selected ? "u-row-selected" : view.mode === "pending" ? "u-row-overdue" : "hover:bg-subtle"
      }`}
    >
      <span
        aria-hidden
        className={`relative flex size-9 shrink-0 items-center justify-center rounded-full border text-sm font-semibold ${
          view.mode === "pending"
            ? "border-warn/40 bg-warn-soft text-warn"
            : view.mode === "human"
              ? "border-success/40 bg-success/10 text-success"
              : "border-line-strong bg-subtle text-foreground"
        }`}
      >
        {initial}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center justify-between gap-2">
          <span className="u-mono truncate text-[0.8125rem] font-semibold text-foreground">{view.conversationRef}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <ActivityDot active={view.active} windowHours={activityWindowHours} />
            {view.lastMessageAt ? (
              <span className="u-mono text-[0.6875rem] text-faint">{relTime(view.lastMessageAt, now)}</span>
            ) : null}
          </span>
        </span>
        <span className="truncate text-xs text-muted">{conversationPreview(view)}</span>
        {showWorkflow && view.workflowName ? (
          <span className="u-mono mt-0.5 w-fit max-w-full truncate rounded border border-line px-1.5 py-0.5 text-[0.625rem] text-faint">
            {view.workflowName}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

/**
 * Empty list when a scoped workflow isn't handoff-active yet (H-6). Explains what
 * connecting handoff unlocks; the settings link is owner/admin only (members get the
 * text but no link — the settings page refuses them server-side anyway).
 */
function WorkflowNotSetUp({ settingsHref }: { settingsHref: string | null }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <p className="text-sm font-medium text-muted">This workflow isn&rsquo;t set up for handoff yet.</p>
      <p className="max-w-xs text-sm text-faint">
        Connect it for handoff so your team can see and reply to its conversations here.
      </p>
      {settingsHref ? (
        <Link
          href={settingsHref}
          className="mt-1 rounded-lg border border-line px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-subtle"
        >
          Open workflow settings
        </Link>
      ) : null}
    </div>
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
