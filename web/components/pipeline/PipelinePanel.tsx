"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PageShell } from "@/components/ui/PageShell";
import { OVERLAY_SCRIM, useTrappedPanel } from "@/components/ui/Overlay";
import { Menu, MenuButton, MenuLink, MenuSeparator } from "@/components/scheduling/ui/Menu";
import { formatStampFull, relativeAgeShort } from "@/lib/format";
import { ORIGIN_GROUPS } from "@/lib/originDisplay";
import {
  BOARD_STAGES,
  LOST_REASON_LABEL,
  LOST_REASONS,
  STAGE_LABEL,
  groupByStage,
  originLineOf,
  originTitleOf,
  sortByActivityDesc,
  spokeLastDisplay,
  type BoardCard,
} from "@/lib/pipelineBoard";
import {
  markOpportunityLostAction,
  qualifyOpportunityAction,
  reopenOpportunityAction,
  unqualifyOpportunityAction,
} from "@/lib/pipelineActions";

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
}

const BTN =
  "inline-flex h-[36px] items-center justify-center rounded-lg bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50";
const GHOST =
  "inline-flex h-[32px] items-center justify-center rounded-lg border border-line px-2.5 text-xs text-muted transition hover:bg-subtle hover:text-foreground disabled:opacity-50";
const PRIMARY_SM =
  "u-focus inline-flex h-[32px] items-center justify-center rounded-lg bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50";
const INPUT =
  "h-[36px] rounded-lg border border-line-strong bg-surface px-2.5 text-xs text-foreground outline-none transition focus:border-foreground";

type Tab = "board" | "perdidos" | "cola";

