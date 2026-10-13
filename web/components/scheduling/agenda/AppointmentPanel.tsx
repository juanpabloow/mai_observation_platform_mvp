"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useIsOverlayWidth, useTrappedPanel } from "@/components/ui/Overlay";
import { MobileAppointmentSheet } from "../mobile/MobileAppointmentSheet";
import { appointmentActionPlan } from "@/lib/appointmentActionPlan";
import { priceLabelCOP } from "@/lib/money";
import { dayHeadline, fmtTime, longDate, siteDayKey } from "@/lib/siteCalendar";
import type { AppointmentActivityItem } from "@/lib/schedulingActions";
import type { Appt } from "../AgendaView";
import { Menu, MenuButton } from "../ui/Menu";
import { Alert, Avatar, Button, CARD, ConfirmDialog, IconButton, StatusChip, TEXTAREA, buttonClass, useModalLayer } from "../ui/system";
import { DESTRUCTIVE, STATUS_NAME, type AppointmentStatus } from "./status";

/**
 * The APPOINTMENT DETAIL — a side panel over the agenda (the calendar stays visible and
 * keeps its scroll position underneath), built from the same Scheduling system as the
 * agenda itself (ui/system.tsx): the same buttons, chips, avatars, cards and type.
 *
 * Reading order, top to bottom: WHEN (date, time, state) → WHO (client) → WHAT (service,
 * professional, price) → history (activity), and the one primary action in the footer.
 * Each action appears ONCE:
 *   state menu   confirm · no-show · cancel (destructive ones ask first)
 *   footer       Completar cita (the primary)
 *   service card Cambiar hora o profesional (= reschedule)
 *   client card  Ver ficha · Conversación · Reservar de nuevo
 *   activity     Ver actividad
 * Things this product has no model for (comments, forms, payment policy, recurrence,
 * group bookings, checkout) are not drawn at all.
 *
 * The service pastel appears ONLY as the stripe of the service card; the state has its
 * own tone (StatusChip). The panel itself stays neutral.
 */

type Target = Exclude<AppointmentStatus, "scheduled">;

const ACTIVITY_LABEL: Record<AppointmentActivityItem["type"], string> = {
  created: "Cita creada",
  rescheduled: "Cita reprogramada",
  cancelled: "Cita cancelada",
  confirmed: "Cita confirmada",
  completed: "Cita completada",
  no_show: "Marcada como inasistencia",
  note: "Nota",
  other: "Actualización",
};
const ACTOR_LABEL: Record<AppointmentActivityItem["actor"], string> = {
  team: "Equipo",
  public: "Reserva en línea",
  agent: "Agente de reservas",
  system: "Sistema",
};
const TARGET_LABEL: Record<Target, string> = {
  confirmed: "Confirmar cita",
  completed: "Completar cita",
  no_show: "Marcar inasistencia",
  cancelled: "Cancelar cita",
};

