"use client";

import { apptClientLabel } from "@/lib/apptClientLabel";
import { useCallback, useRef, useState } from "react";
import { useIsOverlayWidth } from "@/components/ui/Overlay";
import { MobileAppointmentSheet } from "../mobile/MobileAppointmentSheet";
import { mFamilyClass } from "../mobile/MobileAgenda";
import { CATEGORY_GROUPS } from "../services/categories";
import { serviceCategory } from "@/lib/agendaCategory";
import { appointmentActionPlan } from "@/lib/appointmentActionPlan";
import { rescheduleBlockedReason } from "@/lib/rescheduleFlow";
import { fmtTime } from "@/lib/siteCalendar";
import type { AppointmentActivityItem } from "@/lib/schedulingActions";
import type { ReviewLinkLoader } from "./ReviewLink";
import type { Appt } from "../AgendaView";
import { type AppointmentStatus } from "./status";
import { SidePanel, type SidePanelHandle } from "./SidePanel";
import { RescheduleInline } from "./RescheduleInline";
import { ServiceChangeInline, type ServiceOption } from "./ServiceChangeInline";
import { TimeCorrectInline } from "./TimeCorrectInline";
import { GuestContact } from "./GuestContact";
import { Icon, ICON, Sheet } from "../mobile/kit";
import type { PaymentHooks } from "./PaymentSection";
import { AppointmentCard, CalIcon, dayLabel, formatDuration, initials, type CardParts } from "./AppointmentCard";

/**
 * The APPOINTMENT DETAIL — the agenda's side panel (SidePanel «card», 520 px, floating, the
 * calendar stays visible and usable beside it) and, on the phone, the bottom sheet. Both frame
 * the SAME AppointmentCard (card language 5a), so the phone and the desktop offer exactly the
 * same states, sections and actions. Reagendar opens INSIDE this same panel on desktop
 * (RescheduleInline) — the same appointment moves; nothing is cancelled and recreated — and as
 * its own full-screen flow on the phone.
 *
 * A past appointment is never assumed completed: it keeps its state and says so.
 */

type Target = Exclude<AppointmentStatus, "scheduled">;

