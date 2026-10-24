"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { apptClientLabel } from "@/lib/apptClientLabel";
import type { ActionPlan } from "@/lib/appointmentActionPlan";
import { priceLabelCOP } from "@/lib/money";
import { fmtTime, longDate } from "@/lib/siteCalendar";
import type { AppointmentActivityItem } from "@/lib/schedulingActions";
import type { Appt } from "../AgendaView";
import { AgAvatar, STATE_GLYPH, StateChip } from "./AgendaChrome";
import { CobroSection, type PaymentHooks } from "./PaymentSection";
import { ReviewSection, type ReviewLinkLoader } from "./ReviewLink";
import { STATUS_NAME, type AppointmentStatus } from "./status";

/**
 * THE APPOINTMENT CARD — card language 5a («Agenda Lenguaje Tarjeta»), one body for the
 * desktop side panel and the phone sheet, so both offer exactly the same actions.
 *
 * Reading order: header (service bar · client · date, time, duration) → state in one touch,
 * with «Cancelar cita» / «Marcar inasistencia» confirmed IN PLACE → «Requiere revisión» →
 * Cita (service + list price, professional, phone with Llamar / WhatsApp, origin, the guest
 * details without a contact) → Cobro (payments.view only) → Reseña → Actividad. Footer: a note
 * on what the state allows, then the secondary action (Reagendar / Ver ficha) and the ONE next
 * step (Confirmar · Marcar completada · Registrar cobro · Reservar de nuevo).
 *
 * Functions, states and permissions are the engine's (appointmentActionPlan): the card never
 * offers a change the server would refuse, and the server checks every request anyway. What
 * the sheet marks «Propuesto» (visits/no-shows, internal note, reactivating a cancelled one) is
 * not here — it needs its own definition.
 */

type Target = Exclude<AppointmentStatus, "scheduled">;

export const CANCEL_REASONS = ["Cliente canceló", "Reprogramará", "Profesional no disponible", "Otro"] as const;

const ACTIVITY_LABEL: Record<AppointmentActivityItem["type"], string> = {
  created: "Creada",
  rescheduled: "Reagendada",
  cancelled: "Cancelada",
  confirmed: "Confirmada",
  completed: "Completada",
  no_show: "Marcada como inasistencia",
  note: "Actualización del contacto",
  other: "Actualización",
};
const ACTOR_LABEL: Record<AppointmentActivityItem["actor"], string> = {
  team: "por el equipo",
  public: "· Reserva en línea",
  agent: "por el agente de reservas",
  system: "por el sistema",
};

/** A phone number we can dial / open in WhatsApp — only digits and a leading +. */
export function phoneOf(identity: string | null): string | null {
  if (!identity || identity.includes("@")) return null;
  const digits = identity.replace(/[^\d+]/g, "");
  return digits.replace(/\D/g, "").length >= 7 ? digits : null;
}

export interface CardParts {
  leading: ReactNode;
  title: string;
  meta: ReactNode;
  body: ReactNode;
  footer: ReactNode;
}

