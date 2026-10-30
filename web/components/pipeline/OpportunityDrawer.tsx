"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { OVERLAY_SCRIM, useTrappedPanel } from "@/components/ui/Overlay";
import { formatStampFull, relativeAgeShort } from "@/lib/format";
import { priceLabelCOP } from "@/lib/money";
import { STAGE_LABEL, LOST_REASON_LABEL, type BoardCard } from "@/lib/pipelineBoard";
import { loadOpportunityDrawerAction, type DrawerData } from "@/lib/pipelineActions";

/** Appointment status → the same words the agenda uses. */
const APPT_STATUS_LABEL: Record<string, string> = {
  scheduled: "Sin confirmar",
  confirmed: "Confirmada",
  completed: "Completada",
  no_show: "No asistió",
  cancelled: "Cancelada",
};

/** Stage-event reason codes → plain Spanish. Unknown codes fall back to a humanised form. */
const REASON_LABEL: Record<string, string> = {
  qualified: "Calificada",
  bot_qualify_new: "Calificada por el bot",
  bot_qualify_reopen: "Reabierta y calificada por el bot",
  booking: "Reservó una cita",
  booking_new: "Reservó una cita",
  appointment_completed: "Asistió a la cita",
  appointment_cancelled: "Cita cancelada",
  no_asistio: "No asistió",
  no_respondio: "Sin respuesta",
  inbound: "Nueva conversación",
  inbound_ad: "Entró por un anuncio",
  inbound_new: "Nueva conversación",
  manual_reopen: "Reabierta manualmente",
  payment_recorded: "Pago registrado",
  payment_voided: "Pago anulado",
  payment_new: "Pago registrado",
  precio: "Precio",
  horario: "Horario",
  otro: "Otro",
};
function reasonLabel(code: string | null): string | null {
  if (!code) return null;
  return REASON_LABEL[code] ?? code.replace(/_/g, " ");
}

const STAGE_SEQUENCE: Array<{ key: keyof DrawerData["stages"]; label: string }> = [
  { key: "lead", label: "Lead" },
  { key: "qualified", label: "Calificado" },
  { key: "booked", label: "Reservó" },
  { key: "attended", label: "Asistió" },
  { key: "paid", label: "Pagó" },
];

const SENDER_LABEL: Record<DrawerData["messages"][number]["sender"], string> = {
  user: "Cliente",
  bot: "Bot",
  human_agent: "Agente",
};

/**
 * JP-7 §4 — the opportunity DRAWER. Clicking a card (board or list) opens this beside the board, not
 * a page change: a right-hand panel on desktop, a full-height sheet on phone. It shows the full
 * stage timeline with timestamps, the qualification evidence, the linked appointment(s), the recorded
 * payment (only when the loader returned one — it is gated server-side by payments.view), the last
 * few messages with a link into the Inbox, and the stage history with who did each transition. The
 * same actions as the card live at the foot; "Ver ficha" still links to the contact record.
 *
 * Reads load through `loadOpportunityDrawerAction` in an async effect (state set only in `.then`, so
 * no setState-in-effect); the parent keys this on the card id, so each selection mounts fresh.
 */
