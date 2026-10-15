"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { InboxThread } from "./InboxThread";
import { CustomerDetailsPanel } from "./CustomerDetailsPanel";
import { PageShell } from "@/components/ui/PageShell";
import { OVERLAY_SCRIM, useTrappedPanel } from "@/components/ui/Overlay";
import { PageTitle } from "@/components/ui/PageTitle";
import { InboxAvatar, StateChip, IconBot, IconCheck, IconClockAlert, IconClose, IconFilter, IconLock, IconPerson, IconSearch } from "./inbox/InboxUi";
import {
  conversationPreview,
  type HistoryTurnView,
  type InboxConversationView,
  type InboxHeaderView,
  type InboxMessageView,
  type ThreadEventView,
} from "@/lib/inboxView";
import { groupConversations, pendingCount } from "@/lib/inboxGroups";
import {
  avatarText,
  capCount,
  conversationTitle,
  dayBuckets,
  DEFAULT_INBOX_TAB,
  INBOX_TABS,
  inTab,
  listStamp,
  matchesSearch,
  previewLines,
  responder,
  tabCounts,
  windowState,
  type InboxTab,
} from "@/lib/inboxPresent";
import { scopeHref } from "@/lib/scopeSurface";
import { useScope } from "@/components/ScopeProvider";

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

export interface InboxWorkflowOption {
  id: string;
  name: string | null;
  active: boolean | null;
}

const POLL_MS = 5000;

/**
 * The unified client inbox — redesign "Inbox de Gallery": in seconds, know which
 * conversation needs attention, who answers, what happened and what to do next.
 *
 *   LIST   (left)   "Inbox" + "N necesitan una persona", the workflow selector, search,
 *                   tabs Todas · Escalado · Persona · Bot (with counts), and the three
 *                   groups — Necesitan una persona / Atiende una persona / Atiende el bot —
 *                   each split into Hoy · Ayer · Anteriores. Light-polls `endpoint`.
 *   THREAD (center) <InboxThread/> — header, take/return with confirmation, composer.
 *   FICHA  (right)  the customer card, opened on demand: an inline column from xl up, a
 *                   side panel from md, and its own full screen on the phone.
 *
 * Phone (< md): ONE view at a time — list → conversation → ficha. Going back keeps the
 * tab, the search and each conversation's draft.
 *
 * Selection is the EXISTING `?c=<id>` query param (deep links preserved). The workflow
 * SCOPE stays a single source of truth: the in-list selector writes the SAME scope as the
 * header switcher (setScope + `?workflow=`) — there is no second, client-side workflow
 * filter. All props are serializable — no function crosses from the server page.
 */
