"use client";

import { apptClientLabel } from "@/lib/apptClientLabel";
import Link from "next/link";
import { useEffect, useState } from "react";
import { priceLabelCOP } from "@/lib/money";
import { fmtTime, longDate } from "@/lib/siteCalendar";
import type { AppointmentActivityItem } from "@/lib/schedulingActions";
import { CATEGORY_GROUPS } from "../services/categories";
import type { Appt } from "../AgendaView";
import { type AppointmentStatus } from "../agenda/status";
import { appointmentActionPlan } from "@/lib/appointmentActionPlan";
import { rescheduleBlockedReason } from "@/lib/rescheduleFlow";
import { reviewShareText, useReviewLink, whatsappHref, type ReviewLinkLoader } from "../agenda/ReviewLink";
import { serviceCategory } from "@/lib/agendaCategory";
import { mFamilyClass } from "./MobileAgenda";
import { Icon, ICON, MButton, MClientAvatar, MConfirm, MIconButton, MPill, MStaffAvatar, MStateChip, Sheet, STATE_ICON, STATE_LABEL } from "./kit";

/**
 * The appointment DETAIL on the phone (reference §02): a bottom sheet over the agenda
 * that opens part-way and expands from its handle (tap or drag). Hierarchy: when → who
 * (Llamar / WhatsApp / Ficha) → service, professional, site, origin, activity, colour →
 * "Reagendar" sits visible right under the time (apart from the states) →
 * "Más acciones" + the ONE next valid step (Sin confirmar → Confirmar, Confirmada →
 * Completar). States and transitions are exactly the backend's; cancel and no-show
 * confirm first in their own sheet, with the safe option first and focused.
 *
 * The colour row is the AUTOMATIC colour (service category) — the product has no
 * per-appointment manual colour, so none is offered. No internal note field either.
 */

type Target = Exclude<AppointmentStatus, "scheduled">;
type View = "detail" | "status" | "cancel" | "no_show" | null;

const ACTIVITY_LABEL: Record<AppointmentActivityItem["type"], string> = {
  created: "Creada",
  rescheduled: "Reprogramada",
  cancelled: "Cancelada",
  confirmed: "Confirmada",
  completed: "Completada",
  no_show: "Marcada como inasistencia",
  note: "Nota",
  other: "Actualizada",
};
const ACTOR_LABEL: Record<AppointmentActivityItem["actor"], string> = {
  team: "el equipo",
  public: "reserva en línea",
  agent: "el agente de reservas",
  system: "el sistema",
};
const STATE_DESC: Record<string, string> = {
  scheduled: "Pendiente de respuesta del cliente",
  confirmed: "El cliente confirmó que asistirá",
  completed: "El servicio terminó",
};
const CANCEL_REASONS = ["Cliente canceló", "Reprogramará", "Profesional no disponible", "Otro"] as const;

/** A phone number we can dial / open in WhatsApp — only digits and a leading +. */
function phoneOf(identity: string | null): string | null {
  if (!identity || identity.includes("@")) return null;
  const digits = identity.replace(/[^\d+]/g, "");
  return digits.replace(/\D/g, "").length >= 7 ? digits : null;
}

