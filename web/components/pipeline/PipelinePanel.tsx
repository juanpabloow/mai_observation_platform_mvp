"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PageShell } from "@/components/ui/PageShell";
import { OVERLAY_SCRIM, useTrappedPanel } from "@/components/ui/Overlay";
import { relativeAgeShort } from "@/lib/format";
import { priceLabelCOP } from "@/lib/money";
import { ORIGIN_GROUPS } from "@/lib/originDisplay";
import {
  BOARD_STAGES,
  LOST_REASON_LABEL,
  LOST_REASONS,
  STAGE_LABEL,
  agoCompact,
  agoShort,
  apptDatePhrase,
  apptDayLabel,
  apptWhenLine,
  cardUrgency,
  lossReasonCounts,
  originLineOf,
  originTitleOf,
  qualificationLineOf,
  reminderText,
  sortBoardColumn,
  type BoardCard,
  type CohortMonthOption,
  type CohortPeriod,
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
import { confirmAppointmentAction } from "@/lib/schedulingActions";
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
  months: CohortMonthOption[];
}

const INPUT = "h-[34px] rounded-lg border border-line-strong bg-surface px-2.5 text-xs text-foreground outline-none transition focus:border-foreground";
const GHOST = "u-focus inline-flex h-[30px] items-center justify-center rounded-lg border border-line-strong px-2.5 text-xs font-medium text-foreground transition hover:bg-subtle disabled:opacity-50";
const PRIMARY = "u-focus inline-flex h-[30px] items-center justify-center rounded-lg bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50";
const MODAL_BTN = "inline-flex h-[36px] items-center justify-center rounded-lg bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50";

type Tab = "board" | "te_esperan" | "sin_respuesta" | "perdidos";
type View = "board" | "list";

/** A per-user preference persisted in localStorage, SSR-safe via an external store. */
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
        /* private mode */
      }
      listeners.forEach((cb) => cb());
    },
  };
}
const viewPref = makePref("mai.pipelineView", "board");

type SortKey = "name" | "stage" | "time" | "appt" | "lastMsg" | "owner";
interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

