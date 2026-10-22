"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { useIsOverlayWidth } from "@/components/ui/Overlay";
import { MobileAppointmentSheet } from "../mobile/MobileAppointmentSheet";
import { appointmentActionPlan } from "@/lib/appointmentActionPlan";
import { rescheduleBlockedReason } from "@/lib/rescheduleFlow";
import { priceLabelCOP } from "@/lib/money";
import { fmtTime, longDate } from "@/lib/siteCalendar";
import type { AppointmentActivityItem } from "@/lib/schedulingActions";
import { ReviewLinkCard, type ReviewLinkLoader } from "./ReviewLink";
import type { Appt } from "../AgendaView";
import { Alert, Avatar, Button, StatusChip, TEXTAREA } from "../ui/system";
import { ConfirmLayer } from "@/components/ui/module/ConfirmLayer";
import { DESTRUCTIVE, STATUS_NAME, type AppointmentStatus } from "./status";
import { SidePanel, PanelSection, type SidePanelHandle } from "./SidePanel";
import { RescheduleInline } from "./RescheduleInline";
import { GuestContact } from "./GuestContact";
import { StatusGlyphInline } from "./StatusGlyph";

/**
 * The APPOINTMENT DETAIL — the agenda's side panel (SidePanel: 520 px, floating, the
 * calendar stays visible and usable beside it). Phone: the existing bottom sheet.
 *
 * Reading order: WHO + WHEN (header) → state in one touch → «Requiere revisión» when the
 * appointment conflicts with the schedule → what/who/where → the client (or, without a
 * linked contact, the guest details with «Guardar contacto») → activity. Footer: Reagendar
 * and the next step. Reagendar opens INSIDE this same panel (RescheduleInline) — the same
 * appointment moves; nothing is cancelled and recreated.
 *
 * A past appointment is never assumed completed: it keeps its state and says so.
 */

type Target = Exclude<AppointmentStatus, "scheduled">;

const ACTIVITY_LABEL: Record<AppointmentActivityItem["type"], string> = {
  created: "Cita creada",
  rescheduled: "Cita reagendada",
  cancelled: "Cita cancelada",
  confirmed: "Cita confirmada",
  completed: "Cita completada",
  no_show: "Marcada como inasistencia",
  note: "Actualización del contacto",
  other: "Actualización",
};
const ACTOR_LABEL: Record<AppointmentActivityItem["actor"], string> = {
  team: "Equipo",
  public: "Reserva en línea",
  agent: "Agente de reservas",
  system: "Sistema",
};

export interface ReschedulePanelConfig {
  clientId: string;
  siteId: string;
  staff: Array<{ id: string; name: string; photoUrl?: string | null }>;
  openWeekdays: Set<string>;
  lockStaffId: string | null;
  /** Unsaved blocks being edited (discounted from the times offered). */
  holds?: string[];
  onDone: (result: { dayKey: string; appointmentId: string; startAt: string }) => void;
}

