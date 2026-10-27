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
import { GuestContact } from "./GuestContact";
import type { ServiceOption, StaffOption } from "./editPanels";
import type { PaymentHooks } from "./PaymentSection";
import { AppointmentCard, CalIcon, dayLabel, formatDuration, initials, type CardParts, type InlineRescheduleConfig } from "./AppointmentCard";

/**
 * The APPOINTMENT DETAIL — the agenda's side panel (SidePanel «card», 520 px, floating, the
 * calendar stays visible and usable beside it) and, on the phone, the bottom sheet. Both frame
 * the SAME AppointmentCard, so the phone and the desktop offer exactly the same states, sections
 * and edits.
 *
 * JP-5: date/time, service and professional are each editable in place ON the row, inside the
 * card body (desktop and phone alike). The only separate flow left here is a DEEP-LINKED
 * «Reagendar» (from an affected-appointments list or a contact record): it still opens the panel
 * directly in the reschedule picker on desktop, and the phone uses AgendaView's full-screen flow.
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
  clientId: string;
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
  /** Open directly in «Reagendar» (deep-linked from an affected-appointments list). */
  startInReschedule?: boolean;
  onContactSaved?: (message: string) => void;
  /** Where to return after a reschedule opened from a form (label for the back link). */
  returnLabel?: string | null;
  /** PY-2: the «Cobro» of a completed appointment — only with payments.view. */
  payment?: PaymentHooks | null;
  // ── JP-5 edit-in-place ──
  /** The site's service catalogue + active professionals for the inline editors. */
  services: ServiceOption[];
  staff: StaffOption[];
  /** The day's appointments, for the live conflict preview. */
  others: Appt[];
  /** A staff login (locked to its own column): no service/professional edit controls. */
  isStaffLogin: boolean;
  /** An in-place edit saved (refresh + toast). */
  onEdited: (verb: string) => void;
  /** A future reschedule landed (may move days → navigate + flash on the grid). */
  onTimeRescheduled: (r: { dayKey: string; appointmentId: string; startAt: string }) => void;
}) {
  const { appt, timezone: tz } = props;
  const phone = useIsOverlayWidth(767.98);
  const [mode, setMode] = useState<"detail" | "reschedule">(props.startInReschedule ? "reschedule" : "detail");
  const [rescheduleDirty, setRescheduleDirty] = useState(false);
  const [contactDirty, setContactDirty] = useState(false);
  const handle = useRef<SidePanelHandle | null>(null);
  const onRescheduleDirty = useCallback((d: boolean) => setRescheduleDirty(d), []);
  const onContactDirty = useCallback((d: boolean) => setContactDirty(d), []);

  const [now] = useState(() => Date.now());
  const plan = appointmentActionPlan({ canOperate: props.canOperate, canModify: props.canModify, status: appt.status, startAt: appt.start_at, now });
  const blocked = props.canOperate ? rescheduleBlockedReason({ status: appt.status, allowed: plan.allowed, staffName: appt.staff_name }) : null;
  const client = apptClientLabel(appt);

  // The in-card time editor reschedules a FUTURE appointment with availability rules; present
  // only when this login may operate the agenda (the config carries the site + open weekdays).
  const inlineReschedule: InlineRescheduleConfig | null = props.reschedule
    ? { siteId: props.reschedule.siteId, openWeekdays: props.reschedule.openWeekdays, lockStaffId: props.reschedule.lockStaffId, holds: props.reschedule.holds }
    : null;

  const guest = !appt.contact_id ? (
    <GuestContact
      clientId={props.clientId}
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

  const card = (frame: (p: CardParts) => React.ReactNode, extraRows?: Array<{ k: string; v: React.ReactNode }>) => (
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
      clientId={props.clientId}
      services={props.services}
      staff={props.staff}
      others={props.others}
      reschedule={inlineReschedule}
      isStaffLogin={props.isStaffLogin}
      onTimeRescheduled={props.onTimeRescheduled}
      onEdited={props.onEdited}
      loadActivity={props.loadActivity}
      loadReviewLink={props.loadReviewLink}
      payment={props.payment}
      contactSlot={guest}
      extraRows={extraRows}
      frame={frame}
    />
  );

  if (phone) {
    const family = serviceCategory(appt.service_name, appt.service_category);
    return card((parts) => <MobileAppointmentSheet parts={parts} onClose={props.onClose} />, [
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
    ]);
  }

  // Desktop deep-linked «Reagendar» (startInReschedule): the full availability picker in the panel.
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
            subtitle="Cambiar fecha y hora · la misma cita"
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

  return card((parts) => (
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
  ));
}