export function PipelinePanel({
  clientId,
  clientName,
  cards,
  lostCards,
  queue,
  campaigns,
  ads,
  filters,
}: {
  clientId: string;
  clientName: string;
  cards: BoardCard[];
  lostCards: BoardCard[];
  queue: QueueItem[];
  campaigns: Array<{ id: string; name: string }>;
  ads: Array<{ id: string; label: string }>;
  filters: Filters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>("board");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [modal, setModal] = useState<null | { kind: "qualify" | "lost"; card: BoardCard }>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "No se pudo completar la acción.");
      else {
        setModal(null);
        router.refresh();
      }
    });
  };

  const apply = (patch: Partial<Filters>) => {
    const p = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const grouped = groupByStage(sortByActivityDesc(cards));
  const now = new Date();
  const filtered = Boolean(filters.origin || filters.campaign || filters.ad || filters.from || filters.to || filters.status);

  return (
    <main className="flex min-h-0 w-full flex-1 flex-col gap-[var(--content-pad)]">
      <PageShell grow={false} clip={false}>
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2.5">
              <h1 className="truncate text-xl font-semibold tracking-[-0.025em] text-foreground">Pipeline</h1>
              <span className="truncate text-xs text-muted">{clientName}</span>
            </div>
            <p className="mt-0.5 hidden text-xs text-muted sm:block">
              Cada oportunidad es una venta. Reservó y Asistió vienen de las citas; aquí calificas, pierdes o reabres.
            </p>
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
          <PageShell grow={false} clip={false}>
            <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
              <Select label="Origen" value={filters.origin} onChange={(v) => apply({ origin: v })} options={[{ value: "", label: "Cualquier origen" }, ...ORIGIN_GROUPS.map((g) => ({ value: g.key, label: g.label }))]} />
              {campaigns.length ? (
                <Select label="Campaña" value={filters.campaign} onChange={(v) => apply({ campaign: v })} options={[{ value: "", label: "Cualquier campaña" }, ...campaigns.map((c) => ({ value: c.id, label: c.name }))]} />
              ) : null}
              {ads.length ? (
                <Select label="Anuncio" value={filters.ad} onChange={(v) => apply({ ad: v })} options={[{ value: "", label: "Cualquier anuncio" }, ...ads.map((a) => ({ value: a.id, label: a.label }))]} />
              ) : null}
              <Select label="Estado" value={filters.status} onChange={(v) => apply({ status: v })} options={[{ value: "", label: "Abiertas y ganadas" }, { value: "open", label: "Abiertas" }, { value: "won", label: "Ganadas" }]} />
              <label className="flex items-center gap-1.5 text-xs text-muted">
                Abierta desde
                <input type="date" value={filters.from} onChange={(e) => apply({ from: e.target.value })} aria-label="Abierta desde" className={INPUT} />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                hasta
                <input type="date" value={filters.to} onChange={(e) => apply({ to: e.target.value })} aria-label="Abierta hasta" className={INPUT} />
              </label>
              {filtered ? (
                <button type="button" className={GHOST} onClick={() => apply({ origin: "", campaign: "", ad: "", from: "", to: "", status: "" })}>
                  Quitar filtros
                </button>
              ) : null}
            </div>
          </PageShell>

          {/* The board FILLS the height below the filters and never grows the page: the row is
              flex-1 min-h-0 and scrolls horizontally; each column stretches to full height and
              scrolls its OWN cards (overflow-y), with its header pinned at the top. Columns keep a
              comfortable fixed width and scroll-snap when they don't fit (narrow / phone). */}
          <PageShell ariaLabel="Tablero de pipeline" className="overflow-hidden">
            <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto p-3 sm:p-4">
              {BOARD_STAGES.map((col) => {
                if (col.disabled) {
                  // Pagó: a slim, always-empty column so the four live columns get the width. The
                  // note lives in the tooltip (there are no cards to label).
                  return (
                    <section
                      key={col.key}
                      aria-label={`${col.label} — llega con la fase de pagos`}
                      title="Llega con la fase de pagos"
                      className="flex w-12 shrink-0 snap-start flex-col items-center justify-start gap-2 rounded-xl border border-dashed border-line bg-subtle/30 py-3 text-faint"
                    >
                      <span className="rotate-180 text-xs font-semibold tracking-wide [writing-mode:vertical-rl]">{col.label}</span>
                    </section>
                  );
                }
                const colCards = grouped[col.key];
                return (
                  <section key={col.key} aria-label={col.label} className="flex min-h-0 w-[17rem] shrink-0 snap-start flex-col rounded-xl border border-line bg-subtle/40">
                    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-2.5 py-2">
                      <h2 className="text-xs font-semibold text-foreground">{col.label}</h2>
                      <span className="u-mono rounded bg-chip px-1.5 py-0.5 text-[0.625rem] text-faint">{colCards.length}</span>
                    </header>
                    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                      {colCards.length === 0 ? (
                        <p className="px-1 py-6 text-center text-[0.6875rem] text-faint">Sin oportunidades.</p>
                      ) : (
                        colCards.map((c) => (
                          <OppCard key={c.id} clientId={clientId} card={c} now={now} pending={pending}
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
        </>
      ) : tab === "perdidos" ? (
        <PageShell className="overflow-y-auto" ariaLabel="Oportunidades perdidas">
          <div className="flex min-h-full flex-col gap-2 p-3 sm:p-4">
            {lostCards.length === 0 ? (
              <p className="py-10 text-center text-xs text-muted">Ninguna oportunidad perdida con estos filtros.</p>
            ) : (
              lostCards.map((c) => (
                <article key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/clients/${clientId}/contacts/${c.contactId}`} className="truncate text-sm font-medium text-foreground hover:underline">{c.name}</Link>
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

      {modal?.kind === "qualify" ? (
        <QualifyModal card={modal.card} pending={pending} onClose={() => setModal(null)} onSubmit={(service, timeframe) => run(() => qualifyOpportunityAction(clientId, modal.card.id, { service, timeframe }))} />
      ) : null}
      {modal?.kind === "lost" ? (
        <LostModal card={modal.card} pending={pending} onClose={() => setModal(null)} onSubmit={(reason, note) => run(() => markOpportunityLostAction(clientId, modal.card.id, { reason, note }))} />
      ) : null}
    </main>
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
 * A COMPACT board card: three short, non-wrapping lines — name + time in stage, a one-line origin
 * (campaign in the tooltip), and who spoke last + when (the customer's turn is emphasised: it needs
 * a reply). One primary action per stage (Lead → Calificar); the rest live in a "⋯" menu (keyboard
 * and touch, no hover-only). The whole card body is a stretched link to the contact record; the
 * action controls sit above it. No "Ganada" chip — each column already implies the status.
 */
function OppCard({ clientId, card, now, pending, onQualify, onUnqualify, onLose }: {
  clientId: string;
  card: BoardCard;
  now: Date;
  pending: boolean;
  onQualify: () => void;
  onUnqualify: () => void;
  onLose: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const spoke = spokeLastDisplay(card.spokeLast);
  const isOpen = card.status === "open";
  const contactHref = `/clients/${clientId}/contacts/${card.contactId}`;
  return (
    <article className="relative flex flex-col gap-1 rounded-lg border border-line bg-surface p-2.5 transition-colors hover:border-line-strong focus-within:border-line-strong">
      {/* Line 1 — name (stretched link → the contact record) + time in stage, right-aligned. */}
      <div className="flex items-start gap-2">
        <Link
          href={contactHref}
          className="u-focus min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-foreground no-underline after:absolute after:inset-0 after:rounded-lg after:content-[''] hover:underline"
        >
          {card.name}
        </Link>
        {card.stageSince ? (
          <span className="shrink-0 text-[0.625rem] text-faint" title={`En esta etapa desde ${formatStampFull(new Date(card.stageSince))}`}>
            {relativeAgeShort(card.stageSince, now)}
          </span>
        ) : null}
      </div>

      {/* Line 2 — origin on one line, truncated (the campaign is in the tooltip + the detail). */}
      <p className="truncate text-[0.6875rem] text-muted" title={originTitleOf(card)}>
        {originLineOf(card)}
      </p>

      {/* Line 3 — who spoke last + when. Customer last → calm emphasis (warn), this one needs a reply. */}
      {card.lastMessageAt ? (
        <p className={`truncate text-[0.625rem] ${spoke?.emphasize ? "font-medium text-warn" : "text-faint"}`}>
          {spoke?.label ?? "Mensaje"} ·{" "}
          <span title={formatStampFull(new Date(card.lastMessageAt))}>{relativeAgeShort(card.lastMessageAt, now)}</span>
        </p>
      ) : null}

      {/* Actions — one primary per stage + a menu for the rest. `relative z-10` keeps them above the
          stretched link so they stay independently clickable. */}
      <div className="relative z-10 mt-0.5 flex items-center justify-between gap-2">
        {card.stage === "lead" ? (
          <button type="button" className={PRIMARY_SM} disabled={pending} onClick={onQualify}>Calificar</button>
        ) : (
          <span aria-hidden />
        )}
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
    </article>
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