export function ClientInboxWorkspace({
  clientId,
  initial,
  scope,
  workflowHandoffActive,
  viewerUserId,
  viewerName,
  viewerIsFullAccess,
  workflows,
}: {
  clientId: string;
  initial: GridPayload;
  /** The active workflow scope: 'all' or a workflow id (resolved by the page). */
  scope: "all" | string;
  /** Only meaningful when `scope` is a workflow AND the list is empty (H-6). */
  workflowHandoffActive: boolean | null;
  viewerUserId: string;
  viewerName: string | null;
  viewerIsFullAccess: boolean;
  /** This client's workflows for the in-list selector; null = this login has no workflow
   *  switcher (same rule as the header), so the selector is not shown. */
  workflows: InboxWorkflowOption[] | null;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selectedId = searchParams.get("c");

  const endpoint =
    scope === "all"
      ? `/api/inbox/${encodeURIComponent(clientId)}/conversations`
      : `/api/inbox/${encodeURIComponent(clientId)}/conversations?workflow=${encodeURIComponent(scope)}`;
  const [data, setData] = useState<GridPayload>(initial);
  const [stale, setStale] = useState(false);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<InboxTab>(DEFAULT_INBOX_TAB);

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
  // Workflow-scoped at the data layer; here only the search and the tab narrow it.
  const searched = useMemo(() => all.filter((v) => matchesSearch(v, search)), [all, search]);
  const counts = tabCounts(searched);
  const inView = useMemo(() => searched.filter((v) => inTab(v.mode, tab)), [searched, tab]);
  const groups = useMemo(() => groupConversations(inView), [inView]);
  const pending = pendingCount(all);
  const selectedView = selectedId ? all.find((v) => v.id === selectedId) ?? null : null;

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

  // W-2: an open conversation OUTSIDE the active workflow scope closes cleanly.
  useEffect(() => {
    if (scope === "all" || !selectedId) return;
    if (!all.some((v) => v.id === selectedId)) close();
  }, [scope, selectedId, all, close]);

  // ── Thread payload for the selected conversation ──
  const [thread, setThread] = useState<ThreadPayload | null>(null);
  const [threadError, setThreadError] = useState(false);
  const [threadAttempt, setThreadAttempt] = useState(0);
  useEffect(() => {
    if (!selectedId) {
      /* eslint-disable-next-line react-hooks/set-state-in-effect -- reset of this fetch effect's own state */
      setThread(null);
      setThreadError(false);
      return;
    }
    let cancelled = false;
    setThreadError(false);
    void (async () => {
      try {
        const res = await fetch(`/api/inbox/${clientId}/conversations/${selectedId}/messages?history=1`, { cache: "no-store" });
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
  }, [selectedId, clientId, threadAttempt]);

  // ── Ficha: inline (xl+), side panel (md–xl), full screen (phone) — opened on demand ──
  const [detailsInline, setDetailsInline] = useState(false);
  const [detailsDrawer, setDetailsDrawer] = useState(false);
  const customerDrawerRef = useTrappedPanel({ active: detailsDrawer, onClose: () => setDetailsDrawer(false) });
  useEffect(() => {
    if (!detailsDrawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailsDrawer(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [detailsDrawer]);
  const openDetails = () => {
    if (window.matchMedia("(min-width: 1280px)").matches) setDetailsInline((o) => !o);
    else setDetailsDrawer(true);
  };

  const clearFilters = () => {
    setSearch("");
    setTab("all");
  };
  const threadReady = thread && thread.header.id === selectedId ? thread : null;

  return (
    // Phone: the inbox IS the screen — out of the floating card (no gutter, border,
    // radius or shadow). From md up it is the usual card.
    <PageShell as="main" row ariaLabel="Inbox" className="max-md:-m-[var(--content-pad)] max-md:rounded-none max-md:border-0 max-md:shadow-none">
      {/* ── LIST ── */}
      <aside
        aria-label="Conversations"
        className={`min-h-0 w-full shrink-0 border-r border-line md:flex md:w-[300px] lg:w-[320px] xl:w-[336px] ${selectedId ? "hidden md:flex" : "flex"}`}
      >
        <div className="flex min-h-0 w-full flex-col overflow-hidden">
          <div className="flex flex-col gap-2.5 border-b border-line px-3.5 pb-3 pt-3 md:gap-2 md:px-3 md:pb-2.5 md:pt-2">
            <div className="flex min-h-[var(--topbar-height)] items-center gap-2">
              <PageTitle title="Inbox">
                {pending > 0 ? (
                  <StateChip kind="pending" size="sm">
                    {capCount(pending)} {pending === 1 ? "necesita una persona" : "necesitan una persona"}
                  </StateChip>
                ) : null}
              </PageTitle>
              <span className="ml-auto" />
              {/* The in-list workflow selector writes the SAME scope as the header switcher. */}
              {workflows && workflows.length > 0 ? <WorkflowSelector clientId={clientId} scope={scope} workflows={workflows} /> : null}
            </div>
            <div className="u-focus flex h-11 items-center gap-2 rounded-xl border border-transparent bg-chip px-3 md:h-9">
              <span className="text-faint">
                <IconSearch />
              </span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar nombre, número o mensaje"
                aria-label="Buscar conversaciones"
                className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-faint md:text-[0.8125rem]"
              />
              {search ? (
                <button type="button" onClick={() => setSearch("")} aria-label="Borrar búsqueda" className="inline-flex size-8 items-center justify-center rounded-full text-faint hover:text-foreground">
                  <IconClose />
                </button>
              ) : null}
            </div>
            <InboxTabs tab={tab} counts={counts} onChange={setTab} />
            {scope !== "all" ? <ActiveWorkflowFilter clientId={clientId} name={workflows?.find((w) => w.id === scope)?.name ?? all.find((v) => v.workflowName)?.workflowName ?? null} /> : null}
            {stale ? (
              <p role="status" className="flex items-center justify-between gap-2 rounded-lg bg-chip px-2.5 py-1.5 text-xs text-muted">
                No pudimos actualizar la bandeja.
                <button type="button" onClick={() => void load()} className="font-semibold text-foreground underline underline-offset-2">
                  Reintentar
                </button>
              </p>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pb-3">
            {all.length === 0 ? (
              scope !== "all" && workflowHandoffActive === false ? (
                <WorkflowNotSetUp settingsHref={viewerIsFullAccess ? scopeHref(clientId, "settings", scope) : null} />
              ) : (
                <EmptyNote title="Todavía no hay conversaciones" body={scope === "all" ? "Aparecen aquí cuando un flujo publica mensajes o una persona toma una." : "Este flujo todavía no tiene conversaciones."} />
              )
            ) : search.trim() && searched.length === 0 ? (
              <div className="flex flex-col items-start gap-2 px-4 py-6">
                <p className="text-sm font-semibold text-foreground">Sin resultados para “{search.trim()}”</p>
                <p className="text-sm text-muted">Prueba con otro nombre, número o parte del mensaje.</p>
                <button type="button" onClick={clearFilters} className="mt-1 inline-flex h-11 items-center rounded-xl border border-line-strong px-3.5 text-sm font-medium text-foreground hover:bg-subtle md:h-9">
                  Limpiar filtros
                </button>
              </div>
            ) : inView.length === 0 ? (
              tab === "pending" ? (
                <div className="flex flex-col items-start gap-2 px-4 py-6">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    <IconCheck /> Estás al día
                  </p>
                  <p className="text-sm text-muted">Ninguna conversación necesita una persona ahora.</p>
                  <button type="button" onClick={() => setTab("all")} className="mt-1 inline-flex h-11 items-center rounded-xl border border-line-strong px-3.5 text-sm font-medium text-foreground hover:bg-subtle md:h-9">
                    Ver todas
                  </button>
                </div>
              ) : (
                <EmptyNote title="Nada en esta pestaña" body="Cambia de pestaña o de workflow para ver más conversaciones." />
              )
            ) : (
              groups.map((g) => (
                <div key={g.key} role="group" aria-label={g.meta.label}>
                  {tab === "all" ? (
                    <h2 className="sticky top-0 z-10 flex items-center gap-2 bg-surface px-3.5 pb-1.5 pt-3.5 text-xs font-semibold text-foreground md:px-3 md:pt-3">
                      <GroupDot tone={g.meta.tone} />
                      {g.meta.label}
                      <span className="ml-auto font-normal text-faint">{capCount(g.items.length)}</span>
                    </h2>
                  ) : null}
                  {dayBuckets(g.items, now).map((b) => (
                    <div key={b.key}>
                      <h3 className="px-3.5 pb-1 pt-2 text-[0.6875rem] font-medium text-faint md:px-3 md:pt-1.5">{b.label}</h3>
                      <ul>
                        {b.items.map((v) => (
                          <li key={v.id} className="u-inbox-row">
                            <ConversationRow view={v} href={hrefFor(v.id)} selected={v.id === selectedId} now={now} viewerUserId={viewerUserId} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      </aside>

      {/* ── THREAD ── */}
      <section aria-label="Conversation" className={`min-h-0 min-w-0 flex-1 flex-col ${selectedId ? "flex" : "hidden md:flex"}`}>
        {!selectedId ? (
          <EmptyChat />
        ) : threadError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm font-semibold text-foreground">No pudimos cargar la conversación</p>
            <p className="text-sm text-muted">Revisa tu conexión e inténtalo de nuevo.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setThreadAttempt((n) => n + 1)} className="inline-flex h-11 items-center rounded-xl bg-ink px-4 text-sm font-semibold text-ink-fg md:h-9">
                Reintentar
              </button>
              <button type="button" onClick={close} className="inline-flex h-11 items-center rounded-xl border border-line-strong px-3.5 text-sm font-medium md:h-9">
                Volver a la bandeja
              </button>
            </div>
          </div>
        ) : threadReady ? (
          <InboxThread
            key={threadReady.header.id}
            clientId={clientId}
            initial={threadReady}
            viewerUserId={viewerUserId}
            viewerName={viewerName}
            viewerIsFullAccess={viewerIsFullAccess}
            onBack={close}
            onOpenDetails={selectedView ? openDetails : undefined}
            detailsOpen={detailsInline || detailsDrawer}
            onModeChanged={() => void load()}
          />
        ) : (
          <ThreadSkeleton />
        )}
      </section>

      {/* ── FICHA (inline from xl up) ── */}
      {selectedId && selectedView && detailsInline ? (
        <aside aria-label="Customer details" className="hidden w-[340px] shrink-0 flex-col border-l border-line xl:flex 2xl:w-[360px]">
          <CustomerDetailsPanel
            key={selectedView.id}
            clientId={clientId}
            conversationId={selectedView.id}
            conversationRef={selectedView.conversationRef}
            workflowName={selectedView.workflowName}
            viewerUserId={viewerUserId}
            viewerIsFullAccess={viewerIsFullAccess}
            onClose={() => setDetailsInline(false)}
          />
        </aside>
      ) : null}

      {/* ── FICHA (side panel md–xl, full screen on the phone) ── */}
      {selectedId && selectedView && detailsDrawer ? (
        <div className="xl:hidden">
          <button type="button" aria-label="Cerrar la ficha del cliente" onClick={() => setDetailsDrawer(false)} className={`${OVERLAY_SCRIM} max-md:hidden`} />
          <aside
            ref={customerDrawerRef as React.RefObject<HTMLElement>}
            aria-label="Customer details"
            role="dialog"
            aria-modal
            tabIndex={-1}
            className="fixed inset-0 z-50 flex flex-col bg-surface md:inset-y-0 md:left-auto md:right-0 md:w-[380px] md:border-l md:border-line-strong"
          >
            <CustomerDetailsPanel
              key={selectedView.id}
              clientId={clientId}
              conversationId={selectedView.id}
              conversationRef={selectedView.conversationRef}
              workflowName={selectedView.workflowName}
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

/** Todas · Escalado · Persona · Bot — the same groups, with counts. */
function InboxTabs({ tab, counts, onChange }: { tab: InboxTab; counts: Record<InboxTab, number>; onChange: (t: InboxTab) => void }) {
  return (
    // Always the full width of the column (each tab grows from its own content), a
    // little apart from the search field above.
    <div role="group" aria-label="Filtrar conversaciones" className="mt-1.5 flex w-full gap-1.5 md:mt-1 md:gap-1 xl:gap-1.5">
      {INBOX_TABS.map((t) => {
        const on = t.key === tab;
        const icon = t.key === "pending" ? <IconClockAlert /> : t.key === "human" ? <IconPerson className="size-3.5" /> : t.key === "bot" ? <IconBot className="size-3.5" /> : null;
        return (
          <button
            key={t.key}
            type="button"
            aria-pressed={on}
            aria-label={`${t.name}, ${counts[t.key]}`}
            onClick={() => onChange(t.key)}
            className={`inline-flex h-11 flex-auto items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border px-3 text-sm transition-colors md:h-8 md:gap-1 md:px-2 md:text-[0.8125rem] xl:gap-1.5 xl:px-2.5 ${on ? "border-ink bg-ink font-semibold text-ink-fg" : "border-line-strong text-foreground hover:bg-subtle"}`}
          >
            {icon}
            {t.label ? <span>{t.label}</span> : null}
            <span className={`tabular-nums ${on ? "" : "text-muted"}`}>{capCount(counts[t.key])}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The in-list workflow selector (frames 1g / 2k). It is the header switcher's twin, not a
 * second filter: choosing writes the SAME scope (cookie + `?workflow=`), so the header, the
 * sidebar links and this list can never disagree.
 */
function WorkflowSelector({ clientId, scope, workflows }: { clientId: string; scope: "all" | string; workflows: InboxWorkflowOption[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setScope } = useScope();
  const [open, setOpen] = useState(false);
  // FIXED position from the button's rect: the list column clips (overflow-hidden), so an
  // absolutely-positioned menu inside it would be cut off on a short screen.
  const [pos, setPos] = useState<{ top: number; right: number; maxHeight: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (open) return setOpen(false);
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right), maxHeight: Math.max(200, window.innerHeight - r.bottom - 16) });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);
  const choose = (id: "all" | string) => {
    setOpen(false);
    setScope(clientId, id);
    const p = new URLSearchParams(searchParams.toString());
    p.delete("c");
    if (id === "all") p.delete("workflow");
    else p.set("workflow", id);
    const qs = p.toString();
    router.push(`/clients/${encodeURIComponent(clientId)}/inbox${qs ? `?${qs}` : ""}`);
  };
  const active = workflows.filter((w) => w.active !== false);
  const inactive = workflows.filter((w) => w.active === false);
  const item = (id: "all" | string, label: string, status: "active" | "inactive" | null) => {
    const on = scope === id;
    return (
      <button
        key={id}
        type="button"
        role="menuitemradio"
        aria-checked={on}
        onClick={() => choose(id)}
        className="flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-foreground hover:bg-subtle md:min-h-9"
      >
        {status ? <span aria-hidden className={`size-2 shrink-0 rounded-full ${status === "active" ? "bg-success" : "border border-line-strong"}`} /> : null}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {status ? <span className="shrink-0 text-xs text-faint">{status === "active" ? "Activo" : "Inactivo"}</span> : null}
        {on ? <IconCheck /> : null}
      </button>
    );
  };
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Elegir workflow"
        onClick={toggle}
        className={`inline-flex size-11 items-center justify-center rounded-xl border transition-colors md:size-9 ${scope !== "all" ? "border-ink text-foreground" : "border-line-strong text-foreground hover:bg-subtle"}`}
      >
        <IconFilter />
      </button>
      {open && pos ? (
        <div
          role="menu"
          aria-label="Workflows"
          style={{ top: pos.top, right: pos.right, maxHeight: pos.maxHeight }}
          className="fixed z-50 w-[min(300px,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-line bg-popover p-1.5 text-popover-foreground shadow-[var(--shadow-float)]"
        >
          <p className="px-2.5 pb-1 pt-1.5 text-xs text-faint">Workflows</p>
          {item("all", "Todos los workflows", null)}
          {active.length ? <p className="px-2.5 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-faint">Activos</p> : null}
          {active.map((w) => item(w.id, w.name ?? "Workflow sin nombre", "active"))}
          {inactive.length ? <p className="px-2.5 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-faint">Inactivos</p> : null}
          {inactive.map((w) => item(w.id, w.name ?? "Workflow sin nombre", "inactive"))}
        </div>
      ) : null}
    </div>
  );
}

function GroupDot({ tone }: { tone: "attention" | "human" | "bot" }) {
  if (tone === "bot") return <span aria-hidden className="size-2 shrink-0 rounded-full border border-line-strong" />;
  return <span aria-hidden className={`size-2 shrink-0 rounded-full ${tone === "attention" ? "bg-chip-pending-fg" : "bg-chip-you-fg"}`} />;
}

/**
 * One row: initials (no visit counter), name / known phone / "Contacto sin nombre", the
 * time, the preview (2 lines only where a person must act) and the state chips. Workflow and
 * channel left the row — they live in the conversation header and the ficha.
 */
function ConversationRow({
  view,
  href,
  selected,
  now,
  viewerUserId,
}: {
  view: InboxConversationView;
  href: string;
  selected: boolean;
  now: Date;
  viewerUserId: string;
}) {
  const title = conversationTitle(view.contactName, view.conversationRef);
  const who = responder(view.mode, view.assignedAgentUserId, view.assignedAgentName, viewerUserId);
  const expired = view.mode !== "bot" && windowState(view.lastUserMessageAt, now).state === "closed";
  const lines = previewLines(view.mode);
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={selected ? "page" : undefined}
      aria-label={`${title.text} — ${who.label}${expired ? ", ventana vencida" : ""}`}
      className={`mx-1.5 my-px flex items-start gap-3 rounded-xl border px-2.5 py-2.5 transition-colors md:gap-2.5 md:py-2 ${
        selected ? "border-transparent bg-queue-row-active" : "border-transparent hover:bg-queue-row-active/50"
      }`}
    >
      <InboxAvatar text={avatarText(view.contactName, view.conversationRef)} toneKey={view.conversationRef} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline justify-between gap-2">
          <span className={`truncate text-[0.9375rem] font-semibold leading-snug text-foreground md:text-[0.875rem] ${title.kind === "phone" ? "tabular-nums" : ""}`}>{title.text}</span>
          {view.lastMessageAt ? <span className="shrink-0 text-xs tabular-nums text-faint">{listStamp(new Date(view.lastMessageAt), now)}</span> : null}
        </span>
        <span className={`text-[0.8125rem] leading-snug text-muted md:text-[0.78125rem] ${lines === 2 ? "line-clamp-2" : "truncate"}`}>{conversationPreview(view)}</span>
        {view.mode !== "bot" || expired ? (
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            {view.mode !== "bot" ? (
              <StateChip kind={who.kind} size="sm">
                {who.label}
              </StateChip>
            ) : null}
            {expired ? (
              <span className="inline-flex items-center gap-1 text-[0.6875rem] text-faint">
                <IconLock /> Ventana vencida
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function EmptyNote({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-8">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="text-sm text-muted">{body}</p>
    </div>
  );
}

/** Empty list when a scoped workflow isn't handoff-active yet (H-6). */
function WorkflowNotSetUp({ settingsHref }: { settingsHref: string | null }) {
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-8">
      <p className="text-sm font-semibold text-foreground">Este flujo todavía no tiene handoff.</p>
      <p className="max-w-xs text-sm text-muted">Conéctalo para que tu equipo pueda ver y responder sus conversaciones aquí.</p>
      {settingsHref ? (
        <Link href={settingsHref} className="mt-1 inline-flex h-11 items-center rounded-xl border border-line-strong px-3.5 text-sm font-medium text-foreground hover:bg-subtle md:h-9">
          Abrir la configuración del flujo
        </Link>
      ) : null}
    </div>
  );
}

/** Frame 1b — nothing selected. */
function EmptyChat() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-[var(--thread-bg)] p-6 text-center">
      <p className="text-sm font-semibold text-foreground">Elige una conversación</p>
      <p className="max-w-xs text-sm text-muted">Las que necesitan una persona están arriba. Abre una para leer el hilo y responder.</p>
    </div>
  );
}

/** Frame 1m — loading the thread. */
function ThreadSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label="Cargando la conversación">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <span className="size-9 animate-pulse rounded-full bg-chip" />
        <span className="flex flex-col gap-1.5">
          <span className="h-3.5 w-36 animate-pulse rounded bg-chip" />
          <span className="h-3 w-52 animate-pulse rounded bg-chip" />
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-3 bg-[var(--thread-bg)] p-5">
        {[60, 44, 70, 38].map((w, i) => (
          <span key={i} className={`h-12 animate-pulse rounded-2xl bg-chip ${i % 2 ? "self-end" : ""}`} style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

/** "Mostrando solo el flujo X · Quitar filtro" — the persisted scope, visible and clearable. */
function ActiveWorkflowFilter({ clientId, name }: { clientId: string; name: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setScope } = useScope();
  const clear = () => {
    setScope(clientId, "all");
    const p = new URLSearchParams(searchParams.toString());
    p.delete("workflow");
    const qs = p.toString();
    router.push(`/clients/${encodeURIComponent(clientId)}/inbox${qs ? `?${qs}` : ""}`);
  };
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
      <span>
        Mostrando solo el flujo <strong className="font-medium text-foreground">{name ?? "seleccionado"}</strong>
      </span>
      <span aria-hidden>·</span>
      <button type="button" onClick={clear} className="u-focus inline-flex items-center rounded-md font-medium text-foreground underline-offset-2 hover:underline max-md:min-h-[44px]">
        Quitar filtro
      </button>
    </p>
  );
}
