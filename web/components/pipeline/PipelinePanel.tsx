"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PageShell } from "@/components/ui/PageShell";
import { OVERLAY_SCRIM, useTrappedPanel } from "@/components/ui/Overlay";
import { Menu, MenuButton, MenuLink, MenuSeparator } from "@/components/scheduling/ui/Menu";
import { formatStampFull, relativeAgeShort } from "@/lib/format";
import { priceLabelCOP } from "@/lib/money";
import { ORIGIN_GROUPS } from "@/lib/originDisplay";
import {
  BOARD_STAGES,
  COHORT_PRESET_LABEL,
  LOST_REASON_LABEL,
  LOST_REASONS,
  STAGE_LABEL,
  apptLineOf,
  groupByStage,
  lossReasonCounts,
  originLineOf,
  originTitleOf,
  ownerInitials,
  qualificationLineOf,
  sortByActivityDesc,
  type BoardCard,
  type CohortPeriod,
  type CohortPreset,
  type CohortStep,
  type LostReason,
  type StageTotals,
} from "@/lib/pipelineBoard";
import {
  markOpportunityLostAction,
  qualifyOpportunityAction,
  reopenOpportunityAction,
  unqualifyOpportunityAction,
} from "@/lib/pipelineActions";
import { OpportunityDrawer } from "@/components/pipeline/OpportunityDrawer";

interface QueueItem {
  id: string;
  contactId: string;
  conversationId: string | null;
  name: string;
  stage: string;
  lastMessageAt: string;
}
interface Filters {
  origin: string;
  campaign: string;
  ad: string;
  from: string;
  to: string;
  status: string;
  q: string;
  owner: string;
}
interface CohortView {
  period: CohortPeriod;
  steps: CohortStep[];
  size: number;
  lost: number;
  topLoss: { reason: LostReason; count: number } | null;
}

const BTN =
  "inline-flex h-[36px] items-center justify-center rounded-lg bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50";
const GHOST =
  "u-focus inline-flex h-[32px] items-center justify-center rounded-lg border border-line px-2.5 text-xs text-muted transition hover:bg-subtle hover:text-foreground disabled:opacity-50";
/** JP-7b §4: the per-card primary action is a COMPACT GHOST button, not a solid black block. */
const QUALIFY_BTN =
  "u-focus inline-flex h-[28px] items-center justify-center rounded-md border border-line-strong px-2.5 text-[0.6875rem] font-medium text-foreground transition hover:bg-subtle disabled:opacity-50";
const INPUT =
  "h-[34px] rounded-lg border border-line-strong bg-surface px-2.5 text-xs text-foreground outline-none transition focus:border-foreground";
const CHIP = "u-focus inline-flex h-[34px] items-center gap-1.5 rounded-lg border px-2.5 text-xs transition";

type Tab = "board" | "perdidos" | "cola";
type View = "board" | "list";

/** A per-user preference persisted in localStorage, SSR-safe via an external store (no hydration
 *  mismatch, no setState-in-effect). Used for the Tablero/Lista view and the funnel strip state. */
function makePref(key: string, fallback: string) {
  const listeners = new Set<() => void>();
  return {
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    read(): string {
      try {
        return localStorage.getItem(key) ?? fallback;
      } catch {
        return fallback;
      }
    },
    server: () => fallback,
    write(v: string) {
      try {
        localStorage.setItem(key, v);
      } catch {
        /* private mode: the choice just won't persist */
      }
      listeners.forEach((cb) => cb());
    },
  };
}
const viewPref = makePref("mai.pipelineView", "board");
const stripPref = makePref("mai.pipelineFunnel", "open");

type SortKey = "name" | "stage" | "time" | "appt" | "lastMsg" | "owner";
interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