export function AppointmentPanel(props: {
  appt: Appt;
  timezone: string;
  toneClass: string;
  siteName: string;
  originLabel: string;
  canOperate: boolean;
  canModify: boolean;
  pending: boolean;
  error: string | null;
  contactHref: string | null;
  conversationHref: string | null;
  bookAgainHref: string | null;
  onClose: () => void;
  onLocate: () => void;
  /** Phone: open the full-screen reschedule flow. Desktop reschedules inline. */
  onReschedule: () => void;
  onStatus: (target: Target, reason?: string) => void;
  loadActivity: () => Promise<{ ok: true; items: AppointmentActivityItem[] } | { ok: false; error: string }>;
  loadReviewLink: ReviewLinkLoader;
  staffColor?: string;
  covered?: boolean;
  /** Why this appointment needs review (labels), empty when it does not. */
  review?: string[];
  reschedule?: ReschedulePanelConfig;
  /** Open directly in «Reagendar» (from an affected-appointments list). */
  startInReschedule?: boolean;
  onContactSaved?: (message: string) => void;
  /** Where to return after a reschedule opened from a form (label for the back link). */
  returnLabel?: string | null;
}) {
  const { appt, timezone: tz } = props;
  const phone = useIsOverlayWidth(767.98);
  const [mode, setMode] = useState<"detail" | "reschedule">(props.startInReschedule ? "reschedule" : "detail");
  const [confirm, setConfirm] = useState<{ target: Target; reason: string } | null>(null);
  const [rescheduleDirty, setRescheduleDirty] = useState(false);
  const [contactDirty, setContactDirty] = useState(false);
  const [activity, setActivity] = useState<
    { state: "idle" } | { state: "loading" } | { state: "error"; error: string } | { state: "ready"; items: AppointmentActivityItem[] }
  >({ state: "idle" });
  const handle = useRef<SidePanelHandle | null>(null);
  const onRescheduleDirty = useCallback((d: boolean) => setRescheduleDirty(d), []);
  const onContactDirty = useCallback((d: boolean) => setContactDirty(d), []);

  const plan = appointmentActionPlan({ canOperate: props.canOperate, canModify: props.canModify, status: appt.status });
  const blocked = props.canOperate ? rescheduleBlockedReason({ status: appt.status, allowed: plan.allowed, staffName: appt.staff_name }) : null;
  const price = priceLabelCOP(appt.price);
  // Whether there is a contact is contact_id; the label only names what is known.
  const client = appt.contact_name ?? appt.guest_name ?? (appt.origin === "walk_in" ? "Atención sin cita" : "Sin contacto");
  const timeRange = `${fmtTime(appt.start_at, tz)} – ${fmtTime(appt.service_end_at, tz)}`;
  const [now] = useState(() => Date.now());
  const started = Date.parse(appt.start_at) <= now;
  const ended = Date.parse(appt.service_end_at) <= now;
  const live = appt.status === "scheduled" || appt.status === "confirmed";

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
        loadReviewLink={props.loadReviewLink}
      />
    );
  }

  const choose = (target: Target) => {
    if (DESTRUCTIVE.has(target)) setConfirm({ target, reason: "" });
    else props.onStatus(target);
  };

  const showActivity = async () => {
    setActivity({ state: "loading" });
    const r = await props.loadActivity();
    setActivity(r.ok ? { state: "ready", items: r.items } : { state: "error", error: r.error });
  };

  const stripe = <span aria-hidden className={`u-appt-service ${props.toneClass} mt-1 h-[40px] w-1 shrink-0 rounded-full bg-[var(--appt-ink)]`} />;
  const subtitle = (
    <span className="u-tnum">
      {longDate(appt.start_at, tz)} · {timeRange} · {formatDuration(appt.duration_min)}
    </span>
  );

  if (mode === "reschedule" && props.reschedule && plan.reschedule) {
    const cfg = props.reschedule;
    return (
      <RescheduleInline
        clientId={cfg.clientId}
        siteId={cfg.siteId}
        timezone={tz}
        appt={appt}
        staff={cfg.staff}
        lockStaffId={cfg.lockStaffId}
        openWeekdays={cfg.openWeekdays}
        holds={cfg.holds}
        onDirty={onRescheduleDirty}
        onCancel={() => (props.startInReschedule ? props.onClose() : setMode("detail"))}
        onDone={cfg.onDone}
        frame={(body, footer) => (
          <SidePanel
            name="reschedule"
            title={`Reagendar · ${client}`}
            subtitle={subtitle}
            leading={stripe}
            aside={<StatusChip status={appt.status} size="sm" />}
            dirty={rescheduleDirty}
            onClose={props.onClose}
            handleRef={handle}
            insideSelector="[data-appt-card]"
            footer={footer}
          >
            {props.returnLabel ? <p className="mb-3 text-[12.5px] text-muted">Al guardar vuelves a {props.returnLabel}, con lo que escribiste.</p> : null}
            {body}
          </SidePanel>
        )}
      />
    );
  }

  // One-touch state: the three forward states, enabled only when legal for this login.
  const segment: Array<{ status: AppointmentStatus; label: string }> = [
    { status: "scheduled", label: "Sin confirmar" },
    { status: "confirmed", label: "Confirmada" },
    { status: "completed", label: "Completada" },
  ];
  const canTo = (s: AppointmentStatus) => s !== "scheduled" && plan.transitions.includes(s as Target) && (s !== "completed" || started);

  return (
    <>
      <SidePanel
        name="appointment"
        title={client}
        subtitle={subtitle}
        leading={stripe}
        aside={<StatusChip status={appt.status} size="sm" />}
        dirty={contactDirty}
        covered={confirm !== null || props.covered}
        onClose={props.onClose}
        handleRef={handle}
        insideSelector="[data-appt-card]"
        footer={
          <div className="flex items-center gap-2">
            {plan.reschedule && props.reschedule ? (
              <Button onClick={() => setMode("reschedule")} disabled={props.pending}>
                <CalendarGlyph />
                Reagendar
              </Button>
            ) : (
              <span className="min-w-0 flex-1 text-[12.5px] text-muted">{blocked}</span>
            )}
            <span className="flex-1" />
            {plan.primary === "confirmed" ? (
              <Button variant="primary" onClick={() => props.onStatus("confirmed")} loading={props.pending} loadingLabel="Guardando…">
                <StatusGlyphInline status="confirmed" />
                Confirmar
              </Button>
            ) : plan.primary === "completed" && started ? (
              <Button variant="primary" onClick={() => props.onStatus("completed")} loading={props.pending} loadingLabel="Guardando…">
                <StatusGlyphInline status="completed" />
                Marcar completada
              </Button>
            ) : null}
          </div>
        }
      >
        <div inert={confirm !== null} className="flex flex-col">
          {props.error ? <div className="mb-3"><Alert>{props.error}</Alert></div> : null}

          {plan.allowed && live ? (
            <div className="mb-4 flex flex-col gap-2">
              <div role="group" aria-label="Estado de la cita" className="grid grid-cols-3 gap-0.5 rounded-[12px] bg-chip p-1">
                {segment.map((s) => {
                  const current = appt.status === s.status;
                  const enabled = !current && canTo(s.status);
                  return (
                    <button
                      key={s.status}
                      type="button"
                      aria-pressed={current}
                      disabled={!enabled || props.pending}
                      onClick={() => enabled && choose(s.status as Target)}
                      className={`u-focus flex h-[44px] items-center justify-center gap-1.5 rounded-[9px] text-[13px] transition-colors md:h-[36px] ${
                        current ? "bg-surface font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : enabled ? "text-foreground hover:bg-subtle" : "text-faint"
                      }`}
                    >
                      <StatusGlyphInline status={s.status} />
                      {s.label}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
                {plan.transitions.includes("no_show") ? (
                  <button type="button" className="u-focus rounded font-medium text-foreground hover:underline" onClick={() => choose("no_show")} disabled={props.pending}>
                    Marcar inasistencia
                  </button>
                ) : null}
                {plan.transitions.includes("cancelled") ? (
                  <button type="button" className="u-focus rounded font-medium text-danger hover:underline" onClick={() => choose("cancelled")} disabled={props.pending}>
                    Cancelar cita
                  </button>
                ) : null}
                {!started && plan.transitions.includes("completed") ? <span className="ml-auto text-[12.5px] text-muted">Completar se habilita al empezar la cita</span> : null}
              </div>
            </div>
          ) : null}

          {props.review && props.review.length > 0 && live ? (
            <div role="status" className="mb-4 rounded-[12px] border border-[var(--warn-rule)] bg-[var(--warn-soft)] px-3.5 py-3 text-[13px]">
              <p className="font-semibold text-[var(--warn)]">Requiere revisión</p>
              <p className="mt-0.5 text-foreground">{props.review.join(" · ")}.</p>
              <p className="mt-1 text-muted">No se movió ni se canceló nada. Reagéndala o déjala como está; el aviso sigue hasta que el conflicto desaparezca.</p>
            </div>
          ) : null}

          {live && ended ? (
            <p className="mb-4 rounded-[12px] bg-subtle px-3.5 py-3 text-[13px] text-muted">
              La hora ya pasó y la cita sigue «{STATUS_NAME[appt.status]}». Marca lo que pasó: una hora pasada no confirma que se atendió.
            </p>
          ) : null}

          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-3 text-[13px]">
            <dt className="text-muted">Servicio</dt>
            <dd className={`flex min-w-0 items-center gap-2 ${appt.status === "cancelled" ? "line-through decoration-1 opacity-70" : ""}`}>
              <span aria-hidden className={`u-appt-service ${props.toneClass} size-2 shrink-0 rounded-full bg-[var(--appt-ink)]`} />
              <span className="truncate">{appt.service_name}</span>
            </dd>
            <dt className="text-muted">Profesional</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <Avatar name={appt.staff_name} size="sm" />
              <span className="truncate">{appt.staff_name ?? "Sin profesional"}</span>
            </dd>
            {appt.contact_id && appt.primary_identity ? (
              <>
                <dt className="text-muted">{appt.primary_identity.includes("@") ? "Correo" : "Teléfono"}</dt>
                <dd className="u-mono truncate">{appt.primary_identity}</dd>
              </>
            ) : null}
            <dt className="text-muted">Origen</dt>
            <dd className="truncate">{props.originLabel}</dd>
            <dt className="text-muted">Sede</dt>
            <dd className="truncate">{props.siteName}</dd>
            <dt className="text-muted">Precio</dt>
            <dd className="u-mono">{price ?? "Sin precio"}</dd>
          </dl>

          <div className="mt-5">
            <PanelSection
              id="appt-client"
              title="Cliente"
              action={!appt.contact_id ? <span className="rounded-full bg-chip px-2 py-0.5 text-[11.5px] text-muted">Sin contacto vinculado</span> : null}
            >
              {appt.contact_id ? (
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center gap-3">
                    <Avatar name={appt.contact_name} />
                    <p className="min-w-0 flex-1 truncate text-[14px] font-semibold">{appt.contact_name ?? "Sin nombre"}</p>
                  </div>
                  {props.contactHref || props.conversationHref || props.bookAgainHref ? (
                    <div className="flex flex-wrap gap-2">
                      {props.contactHref ? <Link href={props.contactHref} className="u-focus inline-flex h-[36px] items-center rounded-sch-control border border-line px-3 text-[13px] font-medium hover:bg-subtle">Ver ficha</Link> : null}
                      {props.conversationHref ? <Link href={props.conversationHref} className="u-focus inline-flex h-[36px] items-center rounded-sch-control border border-line px-3 text-[13px] font-medium hover:bg-subtle">Conversación</Link> : null}
                      {props.bookAgainHref ? <Link href={props.bookAgainHref} className="u-focus inline-flex h-[36px] items-center rounded-sch-control px-3 text-[13px] font-medium hover:bg-subtle">Reservar de nuevo</Link> : null}
                    </div>
                  ) : null}
                </div>
              ) : (
                <GuestContact
                  clientId={props.reschedule?.clientId ?? ""}
                  siteId={props.reschedule?.siteId ?? ""}
                  appointmentId={appt.id}
                  canModify={plan.allowed}
                  initial={{ name: appt.guest_name, phone: appt.guest_phone, email: appt.guest_email }}
                  onDirty={onContactDirty}
                  onSaved={(m) => {
                    setContactDirty(false);
                    props.onContactSaved?.(m);
                  }}
                />
              )}
            </PanelSection>

            {plan.reviewLink ? (
              <div className="py-4">
                <ReviewLinkCard load={props.loadReviewLink} siteName={props.siteName} phone={appt.primary_identity?.includes("@") ? null : appt.primary_identity} />
              </div>
            ) : null}

            {plan.readActivity ? (
              <PanelSection
                id="appt-activity"
                title="Actividad"
                action={
                  activity.state === "idle" || activity.state === "error" ? (
                    <Button variant="tertiary" size="sm" onClick={showActivity}>
                      {activity.state === "error" ? "Reintentar" : "Ver actividad"}
                    </Button>
                  ) : null
                }
              >
                {activity.state === "loading" ? (
                  <div className="flex flex-col gap-2" aria-busy="true" aria-label="Cargando actividad">
                    {Array.from({ length: 3 }, (_, i) => (
                      <div key={i} className="h-[36px] rounded-sch-control bg-subtle" />
                    ))}
                  </div>
                ) : activity.state === "error" ? (
                  <p className="text-[13px] text-danger">{activity.error}</p>
                ) : activity.state === "ready" ? (
                  activity.items.length === 0 ? (
                    <p className="text-[13px] text-muted">Aún no hay actividad registrada.</p>
                  ) : (
                    <ol className="flex flex-col">
                      {activity.items.map((item) => (
                        <li key={item.id} className="border-l-2 border-line py-2 pl-3.5 first:pt-0 last:pb-0">
                          <span className="block text-[13px] font-medium">{ACTIVITY_LABEL[item.type]}</span>
                          <span className="block text-xs text-muted">
                            {ACTOR_LABEL[item.actor]} · {longDate(item.at, tz)} · <span className="u-mono">{fmtTime(item.at, tz)}</span>
                          </span>
                          {item.fromStart && item.toStart ? (
                            <span className="u-mono block text-xs text-muted">
                              {longDate(item.fromStart, tz)} {fmtTime(item.fromStart, tz)} → {longDate(item.toStart, tz)} {fmtTime(item.toStart, tz)}
                            </span>
                          ) : null}
                          {item.reason ? <span className="block text-xs text-muted">Motivo: {item.reason}</span> : null}
                        </li>
                      ))}
                    </ol>
                  )
                ) : (
                  <p className="text-[13px] text-muted">Quién creó, confirmó, reagendó o cambió esta cita.</p>
                )}
              </PanelSection>
            ) : null}
          </div>
        </div>
      </SidePanel>
      {confirm ? (
          <ConfirmLayer
            id="appt-confirm"
            title={confirm.target === "cancelled" ? "¿Cancelar esta cita?" : "¿Marcar como inasistencia?"}
            body={
              confirm.target === "cancelled"
                ? `Se libera el horario de ${timeRange}. La cita queda en el historial como cancelada.`
                : `${client} quedará marcado como no asistió a la cita de ${timeRange}.`
            }
            confirmLabel={confirm.target === "cancelled" ? "Cancelar cita" : "Marcar inasistencia"}
            cancelLabel="Volver"
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
          </ConfirmLayer>
      ) : null}
    </>
  );
}

function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function CalendarGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2.5 3.5h11v10h-11zM2.5 6.6h11M5.5 2v2.5M10.5 2v2.5" />
    </svg>
  );
}