export function MobileAppointmentSheet(props: {
  appt: Appt;
  timezone: string;
  siteName: string;
  originLabel: string;
  canOperate: boolean;
  /** Server-computed per appointment (gateAppointment's checks) — see lib/appointmentActionPlan. */
  canModify: boolean;
  pending: boolean;
  error: string | null;
  contactHref: string | null;
  conversationHref: string | null;
  bookAgainHref: string | null;
  staffColor?: string;
  onClose: () => void;
  onReschedule: () => void;
  onStatus: (target: Target, reason?: string) => void;
  loadActivity: () => Promise<{ ok: true; items: AppointmentActivityItem[] } | { ok: false; error: string }>;
  loadReviewLink: ReviewLinkLoader;
  /** Without a linked contact: the SAME contact actions as desktop (GuestContact). */
  contactSlot?: React.ReactNode;
}) {
  const { appt, timezone: tz } = props;
  const [view, setView] = useState<View>("detail");
  const [reason, setReason] = useState<string | null>(null);
  const [otherReason, setOtherReason] = useState("");
  const [activity, setActivity] = useState<{ state: "loading" } | { state: "error" } | { state: "ready"; items: AppointmentActivityItem[] }>({ state: "loading" });

  const [now] = useState(() => Date.now());
  const plan = appointmentActionPlan({ canOperate: props.canOperate, canModify: props.canModify, status: appt.status, startAt: appt.start_at, now });
  // The activity line is part of the detail (who created it, when) — loaded once, and only
  // when the server would serve it (same appointment gate as the writes).
  useEffect(() => {
    if (!plan.readActivity) return;
    let alive = true;
    props.loadActivity().then((r) => {
      if (alive) setActivity(r.ok ? { state: "ready", items: r.items } : { state: "error" });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appt.id]);

  const review = useReviewLink(props.loadReviewLink);
  const canAct = plan.reschedule;
  const allowed = new Set<string>(plan.transitions);
  const primary: { label: string; target: Target } | null = plan.primary ? { label: plan.primary === "confirmed" ? "Confirmar" : "Completar", target: plan.primary } : null;
  // "Más acciones" only when it holds something this login may do or open.
  const hasMore = plan.transitions.length > 0 || Boolean(props.bookAgainHref || props.conversationHref);
  const blocked = props.canOperate ? rescheduleBlockedReason({ status: appt.status, allowed: plan.allowed, staffName: appt.staff_name }) : null;
  const client = apptClientLabel(appt);
  const firstName = client.replace(/^\s*[[(][^\])]*[\])]\s*/, "").split(/\s+/)[0];
  const start = fmtTime(appt.start_at, tz);
  const end = fmtTime(appt.service_end_at, tz);
  const price = priceLabelCOP(appt.price);
  const family = serviceCategory(appt.service_name, appt.service_category);
  const phone = phoneOf(appt.primary_identity);
  const created = activity.state === "ready" ? activity.items.find((i) => i.type === "created") ?? activity.items[0] : undefined;
  const close = () => {
    setView(null);
    props.onClose();
  };

  const rows: { k: string; v: React.ReactNode }[] = [
    {
      k: "Servicio",
      v: (
        <span className="flex items-center gap-2">
          <span aria-hidden className={`${mFamilyClass(appt)} size-3 flex-none rounded-full bg-[var(--m-dot)]`} />
          <span className={appt.status === "cancelled" ? "line-through" : ""}>
            {appt.service_name}
            {price ? ` · ${price}` : ""}
          </span>
        </span>
      ),
    },
    {
      k: "Profesional",
      v: (
        <span className="flex items-center gap-2">
          <MStaffAvatar id={appt.staff_id} name={appt.staff_name} size={28} color={props.staffColor} />
          {appt.staff_name ?? "Sin profesional"}
        </span>
      ),
    },
    { k: "Sede", v: props.siteName },
    { k: "Origen", v: props.originLabel },
    ...(plan.readActivity ? [{
      k: "Actividad",
      v:
        activity.state === "loading" ? (
          <span className="text-m-tx3">Cargando…</span>
        ) : created ? (
          `${ACTIVITY_LABEL[created.type]} por ${ACTOR_LABEL[created.actor]} · ${longDate(created.at, tz)} ${fmtTime(created.at, tz)}`
        ) : (
          <span className="text-m-tx3">{activity.state === "error" ? "No se pudo cargar la actividad." : "Sin actividad registrada."}</span>
        ),
    }] : []),
    ...(plan.reviewLink ? [{ k: "Reseña", v: <ReviewRow review={review} siteName={props.siteName} phone={phone} /> }] : []),
    {
      k: "Color",
      v: (
        <span className="flex items-center gap-2">
          <span aria-hidden className={`${mFamilyClass(appt)} flex size-7 flex-none items-center justify-center rounded-full bg-[var(--m-fill)] shadow-[inset_0_0_0_1px_var(--m-bd)]`}>
            <span className="size-2.5 rounded-full bg-[var(--m-dot)]" />
          </span>
          Automático · {CATEGORY_GROUPS.find((g) => g.value === family)?.label ?? "Sin categoría"}
        </span>
      ),
    },
  ];

  const finalReason = reason === "Otro" ? otherReason.trim() || "Otro" : reason ?? undefined;

  return (
    <>
      <Sheet
        open={view === "detail"}
        onClose={close}
        label="Detalle de la cita"
        expandable
        header={
          <div className="flex flex-none items-start gap-3 border-b border-m-dv px-4 pb-[14px]">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span aria-hidden className={`${mFamilyClass(appt)} block h-1.5 w-12 rounded-[3px] bg-[var(--m-dot)]`} />
              <span className="u-tnum text-[24px] font-semibold tracking-[-0.01em]">
                {start} – {end}
              </span>
              <span className="text-[14px] text-m-tx2">
                {longDate(appt.start_at, tz).replace(/ de \d{4}$/, "")} · {appt.duration_min} min
              </span>
              <MStateChip status={appt.status} />
            </div>
            <MIconButton label="Cerrar detalle" round soft onClick={close}>
              <Icon d={ICON.close} size={16} width={1.6} />
            </MIconButton>
          </div>
        }
        footer={
          hasMore || primary ? (
          <div className="flex gap-2">
            {hasMore ? <MButton onClick={() => setView("status")}>Más acciones</MButton> : null}
            {primary ? (
              <MButton kind="primary" grow loading={props.pending} loadingLabel="Guardando…" onClick={() => props.onStatus(primary.target)}>
                {primary.label}
              </MButton>
            ) : null}
          </div>
          ) : null
        }
        bodyClassName="px-4 pb-4"
      >
        {props.error ? (
          <p role="alert" className="mt-3 rounded-[12px] bg-m-dnbg px-3 py-2.5 text-[14px] text-m-dn">
            {props.error}
          </p>
        ) : null}
        {/* "Reagendar" — visible, apart from the state actions and cancel. */}
        {canAct ? (
          <MButton
            className="mt-3 w-full gap-2"
            disabled={props.pending}
            onClick={() => {
              // Close this sheet first: the flow is its own full-screen layer.
              setView(null);
              props.onReschedule();
            }}
          >
            <Icon d={ICON.calendar} size={18} width={1.4} />
            Reagendar
          </MButton>
        ) : blocked ? (
          <p className="m-0 mt-3 text-[14px] leading-[1.45] text-m-tx3">{blocked}</p>
        ) : null}
        <div className="flex items-center gap-3 pb-3 pt-4">
          <MClientAvatar name={appt.contact_name} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="break-words text-[17px] font-semibold leading-[1.3]">{client}</span>
            {appt.primary_identity ? <span className="u-tnum text-[14px] text-m-tx3">{appt.primary_identity}</span> : null}
            {!appt.contact_id ? <span className="text-[14px] text-m-tx3">Sin cliente asociado</span> : null}
          </div>
        </div>
        {phone || props.contactHref ? (
          <div className="grid grid-cols-3 gap-2 pb-4">
            {phone ? (
              <a href={`tel:${phone}`} className="flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-[12px] border border-m-bd bg-m-sf text-[13px] text-m-tx">
                <Icon d={ICON.phone} size={18} width={1.4} />
                Llamar
              </a>
            ) : null}
            {phone ? (
              // Opens a chat with the client — it does not send anything by itself.
              <a href={`https://wa.me/${phone.replace(/\D/g, "")}`} target="_blank" rel="noopener noreferrer" className="flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-[12px] border border-m-bd bg-m-sf text-[13px] text-m-tx">
                <Icon d={ICON.chat} size={18} width={1.4} />
                WhatsApp
              </a>
            ) : null}
            {props.contactHref ? (
              <Link href={props.contactHref} className="flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-[12px] border border-m-bd bg-m-sf text-[13px] text-m-tx">
                <Icon d={ICON.person} size={18} width={1.4} />
                Ficha
              </Link>
            ) : null}
          </div>
        ) : null}
        {rows.map((r) => (
          <div key={r.k} className="flex min-h-[56px] items-start gap-3 border-t border-m-dv py-4">
            <span className="w-24 flex-none pt-px text-[14px] text-m-tx3">{r.k}</span>
            <span className="min-w-0 flex-1 text-[15px] leading-[1.4]">{r.v}</span>
          </div>
        ))}
        {props.contactSlot ? (
          <div className="flex flex-col gap-2 border-t border-m-dv py-4">
            <span className="text-[14px] font-semibold text-m-tx2">Cliente</span>
            {props.contactSlot}
          </div>
        ) : null}
      </Sheet>

      <Sheet open={view === "status"} onClose={() => setView("detail")} label="Acciones de la cita" bodyClassName="flex flex-col px-4 pb-[max(20px,env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Volver al detalle" onClick={() => setView("detail")} className="-ml-2.5 flex size-[44px] flex-none items-center justify-center border-0 bg-transparent text-m-tx">
            <Icon d={ICON.back} size={20} width={1.6} />
          </button>
          <div className="flex flex-col">
            <span className="text-[18px] font-semibold">Estado y acciones</span>
            <span className="text-[14px] text-m-tx3">
              {client} · {start} – {end}
            </span>
          </div>
        </div>
        <div role="radiogroup" aria-label="Estado" className="pt-2">
          {(["scheduled", "confirmed", "completed"] as const).map((s) => {
            const cur = appt.status === s;
            const enabled = cur || allowed.has(s);
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={cur}
                disabled={!enabled || props.pending}
                onClick={() => {
                  if (cur || !allowed.has(s)) return;
                  props.onStatus(s as Target);
                  setView("detail");
                }}
                className="flex min-h-[60px] w-full items-center gap-3 border-0 border-t border-m-dv bg-transparent px-1 py-[10px] text-left text-m-tx first:border-t-0 disabled:opacity-45"
              >
                <span aria-hidden className={`u-m-st-${s} flex size-9 flex-none items-center justify-center rounded-[10px] text-[15px] font-semibold`}>
                  {STATE_ICON[s]}
                </span>
                <span className="flex flex-1 flex-col">
                  <span className="text-[16px]">{STATE_LABEL[s]}</span>
                  <span className="text-[13px] text-m-tx3">{s === "completed" && plan.completeWaitsForStart ? "Se habilita al empezar la cita" : STATE_DESC[s]}</span>
                </span>
                {cur ? <span className="text-[13px] font-semibold text-m-ok">Actual</span> : null}
              </button>
            );
          })}
        </div>
        {props.bookAgainHref || props.conversationHref ? (
          <div className="flex flex-col">
            {props.bookAgainHref ? (
              <Link href={props.bookAgainHref} className="flex min-h-[56px] items-center gap-3 border-t border-m-dv px-1 text-[16px] text-m-tx">
                Reservar de nuevo
              </Link>
            ) : null}
            {props.conversationHref ? (
              <Link href={props.conversationHref} className="flex min-h-[56px] items-center gap-3 border-t border-m-dv px-1 text-[16px] text-m-tx">
                Ver conversación
              </Link>
            ) : null}
          </div>
        ) : null}
        {canAct && (allowed.has("no_show") || allowed.has("cancelled")) ? (
          <>
            <span className="pb-2 pt-[18px] text-[12.5px] font-semibold uppercase tracking-[0.04em] text-m-tx3">Liberan el horario · piden confirmación</span>
            <div className="overflow-hidden rounded-[16px] border border-m-dnbd">
              {allowed.has("no_show") ? (
                <button type="button" onClick={() => setView("no_show")} className="flex min-h-[52px] w-full items-center gap-2.5 border-0 bg-transparent px-[14px] text-left text-[16px] text-m-dn">
                  <span aria-hidden>⊘</span>Marcar inasistencia
                </button>
              ) : null}
              {allowed.has("cancelled") ? (
                <button type="button" onClick={() => setView("cancel")} className="flex min-h-[52px] w-full items-center gap-2.5 border-0 border-t border-m-dnbd bg-transparent px-[14px] text-left text-[16px] text-m-dn">
                  <span aria-hidden>✕</span>Cancelar cita
                </button>
              ) : null}
            </div>
          </>
        ) : null}
        <MButton className="mt-[14px] w-full" onClick={() => setView("detail")}>
          Cerrar
        </MButton>
      </Sheet>

      <Sheet open={view === "cancel"} onClose={() => setView("status")} alert label={`¿Cancelar la cita de ${firstName}?`} bodyClassName="pb-[max(20px,env(safe-area-inset-bottom))]">
        <MConfirm
          title={`¿Cancelar la cita de ${firstName}?`}
          body={`Se libera el horario de ${start} a ${end}${appt.staff_name ? ` con ${appt.staff_name}` : ""}. La cita queda en el historial como cancelada.`}
        >
          <div className="flex flex-col gap-2">
            <span className="text-[14px] font-semibold">
              Motivo <span className="font-normal text-m-tx3">(opcional)</span>
            </span>
            <div role="radiogroup" aria-label="Motivo" className="flex flex-wrap gap-2">
              {CANCEL_REASONS.map((r) => (
                <MPill key={r} role="radio" selected={reason === r} onClick={() => setReason(reason === r ? null : r)}>
                  {r}
                </MPill>
              ))}
            </div>
            {reason === "Otro" ? (
              <textarea
                value={otherReason}
                onChange={(e) => setOtherReason(e.target.value)}
                maxLength={500}
                rows={2}
                aria-label="Describe el motivo"
                placeholder="Describe el motivo"
                className="min-h-[72px] w-full resize-none rounded-[12px] border border-m-bd bg-m-sf px-[14px] py-3 text-[16px] leading-[1.4] text-m-tx"
              />
            ) : null}
          </div>
          <div className="flex flex-col gap-2 pt-1">
            <MButton data-autofocus className="w-full font-semibold" onClick={() => setView("status")}>
              Volver sin cambiar
            </MButton>
            <MButton
              kind="danger"
              className="w-full"
              loading={props.pending}
              loadingLabel="Cancelando…"
              onClick={() => {
                props.onStatus("cancelled", finalReason);
                setView("detail");
              }}
            >
              Cancelar cita
            </MButton>
          </div>
        </MConfirm>
      </Sheet>

      <Sheet open={view === "no_show"} onClose={() => setView("status")} alert label="¿Marcar inasistencia?" bodyClassName="pb-[max(20px,env(safe-area-inset-bottom))]">
        <MConfirm title="¿Marcar inasistencia?" body={`${client} no se presentó a las ${start}. Quedará registrado en su ficha y el horario se libera.`}>
          <div className="flex flex-col gap-2 pt-1">
            <MButton data-autofocus className="w-full font-semibold" onClick={() => setView("status")}>
              Volver sin cambiar
            </MButton>
            <MButton
              kind="danger"
              className="w-full"
              loading={props.pending}
              onClick={() => {
                props.onStatus("no_show");
                setView("detail");
              }}
            >
              Marcar inasistencia
            </MButton>
          </div>
        </MConfirm>
      </Sheet>
    </>
  );
}

