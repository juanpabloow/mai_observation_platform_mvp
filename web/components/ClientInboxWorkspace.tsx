"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { InboxThread } from "./InboxThread";
import { CustomerDetailsPanel } from "./CustomerDetailsPanel";
import { PageShell } from "@/components/ui/PageShell";
import { OVERLAY_SCRIM, useTrappedPanel } from "@/components/ui/Overlay";
import { PageTitle } from "@/components/ui/PageTitle";
import { avatarColor } from "@/lib/avatarColor";
import { SEARCH_SHELL_CLS } from "@/components/ui/primitives";
import { formatAgeShort } from "@/lib/format";
import {
  conversationAvatarLabel,
  conversationPreview,
  formatConversationRef,
  type HistoryTurnView,
  type InboxConversationView,
  type InboxHeaderView,
  type InboxMessageView,
  type ThreadEventView,
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
  events?: ThreadEventView[];
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
        // also match what the row actually SHOWS, so typing "+57 304" finds the
        // row whose stored ref is the bare "573043906303".
        formatConversationRef(v.conversationRef).toLowerCase().includes(needle) ||
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
  /*
   * The client card starts CLOSED, on every width.
   *
   * It used to default open on xl+, which meant opening a conversation immediately spent
   * ~340px on a panel nobody had asked for — and the thread, the thing you came to read,
   * got whatever was left. The panel is an answer to "who is this?", which is a question
   * you ask sometimes; the thread is why the screen exists.
   *
   * `Detalles` opens it and the state persists for the session, so someone who works with
   * it open pays one click, once. It is deliberately NOT remembered in a cookie: that
   * would quietly reintroduce "opens by default" for exactly the people who hit this.
   */
  const [detailsInline, setDetailsInline] = useState(false);
  const [detailsDrawer, setDetailsDrawer] = useState(false);
  // The mobile customer panel is an overlay, so it gets the shared overlay contract.
  const customerDrawerRef = useTrappedPanel({
    active: detailsDrawer,
    onClose: () => setDetailsDrawer(false),
  });
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
        aria-label={detailsInline ? "Ocultar los datos del cliente" : "Ver los datos del cliente"}
        aria-pressed={detailsInline}
        // `aria-pressed` carries the open/closed state, so the LABEL stays constant — a
        // button whose text flips between "Ver" and "Ocultar" makes a screen reader
        // announce the action twice and reads as two different controls.
        className={`hidden h-8 items-center rounded-md border px-2.5 text-xs transition-colors xl:inline-flex ${
          detailsInline
            ? "border-ink text-foreground"
            : "border-line-strong text-muted hover:border-faint hover:text-foreground"
        }`}
      >
        Detalles
      </button>
      {/* Tablet/mobile: open the details drawer. */}
      <button
        type="button"
        onClick={() => setDetailsDrawer(true)}
        aria-label="Ver los datos del cliente"
        className="inline-flex h-8 items-center rounded-md border border-line-strong px-2.5 text-xs text-muted transition-colors hover:border-faint hover:text-foreground xl:hidden"
      >
        Detalles
      </button>
    </>
  );

  return (
    // ONE floating card holds all three panes (the SHARED page shell — the same
    // component Contacts and the Agenda render into). The panes are separated by the
    // card's own 1px hairlines, never by a strip of canvas showing between them:
    // before this, the workspace root was a bare flex box with no fill, so the grey
    // canvas painted straight through the middle of the screen and no section had a
    // visible edge.
    <PageShell as="main" row ariaLabel="Inbox">
      {/* ── LEFT — conversation list ── */}
      <aside
        aria-label="Conversations"
        // Desktop queue: ~320-380px so the ref + preview + stamp fit without wrapping,
        // and the CENTER column keeps the rest (no dead space beside a thread). The
        // column is WHITE like the rest of the card and separated by one hairline —
        // the tint belongs to the SELECTED ROW, not to the whole column.
        // 280/300px, down from 336/360. The queue is scanned, not read: a row shows a
        // name, a one-line preview and a flow, and none of those needed 360px — the
        // preview truncates at any width, so the extra pixels bought a longer fragment of
        // a sentence you are going to open anyway. The thread is where the width belongs.
        className={`min-h-0 w-full shrink-0 border-r border-line lg:flex lg:w-[280px] xl:w-[300px] ${
          selectedId ? "hidden lg:flex" : "flex"
        }`}
      >
        <div className="flex min-h-0 w-full flex-col overflow-hidden">
        {/* The queue owns the screen's title. The Inbox is THREE panes, not one list,
            so the title belongs to the column it names rather than to a band across
            all three — but it renders through the SAME <PageTitle/> as Customers and
            the Agenda, so the three screens agree on what a title looks like. */}
        <div className="flex flex-col border-b border-line">
          <div className="flex h-[var(--topbar-height)] shrink-0 items-center px-3">
            <PageTitle
              title="Inbox"
              context={
                // Plain sentence case, per the design (§3.1) — a mono uppercase badge on
                // the pane's own title read as a status chip rather than as a count. It
                // still goes brand-red when it is non-zero, because "someone is waiting"
                // is one of the three things red is for.
                <span
                  className={`text-[0.6875rem] ${pending > 0 ? "font-medium text-brand" : "text-faint"}`}
                  title="Conversaciones esperando a una persona"
                >
                  {pending} {pending === 1 ? "te necesita" : "te necesitan"}
                </span>
              }
            />
          </div>
          <div className="flex shrink-0 flex-col gap-1 px-3 pb-3">
            {/* Search sits in a bordered shell with the glass inside it, so the icon
                can't be mistaken for a control — it's the field's own affordance. */}
            {/* The SHARED search shell — the queue and the two list screens are one
                object (§3.1), so the treatment lives in primitives, not here. */}
            <div className={SEARCH_SHELL_CLS}>
              <SearchIcon />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar nombre, número o mensaje…"
                aria-label="Buscar conversaciones"
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
              />
              {/* TODO(inbox): the design puts a FILTER control at the right of the
                  search field, but this list has no facets to open: the only scope
                  that exists is the workflow, and that selector lives in the app
                  header (W-2, deliberately not duplicated here). It renders disabled
                  and says so on hover rather than opening an empty menu — wire it up
                  when the list gains real facets (channel / intent / assignee). */}
              <button
                type="button"
                disabled
                title="No list filters yet — the workflow scope lives in the header switcher"
                aria-label="Filter conversations"
                className="-mr-1 inline-flex size-7 shrink-0 cursor-not-allowed items-center justify-center rounded-md text-faint"
              >
                <FilterIcon />
              </button>
            </div>
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
            // TODO(inbox): the design's third lane, "CLOSED TODAY", has no state
            //   behind it — `conversations.mode` is DB-constrained to bot|pending|human
            //   and resolving a conversation sets it back to `bot` (see lib/inboxGroups.ts),
            //   so a closed conversation is indistinguishable from a bot-handled one.
            //   The lane (and its count) would be fabricated, so it is NOT rendered.
            //   Needs a `closed_at` / terminal state on the conversation first.
            groups.map((g) => (
              <div key={g.key} role="group" aria-label={g.meta.label}>
                {/* Sticky group header so the queue stays legible while scrolling. */}
                {/* Sticky lane header, on the queue's own tinted ground so rows slide
                    under it without a colour seam. */}
                <div className="sticky top-0 z-10 flex items-center gap-2 bg-surface px-3.5 pb-2 pt-3.5">
                  <GroupDot tone={g.meta.tone} />
                  {/* Sentence case at 590 — the lane label is a heading, and mono
                      uppercase made three of them read as a stack of status codes. */}
                  <span className="text-[0.6875rem] font-semibold text-muted">{g.meta.label}</span>
                  <span className="ml-auto text-[0.6875rem] text-faint">{g.items.length}</span>
                </div>
                <ul>
                  {g.items.map((v) => (
                    <li key={v.id}>
                      <ConversationRow
                        view={v}
                        href={hrefFor(v.id)}
                        selected={v.id === selectedId}
                        now={now}
                        activityWindowHours={data.activityWindowHours}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
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
              className="inline-flex h-8 items-center rounded-md border border-line-strong px-3 text-sm transition-colors hover:bg-hover"
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
        // Same overlay contract as the staff drawer: scrim, tap-to-close, Escape and a
        // focus trap. The scrim was already here; Escape and the trap were not, so a
        // keyboard reader could tab straight out into the thread behind it.
        <div className="xl:hidden">
          <button
            type="button"
            aria-label="Close customer details"
            onClick={() => setDetailsDrawer(false)}
            className={OVERLAY_SCRIM}
          />
          <aside
            ref={customerDrawerRef as React.RefObject<HTMLElement>}
            aria-label="Customer details"
            role="dialog"
            aria-modal
            tabIndex={-1}
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
    </PageShell>
  );
}

/** A colored+shaped status dot for a group header (color is NOT the only signal — it
 * sits beside the group's text label). */
function GroupDot({ tone }: { tone: InboxGroupMeta["tone"] }) {
  // The live lanes carry a filled dot; the bot lane a hollow ring, so the queue
  // reads as "someone is on it" vs "nobody is" before any colour is perceived.
  if (tone === "bot") return <span aria-hidden className="size-2 shrink-0 rounded-full border border-line-strong" />;
  const cls = tone === "attention" ? "bg-brand" : "bg-success";
  return <span aria-hidden className={`size-2 shrink-0 rounded-full ${cls}`} />;
}

/** Funnel — the search shell's filter affordance (see the TODO at its call site). */
function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
      <path
        d="M4 6h16l-6.2 7.2v4.6L10.2 20v-6.8L4 6Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Magnifier for the queue's search shell. */
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-faint" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.25" stroke="currentColor" strokeWidth="1.6" />
      <path d="m15.8 15.8 3.7 3.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
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
      className="size-1.5 shrink-0 rounded-full bg-success"
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
  activityWindowHours,
}: {
  view: InboxConversationView;
  href: string;
  selected: boolean;
  now: Date;
  activityWindowHours: number;
}) {
  // TODO(inbox): the design shows the customer's NAME (falling back to the phone) and
  //   an unread-message counter on the avatar. Neither exists on this payload: the list
  //   row carries only `conversationRef` (the channel identifier), and there is no
  //   read/unread model on messages at all. Both would have to be fabricated here, so
  //   the row shows the real identifier and an initial-only avatar. Needs the contact
  //   join on the list query + a per-viewer read cursor.
  // TODO(inbox): the design's second chip is the conversation's INTENT + CHANNEL
  //   ("RESCHEDULING · WHATSAPP"). Only the workflow name is on this payload, so that
  //   is the single chip rendered; intent has no model and the channel isn't exposed
  //   on the list view.
  const title = view.contactName?.trim() || formatConversationRef(view.conversationRef);
  const named = Boolean(view.contactName?.trim());
  const initial = conversationAvatarLabel(view.conversationRef, view.contactName);
  // "RESCHEDULING · WHATSAPP" — the workflow the conversation belongs to and the
  // channel the person is on, as one quiet metadata line rather than two filled pills.
  const meta = [view.workflowName, view.channel].filter(Boolean).join(" · ");
  const stateLabel =
    view.mode === "pending"
      ? "Necesita a una persona"
      : view.mode === "human"
        ? "Un humano atiende"
        : "El bot atiende";
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={selected ? "page" : undefined}
      aria-label={`${view.conversationRef} — ${stateLabel}`}
      // The row is an INSET rounded card. Its state is a FILL plus a 1px border —
      // never an inset left bar: a 2px bar cannot follow a 15px radius, so it read as
      // a dark sliver clipped against the lane header above it. Every state carries a
      // border (transparent when idle) so selecting a row can't shift the geometry by
      // a pixel.
      // 50px, down from 56. Three lines of 11–13px type need ~44px; the rest was air, and
      // at 300px wide the queue shows fewer rows per screen than it did at 360 unless the
      // row gives some of it back.
      className={`relative mx-1.5 my-px flex min-h-[50px] items-center gap-2.5 overflow-hidden rounded-lg border px-2.5 py-2 transition-colors ${
        selected
          ? "border-transparent bg-queue-row-active"
          : view.mode === "pending"
            ? "border-warn/25 bg-warn-soft"
            : "border-transparent hover:bg-queue-row-active/50"
      }`}
    >
      {/*
        THE DISC carries the person's VISIT COUNT, not their initials (§3.1).
        Two reasons the design is right about this. The initials were redundant — the row
        title one line to the right is already the name, or the number when there is no
        name. And "how many times has this person been in" is the single most useful thing
        to know before opening a thread: it separates a fourteen-visit regular from a lead
        who has never walked in, which changes how you answer.
        The TONE is still the contact's own (see lib/avatarColor), so the disc remains the
        thing that lets you re-find someone in a long queue, and it matches the disc the
        thread shows for the same person.
        The count is 0 for an unattributed conversation. That is honest rather than blank:
        we have no contact, so we have no visits on record.
      */}
      <span
        title={`${view.contactVisitCount} ${view.contactVisitCount === 1 ? "visita" : "visitas"} · ${initial}`}
        className={`u-mono relative flex size-[30px] shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-semibold ${avatarColor(
          view.conversationRef,
        )}`}
      >
        {view.contactVisitCount}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center justify-between gap-2">
          <span
            className={`truncate text-[13px] leading-tight text-foreground ${named ? "" : "u-mono"}`}
          >
            {title}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <ActivityDot active={view.active} windowHours={activityWindowHours} />
            {view.lastMessageAt ? (
              <span className="u-mono text-[0.6875rem] text-faint">{relTime(view.lastMessageAt, now)}</span>
            ) : null}
          </span>
        </span>
        <span className="truncate text-[0.78125rem] leading-tight text-muted">{conversationPreview(view)}</span>
        {meta ? (
          // Metadata reads as small caps on the row's own ground — a filled pill here
          // competed with the avatar and the timestamp for the same glance.
          // Sentence case, matching the design's "Reagenda · WhatsApp". It was mono
          // uppercase, which put a third type treatment on a 56px row.
          <span className="truncate text-[0.6875rem] leading-tight text-faint">{meta}</span>
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
      <p className="text-sm font-medium text-muted">Este flujo todavía no tiene handoff.</p>
      <p className="max-w-xs text-sm text-faint">
        Conéctalo para que tu equipo pueda ver y responder sus conversaciones aquí.
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
      <p className="text-sm font-medium text-muted">Elige una conversación</p>
      <p className="max-w-xs text-sm text-faint">
        Elige una conversación de la lista para leer el hilo y actuar.
      </p>
    </div>
  );
}