export interface ReschedulePanelConfig {
  clientId: string;
  siteId: string;
  staff: Array<{ id: string; name: string; photoUrl?: string | null; tint?: "1" | "2" | "3" | "4" }>;
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
  payment?: PaymentHooks | null;
  /** JP-4: the site's service catalogue for «Cambiar servicio». */
  services?: ServiceOption[];
  /** JP-4: after a service change or time correction — refresh + toast. */
  onEdited?: (message: string) => void;
}) {
  const { appt, timezone: tz } = props;
  const phone = useIsOverlayWidth(767.98);
  const [mode, setMode] = useState<"detail" | "reschedule" | "service" | "time">(props.startInReschedule ? "reschedule" : "detail");
  const [rescheduleDirty, setRescheduleDirty] = useState(false);
  const [editDirty, setEditDirty] = useState(false);
  const [contactDirty, setContactDirty] = useState(false);
  // Phone: «Reagendar» is its own full-screen flow, so the sheet steps aside for it.
  const [hidden, setHidden] = useState(false);
  const handle = useRef<SidePanelHandle | null>(null);
  const onRescheduleDirty = useCallback((d: boolean) => setRescheduleDirty(d), []);
  const onEditDirty = useCallback((d: boolean) => setEditDirty(d), []);
  const onContactDirty = useCallback((d: boolean) => setContactDirty(d), []);

  const [now] = useState(() => Date.now());
  const plan = appointmentActionPlan({ canOperate: props.canOperate, canModify: props.canModify, status: appt.status, startAt: appt.start_at, now });
  const blocked = props.canOperate ? rescheduleBlockedReason({ status: appt.status, allowed: plan.allowed, staffName: appt.staff_name }) : null;
  const client = apptClientLabel(appt);

  // JP-4 edit entry points: both need the client/staff config; a service change also needs at
  // least one OTHER service to switch to. The server re-checks every request regardless.
  const canEdit = Boolean(props.reschedule);
  const onChangeService = canEdit && plan.changeService && (props.services ?? []).some((s) => s.id !== appt.service_id) ? () => setMode("service") : null;
  const onCorrectTime = canEdit && plan.correctTime ? () => setMode("time") : null;

  const guest = !appt.contact_id ? (
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
  ) : null;

  const card = (frame: (p: CardParts) => React.ReactNode, onReschedule: (() => void) | null, extraRows?: Array<{ k: string; v: React.ReactNode }>) => (
    <AppointmentCard
      appt={appt}
      timezone={tz}
      toneClass={props.toneClass}
      siteName={props.siteName}
      originLabel={props.originLabel}
      plan={plan}
      canOperate={props.canOperate}
      blocked={blocked}
      pending={props.pending}
      error={props.error}
      contactHref={props.contactHref}
      conversationHref={props.conversationHref}
      bookAgainHref={props.bookAgainHref}
      staffTint={props.staffTint}
      review={props.review}
      onStatus={props.onStatus}
      onReschedule={onReschedule}
      onChangeService={onChangeService}
      onCorrectTime={onCorrectTime}
      loadActivity={props.loadActivity}
      loadReviewLink={props.loadReviewLink}
      payment={props.payment}
      contactSlot={guest}
      extraRows={extraRows}
      frame={frame}
    />
  );

  // JP-4 — «Cambiar servicio» / «Corregir hora o profesional». Both edit THE SAME appointment
  // in its own panel (desktop) / sheet (phone), like Reagendar; the detail returns on Volver or
  // after a save. The server re-checks every request through the appointment gate.
  if ((mode === "service" || mode === "time") && props.reschedule) {
    const cfg = props.reschedule;
    const onDoneEdit = (m: string) => {
      setEditDirty(false);
      setMode("detail");
      props.onEdited?.(m);
    };
    const renderEditFrame = (subtitle: string, body: React.ReactNode, footer: React.ReactNode) =>
      phone ? (
        <Sheet
          open
          onClose={props.onClose}
          label={subtitle}
          expandable
          tone="card"
          header={
            <div className="c5-head flex-none gap-2 pt-0">
              <div className="-mr-2 flex items-center justify-end">
                <button type="button" aria-label="Volver al detalle" title="Volver" onClick={() => setMode("detail")} className="u-focus c5-x">
                  <Icon d={ICON.close} size={16} width={1.6} />
                </button>
              </div>
              <div className="flex items-center gap-3">
                <span aria-hidden className={`${props.toneClass} c5-bar`} style={{ background: "var(--appt-rule, var(--c5-sec))" }} />
                <h2 className="c5-title min-w-0 flex-1 break-words">{client}</h2>
              </div>
              <p className="c5-note">{subtitle}</p>
            </div>
          }
          footer={footer}
          bodyClassName="c5-body"
        >
          {body}
        </Sheet>
      ) : (
        <SidePanel
          name={mode}
          variant="card"
          title={client}
          subtitle={subtitle}
          leading={
            <>
              <span aria-hidden className={`${props.toneClass} c5-bar`} style={{ background: "var(--appt-rule, var(--c5-sec))" }} />
              <span aria-hidden className="c5-av">{initials(client)}</span>
            </>
          }
          meta={
            <div className="c5-meta">
              <span className="flex items-center gap-1.5">
                <CalIcon />
                {dayLabel(appt.start_at, tz)}
              </span>
              <span>
                {fmtTime(appt.start_at, tz)} – {fmtTime(appt.service_end_at, tz)}
              </span>
              <span className="text-[var(--c5-head-sub)]">{formatDuration(appt.duration_min)}</span>
            </div>
          }
          bodyClassName="pt-4 pb-5"
          dirty={editDirty}
          onClose={props.onClose}
          handleRef={handle}
          insideSelector="[data-appt-card]"
          footer={footer}
        >
          {body}
        </SidePanel>
      );
    if (mode === "service") {
      return (
        <ServiceChangeInline
          clientId={cfg.clientId}
          appt={appt}
          services={props.services ?? []}
          onCancel={() => setMode("detail")}
          onDirty={onEditDirty}
          onDone={onDoneEdit}
          frame={(body, footer) => renderEditFrame("Cambiar servicio · misma cita, cliente e historial", body, footer)}
        />
      );
    }
    return (
      <TimeCorrectInline
        clientId={cfg.clientId}
        timezone={tz}
        appt={appt}
        staff={cfg.staff}
        lockStaffId={cfg.lockStaffId}
        onCancel={() => setMode("detail")}
        onDirty={onEditDirty}
        onDone={onDoneEdit}
        frame={(body, footer) => renderEditFrame("Corregir hora o profesional · registra lo que pasó", body, footer)}
      />
    );
  }

  if (phone) {
    if (hidden) return null;
    const family = serviceCategory(appt.service_name, appt.service_category);
    return card(
      (parts) => <MobileAppointmentSheet parts={parts} onClose={props.onClose} />,
      plan.reschedule
        ? () => {
            setHidden(true);
            props.onReschedule();
          }
        : null,
      [
        { k: "Sede", v: props.siteName },
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
      ],
    );
  }

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
            variant="card"
            title={client}
            subtitle="Reagendar · la misma cita cambia de fecha u hora"
            leading={
              <>
                <span aria-hidden className={`${props.toneClass} c5-bar`} style={{ background: "var(--appt-rule, var(--c5-sec))" }} />
                <span aria-hidden className="c5-av">{initials(client)}</span>
              </>
            }
            meta={
              <div className="c5-meta">
                <span className="flex items-center gap-1.5">
                  <CalIcon />
                  {dayLabel(appt.start_at, tz)}
                </span>
                <span>
                  {fmtTime(appt.start_at, tz)} – {fmtTime(appt.service_end_at, tz)}
                </span>
                <span className="text-[var(--c5-head-sub)]">{formatDuration(appt.duration_min)}</span>
              </div>
            }
            bodyClassName="pt-4 pb-5"
            dirty={rescheduleDirty}
            onClose={props.onClose}
            handleRef={handle}
            insideSelector="[data-appt-card]"
            footer={footer}
          >
            {props.returnLabel ? <p className="c5-note mb-3">Al guardar vuelves a {props.returnLabel}, con lo que escribiste.</p> : null}
            {body}
          </SidePanel>
        )}
      />
    );
  }

  return card(
    (parts) => (
      <SidePanel
        name="appointment"
        variant="card"
        title={parts.title}
        leading={parts.leading}
        aside={parts.status}
        meta={parts.meta}
        dirty={contactDirty}
        covered={props.covered}
        onClose={props.onClose}
        handleRef={handle}
        insideSelector="[data-appt-card]"
        footer={parts.footer}
      >
        {parts.body}
      </SidePanel>
    ),
    props.reschedule ? () => setMode("reschedule") : null,
  );
}
