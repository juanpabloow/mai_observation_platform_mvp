"use client";

import { apptClientLabel } from "@/lib/apptClientLabel";
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
import { Alert, Button, TEXTAREA } from "../ui/system";
import { ConfirmLayer } from "@/components/ui/module/ConfirmLayer";
import { DESTRUCTIVE, STATUS_NAME, type AppointmentStatus } from "./status";
import { SidePanel, PanelSection, type SidePanelHandle } from "./SidePanel";
import { RescheduleInline } from "./RescheduleInline";
import { GuestContact } from "./GuestContact";
import { PaymentSection } from "./PaymentSection";
import { AgAvatar, STATE_GLYPH, StateChip } from "./AgendaChrome";

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
  /** The professional's avatar pastel (roster order, as in the calendar). */
  staffTint?: "1" | "2" | "3" | "4";
  covered?: boolean;
  /** Why this appointment needs review (labels), empty when it does not. */
  review?: string[];
  reschedule?: ReschedulePanelConfig;
  /** Open directly in «Reagendar» (from an affected-appointments list). */
  startInReschedule?: boolean;
  onContactSaved?: (message: string) => void;
  /** Where to return after a reschedule opened from a form (label for the back link). */
  returnLabel?: string | null;
  /** PY-2: the «Cobro» of a completed appointment — only with payments.view. */
  payment?: { clientId: string; canRecord: boolean; canVoid: boolean; onRecord: () => void; onChanged: (message: string) => void } | null;
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

  const [now] = useState(() => Date.now());
  // Which state is being saved — the segment says «Guardando…» on THAT option (and the
  // live region announces it) until the server answers; the chip changes only then.
  const [savingTo, setSavingTo] = useState<Target | null>(null);
  const plan = appointmentActionPlan({ canOperate: props.canOperate, canModify: props.canModify, status: appt.status, startAt: appt.start_at, now });
  const blocked = props.canOperate ? rescheduleBlockedReason({ status: appt.status, allowed: plan.allowed, staffName: appt.staff_name }) : null;
  const price = priceLabelCOP(appt.price);
  // Whether there is a contact is contact_id; the label only names what is known.
  const client = apptClientLabel(appt);
  const timeRange = `${fmtTime(appt.start_at, tz)} – ${fmtTime(appt.service_end_at, tz)}`;
  const started = Date.parse(appt.start_at) <= now;
  const ended = Date.parse(appt.service_end_at) <= now;
  const live = appt.status === "scheduled" || appt.status === "confirmed";

  const paymentSection = (compact: boolean) =>
    props.payment && appt.status === "completed" ? (
      <PaymentSection
        clientId={props.payment.clientId}
        appt={appt}
        timezone={tz}
        canRecord={props.payment.canRecord}
        canVoid={props.payment.canVoid}
        onRecord={props.payment.onRecord}
        onChanged={props.payment.onChanged}
        compact={compact}
      />
    ) : null;

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
        paymentSlot={paymentSection(true)}
        contactSlot={
          !appt.contact_id ? (
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
          ) : null
        }
      />
    );
  }

  const shownSaving = props.pending ? savingTo : null;
  const choose = (target: Target) => {
    if (DESTRUCTIVE.has(target)) setConfirm({ target, reason: "" });
    else {
      setSavingTo(target);
      props.onStatus(target);
    }
  };

  const showActivity = async () => {
    setActivity({ state: "loading" });
    const r = await props.loadActivity();
    setActivity(r.ok ? { state: "ready", items: r.items } : { state: "error", error: r.error });
  };

  // Reference (A.dotL): a 6px bar in the service family — it stays the service's colour when
  // the appointment is completed (completion FILLS the chip and the card with it, no green);
  // a no-show / cancelled take their state's colour. Subtitle: "jueves 22 oct · 14:30 – 15:15 · 45 min".
  const barColor =
    appt.status === "no_show" ? "var(--danger)" : appt.status === "cancelled" ? "var(--line-strong)" : "var(--appt-rule, var(--line-strong))";
  const stripe = <span aria-hidden className={`${props.toneClass} min-h-[44px] w-[6px] shrink-0 self-stretch rounded-[3px]`} style={{ background: barColor }} />;
  const subtitle = (
    <span className="tabular-nums">
      {shortDay(appt.start_at, tz)} · {timeRange} · {formatDuration(appt.duration_min)}
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
            title={client}
            titleSize="lg"
            headerRule={false}
            bodyClassName="px-5 pb-5 pt-1"
            subtitle={subtitle}
            leading={stripe}
            aside={<StateChip status={appt.status} toneClass={props.toneClass} />}
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
  const canTo = (s: AppointmentStatus) => s !== "scheduled" && plan.transitions.includes(s as Target);

  return (
    <>
      <SidePanel
        name="appointment"
        title={client}
        titleSize="lg"
        headerRule={false}
        bodyClassName="px-5 pb-5 pt-1"
        subtitle={subtitle}
        leading={stripe}
        aside={<StateChip status={appt.status} toneClass={props.toneClass} />}
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
                Confirmar cita
              </Button>
            ) : plan.primary === "completed" && started ? (
              <Button variant="primary" onClick={() => props.onStatus("completed")} loading={props.pending} loadingLabel="Guardando…">
                <span aria-hidden>✓✓</span>
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
              <div role="group" aria-label="Estado de la cita" className="grid grid-cols-3 gap-1 rounded-[12px] bg-[var(--ag-seg)] p-1">
                {segment.map((s) => {
                  const current = appt.status === s.status;
                  const enabled = !current && canTo(s.status);
                  const waits = s.status === "completed" && plan.completeWaitsForStart;
                  return (
                    <button
                      key={s.status}
                      type="button"
                      aria-pressed={current}
                      aria-disabled={!enabled || undefined}
                      title={waits ? "Disponible cuando empiece la cita" : undefined}
                      disabled={!enabled || props.pending}
                      onClick={() => enabled && choose(s.status as Target)}
                      className={`u-focus flex h-[44px] items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] text-[13.5px] transition-colors md:h-[36px] ${
                        current
                          ? "bg-[var(--ag-seg-on)] font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.1)]"
                          : enabled
                            ? "text-[var(--ag-ink2)] hover:bg-[var(--ag-seg-on)]"
                            : "cursor-not-allowed text-[var(--ag-prim-dis-ink)]"
                      }`}
                    >
                      {shownSaving === s.status ? (
                        <>
                          <span aria-hidden className="u-ag-busy-dot size-[6px] rounded-full bg-current" />
                          Guardando…
                        </>
                      ) : (
                        <>
                          <span aria-hidden>{STATE_GLYPH[s.status]}</span>
                          {s.label}
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
              <span role="status" aria-live="polite" className="sr-only">
                {shownSaving ? `Guardando: ${segment.find((x) => x.status === shownSaving)?.label ?? ""}` : ""}
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {plan.transitions.includes("no_show") ? (
                  <button type="button" className="u-focus h-[32px] rounded-[8px] px-2 text-[13px] text-[var(--ag-ink2)] hover:bg-[var(--subtle)]" onClick={() => choose("no_show")} disabled={props.pending}>
                    Marcar inasistencia
                  </button>
                ) : null}
                {plan.transitions.includes("cancelled") ? (
                  <button type="button" className="u-focus h-[32px] rounded-[8px] px-2 text-[13px] text-danger hover:bg-[var(--subtle)]" onClick={() => choose("cancelled")} disabled={props.pending}>
                    Cancelar cita
                  </button>
                ) : null}
                {plan.completeWaitsForStart ? <span className="ml-auto text-[12.5px] text-muted">Completar se habilita al empezar la cita</span> : null}
              </div>
            </div>
          ) : null}

          <dl className="flex flex-col">
            <KV k="Servicio">
              <span className={`flex min-w-0 items-center gap-2 ${appt.status === "cancelled" ? "line-through decoration-1 opacity-70" : ""}`}>
                <span aria-hidden className={`${props.toneClass} size-2 shrink-0 rounded-full bg-[var(--appt-rule)]`} />
                <span className="truncate">{appt.service_name}</span>
              </span>
            </KV>
            <KV k="Profesional">
              <span className="flex min-w-0 items-center gap-2">
                <AgAvatar name={appt.staff_name} id={appt.staff_id} size={24} tint={props.staffTint} />
                <span className="truncate">{appt.staff_name ?? "Sin profesional"}</span>
              </span>
            </KV>
            {appt.contact_id && appt.primary_identity ? (
              <KV k={appt.primary_identity.includes("@") ? "Correo" : "Teléfono"}>
                <span className="tabular-nums">{appt.primary_identity}</span>
              </KV>
            ) : null}
            {!appt.contact_id ? (
              <div className="flex flex-col gap-2.5 py-3 shadow-[inset_0_-1px_0_var(--line-soft)]">
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
              </div>
            ) : null}
            <KV k="Precio">
              <span className="tabular-nums">{price ?? "Sin precio"}</span>
            </KV>
            <KV k="Origen" last>
              {props.originLabel}
            </KV>
          </dl>

          {paymentSection(false) ? <div className="mt-2 shadow-[inset_0_1px_0_var(--line-soft)]">{paymentSection(false)}</div> : null}

          {props.review && props.review.length > 0 && live ? (
            <div role="status" className="mt-4 flex gap-2 rounded-[10px] bg-[var(--warn-soft)] px-3 py-2.5 text-[13px] leading-[1.45] text-[var(--warn)]">
              <span aria-hidden>!</span>
              <span>
                Requiere revisión: {props.review.join(" · ")}. Su estado («{STATUS_NAME[appt.status]}») no cambia; reagéndala si hace falta. No se movió ni se canceló nada.
              </span>
            </div>
          ) : null}

          {live && ended ? (
            <p className="mt-4 rounded-[10px] bg-[var(--chip)] px-3 py-2.5 text-[13px] leading-[1.45] text-[var(--ag-ink2)]">
              La hora ya pasó y la cita sigue «{STATUS_NAME[appt.status]}». Marca lo que pasó: una hora pasada no confirma que se atendió.
            </p>
          ) : null}

          <div className="mt-4">
            {appt.contact_id && (props.contactHref || props.conversationHref || props.bookAgainHref) ? (
              <div className="flex flex-wrap gap-1 pb-2">
                {props.contactHref ? <Link href={props.contactHref} className="u-focus inline-flex h-[32px] items-center rounded-[8px] px-2 text-[13px] text-[var(--ag-ink2)] hover:bg-[var(--subtle)]">Ver ficha del cliente</Link> : null}
                {props.conversationHref ? <Link href={props.conversationHref} className="u-focus inline-flex h-[32px] items-center rounded-[8px] px-2 text-[13px] text-[var(--ag-ink2)] hover:bg-[var(--subtle)]">Ver conversación</Link> : null}
                {props.bookAgainHref ? <Link href={props.bookAgainHref} className="u-focus inline-flex h-[32px] items-center rounded-[8px] px-2 text-[13px] text-[var(--ag-ink2)] hover:bg-[var(--subtle)]">Reservar de nuevo</Link> : null}
              </div>
            ) : null}

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

/** The reference's key–value row (ST.kv): 170px label column, 11px rhythm, a hairline. */
function KV({ k, children, last }: { k: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`grid grid-cols-[170px_minmax(0,1fr)] gap-3 py-[11px] text-[13.5px] ${last ? "" : "shadow-[inset_0_-1px_0_var(--line-soft)]"}`}>
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

const DAY_SHORT = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MON_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
/** "jueves 22 oct" — the reference's detail subtitle, in the site's zone. */
function shortDay(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return `${DAY_SHORT[wd] ?? ""} ${Number(get("day"))} ${MON_SHORT[Number(get("month")) - 1] ?? ""}`;
}