export function PipelinePanel({
  clientId,
  clientName,
  cards,
  lostCards,
  moneyTotals,
  cohort,
  queue,
  campaigns,
  ads,
  owners,
  filters,
}: {
  clientId: string;
  clientName: string;
  cards: BoardCard[];
  lostCards: BoardCard[];
  /** JP-7: per-stage money, present ONLY for a revenue viewer (null for a Setter — enforced server-side). */
  moneyTotals: StageTotals | null;
  /** JP-7b §1: the cohort funnel for its own (independent) period. */
  cohort: CohortView;
  queue: QueueItem[];
  campaigns: Array<{ id: string; name: string }>;
  ads: Array<{ id: string; label: string }>;
  /** JP-7: the tenant's members, for the owner filter. */
  owners: Array<{ id: string; label: string }>;
  filters: Filters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>("board");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [modal, setModal] = useState<null | { kind: "qualify" | "lost"; card: BoardCard }>(null);
  const [selected, setSelected] = useState<BoardCard | null>(null);
  const [lossFilter, setLossFilter] = useState<BoardCard["lostReason"]>(null);
  const [searchDraft, setSearchDraft] = useState(filters.q);
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const view = useSyncExternalStore(viewPref.subscribe, viewPref.read, viewPref.server) as View;
  const stripOpen = useSyncExternalStore(stripPref.subscribe, stripPref.read, stripPref.server) !== "collapsed";
  const [sort, setSort] = useState<Sort>({ key: "time", dir: "desc" });

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "No se pudo completar la acción.");
      else {
        setModal(null);
        setSelected(null);
        router.refresh();
      }
    });
  };

  const go = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const apply = (patch: Partial<Filters>) => go(patch);

  // JP-7: the "waiting" lens filters the board to sales where the CUSTOMER spoke last.
  const waitingCount = cards.filter((c) => c.spokeLast === "customer").length;
  const shownCards = onlyWaiting ? cards.filter((c) => c.spokeLast === "customer") : cards;
  const grouped = groupByStage(sortByActivityDesc(shownCards));
  const now = new Date();
  const boardFiltered = Boolean(filters.origin || filters.campaign || filters.ad || filters.from || filters.to || filters.status || filters.q || filters.owner);
  // JP-7b §3: advanced filters live behind "Filtros" — the badge counts the active ones (dates = 1).
  const advancedCount = [filters.ad, filters.status, filters.owner, filters.from || filters.to].filter(Boolean).length;
  // JP-7 / §2: per-column money for the HEADERS (revenue viewers only); the strip carries no money.
  const columnMoney: Partial<Record<BoardCard["stage"], number>> = moneyTotals
    ? { booked: moneyTotals.bookedExpected, attended: moneyTotals.attendedPending, paid: moneyTotals.paidCollected }
    : {};
  const losses = lossReasonCounts(lostCards);

  return (
    <main className="flex min-h-0 w-full flex-1 flex-col gap-[var(--content-pad)]">
      <PageShell grow={false} clip={false}>
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="u-page-title truncate text-[19px] font-semibold tracking-[-0.025em] text-foreground">Pipeline</h1>
            <span className="truncate text-xs text-muted">{clientName}</span>
            {/* JP-7b §3: the explanation is an info hint, not a line of chrome. */}
            <button
              type="button"
              aria-label="Qué es el pipeline"
              title="Cada oportunidad es una venta. Reservó y Asistió vienen de las citas; aquí calificas, pierdes o reabres."
              className="u-focus grid size-[18px] shrink-0 place-items-center rounded-full border border-line text-[0.625rem] font-semibold text-muted transition hover:bg-subtle hover:text-foreground"
            >
              i
            </button>
          </div>
        </div>
        <nav aria-label="Vistas" className="flex items-center gap-1 overflow-x-auto border-t border-line px-2 sm:px-3">
          <TabButton active={tab === "board"} onClick={() => setTab("board")} label="Pipeline" />
          <TabButton active={tab === "perdidos"} onClick={() => setTab("perdidos")} label="Perdidos" count={lostCards.length || undefined} />
          <TabButton active={tab === "cola"} onClick={() => setTab("cola")} label="Sin respuesta" count={queue.length || undefined} countTone="warn" />
        </nav>
      </PageShell>

      {error ? (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {tab === "board" ? (
        <>
          {/* JP-7b §3: ONE filter row — search · Origen · Campaña · Filtros(⋯) · waiting chip · view. */}
          <PageShell grow={false} clip={false}>
            <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
              <form onSubmit={(e) => { e.preventDefault(); apply({ q: searchDraft.trim() }); }} className="flex items-center">
                <input
                  type="search"
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                  placeholder="Buscar nombre, teléfono, @usuario"
                  aria-label="Buscar en el pipeline"
                  className={`${INPUT} w-[13rem]`}
                />
              </form>
              <Select label="Origen" value={filters.origin} onChange={(v) => apply({ origin: v })} options={[{ value: "", label: "Cualquier origen" }, ...ORIGIN_GROUPS.map((g) => ({ value: g.key, label: g.label }))]} />
              {campaigns.length ? (
                <Select label="Campaña" value={filters.campaign} onChange={(v) => apply({ campaign: v })} options={[{ value: "", label: "Cualquier campaña" }, ...campaigns.map((c) => ({ value: c.id, label: c.name }))]} />
              ) : null}
              <button type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((v) => !v)} className={`${CHIP} ${advancedCount > 0 ? "border-foreground text-foreground" : "border-line-strong text-muted hover:bg-subtle"}`}>
                Filtros
                {advancedCount > 0 ? <span className="u-tnum rounded-full bg-foreground px-1.5 text-[0.625rem] font-semibold text-background">{advancedCount}</span> : <span aria-hidden className="text-faint">▾</span>}
              </button>
              {/* The "waiting" lens — a real toggle chip with its count. */}
              <button type="button" aria-pressed={onlyWaiting} onClick={() => setOnlyWaiting((v) => !v)} className={`${CHIP} ${onlyWaiting ? "border-warn bg-warn-soft text-warn" : "border-line-strong text-muted hover:bg-subtle"}`}>
                Esperan respuesta
                <span className="u-tnum rounded-full bg-chip px-1.5 text-[0.625rem] font-semibold">{waitingCount}</span>
              </button>
              {boardFiltered || onlyWaiting ? (
                <button type="button" className={GHOST} onClick={() => { setSearchDraft(""); setOnlyWaiting(false); apply({ origin: "", campaign: "", ad: "", from: "", to: "", status: "", q: "", owner: "" }); }}>
                  Quitar filtros
                </button>
              ) : null}
              <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-chip p-0.5" role="group" aria-label="Vista">
                <button type="button" aria-pressed={view === "board"} onClick={() => viewPref.write("board")} className={`u-focus rounded-md px-2.5 py-1 text-xs transition ${view === "board" ? "bg-surface font-medium text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}>Tablero</button>
                <button type="button" aria-pressed={view === "list"} onClick={() => viewPref.write("list")} className={`u-focus rounded-md px-2.5 py-1 text-xs transition ${view === "list" ? "bg-surface font-medium text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}>Lista</button>
              </div>
            </div>
            {/* The rest of the filters, revealed by "Filtros". */}
            {advancedOpen ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2.5 sm:px-4">
                {ads.length ? (
                  <Select label="Anuncio" value={filters.ad} onChange={(v) => apply({ ad: v })} options={[{ value: "", label: "Cualquier anuncio" }, ...ads.map((a) => ({ value: a.id, label: a.label }))]} />
                ) : null}
                <Select label="Estado" value={filters.status} onChange={(v) => apply({ status: v })} options={[{ value: "", label: "Abiertas y ganadas" }, { value: "open", label: "Abiertas" }, { value: "won", label: "Ganadas" }]} />
                {owners.length ? (
                  <Select label="Dueño" value={filters.owner} onChange={(v) => apply({ owner: v })} options={[{ value: "", label: "Cualquier dueño" }, { value: "unassigned", label: "Sin dueño" }, ...owners.map((o) => ({ value: o.id, label: o.label }))]} />
                ) : null}
                <OpenedDateControl from={filters.from} to={filters.to} onChange={(from, to) => apply({ from, to })} />
              </div>
            ) : null}
          </PageShell>

          {/* JP-7b §1/§2: the COHORT funnel — one group of leads followed over time. Compact + collapsible. */}
          <CohortStrip cohort={cohort} open={stripOpen} onToggle={() => stripPref.write(stripOpen ? "collapsed" : "open")} onPeriod={(preset, from, to) => go({ fp: preset, ff: from, ft: to })} onLost={() => setTab("perdidos")} />

          {view === "list" ? (
            <BoardListView cards={shownCards} now={now} sort={sort} onSort={setSort} onOpen={setSelected} />
          ) : (
          /* JP-7b §6: the five columns FIT at ≥1280px (fluid 1fr with a 12rem min); below that the
             row scrolls with snap. The grid fills the height; each column scrolls its own cards. */
          <PageShell ariaLabel="Tablero de pipeline" className="overflow-hidden">
            <div className="grid min-h-0 flex-1 snap-x grid-cols-[repeat(5,minmax(11rem,1fr))] gap-3 overflow-auto p-3 sm:p-4">
              {BOARD_STAGES.map((col) => {
                const colCards = grouped[col.key];
                return (
                  <section key={col.key} aria-label={col.label} className="flex min-h-0 min-w-0 snap-start flex-col rounded-xl border border-line bg-subtle/40">
                    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-2.5 py-2">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <h2 className="text-xs font-semibold text-foreground">{col.label}</h2>
                        {/* §2: column headers show what is there NOW — the count (below) + money here, revenue roles only. */}
                        {columnMoney[col.key] !== undefined ? <span className="u-tnum truncate text-[0.625rem] text-muted">{priceLabelCOP(columnMoney[col.key]!)}</span> : null}
                      </div>
                      <span className="u-mono rounded bg-chip px-1.5 py-0.5 text-[0.625rem] text-faint">{colCards.length}</span>
                    </header>
                    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                      {colCards.length === 0 ? (
                        <p className="px-1 py-6 text-center text-[0.6875rem] text-faint">Sin oportunidades.</p>
                      ) : (
                        colCards.map((c) => (
                          <OppCard key={c.id} clientId={clientId} card={c} now={now} pending={pending}
                            onOpen={() => setSelected(c)}
                            onQualify={() => setModal({ kind: "qualify", card: c })}
                            onUnqualify={() => run(() => unqualifyOpportunityAction(clientId, c.id))}
                            onLose={() => setModal({ kind: "lost", card: c })}
                          />
                        ))
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </PageShell>
          )}
        </>
      ) : tab === "perdidos" ? (
        <PageShell className="overflow-y-auto" ariaLabel="Oportunidades perdidas">
          <div className="flex min-h-full flex-col gap-2 p-3 sm:p-4">
            {losses.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 pb-1" role="group" aria-label="Motivos de pérdida">
                <button type="button" onClick={() => setLossFilter(null)} aria-pressed={lossFilter === null} className={`u-focus rounded-full border px-2.5 py-1 text-[0.6875rem] font-medium transition ${lossFilter === null ? "border-foreground bg-foreground text-background" : "border-line text-muted hover:bg-subtle"}`}>
                  Todas <span className="u-tnum">{lostCards.length}</span>
                </button>
                {losses.map(({ reason, count }) => (
                  <button key={reason} type="button" onClick={() => setLossFilter(lossFilter === reason ? null : reason)} aria-pressed={lossFilter === reason} className={`u-focus rounded-full border px-2.5 py-1 text-[0.6875rem] font-medium transition ${lossFilter === reason ? "border-warn bg-warn-soft text-warn" : "border-line text-muted hover:bg-subtle"}`}>
                    {LOST_REASON_LABEL[reason]} <span className="u-tnum">{count}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {lostCards.length === 0 ? (
              <p className="py-10 text-center text-xs text-muted">Ninguna oportunidad perdida con estos filtros.</p>
            ) : (
              lostCards.filter((c) => !lossFilter || c.lostReason === lossFilter).map((c) => (
                <article key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" onClick={() => setSelected(c)} className="u-focus truncate text-left text-sm font-medium text-foreground hover:underline">{c.name}</button>
                      <OriginChip card={c} />
                      {c.lostReason ? <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[0.625rem] font-medium text-warn">{LOST_REASON_LABEL[c.lostReason]}</span> : null}
                    </div>
                    {c.lostNote ? <p className="mt-1 line-clamp-2 text-xs text-muted">{c.lostNote}</p> : null}
                  </div>
                  <button type="button" className={GHOST} disabled={pending} onClick={() => run(() => reopenOpportunityAction(clientId, c.id))}>
                    Reabrir
                  </button>
                </article>
              ))
            )}
          </div>
        </PageShell>
      ) : (
        <PageShell className="overflow-y-auto" ariaLabel="Sin respuesta del negocio">
          <div className="flex min-h-full flex-col gap-2 p-3 sm:p-4">
            <p className="text-xs text-muted">
              Oportunidades abiertas donde el cliente escribió último y el negocio no ha respondido. Nunca se pierden solas: contéstalas.
            </p>
            {queue.length === 0 ? (
              <p className="py-10 text-center text-xs text-muted">Todo respondido. 🎉</p>
            ) : (
              queue.map((q) => (
                <article key={q.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/clients/${clientId}/contacts/${q.contactId}`} className="truncate text-sm font-medium text-foreground hover:underline">{q.name}</Link>
                    <p className="mt-0.5 text-[0.6875rem] text-faint">
                      {STAGE_LABEL[q.stage as keyof typeof STAGE_LABEL] ?? q.stage} · esperando{" "}
                      <span title={formatStampFull(new Date(q.lastMessageAt))}>{relativeAgeShort(q.lastMessageAt, now)}</span>
                    </p>
                  </div>
                  {q.conversationId ? (
                    <Link href={`/clients/${clientId}/inbox?c=${q.conversationId}`} className={GHOST}>
                      Abrir conversación
                    </Link>
                  ) : null}
                </article>
              ))
            )}
          </div>
        </PageShell>
      )}

      {selected ? (
        <OpportunityDrawer
          key={selected.id}
          clientId={clientId}
          card={selected}
          now={now}
          pending={pending}
          trapActive={modal === null}
          onClose={() => setSelected(null)}
          onQualify={() => setModal({ kind: "qualify", card: selected })}
          onUnqualify={() => run(() => unqualifyOpportunityAction(clientId, selected.id))}
          onLose={() => setModal({ kind: "lost", card: selected })}
          onReopen={() => run(() => reopenOpportunityAction(clientId, selected.id))}
        />
      ) : null}

      {modal?.kind === "qualify" ? (
        <QualifyModal card={modal.card} pending={pending} onClose={() => setModal(null)} onSubmit={(service, timeframe) => run(() => qualifyOpportunityAction(clientId, modal.card.id, { service, timeframe }))} />
      ) : null}
      {modal?.kind === "lost" ? (
        <LostModal card={modal.card} pending={pending} onClose={() => setModal(null)} onSubmit={(reason, note) => run(() => markOpportunityLostAction(clientId, modal.card.id, { reason, note }))} />
      ) : null}
    </main>
  );
}

/**
 * JP-7b §1 — the COHORT funnel strip. It follows ONE group of opportunities (those OPENED in the
 * selected period) and shows how many of THAT group reached each stage over time, so conversion is
 * never above 100%. Its period is independent of the board. Compact + collapsible; no money, no
 * current-column counts (those live in the column headers — §2).
 */
function CohortStrip({ cohort, open, onToggle, onPeriod, onLost }: {
  cohort: CohortView;
  open: boolean;
  onToggle: () => void;
  onPeriod: (preset: CohortPreset, from: string | null, to: string | null) => void;
  onLost: () => void;
}) {
  const { period, steps, size, lost, topLoss } = cohort;
  const title = `De los ${size} ${size === 1 ? "lead" : "leads"} que entraron ${period.entrada}…`;
  return (
    <PageShell grow={false} clip={false}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:px-4">
        <button type="button" aria-expanded={open} onClick={onToggle} className="u-focus flex min-w-0 items-center gap-1.5 text-left">
          <span aria-hidden className="text-faint">{open ? "▾" : "▸"}</span>
          <span className="truncate text-xs font-medium text-foreground">{title}</span>
        </button>
        {period.inProgress ? (
          <span title="Los leads recientes todavía pueden avanzar; estos porcentajes van a subir." className="rounded-full bg-chip px-2 py-0.5 text-[0.625rem] font-medium text-muted">
            En curso
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <CohortPeriodControl period={period} onPeriod={onPeriod} />
        </div>
      </div>
      {open ? (
        <div className="flex flex-nowrap items-stretch gap-1.5 overflow-x-auto border-t border-line px-3 py-2.5 sm:px-4" aria-label="Embudo del cohorte">
          {steps.map((step, i) => (
            <div key={step.stage} className="flex shrink-0 items-center gap-1.5">
              {i > 0 ? (
                <span className="u-tnum shrink-0 text-[0.625rem] text-faint" title={`${step.convPct ?? 0}% del paso anterior llegó a ${step.label}`}>
                  {step.convPct !== null ? `${step.convPct}%` : "—"}&nbsp;›
                </span>
              ) : null}
              <div className="flex min-w-[76px] flex-col rounded-lg border border-line bg-subtle/40 px-2.5 py-1.5">
                <span className="text-[0.625rem] uppercase tracking-wide text-faint">{step.label}</span>
                <span className="u-tnum text-sm font-semibold text-foreground">{step.reached}</span>
              </div>
            </div>
          ))}
          <div className="flex shrink-0 items-center pl-1">
            <button type="button" onClick={onLost} className="u-focus flex min-w-[76px] flex-col rounded-lg border border-dashed border-line bg-subtle/30 px-2.5 py-1.5 text-left transition hover:bg-subtle">
              <span className="text-[0.625rem] uppercase tracking-wide text-faint">Perdidas</span>
              <span className="u-tnum text-sm font-semibold text-muted">{lost}</span>
              {topLoss ? <span className="truncate text-[0.5625rem] text-faint">sobre todo {LOST_REASON_LABEL[topLoss.reason].toLocaleLowerCase("es")}</span> : null}
            </button>
          </div>
        </div>
      ) : null}
    </PageShell>
  );
}

const COHORT_PRESETS: CohortPreset[] = ["mes_pasado", "hace_30_60", "ultimos_30", "ultimos_90", "custom"];
function CohortPeriodControl({ period, onPeriod }: { period: CohortPeriod; onPeriod: (preset: CohortPreset, from: string | null, to: string | null) => void }) {
  const isCustom = period.preset === "custom";
  return (
    <div className="flex items-center gap-1.5">
      <label className="flex items-center gap-1 text-xs text-muted">
        <span className="sr-only">Periodo del cohorte</span>
        <select
          value={period.preset}
          onChange={(e) => (e.target.value === "custom" ? onPeriod("custom", period.customFrom || null, period.customTo || null) : onPeriod(e.target.value as CohortPreset, null, null))}
          aria-label="Periodo del cohorte"
          className={`${INPUT} max-w-[11rem]`}
        >
          {COHORT_PRESETS.map((p) => (
            <option key={p} value={p}>{COHORT_PRESET_LABEL[p]}</option>
          ))}
        </select>
      </label>
      {isCustom ? (
        <>
          <input type="date" aria-label="Cohorte desde" value={period.customFrom} onChange={(e) => onPeriod("custom", e.target.value, period.customTo || null)} className={INPUT} />
          <input type="date" aria-label="Cohorte hasta" value={period.customTo} onChange={(e) => onPeriod("custom", period.customFrom || null, e.target.value)} className={INPUT} />
        </>
      ) : null}
    </div>
  );
}

/** JP-7b §3: the "opened" date filter as ONE control — presets + an optional custom range. The
 *  presets compute their range in the click handler (never during render), so the clock stays out
 *  of the component body. */
const DATE_PRESETS: Array<{ label: string; days: number }> = [
  { label: "Últimos 7 días", days: 7 },
  { label: "Últimos 30 días", days: 30 },
  { label: "Últimos 90 días", days: 90 },
];
function OpenedDateControl({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const dayStr = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const preset = (days: number) => {
    const now = new Date();
    onChange(dayStr(new Date(now.getTime() - days * 86_400_000)), dayStr(now));
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted">Abierta</span>
      {DATE_PRESETS.map((p) => (
        <button key={p.days} type="button" onClick={() => preset(p.days)} className="u-focus rounded-md border border-line px-2 py-1 text-[0.6875rem] text-muted transition hover:bg-subtle hover:text-foreground">
          {p.label}
        </button>
      ))}
      <input type="date" value={from} onChange={(e) => onChange(e.target.value, to)} aria-label="Abierta desde" className={INPUT} />
      <input type="date" value={to} onChange={(e) => onChange(from, e.target.value)} aria-label="Abierta hasta" className={INPUT} />
      {from || to ? (
        <button type="button" onClick={() => onChange("", "")} className="u-focus text-[0.6875rem] text-muted underline-offset-2 hover:underline">limpiar</button>
      ) : null}
    </div>
  );
}

function OriginChip({ card }: { card: BoardCard }) {
  return (
    <span className={`inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${card.originChip.tone}`}>
      {card.originChip.label}
      {card.originDetail ? <span className="font-normal opacity-80">· {card.originDetail}</span> : null}
    </span>
  );
}

/**
 * JP-7b §4/§5 — a DENSE, content-sized card: the "⋯" menu sits top-right next to the time (no empty
 * footer). The one stage line, then the lead preview (the CUSTOMER's last message only; "Esperando
 * al cliente" when the business spoke last), then the money state. The primary action (Calificar) is
 * a COMPACT GHOST button, never a solid black block. Colour means ONE thing: stale is the left edge
 * only (calm warn, reason in the tooltip); "Cobro pendiente" is neutral with an icon; money green.
 */
function OppCard({ clientId, card, now, pending, onOpen, onQualify, onUnqualify, onLose }: {
  clientId: string;
  card: BoardCard;
  now: Date;
  pending: boolean;
  onOpen: () => void;
  onQualify: () => void;
  onUnqualify: () => void;
  onLose: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isOpen = card.status === "open";
  const contactHref = `/clients/${clientId}/contacts/${card.contactId}`;
  const stageLine = card.stage === "lead" ? originLineOf(card) : card.stage === "qualified" ? qualificationLineOf(card) : card.stage === "booked" ? apptLineOf(card) : null;
  const leadPreview =
    card.stage === "lead"
      ? card.spokeLast === "customer" && card.lastMessageText
        ? `«${card.lastMessageText}»`
        : card.spokeLast === "business"
          ? "Esperando al cliente"
          : null
      : null;
  return (
    <article
      className={`relative flex flex-col gap-1 rounded-lg border border-line bg-surface p-2.5 transition-colors hover:border-line-strong focus-within:border-line-strong ${card.stale ? "border-l-[3px] border-l-[var(--warn-rule)]" : ""}`}
      title={card.stale ? card.stale.reason : undefined}
    >
      {/* Top row — name (stretched → drawer) · owner · time (neutral even when stale) · ⋯ menu. */}
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={onOpen}
          className="u-focus min-w-0 flex-1 truncate text-left text-[0.8125rem] font-medium text-foreground after:absolute after:inset-0 after:rounded-lg after:content-[''] hover:underline"
        >
          {card.name}
        </button>
        {card.owner ? (
          <span aria-hidden title={`Dueño: ${card.owner.name ?? "asignado"}`} className="grid size-[18px] shrink-0 place-items-center rounded-full bg-chip text-[0.5625rem] font-semibold text-muted">
            {ownerInitials(card.owner.name)}
          </span>
        ) : null}
        {card.stageSince ? (
          <span className="shrink-0 text-[0.625rem] text-faint" title={`En esta etapa desde ${formatStampFull(new Date(card.stageSince))}`}>
            {relativeAgeShort(card.stageSince, now)}
          </span>
        ) : null}
        <div className="relative z-10 -mr-1 -mt-0.5 shrink-0">
          <Menu label="Más acciones" floating open={menuOpen} onToggle={() => setMenuOpen((v) => !v)} onClose={() => setMenuOpen(false)}>
            {card.stage === "qualified" ? (
              <MenuButton onClick={() => { setMenuOpen(false); onUnqualify(); }} disabled={pending}>Quitar calificación</MenuButton>
            ) : null}
            {isOpen ? (
              <MenuButton danger onClick={() => { setMenuOpen(false); onLose(); }} disabled={pending}>Marcar perdida</MenuButton>
            ) : null}
            {card.stage === "qualified" || isOpen ? <MenuSeparator /> : null}
            {card.conversationId ? <MenuLink href={`/clients/${clientId}/inbox?c=${card.conversationId}`}>Abrir conversación</MenuLink> : null}
            <MenuLink href={contactHref}>Ver ficha</MenuLink>
          </Menu>
        </div>
      </div>

      {stageLine ? (
        <p className="truncate text-[0.6875rem] text-muted" title={card.stage === "lead" ? originTitleOf(card) : stageLine}>
          {stageLine}
        </p>
      ) : null}

      {leadPreview ? (
        <p className="truncate text-[0.625rem] text-faint" title={leadPreview}>{leadPreview}</p>
      ) : null}

      {/* §5 money state: Asistió is NEUTRAL "cobro pendiente" with an icon; Pagó is success green. */}
      {card.stage === "attended" ? (
        <p className="flex items-center gap-1 truncate text-[0.6875rem] text-muted">
          <ClockIcon />
          Cobro pendiente{card.apptListAmount ? ` · ${priceLabelCOP(card.apptListAmount)} (lista)` : ""}
        </p>
      ) : card.stage === "paid" ? (
        <p className="truncate text-[0.6875rem] font-medium text-[var(--success)]" title={card.paidMethod ?? undefined}>
          {card.paidAmount ? `Pagó ${priceLabelCOP(card.paidAmount)}${card.paidMethod ? ` · ${card.paidMethod}` : ""}` : "Pagado"}
        </p>
      ) : null}

      {/* §4: the one primary action, as a compact ghost button (lead only) — no empty footer. */}
      {card.stage === "lead" ? (
        <div className="relative z-10 mt-0.5">
          <button type="button" className={QUALIFY_BTN} disabled={pending} onClick={onQualify}>Calificar</button>
        </div>
      ) : null}
    </article>
  );
}

function ClockIcon() {
  return (
    <svg aria-hidden width="11" height="11" viewBox="0 0 12 12" fill="none" className="shrink-0 text-faint">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M6 3.6V6l1.6 1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SortTh({ sort, onSort, k, label, className = "" }: { sort: Sort; onSort: (s: Sort) => void; k: SortKey; label: string; className?: string }) {
  const active = sort.key === k;
  const toggle = () => onSort(active ? { key: k, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "name" || k === "owner" || k === "stage" ? "asc" : "desc" });
  return (
    <th scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={`whitespace-nowrap px-2.5 py-1.5 text-left font-medium ${className}`}>
      <button type="button" onClick={toggle} className="u-focus inline-flex items-center gap-1 hover:text-foreground">
        {label}
        <span aria-hidden className="text-[0.625rem] text-faint">{active ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

function BoardListView({ cards, now, sort, onSort, onOpen }: {
  cards: BoardCard[];
  now: Date;
  sort: Sort;
  onSort: (s: Sort) => void;
  onOpen: (card: BoardCard) => void;
}) {
  const STAGE_ORDER: Record<BoardCard["stage"], number> = { lead: 0, qualified: 1, booked: 2, attended: 3, paid: 4 };
  const key = (c: BoardCard): string | number => {
    switch (sort.key) {
      case "name": return c.name.toLocaleLowerCase("es");
      case "stage": return STAGE_ORDER[c.stage];
      case "appt": return c.apptStartAt ?? "";
      case "lastMsg": return c.lastMessageAt ?? "";
      case "owner": return (c.owner?.name ?? "").toLocaleLowerCase("es");
      default: return c.stageSince ?? ""; // "time"
    }
  };
  const sorted = [...cards].sort((a, b) => {
    const av = key(a), bv = key(b);
    const cmp = av < bv ? -1 : av > bv ? 1 : a.id < b.id ? -1 : 1;
    return sort.dir === "asc" ? cmp : -cmp;
  });
  return (
    <PageShell ariaLabel="Lista de oportunidades" className="overflow-auto">
      {cards.length === 0 ? (
        <p className="px-4 py-10 text-center text-xs text-muted">Sin oportunidades con estos filtros.</p>
      ) : (
        <table className="w-full min-w-[56rem] border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-surface text-muted shadow-[0_1px_0_var(--line)]">
            <tr>
              <SortTh sort={sort} onSort={onSort} k="name" label="Contacto" className="pl-4" />
              <SortTh sort={sort} onSort={onSort} k="stage" label="Etapa" />
              <th scope="col" className="whitespace-nowrap px-2.5 py-1.5 text-left font-medium">Origen / anuncio</th>
              <th scope="col" className="whitespace-nowrap px-2.5 py-1.5 text-left font-medium">Servicio</th>
              <SortTh sort={sort} onSort={onSort} k="appt" label="Cita" />
              <SortTh sort={sort} onSort={onSort} k="time" label="En etapa" />
              <SortTh sort={sort} onSort={onSort} k="lastMsg" label="Último mensaje" />
              <SortTh sort={sort} onSort={onSort} k="owner" label="Dueño" className="pr-4" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.id} className="relative border-t border-line-soft hover:bg-subtle/60">
                <td className="max-w-[12rem] truncate px-2.5 py-2 pl-4">
                  <button type="button" onClick={() => onOpen(c)} className="u-focus truncate text-left font-medium text-foreground after:absolute after:inset-0 hover:underline">{c.name}</button>
                </td>
                <td className="whitespace-nowrap px-2.5 py-2 text-muted">{STAGE_LABEL[c.stage]}</td>
                <td className="max-w-[12rem] truncate px-2.5 py-2 text-muted" title={originTitleOf(c)}>{originLineOf(c)}</td>
                <td className="max-w-[10rem] truncate px-2.5 py-2 text-muted">{c.qualService ?? "—"}</td>
                <td className="whitespace-nowrap px-2.5 py-2 text-muted">{apptLineOf(c) ?? "—"}</td>
                <td className="whitespace-nowrap px-2.5 py-2 text-muted">{c.stageSince ? relativeAgeShort(c.stageSince, now) : "—"}</td>
                <td className="max-w-[12rem] truncate px-2.5 py-2 text-muted" title={c.lastMessageText ?? undefined}>{c.lastMessageText ?? (c.lastMessageAt ? relativeAgeShort(c.lastMessageAt, now) : "—")}</td>
                <td className="whitespace-nowrap px-2.5 py-2 pr-4 text-muted">{c.owner?.name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PageShell>
  );
}

function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  const close = useCallback(() => closeRef.current(), []);
  const panelRef = useTrappedPanel({ active: true, onClose: close });
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-5">
      <button type="button" aria-label={`Cerrar ${title}`} className={OVERLAY_SCRIM} onClick={close} />
      <section ref={panelRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="relative z-50 flex w-full flex-col gap-3 rounded-t-2xl border border-line bg-surface p-4 sm:max-w-md sm:rounded-2xl sm:p-5">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {children}
      </section>
    </div>
  );
}

function QualifyModal({ card, pending, onClose, onSubmit }: { card: BoardCard; pending: boolean; onClose: () => void; onSubmit: (service: string, timeframe: string) => void }) {
  const [service, setService] = useState("");
  const [timeframe, setTimeframe] = useState("");
  return (
    <ModalShell title={`Calificar — ${card.name}`} onClose={onClose}>
      <p className="text-xs text-muted">La evidencia: qué servicio quiere y para cuándo.</p>
      <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
        Servicio de interés
        <input value={service} onChange={(e) => setService(e.target.value)} placeholder="Ej. Corte + barba" className={`${INPUT} w-full`} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
        Plazo
        <input value={timeframe} onChange={(e) => setTimeframe(e.target.value)} placeholder="Ej. esta semana" className={`${INPUT} w-full`} />
      </label>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className={GHOST} onClick={onClose}>Cancelar</button>
        <button type="button" className={BTN} disabled={pending || !service.trim() || !timeframe.trim()} onClick={() => onSubmit(service.trim(), timeframe.trim())}>
          Calificar
        </button>
      </div>
    </ModalShell>
  );
}

function LostModal({ card, pending, onClose, onSubmit }: { card: BoardCard; pending: boolean; onClose: () => void; onSubmit: (reason: string, note: string) => void }) {
  const [reason, setReason] = useState<string>("no_respondio");
  const [note, setNote] = useState("");
  const needsNote = reason === "otro";
  return (
    <ModalShell title={`Marcar perdida — ${card.name}`} onClose={onClose}>
      <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
        Motivo
        <select value={reason} onChange={(e) => setReason(e.target.value)} className={`${INPUT} w-full`}>
          {LOST_REASONS.map((r) => (
            <option key={r} value={r}>{LOST_REASON_LABEL[r]}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
        Nota {needsNote ? <span className="text-danger">(obligatoria)</span> : <span className="font-normal text-faint">(opcional)</span>}
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-foreground" />
      </label>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className={GHOST} onClick={onClose}>Cancelar</button>
        <button type="button" className={BTN} disabled={pending || (needsNote && !note.trim())} onClick={() => onSubmit(reason, note.trim())}>
          Marcar perdida
        </button>
      </div>
    </ModalShell>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={`${INPUT} max-w-[12rem]`}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function TabButton({ active, onClick, label, count, countTone }: { active: boolean; onClick: () => void; label: string; count?: number; countTone?: "warn" }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`relative flex h-[44px] shrink-0 items-center gap-1.5 border-b-2 px-3 text-xs font-medium transition lg:h-[40px] lg:px-2.5 ${
        active ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground"
      }`}
    >
      {label}
      {count != null ? (
        <span className={`u-mono rounded px-1.5 py-0.5 text-[0.625rem] ${countTone === "warn" ? "bg-warn-soft text-warn" : "bg-chip text-faint"}`}>{count}</span>
      ) : null}
    </button>
  );
}