export function OpportunityDrawer({
  clientId,
  card,
  now,
  pending,
  trapActive = true,
  onClose,
  onQualify,
  onUnqualify,
  onLose,
  onReopen,
}: {
  clientId: string;
  card: BoardCard;
  now: Date;
  pending: boolean;
  /** Pause the focus trap while a modal (Calificar / Perder) is layered over the drawer, so Escape
   *  and Tab belong to that modal, not the drawer. */
  trapActive?: boolean;
  onClose: () => void;
  onQualify: () => void;
  onUnqualify: () => void;
  onLose: () => void;
  onReopen: () => void;
}) {
  const [data, setData] = useState<DrawerData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  const close = useCallback(() => closeRef.current(), []);
  const panelRef = useTrappedPanel({ active: trapActive, onClose: close });

  useEffect(() => {
    let alive = true;
    loadOpportunityDrawerAction(clientId, card.id).then((r) => {
      if (!alive) return;
      if (r.ok) setData(r.data);
      else setLoadError(r.error ?? "No se pudo cargar la oportunidad.");
    });
    return () => {
      alive = false;
    };
  }, [clientId, card.id]);

  const isOpen = card.status === "open";
  const isLost = card.status === "lost";
  const contactHref = `/clients/${clientId}/contacts/${card.contactId}`;
  const inboxHref = card.conversationId ? `/clients/${clientId}/inbox?c=${card.conversationId}` : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Cerrar" className={OVERLAY_SCRIM} onClick={close} />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Oportunidad — ${card.name}`}
        tabIndex={-1}
        className="u-drawer-in relative z-50 flex h-full w-full flex-col border-l border-line bg-surface shadow-xl sm:max-w-[26rem]"
      >
        {/* Header — name, stage, status, and the two jumps (conversation · ficha). */}
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold text-foreground">{card.name}</h2>
              <span className="shrink-0 rounded-full bg-chip px-2 py-0.5 text-[0.625rem] font-medium text-muted">{STAGE_LABEL[card.stage]}</span>
              {isLost ? <span className="shrink-0 rounded-full bg-warn-soft px-2 py-0.5 text-[0.625rem] font-medium text-warn">Perdida</span> : null}
              {card.status === "won" ? <span className="shrink-0 rounded-full bg-[var(--success-soft)] px-2 py-0.5 text-[0.625rem] font-medium text-[var(--success)]">Ganada</span> : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className={`inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${card.originChip.tone}`}>
                {card.originChip.label}
                {card.originDetail ? <span className="font-normal opacity-80">· {card.originDetail}</span> : null}
              </span>
              {card.owner ? <span className="text-[0.625rem] text-faint">Dueño: {card.owner.name ?? "asignado"}</span> : null}
            </div>
          </div>
          <button type="button" onClick={close} aria-label="Cerrar" className="u-focus -mr-1 shrink-0 rounded-lg p-1.5 text-muted transition hover:bg-subtle hover:text-foreground">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {/* Body — scrolls; the actions footer stays pinned. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {loadError ? (
            <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{loadError}</p>
          ) : !data ? (
            <div className="space-y-3" aria-hidden>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-subtle" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {/* STAGE TIMELINE — every stage this sale reached, with its timestamp. */}
              <Section title="Progreso">
                <ol className="flex flex-col gap-0">
                  {STAGE_SEQUENCE.map((s, i) => {
                    const at = data.stages[s.key];
                    const reached = Boolean(at);
                    const current = card.stage === s.key && isOpen;
                    return (
                      <li key={s.key} className="flex items-start gap-2.5">
                        <div className="flex flex-col items-center self-stretch">
                          <span className={`mt-1 size-2 shrink-0 rounded-full ${reached ? "bg-foreground" : "bg-line-strong"}`} />
                          {i < STAGE_SEQUENCE.length - 1 ? <span className={`w-px flex-1 ${reached ? "bg-line-strong" : "bg-line"}`} /> : null}
                        </div>
                        <div className={`flex min-w-0 flex-1 items-baseline justify-between gap-2 pb-3 ${reached ? "" : "opacity-45"}`}>
                          <span className={`text-xs ${current ? "font-semibold text-foreground" : reached ? "font-medium text-foreground" : "text-muted"}`}>
                            {s.label}{current ? " · actual" : ""}
                          </span>
                          {at ? <time dateTime={at} className="shrink-0 text-[0.625rem] text-faint" title={formatStampFull(new Date(at))}>{relativeAgeShort(at, now)}</time> : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </Section>

              {/* QUALIFICATION EVIDENCE. */}
              {data.qualification ? (
                <Section title="Calificación">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                    <Field label="Servicio" value={data.qualification.service} />
                    <Field label="Plazo" value={data.qualification.timeframe} />
                    <Field label="Por" value={data.qualification.byLabel ? `${data.qualification.byLabel}${data.qualification.implicit ? " (implícita)" : ""}` : null} />
                  </dl>
                </Section>
              ) : null}

              {/* LOST — reason + note, only when lost. */}
              {data.lost ? (
                <Section title="Pérdida">
                  <p className="text-xs text-foreground">
                    <span className="rounded-full bg-warn-soft px-2 py-0.5 font-medium text-warn">{LOST_REASON_LABEL[data.lost.reason]}</span>
                    {data.lost.atLabel ? <span className="ml-2 text-faint" title={formatStampFull(new Date(data.lost.atLabel))}>{relativeAgeShort(data.lost.atLabel, now)}</span> : null}
                  </p>
                  {data.lost.note ? <p className="mt-1.5 whitespace-pre-wrap text-xs text-muted">{data.lost.note}</p> : null}
                </Section>
              ) : null}

              {/* APPOINTMENTS. */}
              {data.appointments.length > 0 ? (
                <Section title={data.appointments.length > 1 ? "Citas" : "Cita"}>
                  <ul className="flex flex-col gap-1.5">
                    {data.appointments.map((a) => (
                      <li key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-subtle/40 px-2.5 py-1.5 text-xs">
                        <span className="min-w-0 truncate text-foreground">
                          <span className="font-medium">{a.service || "Cita"}</span>
                          <span className="text-muted"> · {formatStampFull(new Date(a.startAt))}</span>
                        </span>
                        <span className={`shrink-0 text-[0.625rem] ${a.status === "cancelled" || a.status === "no_show" ? "text-warn" : "text-faint"}`}>
                          {APPT_STATUS_LABEL[a.status] ?? a.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {/* PAYMENT — present only when the loader returned one (gated by payments.view). */}
              {data.payment ? (
                <Section title="Pago">
                  <p className="text-xs font-medium text-[var(--success)]">
                    {priceLabelCOP(data.payment.total) ?? "—"}
                    {data.payment.method ? <span className="font-normal text-muted"> · {data.payment.method}</span> : null}
                  </p>
                </Section>
              ) : null}

              {/* LAST MESSAGES + a jump into the Inbox. */}
              {data.messages.length > 0 || inboxHref ? (
                <Section
                  title="Últimos mensajes"
                  action={inboxHref ? <Link href={inboxHref} className="u-focus text-[0.6875rem] font-medium text-accent hover:underline">Abrir conversación</Link> : undefined}
                >
                  {data.messages.length > 0 ? (
                    <ul className="flex flex-col gap-1.5">
                      {data.messages.map((m) => (
                        <li key={m.id} className="rounded-lg bg-subtle/50 px-2.5 py-1.5">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-[0.625rem] font-medium text-muted">{SENDER_LABEL[m.sender]}</span>
                            <time dateTime={m.at} className="shrink-0 text-[0.625rem] text-faint">{relativeAgeShort(m.at, now)}</time>
                          </div>
                          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-xs text-foreground">{m.text || <span className="text-faint">(sin texto)</span>}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-faint">Sin mensajes registrados.</p>
                  )}
                </Section>
              ) : null}

              {/* STAGE HISTORY — who did each transition, and when. */}
              {data.history.length > 0 ? (
                <Section title="Historial">
                  <ul className="flex flex-col gap-2">
                    {data.history.map((e) => (
                      <li key={e.id} className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="min-w-0">
                          <span className="text-foreground">{historyLine(e)}</span>
                          <span className="text-faint"> · {e.actorLabel}</span>
                        </span>
                        <time dateTime={e.at} className="shrink-0 text-[0.625rem] text-faint" title={formatStampFull(new Date(e.at))}>{relativeAgeShort(e.at, now)}</time>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </div>
          )}
        </div>

        {/* ACTIONS — the same set as the card, plus "Ver ficha". */}
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-4 py-3 sm:px-5">
          {card.stage === "lead" ? (
            <button type="button" className={PRIMARY} disabled={pending} onClick={onQualify}>Calificar</button>
          ) : null}
          {card.stage === "qualified" ? (
            <button type="button" className={GHOST} disabled={pending} onClick={onUnqualify}>Quitar calificación</button>
          ) : null}
          {isLost ? (
            <button type="button" className={GHOST} disabled={pending} onClick={onReopen}>Reabrir</button>
          ) : null}
          {isOpen ? (
            <button type="button" className={DANGER} disabled={pending} onClick={onLose}>Marcar perdida</button>
          ) : null}
          <Link href={contactHref} className={`${GHOST} ml-auto`}>Ver ficha</Link>
        </footer>
      </aside>
    </div>
  );
}

function historyLine(e: DrawerData["history"][number]): string {
  const reason = reasonLabel(e.reason);
  if (reason) return reason;
  if (e.toStatus === "lost") return "Perdida";
  if (e.toStatus === "won") return "Ganada";
  if (e.toStage && e.toStage !== e.fromStage) return `→ ${STAGE_LABEL[e.toStage]}`;
  return "Actualización";
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-[0.625rem] font-semibold uppercase tracking-wide text-faint">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-foreground">{value || "—"}</dd>
    </>
  );
}

const PRIMARY = "u-focus inline-flex h-[34px] items-center justify-center rounded-lg bg-foreground px-3.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50";
const GHOST = "u-focus inline-flex h-[34px] items-center justify-center rounded-lg border border-line px-3 text-xs text-muted transition hover:bg-subtle hover:text-foreground disabled:opacity-50";
const DANGER = "u-focus inline-flex h-[34px] items-center justify-center rounded-lg border border-danger/40 px-3 text-xs font-medium text-danger transition hover:bg-danger/10 disabled:opacity-50";