/** "Reseña" row of a COMPLETED appointment: create the link, then copy or open WhatsApp. */
function ReviewRow({ review, siteName, phone }: { review: ReturnType<typeof useReviewLink>; siteName: string; phone: string | null }) {
  const { s, create, copy } = review;
  if (s.state === "idle" || s.state === "error") {
    return (
      <span className="flex flex-col items-start gap-2">
        {s.state === "error" ? <span role="alert" className="text-[14px] text-m-dn">{s.error}</span> : <span className="text-m-tx3">Se publica solo si la apruebas.</span>}
        <MButton onClick={create} className="h-[44px]">
          {s.state === "error" ? "Reintentar" : "Crear enlace de reseña"}
        </MButton>
      </span>
    );
  }
  if (s.state === "loading") return <span className="text-m-tx3">Creando enlace…</span>;
  const wa = whatsappHref(phone, reviewShareText(siteName, s.url));
  return (
    <span className="flex flex-col items-start gap-2">
      {s.answered ? <span className="text-m-tx3">El cliente ya respondió.</span> : null}
      <span className="flex flex-wrap gap-2">
        <MButton onClick={copy} className="h-[44px]">
          {s.copied ? "Copiado" : "Copiar enlace"}
        </MButton>
        {wa ? (
          <a href={wa} target="_blank" rel="noopener noreferrer" className="flex h-[44px] items-center rounded-[12px] border border-m-bd bg-m-sf px-4 text-[15px] text-m-tx">
            WhatsApp
          </a>
        ) : null}
      </span>
      <span aria-live="polite" className="sr-only">{s.copied ? "Enlace copiado" : ""}</span>
    </span>
  );
}