export function AppointmentPanel(props: {
  appt: Appt;
  timezone: string;
  /** The card's service pastel — used ONLY for the stripe of the service card. */
  toneClass: string;
  siteName: string;
  originLabel: string;
  canOperate: boolean;
  /** Server-computed per appointment (gateAppointment's checks) — see lib/appointmentActionPlan. */
  canModify: boolean;
  pending: boolean;
  error: string | null;
  contactHref: string | null;
  conversationHref: string | null;
  /** New appointment for the same contact — null when not possible (no contact / CRM off / no rights). */
  bookAgainHref: string | null;
  onClose: () => void;
  onLocate: () => void;
  onReschedule: () => void;
  onStatus: (target: Target, reason?: string) => void;
  loadActivity: () => Promise<{ ok: true; items: AppointmentActivityItem[] } | { ok: false; error: string }>;
  /** The professional's avatar colour on the phone (same as the agenda list). */
  staffColor?: string;
}) {
  const { appt, timezone: tz } = props;
  const [minimized, setMinimized] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ target: Target; reason: string } | null>(null);
  const [activity, setActivity] = useState<
    { state: "idle" } | { state: "loading" } | { state: "error"; error: string } | { state: "ready"; items: AppointmentActivityItem[] }
  >({ state: "idle" });

  // Per-appointment state resets because the parent REMOUNTS this panel per
  // appointment (key={appt.id}) — a different card never inherits the previous state.

  // ONE stable close handler for the focus trap (it re-runs whenever this identity
  // changes, which would yank focus on every render). Escape peels layers in order:
  // an open confirmation, then an open menu, then the panel itself.
  const latest = useRef({ menuOpen, confirm, onClose: props.onClose });
  useEffect(() => {
    latest.current = { menuOpen, confirm, onClose: props.onClose };
  });
  const onEscape = useCallback(() => {
    const l = latest.current;
    if (l.confirm) return setConfirm(null);
    if (l.menuOpen) return setMenuOpen(false);
    l.onClose();
  }, []);
  // Below md the detail is the phone's bottom sheet (its own layer stack), not this panel.
  const phone = useIsOverlayWidth(767.98);
  const panelRef = useTrappedPanel({ active: !minimized && !phone, onClose: onEscape });
  // The trap focuses the first control (it would be "Localizar", ring and all). Land on
  // the dialog itself instead: screen readers announce its title and Tab still enters.
  useEffect(() => {
    if (!minimized) (panelRef.current as HTMLElement | null)?.focus({ preventScroll: true });
  }, [minimized, panelRef]);
  // A confirmation is modal WITHIN the panel (useModalLayer): what is behind it is inert.
  const layer = useModalLayer(confirm !== null, panelRef as RefObject<HTMLElement | null>);

  // What this login may do HERE — the server's per-appointment permission + the engine's
  // legal transitions. "Completar" is the footer's primary; the state menu does not repeat it.
  const plan = appointmentActionPlan({ canOperate: props.canOperate, canModify: props.canModify, status: appt.status });
  const stateTargets = plan.stateMenu;
  const price = priceLabelCOP(appt.price);
  const client = appt.contact_name ?? "Atención sin cita";
  const timeRange = `${fmtTime(appt.start_at, tz)} – ${fmtTime(appt.service_end_at, tz)}`;

  const choose = (target: Target) => {
    setMenuOpen(false);
    if (DESTRUCTIVE.has(target)) setConfirm({ target, reason: "" });
    else props.onStatus(target);
  };

  const showActivity = async () => {
    setActivity({ state: "loading" });
    const r = await props.loadActivity();
    setActivity(r.ok ? { state: "ready", items: r.items } : { state: "error", error: r.error });
  };

  if (phone) {
    return (
      <MobileAppointmentSheet
        appt={appt}
        timezone={tz}
        siteName={props.siteName}
        originLabel={props.originLabel}
        canOperate={props.canOperate}
        canModify={props.canModify}
        pending={props.pending}
        error={props.error}
        contactHref={props.contactHref}
        conversationHref={props.conversationHref}
        bookAgainHref={props.bookAgainHref}
        staffColor={props.staffColor}
        onClose={props.onClose}
        onReschedule={props.onReschedule}
        onStatus={props.onStatus}
        loadActivity={props.loadActivity}
      />
    );
  }

  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className="u-focus fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-50 flex h-[48px] max-w-[min(22rem,calc(100vw-2rem))] items-center gap-2.5 rounded-full border border-line bg-popover pl-2 pr-4 text-sm shadow-[var(--shadow-float)]"
        aria-label={`Restaurar el detalle de la cita de ${client}`}
      >
        <StatusChip status={appt.status} size="sm" />
        <span className="u-mono shrink-0 text-xs text-muted">{fmtTime(appt.start_at, tz)}</span>
        <span className="truncate font-medium">{client}</span>
      </button>
    );
  }

  return (
    <>
      {/* A light scrim: the agenda stays readable behind the panel. */}
      <button type="button" aria-label="Cerrar detalle" onClick={props.onClose} className="fixed inset-0 z-40 cursor-default bg-black/15 dark:bg-black/40" />
      <aside
        ref={panelRef as RefObject<HTMLElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby="appt-panel-title"
        tabIndex={-1}
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-background text-foreground shadow-[-12px_0_40px_rgba(18,21,27,0.14)] outline-none md:w-[min(34rem,calc(100vw-3rem))] md:border-l md:border-line"
      >
        <div inert={layer.inert} className="flex min-h-0 flex-1 flex-col">
          {/* WHEN — date, time, state, and the panel's own controls. */}
          <header className="shrink-0 border-b border-line bg-surface px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-5">
            <div className="flex items-start gap-1">
              <div className="min-w-0 flex-1 pt-0.5">
                <h2 id="appt-panel-title" className="truncate text-lg font-semibold tracking-tight">
                  <span className="sm:hidden">{dayHeadline(siteDayKey(appt.start_at, tz))}</span>
                  <span className="hidden sm:inline">{longDate(appt.start_at, tz)}</span>
                </h2>
                <p className="u-mono mt-0.5 text-[13px] text-muted">
                  {timeRange} · {appt.duration_min} min
                </p>
              </div>
              <IconButton label="Localizar en el calendario" onClick={() => { setMinimized(true); props.onLocate(); }}>
                <path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2" strokeLinecap="round" />
                <circle cx="8" cy="8" r="3.25" />
              </IconButton>
              <IconButton label="Minimizar" onClick={() => setMinimized(true)}>
                <path d="M3.5 11.5h9" strokeLinecap="round" />
              </IconButton>
              <IconButton label="Cerrar" onClick={props.onClose}>
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </IconButton>
            </div>
            <div className="mt-3 flex items-center gap-2">
              {stateTargets.length > 0 ? (
                <Menu
                  label={`Estado: ${STATUS_NAME[appt.status] ?? appt.status}. Cambiar estado`}
                  open={menuOpen}
                  onToggle={() => setMenuOpen(!menuOpen)}
                  onClose={() => setMenuOpen(false)}
                  align="left"
                  disabled={props.pending}
                  trigger={
                    <span className="inline-flex items-center gap-1.5">
                      <StatusChip status={appt.status} />
                      <span className={buttonClass({ variant: "tertiary", size: "sm", className: "pointer-events-none -ml-0.5 gap-1 px-2" })}>
                        Cambiar estado
                        <Chevron />
                      </span>
                    </span>
                  }
                >
                  {stateTargets.map((t) => (
                    <MenuButton key={t} danger={DESTRUCTIVE.has(t)} disabled={props.pending} onClick={() => choose(t)}>
                      {TARGET_LABEL[t]}
                    </MenuButton>
                  ))}
                </Menu>
              ) : (
                <StatusChip status={appt.status} />
              )}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
            <div className="flex flex-col gap-3">
              {props.error ? <Alert>{props.error}</Alert> : null}

              {/* WHO */}
              <section aria-labelledby="appt-panel-client" className={`${CARD} p-4`}>
                <h3 id="appt-panel-client" className="sr-only">
                  Cliente
                </h3>
                <div className="flex items-center gap-3">
                  <Avatar name={appt.contact_name} size="lg" />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 break-words text-[15px] font-semibold">{client}</p>
                    {appt.primary_identity ? <p className="u-mono truncate text-[13px] text-muted">{appt.primary_identity}</p> : null}
                    {!appt.contact_id ? <p className="text-[13px] text-muted">Esta cita no tiene un cliente asociado.</p> : null}
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 text-[13px]">
                  <div className="min-w-0">
                    <dt className="text-xs text-muted">Origen</dt>
                    <dd className="truncate">{props.originLabel}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted">Sede</dt>
                    <dd className="truncate">{props.siteName}</dd>
                  </div>
                </dl>
                {props.contactHref || props.conversationHref || props.bookAgainHref ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {props.contactHref ? (
                      <Link href={props.contactHref} className={buttonClass({ size: "sm" })}>
                        Ver ficha
                      </Link>
                    ) : null}
                    {props.conversationHref ? (
                      <Link href={props.conversationHref} className={buttonClass({ size: "sm" })}>
                        Conversación
                      </Link>
                    ) : null}
                    {props.bookAgainHref ? (
                      <Link href={props.bookAgainHref} className={buttonClass({ variant: "tertiary", size: "sm" })}>
                        Reservar de nuevo
                      </Link>
                    ) : null}
                  </div>
                ) : null}
              </section>

              {/* WHAT — the service card wears the service pastel as its stripe only. */}
              <section aria-labelledby="appt-panel-service" className={`${CARD} flex items-stretch overflow-hidden`}>
                <span aria-hidden className={`u-appt-service ${props.toneClass} w-1.5 shrink-0 bg-[var(--appt-ink)] opacity-70`} />
                <div className="min-w-0 flex-1 p-4">
                  <h3 id="appt-panel-service" className="sr-only">
                    Servicio
                  </h3>
                  <div className="flex items-start gap-3">
                    <p className={`min-w-0 flex-1 text-[15px] font-semibold ${appt.status === "cancelled" ? "line-through decoration-1 opacity-70" : ""}`}>{appt.service_name}</p>
                    <p className="u-mono shrink-0 text-[15px] font-medium">{price ?? "Sin precio"}</p>
                  </div>
                  <p className="u-mono mt-1 text-[13px] text-muted">
                    {timeRange} · {appt.duration_min} min
                  </p>
                  <p className="mt-2.5 flex items-center gap-2 text-[13px]">
                    <Avatar name={appt.staff_name} size="sm" />
                    <span className="truncate">{appt.staff_name ?? "Sin profesional"}</span>
                  </p>
                  {plan.reschedule ? (
                    <div className="mt-3">
                      <Button size="sm" onClick={props.onReschedule} disabled={props.pending}>
                        Cambiar hora o profesional
                      </Button>
                    </div>
                  ) : null}
                </div>
              </section>

              {/* HISTORY — read through the same appointment gate on the server. */}
              {plan.readActivity ? (
              <section aria-labelledby="appt-panel-activity" className={`${CARD} p-4`}>
                <div className="flex items-center justify-between gap-2">
                  <h3 id="appt-panel-activity" className="text-[13px] font-semibold">
                    Actividad
                  </h3>
                  {activity.state === "idle" || activity.state === "error" ? (
                    <Button variant="tertiary" size="sm" onClick={showActivity}>
                      {activity.state === "error" ? "Reintentar" : "Ver actividad"}
                    </Button>
                  ) : null}
                </div>
                {activity.state === "loading" ? (
                  <div className="mt-3 flex flex-col gap-2" aria-busy="true" aria-label="Cargando actividad">
                    {Array.from({ length: 3 }, (_, i) => (
                      <div key={i} className="h-10 animate-pulse rounded-sch-control bg-subtle" />
                    ))}
                  </div>
                ) : activity.state === "error" ? (
                  <p className="mt-2 text-[13px] text-danger">{activity.error}</p>
                ) : activity.state === "ready" ? (
                  activity.items.length === 0 ? (
                    <p className="mt-2 text-[13px] text-muted">Aún no hay actividad registrada.</p>
                  ) : (
                    <ol className="mt-3 flex flex-col">
                      {activity.items.map((item) => (
                        <li key={item.id} className="border-l-2 border-line py-2 pl-3.5 first:pt-0 last:pb-0">
                          <span className="block text-[13px] font-medium">{ACTIVITY_LABEL[item.type]}</span>
                          <span className="block text-xs text-muted">
                            {ACTOR_LABEL[item.actor]} · {longDate(item.at, tz)} · <span className="u-mono">{fmtTime(item.at, tz)}</span>
                          </span>
                          {item.fromStart && item.toStart ? (
                            <span className="u-mono block text-xs text-muted">
                              {fmtTime(item.fromStart, tz)} → {fmtTime(item.toStart, tz)}
                            </span>
                          ) : null}
                          {item.reason ? <span className="block text-xs text-muted">Motivo: {item.reason}</span> : null}
                        </li>
                      ))}
                    </ol>
                  )
                ) : (
                  <p className="mt-1 text-[13px] text-muted">Quién creó, confirmó o cambió esta cita.</p>
                )}
              </section>
              ) : null}
            </div>
          </div>

          {/* FOOTER — the total and the one primary action, always in reach. */}
          <footer className="flex shrink-0 items-center gap-3 border-t border-line bg-surface px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-5">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted">Total</p>
              <p className="u-mono text-base font-semibold">{price ?? "Sin precio"}</p>
            </div>
            {plan.complete ? (
              <Button variant="primary" onClick={() => props.onStatus("completed")} loading={props.pending} loadingLabel="Guardando…">
                Completar cita
              </Button>
            ) : (
              <span className="text-[13px] text-muted">
                {appt.status === "completed" ? "Cita completada" : appt.status === "cancelled" ? "Cita cancelada" : appt.status === "no_show" ? "Marcada como inasistencia" : ""}
              </span>
            )}
          </footer>
        </div>

        {confirm ? (
          <ConfirmDialog
            layerRef={layer.layerRef}
            id="appt-confirm"
            title={confirm.target === "cancelled" ? "¿Cancelar esta cita?" : "¿Marcar como inasistencia?"}
            body={
              confirm.target === "cancelled"
                ? `Se libera el horario de ${timeRange}. Esta acción no se puede deshacer desde la agenda.`
                : `${client} quedará marcado como no asistió a la cita de ${timeRange}.`
            }
            confirmLabel={confirm.target === "cancelled" ? "Cancelar cita" : "Marcar inasistencia"}
            pending={props.pending}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              const { target, reason } = confirm;
              setConfirm(null);
              props.onStatus(target, target === "cancelled" && reason.trim() ? reason.trim() : undefined);
            }}
          >
            {confirm.target === "cancelled" ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">
                  Motivo <span className="font-normal text-muted">(opcional)</span>
                </span>
                <textarea value={confirm.reason} onChange={(e) => setConfirm({ ...confirm, reason: e.target.value })} maxLength={500} rows={3} className={TEXTAREA} />
              </label>
            ) : null}
          </ConfirmDialog>
        ) : null}
      </aside>
    </>
  );
}

function Chevron() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