export function AppointmentCard(props: {
  appt: Appt;
  timezone: string;
  toneClass: string;
  siteName: string;
  originLabel: string;
  plan: ActionPlan;
  canOperate: boolean;
  /** Why the date can't change (rescheduleBlockedReason), or null. */
  blocked: string | null;
  pending: boolean;
  error: string | null;
  contactHref: string | null;
  conversationHref: string | null;
  bookAgainHref: string | null;
  staffTint?: "1" | "2" | "3" | "4";
  review?: string[];
  onStatus: (target: Target, reason?: string) => void;
  /** Desktop: reschedule inside the panel. Phone: the full-screen flow. Null = not offered. */
  onReschedule: (() => void) | null;
  loadActivity: () => Promise<{ ok: true; items: AppointmentActivityItem[] } | { ok: false; error: string }>;
  loadReviewLink: ReviewLinkLoader;
  payment?: PaymentHooks | null;
  /** Without a linked contact: the guest details («Guardar contacto»). */
  contactSlot?: ReactNode;
  /** Rows only the phone shows (Sede, Color). */
  extraRows?: Array<{ k: string; v: ReactNode }>;
  frame: (parts: CardParts) => ReactNode;
}) {
  const { appt, timezone: tz, plan } = props;
  const [confirm, setConfirm] = useState<{ target: "cancelled" | "no_show"; reason: string | null; other: string } | null>(null);
  // Which state is being saved — the segment says «Guardando…» on THAT option (and the live
  // region announces it) until the server answers; the state changes only then.
  const [savingTo, setSavingTo] = useState<Target | null>(null);
  const live = appt.status === "scheduled" || appt.status === "confirmed";
  const client = apptClientLabel(appt);
  const timeRange = `${fmtTime(appt.start_at, tz)} – ${fmtTime(appt.service_end_at, tz)}`;
  const [now] = useState(() => Date.now());
  const ended = Date.parse(appt.service_end_at) <= now;
  const price = priceLabelCOP(appt.price);
  const phone = phoneOf(appt.primary_identity);
  const shownSaving = props.pending ? savingTo : null;
  // The in-place confirmation lives while the appointment is still live: once the server
  // applied it the state changes and the box goes with it; an error keeps it for a retry.
  const asking = confirm && live && plan.transitions.includes(confirm.target) ? confirm : null;

  const choose = (target: Target) => {
    if (target === "cancelled" || target === "no_show") {
      setConfirm({ target, reason: null, other: "" });
      return;
    }
    setSavingTo(target);
    props.onStatus(target);
  };

  // ── Header ──
  const leading = (
    <>
      <span aria-hidden className={`${props.toneClass} c5-bar`} style={{ background: barColor(appt.status) }} />
      <span aria-hidden className="c5-av">{initials(client)}</span>
    </>
  );
  const meta = (
    <div className="c5-meta">
      <span className="flex items-center gap-1.5">
        <CalIcon />
        {dayLabel(appt.start_at, tz)}
      </span>
      <span className="flex items-center gap-1.5">
        <ClockIcon />
        {timeRange}
      </span>
      <span className="text-[var(--c5-head-sub)]">{formatDuration(appt.duration_min)}</span>
    </div>
  );

  // ── State ──
  const segment: Array<{ status: AppointmentStatus; label: string }> = [
    { status: "scheduled", label: "Sin confirmar" },
    { status: "confirmed", label: "Confirmada" },
    { status: "completed", label: "Completada" },
  ];
  const stateSection =
    plan.allowed && live ? (
      <div className="c5-sec gap-2">
        <div role="group" aria-label="Estado de la cita" className="c5-seg">
          {segment.map((s) => {
            const current = appt.status === s.status;
            const enabled = !current && s.status !== "scheduled" && plan.transitions.includes(s.status as Target);
            const waits = s.status === "completed" && plan.completeWaitsForStart;
            return (
              <button
                key={s.status}
                type="button"
                aria-pressed={current}
                aria-disabled={!enabled || undefined}
                title={waits ? "Disponible cuando empiece la cita" : undefined}
                disabled={(!enabled && !current) || props.pending}
                onClick={() => enabled && choose(s.status as Target)}
                className="u-focus c5-seg-opt"
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
        <div className="flex flex-wrap items-center gap-x-4">
          {plan.transitions.includes("cancelled") ? (
            <button type="button" data-tone="red" className="u-focus c5-link" onClick={() => choose("cancelled")} disabled={props.pending}>
              Cancelar cita
            </button>
          ) : null}
          {plan.transitions.includes("no_show") ? (
            <button type="button" data-tone="red" className="u-focus c5-link" onClick={() => choose("no_show")} disabled={props.pending}>
              Marcar inasistencia
            </button>
          ) : null}
          {plan.completeWaitsForStart ? <span className="c5-note ml-auto">Completar se habilita al empezar la cita</span> : null}
        </div>
      </div>
    ) : (
      <div className="c5-sec">
        <div className="c5-row">
          <span className="c5-k">Estado</span>
          <StateChip status={appt.status} toneClass={props.toneClass} />
        </div>
      </div>
    );

  const finalReason = asking?.reason === "Otro" ? asking.other.trim() || "Otro" : asking?.reason ?? undefined;
  const confirmBox = asking ? (
    <div role="alertdialog" aria-labelledby="appt-confirm-text" className="c5-box c5-red my-3 gap-2.5">
      <span id="appt-confirm-text" className="text-[13px] leading-[1.45]">
        {asking.target === "cancelled"
          ? `¿Cancelar esta cita? Se libera el horario de ${timeRange}. Queda en el historial como cancelada.`
          : `¿Marcar inasistencia? ${client} quedará marcado como no asistió a la cita de ${timeRange}.`}
      </span>
      {asking.target === "cancelled" ? (
        <div className="flex flex-col gap-2">
          <span className="text-[12px]">Motivo · opcional</span>
          <div role="radiogroup" aria-label="Motivo de la cancelación" className="flex flex-wrap gap-1.5">
            {CANCEL_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={asking.reason === r}
                onClick={() => setConfirm({ ...asking, reason: asking.reason === r ? null : r })}
                className="u-focus c5-choice"
                data-size="sm"
              >
                {r}
              </button>
            ))}
          </div>
          {asking.reason === "Otro" ? (
            <textarea
              value={asking.other}
              onChange={(e) => setConfirm({ ...asking, other: e.target.value })}
              maxLength={500}
              rows={2}
              aria-label="Describe el motivo"
              placeholder="Describe el motivo"
              className="u-focus c5-field resize-none bg-[var(--c5-bg)] text-[15px]"
            />
          ) : null}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" autoFocus data-size="sm" className="u-focus c5-btn" onClick={() => setConfirm(null)} disabled={props.pending}>
          Volver
        </button>
        <button
          type="button"
          data-size="sm"
          data-kind="danger"
          aria-busy={props.pending || undefined}
          className="u-focus c5-btn"
          onClick={() => {
            if (props.pending) return;
            props.onStatus(asking.target, asking.target === "cancelled" ? finalReason : undefined);
          }}
        >
          {props.pending ? (asking.target === "cancelled" ? "Cancelando…" : "Guardando…") : asking.target === "cancelled" ? "Cancelar cita" : "Marcar inasistencia"}
        </button>
      </div>
    </div>
  ) : null;

  // ── Footer ──
  const paymentPending = props.payment?.canRecord && appt.status === "completed" && appt.payment_state !== "recorded";
  const footNote = live
    ? !plan.allowed
      ? props.blocked
      : appt.status === "scheduled"
        ? "Aún no confirmada por el cliente"
        : plan.completeWaitsForStart
          ? "Puedes reagendar hasta que se complete · completar se habilita al empezar la cita"
          : "Puedes reagendar hasta que se complete"
    : appt.status === "completed"
      ? "🔒 Completada · ya no se puede reagendar"
      : appt.status === "cancelled"
        ? "Cancelada · el horario quedó libre"
        : "Inasistencia registrada";
  const secondary =
    plan.reschedule && props.onReschedule ? (
      <button type="button" className="u-focus c5-btn" onClick={props.onReschedule} disabled={props.pending || Boolean(asking)}>
        <CalIcon />
        Reagendar
      </button>
    ) : props.contactHref && appt.contact_id ? (
      <Link href={props.contactHref} className="u-focus c5-btn">
        Ver ficha del cliente
      </Link>
    ) : null;
  let primary: ReactNode = null;
  let primaryIsBookAgain = false;
  if (plan.primary === "confirmed") {
    primary = (
      <button type="button" data-kind="primary" aria-busy={props.pending || undefined} disabled={Boolean(asking)} className="u-focus c5-btn" onClick={() => !props.pending && choose("confirmed")}>
        {props.pending && shownSaving === "confirmed" ? "Guardando…" : "Confirmar cita"}
      </button>
    );
  } else if (plan.primary === "completed") {
    primary = (
      <button type="button" data-kind="primary" aria-busy={props.pending || undefined} disabled={Boolean(asking)} className="u-focus c5-btn" onClick={() => !props.pending && choose("completed")}>
        {props.pending && shownSaving === "completed" ? "Guardando…" : "Marcar completada"}
      </button>
    );
  } else if (live && plan.completeWaitsForStart) {
    primary = (
      <button type="button" data-kind="primary" disabled title="Disponible cuando empiece la cita" className="c5-btn">
        Marcar completada
      </button>
    );
  } else if (paymentPending && props.payment) {
    primary = (
      <button type="button" data-kind="primary" className="u-focus c5-btn" onClick={props.payment.onRecord}>
        Registrar cobro
      </button>
    );
  } else if (!live && props.bookAgainHref && appt.contact_id) {
    primaryIsBookAgain = true;
    primary = (
      <Link href={props.bookAgainHref} data-kind="primary" className="u-focus c5-btn">
        Reservar de nuevo
      </Link>
    );
  }
  const footer =
    footNote || secondary || primary ? (
      <>
        {footNote ? <span className="c5-note">{footNote}</span> : null}
        {secondary || primary ? (
          <div className="flex gap-2">
            {secondary}
            {primary}
          </div>
        ) : null}
      </>
    ) : null;

  // ── Cita ──
  const links: ReactNode[] = [];
  if (appt.contact_id && props.contactHref && !(secondary && !plan.reschedule)) {
    links.push(
      <Link key="contact" href={props.contactHref} className="u-focus c5-link">
        Ver ficha del cliente
      </Link>,
    );
  }
  if (appt.contact_id && props.conversationHref) {
    links.push(
      <Link key="conv" href={props.conversationHref} className="u-focus c5-link">
        Ver conversación
      </Link>,
    );
  }
  if (appt.contact_id && props.bookAgainHref && !primaryIsBookAgain) {
    links.push(
      <Link key="again" href={props.bookAgainHref} className="u-focus c5-link">
        Reservar de nuevo
      </Link>,
    );
  }

  const body = (
    <>
      {props.error ? (
        <div role="alert" className="c5-box c5-red mt-3">
          {props.error}
        </div>
      ) : null}
      <div inert={Boolean(asking) || undefined} className="contents">
        {stateSection}
      </div>
      {confirmBox}
      {props.review && props.review.length > 0 && live ? (
        <div role="status" className="c5-box c5-amber my-3">
          <span className="font-[590]">Requiere revisión: {props.review.join(" · ")}</span>
          <span>Su estado («{STATUS_NAME[appt.status]}») no cambia; reagéndala si hace falta. No se movió ni se canceló nada.</span>
        </div>
      ) : null}
      {live && ended ? (
        <div className="c5-box my-3">La hora ya pasó y la cita sigue «{STATUS_NAME[appt.status]}». Marca lo que pasó: una hora pasada no confirma que se atendió.</div>
      ) : null}
      <div inert={Boolean(asking) || undefined} className="contents">
        <section aria-labelledby="appt-sec-cita" className="c5-sec gap-0">
          <h3 id="appt-sec-cita" className="c5-cap pb-1">
            Cita
          </h3>
          <dl className="contents">
            <div className="c5-row">
              <dt className="c5-k">Servicio</dt>
              <dd className={`flex min-w-0 flex-1 items-center gap-2 ${appt.status === "cancelled" ? "line-through decoration-1 opacity-70" : ""}`}>
                <span aria-hidden className={`${props.toneClass} size-[10px] shrink-0 rounded-[3px] bg-[var(--appt-rule)]`} />
                <span className="truncate">{appt.service_name}</span>
              </dd>
              <dd className="c5-num shrink-0 text-[13px] text-[var(--c5-sec)]">{price ? `Lista ${price}` : "Sin precio"}</dd>
            </div>
            <div className="c5-row">
              <dt className="c5-k">Profesional</dt>
              <dd className="flex min-w-0 items-center gap-2">
                <AgAvatar name={appt.staff_name} id={appt.staff_id} size={24} tint={props.staffTint} />
                <span className="truncate">{appt.staff_name ?? "Sin profesional"}</span>
              </dd>
            </div>
            {appt.contact_id && appt.primary_identity ? (
              <div className="c5-row" data-tall="">
                <dt className="c5-k">{appt.primary_identity.includes("@") ? "Correo" : "Teléfono"}</dt>
                <dd className="c5-num min-w-0 flex-1 [overflow-wrap:anywhere]">{appt.primary_identity}</dd>
                {phone ? (
                  <dd className="flex shrink-0 gap-1.5">
                    <a href={`tel:${phone}`} aria-label={`Llamar a ${client}`} title="Llamar" className="u-focus c5-icon-btn">
                      <PhoneIcon />
                    </a>
                    {/* Opens a chat with the client — it does not send anything by itself. */}
                    <a href={`https://wa.me/${phone.replace(/\D/g, "")}`} target="_blank" rel="noopener noreferrer" aria-label={`Abrir WhatsApp con ${client}`} title="WhatsApp" data-kind="ok" className="u-focus c5-icon-btn">
                      <ChatIcon />
                    </a>
                  </dd>
                ) : null}
              </div>
            ) : null}
            {(props.extraRows ?? []).map((r) => (
              <div key={r.k} className="c5-row">
                <dt className="c5-k">{r.k}</dt>
                <dd className="min-w-0 flex-1">{r.v}</dd>
              </div>
            ))}
            <div className="c5-row">
              <dt className="c5-k">Origen</dt>
              <dd className="min-w-0 flex-1">{props.originLabel}</dd>
            </div>
          </dl>
          {props.contactSlot ? <div className="flex flex-col gap-2.5 pt-2">{props.contactSlot}</div> : null}
          {links.length > 0 ? <div className="flex flex-wrap gap-x-4 pt-1">{links}</div> : null}
        </section>

        {props.payment ? <CobroSection appt={appt} timezone={tz} hooks={props.payment} /> : null}

        {plan.reviewLink ? <ReviewSection load={props.loadReviewLink} siteName={props.siteName} phone={phone} clientName={client} /> : null}

        {plan.readActivity ? <ActivitySection key={`${appt.id}:${appt.status}:${appt.start_at}`} load={props.loadActivity} timezone={tz} /> : null}
      </div>
    </>
  );

  return <>{props.frame({ leading, title: client, meta, body, footer })}</>;
}

/** Actividad: loaded when the card opens (the server reads it through the appointment gate);
 *  the three latest, «Ver todo» for the rest. */
function ActivitySection({ load, timezone: tz }: { load: () => Promise<{ ok: true; items: AppointmentActivityItem[] } | { ok: false; error: string }>; timezone: string }) {
  const [s, setS] = useState<{ state: "loading" } | { state: "error"; error: string } | { state: "ready"; items: AppointmentActivityItem[] }>({ state: "loading" });
  const [all, setAll] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    load()
      .then((r) => alive && setS(r.ok ? { state: "ready", items: r.items } : { state: "error", error: r.error }))
      .catch(() => alive && setS({ state: "error", error: "No se pudo cargar la actividad." }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per appointment state (keyed) or retry
  }, [tick]);
  const items = s.state === "ready" ? [...s.items].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) : [];
  const shown = all ? items : items.slice(0, 3);
  return (
    <section aria-labelledby="appt-sec-act" className="c5-sec gap-2.5">
      <div className="flex items-center">
        <h3 id="appt-sec-act" className="c5-cap flex-1">
          Actividad
        </h3>
        {items.length > 3 ? (
          <button type="button" className="u-focus c5-link min-h-0" onClick={() => setAll(!all)} aria-expanded={all}>
            {all ? "Ver menos" : "Ver todo"}
          </button>
        ) : null}
      </div>
      {s.state === "loading" ? (
        <p role="status" className="c5-small flex items-center gap-2 text-[var(--c5-sec)]">
          <span aria-hidden className="u-ag-busy-dot size-[7px] rounded-full bg-current" />
          Cargando actividad…
        </p>
      ) : s.state === "error" ? (
        <p className="c5-small flex items-center gap-3">
          <span className="text-[var(--c5-red-fg)]">{s.error}</span>
          <button
            type="button"
            className="u-focus c5-link"
            onClick={() => {
              setS({ state: "loading" });
              setTick((n) => n + 1);
            }}
          >
            Reintentar
          </button>
        </p>
      ) : items.length === 0 ? (
        <p className="c5-small text-[var(--c5-sec)]">Aún no hay actividad registrada.</p>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {shown.map((item) => (
            <li key={item.id} className="flex items-start gap-2.5 text-[13px]">
              <span aria-hidden className="c5-dot mt-[6px]" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span>
                  {ACTIVITY_LABEL[item.type]} {ACTOR_LABEL[item.actor]}
                </span>
                {item.fromStart && item.toStart ? (
                  <span className="c5-num text-[12px] text-[var(--c5-sec)]">
                    {longDate(item.fromStart, tz)} {fmtTime(item.fromStart, tz)} → {longDate(item.toStart, tz)} {fmtTime(item.toStart, tz)}
                  </span>
                ) : null}
                {item.reason ? <span className="text-[12px] text-[var(--c5-sec)]">Motivo: {item.reason}</span> : null}
              </span>
              <span className="c5-num shrink-0 text-[var(--c5-sec)]">{stamp(item.at, tz)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function barColor(status: string): string {
  return status === "no_show" ? "var(--c5-red-fg)" : status === "cancelled" ? "var(--c5-ctrl-bd)" : "var(--appt-rule, var(--c5-sec))";
}

export function initials(label: string): string {
  const words = label
    .replace(/^\s*[[(][^\])]*[\])]\s*/, "")
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w));
  if (words.length === 0) return "#";
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toLocaleUpperCase("es");
}

export function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const WD = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const MON = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function parts(iso: string, tz: string) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date(iso));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")), day: Number(get("day")), month: Number(get("month")) - 1 };
}
/** "Vie 23 oct" in the site's zone. */
export function dayLabel(iso: string, tz: string): string {
  const d = parts(iso, tz);
  return `${WD[d.wd] ?? ""} ${d.day} ${MON[d.month] ?? ""}`;
}
/** "22 oct, 18:10" in the site's zone. */
export function stamp(iso: string, tz: string): string {
  const d = parts(iso, tz);
  return `${d.day} ${MON[d.month] ?? ""}, ${fmtTime(iso, tz)}`;
}

export function CalIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function PhoneIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2" />
    </svg>
  );
}
export function ChatIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 20l1.3-3.9A8 8 0 1112 20a8 8 0 01-4-1z" />
    </svg>
  );
}