export function PipelinePanel({
  clientId,
  cards,
  lostCards,
  moneyTotals,
  cohort,
  queue,
  followup,
  campaigns,
  ads,
  owners,
  filters,
}: {
  clientId: string;
  cards: BoardCard[];
  lostCards: BoardCard[];
  moneyTotals: StageTotals | null;
  cohort: CohortView;
  /** "Te esperan": the customer spoke last. */
  queue: QueueItem[];
  /** "Sin respuesta": the business spoke last ≥ 24 h ago. */
  followup: QueueItem[];
  campaigns: Array<{ id: string; name: string }>;
  ads: Array<{ id: string; label: string }>;
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
  const [lossFilter, setLossFilter] = useState<LostReason | null>(null);
  const [searchDraft, setSearchDraft] = useState(filters.q);
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const view = useSyncExternalStore(viewPref.subscribe, viewPref.read, viewPref.server) as View;
  const [sort, setSort] = useState<Sort>({ key: "time", dir: "desc" });
  const now = new Date();

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

  /** "Recordar": pre-type the reminder into the Inbox composer (sessionStorage key the composer reads
   *  on mount), then open the conversation. NEVER auto-sends. */
  const recordar = (card: BoardCard) => {
    if (!card.conversationId) return;
    try {
      sessionStorage.setItem(`inbox-draft:${clientId}:${card.conversationId}`, reminderText(card, now));
    } catch {
      /* private mode: open the conversation anyway, without the draft */
    }
    router.push(`/clients/${clientId}/inbox?c=${card.conversationId}`);
  };

  const grouped = groupBoard(cards, now);
  const moreCount = [filters.ad, filters.owner, filters.from || filters.to].filter(Boolean).length;
  const boardFiltered = Boolean(filters.origin || filters.campaign || filters.ad || filters.from || filters.to || filters.status || filters.q || filters.owner);
  const columnMoney: Partial<Record<BoardCard["stage"], number>> = moneyTotals
    ? { booked: moneyTotals.bookedExpected, attended: moneyTotals.attendedPending, paid: moneyTotals.paidCollected }
    : {};
  const losses = lossReasonCounts(lostCards);

  const filterControls = (
    <FilterControls
      filters={filters}
      searchDraft={searchDraft}
      setSearchDraft={setSearchDraft}
      apply={apply}
      campaigns={campaigns}
      ads={ads}
      owners={owners}
      moreOpen={moreOpen}
      setMoreOpen={setMoreOpen}
      moreCount={moreCount}
      boardFiltered={boardFiltered}
      onClear={() => { setSearchDraft(""); apply({ origin: "", campaign: "", ad: "", from: "", to: "", status: "", q: "", owner: "" }); }}
      view={view}
    />
  );

  return (
    <main className="flex min-h-0 w-full flex-1 flex-col gap-[var(--content-pad)]">
      {/* ── HEADER (one row): title + tabs · filters ───────────────────────────────── */}
      <PageShell grow={false} clip={false}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="u-page-title shrink-0 text-[17px] font-semibold tracking-[-0.02em] text-foreground">Pipeline</h1>
            <nav aria-label="Vistas del pipeline" className="flex items-center gap-0.5 overflow-x-auto rounded-lg bg-chip p-0.5">
              <Tab active={tab === "board"} onClick={() => setTab("board")} label="Activos" count={cards.length} />
              <Tab active={tab === "te_esperan"} onClick={() => setTab("te_esperan")} label="Te esperan" count={queue.length} attention />
              <Tab active={tab === "sin_respuesta"} onClick={() => setTab("sin_respuesta")} label="Sin respuesta" count={followup.length} />
              <Tab active={tab === "perdidos"} onClick={() => setTab("perdidos")} label="Perdidos" count={lostCards.length} />
            </nav>
          </div>
          <div className="ml-auto hidden items-center gap-2 lg:flex">{filterControls}</div>
          {/* Phone: one "Buscar y filtrar" control + the view toggle. */}
          <div className="ml-auto flex items-center gap-2 lg:hidden">
            <button type="button" onClick={() => setMobileFiltersOpen((v) => !v)} aria-expanded={mobileFiltersOpen} className={GHOST}>
              Buscar y filtrar{boardFiltered ? " ·" : ""}
            </button>
            <ViewToggle view={view} />
          </div>
        </div>
        {mobileFiltersOpen ? <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2.5 lg:hidden">{filterControls}</div> : null}
      </PageShell>

      {error ? <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}

      {tab === "board" ? (
        <>
          <CohortStrip cohort={cohort} onPeriod={(fp, ff, ft) => go({ fp, ff, ft })} onLost={() => setTab("perdidos")} />
          {view === "list" ? (
            <BoardListView cards={cards} now={now} sort={sort} onSort={setSort} onOpen={setSelected} />
          ) : (
            <PageShell ariaLabel="Tablero de pipeline" className="overflow-hidden">
              <div className="grid min-h-0 flex-1 snap-x grid-cols-[repeat(5,minmax(11rem,1fr))] gap-2 overflow-x-auto rounded-xl bg-subtle/20 p-2 sm:gap-3 sm:p-3">
                {BOARD_STAGES.map((col) => {
                  const colCards = grouped[col.key];
                  return (
                    <section key={col.key} aria-label={col.label} className="flex min-h-0 min-w-0 snap-start flex-col">
                      <header className="sticky top-0 z-10 flex items-baseline justify-between gap-2 bg-subtle/20 px-1.5 pb-2 pt-1 backdrop-blur-sm">
                        <div className="flex min-w-0 items-baseline gap-1.5">
                          <h2 className="text-sm font-semibold text-foreground">{col.label}</h2>
                          <span className="u-tnum text-xs text-faint">{colCards.length}</span>
                        </div>
                        {columnMoney[col.key] !== undefined ? <span className="u-tnum shrink-0 text-xs text-muted">{priceLabelCOP(columnMoney[col.key]!)}</span> : null}
                      </header>
                      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-0.5 pb-2">
                        {colCards.length === 0 ? (
                          <p className="px-1 py-6 text-center text-[0.6875rem] text-faint">Sin oportunidades.</p>
                        ) : (
                          colCards.map((c) => (
                            <OppCard
                              key={c.id} card={c} now={now} pending={pending}
                              onOpen={() => setSelected(c)}
                              onResponder={() => router.push(`/clients/${clientId}/inbox?c=${c.conversationId}`)}
                              onCalificar={() => setModal({ kind: "qualify", card: c })}
                              onAgendar={() => router.push(`/clients/${clientId}/scheduling/agenda?book=${c.contactId}`)}
                              onEscribir={() => c.conversationId && router.push(`/clients/${clientId}/inbox?c=${c.conversationId}`)}
                              onConfirmar={() => c.apptId && run(() => confirmAppointmentAction(clientId, c.apptId!))}
                              onRecordar={() => recordar(c)}
                              onCobrar={() => c.apptId && router.push(`/clients/${clientId}/scheduling/agenda?appt=${c.apptId}&return=${c.contactId}`)}
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
                      {c.lostReason ? <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[0.625rem] font-medium text-warn">{LOST_REASON_LABEL[c.lostReason]}</span> : null}
                    </div>
                    {c.lostNote ? <p className="mt-1 line-clamp-2 text-xs text-muted">{c.lostNote}</p> : null}
                  </div>
                  <button type="button" className={GHOST} disabled={pending} onClick={() => run(() => reopenOpportunityAction(clientId, c.id))}>Reabrir</button>
                </article>
              ))
            )}
          </div>
        </PageShell>
      ) : (
        <QueueList
          clientId={clientId}
          now={now}
          items={tab === "te_esperan" ? queue : followup}
          action={tab === "te_esperan" ? "responder" : "escribir"}
          emptyText={tab === "te_esperan" ? "Nadie espera respuesta. 🎉" : "Nada pendiente de seguimiento."}
          intro={
            tab === "te_esperan"
              ? "El cliente escribió último y el negocio aún no responde. Nunca se pierden solas: contéstalas."
              : "El negocio escribió último y el cliente lleva ≥ 24 h sin responder. Un seguimiento antes de que se pierdan."
          }
        />
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

function ViewToggle({ view }: { view: View }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-chip p-0.5" role="group" aria-label="Vista">
      <button type="button" aria-pressed={view === "board"} onClick={() => viewPref.write("board")} className={`u-focus rounded-md px-2.5 py-1 text-xs transition ${view === "board" ? "bg-surface font-medium text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}>Tablero</button>
      <button type="button" aria-pressed={view === "list"} onClick={() => viewPref.write("list")} className={`u-focus rounded-md px-2.5 py-1 text-xs transition ${view === "list" ? "bg-surface font-medium text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}>Lista</button>
    </div>
  );
}

/** Urgent cards first, then recent activity (per column). */
function groupBoard(cards: BoardCard[], now: Date): Record<BoardCard["stage"], BoardCard[]> {
  const out: Record<BoardCard["stage"], BoardCard[]> = { lead: [], qualified: [], booked: [], attended: [], paid: [] };
  for (const c of cards) out[c.stage].push(c);
  for (const k of Object.keys(out) as BoardCard["stage"][]) out[k] = sortBoardColumn(out[k], now);
  return out;
}

function Tab({ active, onClick, label, count, attention }: { active: boolean; onClick: () => void; label: string; count: number; attention?: boolean }) {
  const dot = attention && count > 0;
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`u-focus flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${active ? "bg-surface text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}
    >
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-warn" /> : null}
      {label}
      <span className={`u-tnum text-[0.6875rem] ${dot ? "font-semibold text-warn" : active ? "text-muted" : "text-faint"}`}>{count}</span>
    </button>
  );
}

function FilterControls({ filters, searchDraft, setSearchDraft, apply, campaigns, ads, owners, moreOpen, setMoreOpen, moreCount, boardFiltered, onClear, view }: {
  filters: Filters;
  searchDraft: string;
  setSearchDraft: (v: string) => void;
  apply: (patch: Partial<Filters>) => void;
  campaigns: Array<{ id: string; name: string }>;
  ads: Array<{ id: string; label: string }>;
  owners: Array<{ id: string; label: string }>;
  moreOpen: boolean;
  setMoreOpen: (f: (v: boolean) => boolean) => void;
  moreCount: number;
  boardFiltered: boolean;
  onClear: () => void;
  view: View;
}) {
  return (
    <>
      <form onSubmit={(e) => { e.preventDefault(); apply({ q: searchDraft.trim() }); }} className="flex items-center">
        <input type="search" value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} placeholder="Nombre, teléfono o @usuario" aria-label="Buscar en el pipeline" className={`${INPUT} w-[13rem]`} />
      </form>
      <Select label="Origen" value={filters.origin} onChange={(v) => apply({ origin: v })} options={[{ value: "", label: "Origen" }, ...ORIGIN_GROUPS.map((g) => ({ value: g.key, label: g.label }))]} />
      {campaigns.length ? <Select label="Campaña" value={filters.campaign} onChange={(v) => apply({ campaign: v })} options={[{ value: "", label: "Campaña" }, ...campaigns.map((c) => ({ value: c.id, label: c.name }))]} /> : null}
      <div className="relative">
        <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)} className={`${GHOST} ${moreCount > 0 ? "border-foreground text-foreground" : ""}`}>
          Más filtros{moreCount > 0 ? <span className="u-tnum ml-1 rounded-full bg-foreground px-1.5 text-[0.625rem] font-semibold text-background">{moreCount}</span> : <span aria-hidden className="ml-1 text-faint">▾</span>}
        </button>
        {moreOpen ? (
          <div className="absolute right-0 z-30 mt-1 flex w-[16rem] flex-col gap-2 rounded-xl border border-line bg-surface p-3 shadow-lg">
            {ads.length ? <LabeledSelect label="Anuncio" value={filters.ad} onChange={(v) => apply({ ad: v })} options={[{ value: "", label: "Cualquier anuncio" }, ...ads.map((a) => ({ value: a.id, label: a.label }))]} /> : null}
            {owners.length ? <LabeledSelect label="Dueño" value={filters.owner} onChange={(v) => apply({ owner: v })} options={[{ value: "", label: "Cualquier dueño" }, { value: "unassigned", label: "Sin dueño" }, ...owners.map((o) => ({ value: o.id, label: o.label }))]} /> : null}
            <LabeledSelect label="Estado" value={filters.status} onChange={(v) => apply({ status: v })} options={[{ value: "", label: "Abiertas y ganadas" }, { value: "open", label: "Abiertas" }, { value: "won", label: "Ganadas" }]} />
            <div className="flex items-center gap-1.5">
              <label className="flex flex-1 flex-col gap-1 text-[0.625rem] text-muted">Abierta desde<input type="date" value={filters.from} onChange={(e) => apply({ from: e.target.value })} className={INPUT} /></label>
              <label className="flex flex-1 flex-col gap-1 text-[0.625rem] text-muted">hasta<input type="date" value={filters.to} onChange={(e) => apply({ to: e.target.value })} className={INPUT} /></label>
            </div>
          </div>
        ) : null}
      </div>
      {boardFiltered ? <button type="button" className={GHOST} onClick={onClear}>Quitar filtros</button> : null}
      <div className="hidden items-center gap-0.5 rounded-lg bg-chip p-0.5 lg:flex" role="group" aria-label="Vista">
        <button type="button" aria-pressed={view === "board"} onClick={() => viewPref.write("board")} className={`u-focus rounded-md px-2.5 py-1 text-xs transition ${view === "board" ? "bg-surface font-medium text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}>Tablero</button>
        <button type="button" aria-pressed={view === "list"} onClick={() => viewPref.write("list")} className={`u-focus rounded-md px-2.5 py-1 text-xs transition ${view === "list" ? "bg-surface font-medium text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}>Lista</button>
      </div>
    </>
  );
}

// ── COHORT STRIP ──────────────────────────────────────────────────────────────────────────────

function CohortStrip({ cohort, onPeriod, onLost }: {
  cohort: CohortView;
  onPeriod: (fp: string, ff: string | null, ft: string | null) => void;
  onLost: () => void;
}) {
  const { period, steps, size, lost, topLoss } = cohort;
  const paid = steps.find((s) => s.stage === "paid")?.reached ?? 0;
  const conversion = size > 0 ? Math.round((paid / size) * 100) : null;
  return (
    <PageShell grow={false} clip={false}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 overflow-x-auto px-3 py-2 sm:px-4">
        <CohortSelector period={period} months={cohort.months} onPeriod={onPeriod} />
        <span aria-hidden className="h-4 w-px bg-line" />
        <div className="flex flex-nowrap items-center gap-2 text-xs" aria-label="Embudo del cohorte">
          {steps.map((step, i) => (
            <span key={step.stage} className="flex shrink-0 items-center gap-2">
              {i > 0 ? <span className="u-tnum text-faint" title={`${step.convPct ?? 0}% del paso anterior`}>→ {step.convPct ?? 0}%</span> : null}
              <span className="text-muted">{step.label} <span className="u-tnum font-semibold text-foreground">{step.reached}</span></span>
            </span>
          ))}
        </div>
        <button type="button" onClick={onLost} className="u-focus shrink-0 text-xs text-muted transition hover:text-foreground">
          Perdidos <span className="u-tnum font-semibold">{lost}</span>
          {topLoss ? <span className="text-faint"> · {topLossPhrase(topLoss.reason)}</span> : null}
        </button>
        <span className="ml-auto shrink-0 text-xs text-muted">Conversión <span className="u-tnum font-semibold text-foreground">{conversion === null ? "—" : `${conversion}%`}</span></span>
      </div>
    </PageShell>
  );
}

function topLossPhrase(reason: LostReason): string {
  switch (reason) {
    case "no_respondio": return "la mayoría no respondió";
    case "no_asistio": return "la mayoría no asistió";
    case "precio": return "la mayoría por precio";
    case "horario": return "la mayoría por horario";
    default: return "la mayoría por otros motivos";
  }
}

function CohortSelector({ period, months, onPeriod }: { period: CohortPeriod; months: CohortMonthOption[]; onPeriod: (fp: string, ff: string | null, ft: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [cf, setCf] = useState(period.customFrom);
  const [ct, setCt] = useState(period.customTo);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="u-focus flex items-center gap-1.5 text-sm font-medium text-foreground">
        {period.label}
        {period.inProgress ? <span title="Los leads recientes todavía pueden avanzar; estos porcentajes van a subir." className="rounded-full bg-chip px-1.5 py-0.5 text-[0.5625rem] font-medium text-muted">en curso</span> : null}
        <span aria-hidden className="text-faint">▾</span>
      </button>
      {open ? (
        <div className="absolute left-0 z-30 mt-1 flex max-h-[20rem] w-[14rem] flex-col overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg">
          {months.map((m) => (
            <button key={m.key} type="button" onClick={() => { onPeriod(m.key, null, null); setOpen(false); }} className={`u-focus rounded-md px-2.5 py-1.5 text-left text-xs transition hover:bg-subtle ${period.key === m.key ? "font-semibold text-foreground" : "text-muted"}`}>
              {m.label}
            </button>
          ))}
          <div className="my-1 h-px bg-line" />
          {!custom ? (
            <button type="button" onClick={() => setCustom(true)} className="u-focus rounded-md px-2.5 py-1.5 text-left text-xs text-muted transition hover:bg-subtle">Personalizado…</button>
          ) : (
            <div className="flex flex-col gap-1.5 p-1.5">
              <label className="flex flex-col gap-0.5 text-[0.625rem] text-muted">Desde<input type="date" value={cf} onChange={(e) => setCf(e.target.value)} className={INPUT} /></label>
              <label className="flex flex-col gap-0.5 text-[0.625rem] text-muted">Hasta<input type="date" value={ct} onChange={(e) => setCt(e.target.value)} className={INPUT} /></label>
              <button type="button" disabled={!cf || !ct || cf > ct} onClick={() => { onPeriod("custom", cf, ct); setOpen(false); }} className={`${PRIMARY} h-[30px]`}>Aplicar</button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── CARD ────────────────────────────────────────────────────────────────────────────────────

function Avatar({ card }: { card: BoardCard }) {
  return (
    <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-chip text-[0.625rem] font-semibold text-muted">
      {card.avatar}
    </span>
  );
}

/** A tiny status line: a "●" dot (attention) or a clock (muted) + text. */
function StatusLine({ tone, text, icon }: { tone: "attention" | "muted" | "accent"; text: string; icon?: "dot" | "clock" | "check" }) {
  const color = tone === "attention" ? "text-warn" : tone === "accent" ? "text-accent" : "text-muted";
  return (
    <p className={`flex items-center gap-1 truncate text-[0.6875rem] ${tone === "attention" ? "font-medium" : ""} ${color}`}>
      {icon === "dot" ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" /> : null}
      {icon === "clock" ? <ClockIcon /> : null}
      {icon === "check" ? <CheckIcon /> : null}
      <span className="truncate">{text}</span>
    </p>
  );
}

function OppCard({ card, now, pending, onOpen, onResponder, onCalificar, onAgendar, onEscribir, onConfirmar, onRecordar, onCobrar }: {
  card: BoardCard;
  now: Date;
  pending: boolean;
  onOpen: () => void;
  onResponder: () => void;
  onCalificar: () => void;
  onAgendar: () => void;
  onEscribir: () => void;
  onConfirmar: () => void;
  onRecordar: () => void;
  onCobrar: () => void;
}) {
  const urgency = cardUrgency(card, now);
  const timeAgo = card.stageSince ? agoCompact(card.stageSince, now) : card.lastMessageAt ? agoCompact(card.lastMessageAt, now) : null;
  return (
    <article
      className={`relative flex flex-col gap-1.5 rounded-xl border bg-surface p-3 shadow-sm transition-colors hover:border-line-strong focus-within:border-line-strong ${urgency ? "border-[var(--warn-rule)]" : "border-line"}`}
      title={urgency ? urgencyReason(urgency) : undefined}
    >
      <div className="flex items-start gap-2">
        <Avatar card={card} />
        <button type="button" onClick={onOpen} className={`u-focus min-w-0 flex-1 truncate text-left text-[0.8125rem] font-semibold after:absolute after:inset-0 after:rounded-xl after:content-[''] hover:underline ${card.nameMuted ? "italic text-muted" : "text-foreground"}`}>
          {card.name}
        </button>
        {timeAgo ? <span className="u-tnum shrink-0 text-[0.625rem] text-faint">{timeAgo}</span> : null}
      </div>
      <div className="flex flex-col gap-1">
        <CardBody card={card} now={now} />
      </div>
      <CardAction card={card} pending={pending} urgency={urgency}
        onResponder={onResponder} onCalificar={onCalificar} onAgendar={onAgendar} onEscribir={onEscribir} onConfirmar={onConfirmar} onRecordar={onRecordar} onCobrar={onCobrar} />
    </article>
  );
}

/** The 1–2 stage lines (no action). */
function CardBody({ card, now }: { card: BoardCard; now: Date }) {
  if (card.stage === "lead") {
    const origin = originLineOf(card);
    return (
      <>
        <p className="truncate text-[0.6875rem] text-muted" title={originTitleOf(card)}>{origin === "Desconocido" ? "Origen desconocido" : origin}</p>
        {card.spokeLast === "customer" && card.lastMessageAt
          ? <StatusLine tone="attention" icon="dot" text={`Te escribió ${relativeAgeShort(card.lastMessageAt, now)}`} />
          : <StatusLine tone="muted" text="Esperando al cliente" />}
      </>
    );
  }
  if (card.stage === "qualified") {
    const ev = card.qualService ? `Quiere ${card.qualService.toLocaleLowerCase("es")}${card.qualTimeframe ? ` · ${card.qualTimeframe}` : ""}` : qualificationLineOf(card);
    const stale = card.spokeLast !== "customer" && card.lastMessageAt && now.getTime() - new Date(card.lastMessageAt).getTime() > 86_400_000;
    return (
      <>
        {ev ? <p className="truncate text-[0.6875rem] text-muted">{ev}</p> : null}
        {stale ? <StatusLine tone="muted" icon="clock" text={`Sin respuesta · ${agoShort(card.lastMessageAt!, now)}`} /> : null}
      </>
    );
  }
  if (card.stage === "booked") {
    const when = apptWhenLine(card, now);
    const confirmed = card.apptStatus === "confirmed";
    const today = cardUrgency(card, now) === "reservo_today_unconfirmed";
    return (
      <>
        {when ? <p className="truncate text-[0.6875rem] text-foreground">{when}</p> : null}
        {confirmed
          ? <StatusLine tone="accent" icon="check" text="Confirmada" />
          : today
            ? <StatusLine tone="attention" icon="dot" text="Sin confirmar" />
            : <StatusLine tone="muted" text={apptDayLabel(card, now) ? `Sin confirmar · ${apptDayLabel(card, now)!.toLocaleLowerCase("es")}` : "Sin confirmar"} />}
      </>
    );
  }
  if (card.stage === "attended") {
    const line = card.apptService ? `${card.apptService} · ${apptDatePhrase(card, now) ?? ""}` : null;
    const overdue = cardUrgency(card, now) === "asistio_overdue";
    return (
      <>
        {line ? <p className="truncate text-[0.6875rem] text-muted">{line}</p> : null}
        {overdue
          ? <StatusLine tone="attention" icon="dot" text={`Sin cobrar · ${card.stageSince ? agoShort(card.stageSince, now) : ""}`} />
          : <StatusLine tone="muted" icon="clock" text="Cobro pendiente" />}
      </>
    );
  }
  // paid
  return <p className="truncate text-[0.6875rem] text-muted">{card.paidMethod ?? "Pagado"}</p>;
}

/** At most one action button per card (bottom). */
function CardAction({ card, pending, urgency, onResponder, onCalificar, onAgendar, onEscribir, onConfirmar, onRecordar, onCobrar }: {
  card: BoardCard;
  pending: boolean;
  urgency: ReturnType<typeof cardUrgency>;
  onResponder: () => void;
  onCalificar: () => void;
  onAgendar: () => void;
  onEscribir: () => void;
  onConfirmar: () => void;
  onRecordar: () => void;
  onCobrar: () => void;
}) {
  const name = card.nameMuted ? "este contacto" : card.name;
  const btn = (label: string, onClick: () => void, opts: { primary?: boolean; aria: string; disabled?: boolean } ) => (
    <button type="button" onClick={onClick} disabled={pending || opts.disabled} aria-label={opts.aria} className={`relative z-10 ${opts.primary ? PRIMARY : GHOST}`}>{label}</button>
  );
  if (card.stage === "lead") {
    return urgency === "lead_waiting"
      ? btn("Responder", onResponder, { primary: true, aria: `Responder a ${name}`, disabled: !card.conversationId })
      : btn("Calificar", onCalificar, { aria: `Calificar a ${name}` });
  }
  if (card.stage === "qualified") {
    return card.qualService
      ? btn("Agendar", onAgendar, { aria: `Agendar a ${name}` })
      : btn("Escribir", onEscribir, { aria: `Escribir a ${name}`, disabled: !card.conversationId });
  }
  if (card.stage === "booked") {
    if (card.apptStatus === "confirmed") return null;
    return urgency === "reservo_today_unconfirmed"
      ? btn("Confirmar", onConfirmar, { aria: `Confirmar la cita de ${name}`, disabled: !card.apptId })
      : card.conversationId
        ? btn("Recordar", onRecordar, { aria: `Recordar la cita a ${name}` })
        : null;
  }
  if (card.stage === "attended") {
    return (
      <div className="relative z-10 flex items-center justify-between gap-2">
        {card.apptListAmount ? <span className="u-tnum text-xs font-medium text-foreground">{priceLabelCOP(card.apptListAmount)}</span> : <span />}
        {btn("Cobrar", onCobrar, { aria: `Cobrar a ${name}`, disabled: !card.apptId })}
      </div>
    );
  }
  // paid — amount right-aligned, no button
  return card.paidAmount ? <p className="u-tnum text-right text-xs font-medium text-foreground">{priceLabelCOP(card.paidAmount)}</p> : null;
}

function urgencyReason(u: NonNullable<ReturnType<typeof cardUrgency>>): string {
  return u === "lead_waiting" ? "El cliente escribió y espera respuesta." : u === "reservo_today_unconfirmed" ? "La cita es hoy y sigue sin confirmar." : "La cita ya pasó y sigue sin cobrar.";
}

function ClockIcon() {
  return <svg aria-hidden width="11" height="11" viewBox="0 0 12 12" fill="none" className="shrink-0"><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.1" /><path d="M6 3.6V6l1.6 1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function CheckIcon() {
  return <svg aria-hidden width="11" height="11" viewBox="0 0 12 12" fill="none" className="shrink-0"><path d="M2.5 6.2l2.2 2.2L9.5 3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// ── QUEUE (Te esperan / Sin respuesta) ──────────────────────────────────────────────────────

function QueueList({ clientId, now, items, action, emptyText, intro }: { clientId: string; now: Date; items: QueueItem[]; action: "responder" | "escribir"; emptyText: string; intro: string }) {
  return (
    <PageShell className="overflow-y-auto" ariaLabel={action === "responder" ? "Te esperan" : "Sin respuesta"}>
      <div className="flex min-h-full flex-col gap-2 p-3 sm:p-4">
        <p className="text-xs text-muted">{intro}</p>
        {items.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted">{emptyText}</p>
        ) : (
          items.map((q) => (
            <article key={q.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
              <div className="min-w-0 flex-1">
                <Link href={`/clients/${clientId}/contacts/${q.contactId}`} className="truncate text-sm font-medium text-foreground hover:underline">{q.name}</Link>
                <p className="mt-0.5 text-[0.6875rem] text-faint">{STAGE_LABEL[q.stage as keyof typeof STAGE_LABEL] ?? q.stage} · {relativeAgeShort(q.lastMessageAt, now)}</p>
              </div>
              {q.conversationId ? (
                <Link href={`/clients/${clientId}/inbox?c=${q.conversationId}`} aria-label={`${action === "responder" ? "Responder a" : "Escribir a"} ${q.name}`} className={action === "responder" ? PRIMARY : GHOST}>
                  {action === "responder" ? "Responder" : "Escribir"}
                </Link>
              ) : null}
            </article>
          ))
        )}
      </div>
    </PageShell>
  );
}

// ── LIST VIEW ────────────────────────────────────────────────────────────────────────────────

function SortTh({ sort, onSort, k, label, className = "" }: { sort: Sort; onSort: (s: Sort) => void; k: SortKey; label: string; className?: string }) {
  const active = sort.key === k;
  const toggle = () => onSort(active ? { key: k, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "name" || k === "owner" || k === "stage" ? "asc" : "desc" });
  return (
    <th scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={`whitespace-nowrap px-2.5 py-1.5 text-left font-medium ${className}`}>
      <button type="button" onClick={toggle} className="u-focus inline-flex items-center gap-1 hover:text-foreground">{label}<span aria-hidden className="text-[0.625rem] text-faint">{active ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span></button>
    </th>
  );
}

function BoardListView({ cards, now, sort, onSort, onOpen }: { cards: BoardCard[]; now: Date; sort: Sort; onSort: (s: Sort) => void; onOpen: (card: BoardCard) => void }) {
  const STAGE_ORDER: Record<BoardCard["stage"], number> = { lead: 0, qualified: 1, booked: 2, attended: 3, paid: 4 };
  const key = (c: BoardCard): string | number => {
    switch (sort.key) {
      case "name": return c.name.toLocaleLowerCase("es");
      case "stage": return STAGE_ORDER[c.stage];
      case "appt": return c.apptStartAt ?? "";
      case "lastMsg": return c.lastMessageAt ?? "";
      case "owner": return (c.owner?.name ?? "").toLocaleLowerCase("es");
      default: return c.stageSince ?? "";
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
        <table className="w-full min-w-[52rem] border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-surface text-muted shadow-[0_1px_0_var(--line)]">
            <tr>
              <SortTh sort={sort} onSort={onSort} k="name" label="Contacto" className="pl-4" />
              <SortTh sort={sort} onSort={onSort} k="stage" label="Etapa" />
              <th scope="col" className="whitespace-nowrap px-2.5 py-1.5 text-left font-medium">Siguiente paso</th>
              <SortTh sort={sort} onSort={onSort} k="appt" label="Cita" />
              <SortTh sort={sort} onSort={onSort} k="time" label="En etapa" />
              <SortTh sort={sort} onSort={onSort} k="owner" label="Dueño" className="pr-4" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.id} className="relative border-t border-line-soft hover:bg-subtle/60">
                <td className="max-w-[12rem] truncate px-2.5 py-2 pl-4"><button type="button" onClick={() => onOpen(c)} className={`u-focus truncate text-left font-medium after:absolute after:inset-0 hover:underline ${c.nameMuted ? "italic text-muted" : "text-foreground"}`}>{c.name}</button></td>
                <td className="whitespace-nowrap px-2.5 py-2 text-muted">{STAGE_LABEL[c.stage]}</td>
                <td className="max-w-[16rem] truncate px-2.5 py-2 text-muted">{nextStep(c)}</td>
                <td className="whitespace-nowrap px-2.5 py-2 text-muted">{apptWhenLine(c, now) ?? "—"}</td>
                <td className="whitespace-nowrap px-2.5 py-2 text-muted">{c.stageSince ? agoShort(c.stageSince, now) : "—"}</td>
                <td className="whitespace-nowrap px-2.5 py-2 pr-4 text-muted">{c.owner?.name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PageShell>
  );
}

/** The list-view "siguiente paso" summary (mirrors the card's primary line). */
function nextStep(c: BoardCard): string {
  if (c.stage === "lead") return c.spokeLast === "customer" ? "Te escribió — responder" : "Esperando al cliente";
  if (c.stage === "qualified") return c.qualService ? `Quiere ${c.qualService.toLocaleLowerCase("es")} — agendar` : "Escribir";
  if (c.stage === "booked") return c.apptStatus === "confirmed" ? "Confirmada" : "Sin confirmar";
  if (c.stage === "attended") return !c.hasPayment ? "Cobro pendiente" : "Cobrado";
  return c.paidMethod ?? "Pagado";
}

// ── MODALS + SELECTS ────────────────────────────────────────────────────────────────────────

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
      <label className="flex flex-col gap-1 text-xs font-medium text-foreground">Servicio de interés<input value={service} onChange={(e) => setService(e.target.value)} placeholder="Ej. Corte + barba" className={`${INPUT} w-full`} /></label>
      <label className="flex flex-col gap-1 text-xs font-medium text-foreground">Plazo<input value={timeframe} onChange={(e) => setTimeframe(e.target.value)} placeholder="Ej. esta semana" className={`${INPUT} w-full`} /></label>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className={GHOST} onClick={onClose}>Cancelar</button>
        <button type="button" className={MODAL_BTN} disabled={pending || !service.trim() || !timeframe.trim()} onClick={() => onSubmit(service.trim(), timeframe.trim())}>Calificar</button>
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
      <label className="flex flex-col gap-1 text-xs font-medium text-foreground">Motivo
        <select value={reason} onChange={(e) => setReason(e.target.value)} className={`${INPUT} w-full`}>{LOST_REASONS.map((r) => <option key={r} value={r}>{LOST_REASON_LABEL[r]}</option>)}</select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-foreground">Nota {needsNote ? <span className="text-danger">(obligatoria)</span> : <span className="font-normal text-faint">(opcional)</span>}
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-foreground" />
      </label>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className={GHOST} onClick={onClose}>Cancelar</button>
        <button type="button" className={MODAL_BTN} disabled={pending || (needsNote && !note.trim())} onClick={() => onSubmit(reason, note.trim())}>Marcar perdida</button>
      </div>
    </ModalShell>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={`${INPUT} max-w-[11rem]`}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
    </label>
  );
}
function LabeledSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label className="flex flex-col gap-1 text-[0.625rem] text-muted">{label}
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={`${INPUT} w-full`}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
    </label>
  );
}
