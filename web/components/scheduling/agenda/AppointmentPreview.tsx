"use client";

import { apptClientLabel } from "@/lib/apptClientLabel";
import { AgAvatar, StateChip } from "./AgendaChrome";
import { apptCategoryClass, serviceCategory } from "@/lib/agendaCategory";

import { useLayoutEffect, useRef, useState } from "react";
import { priceLabelCOP } from "@/lib/money";
import { fmtTime } from "@/lib/siteCalendar";
import type { Appt } from "../AgendaView";
import { POPOVER } from "../ui/system";

/**
 * The HOVER PREVIEW of an appointment — an informational card anchored beside the
 * card under the pointer (or the keyboard focus). It never changes anything: no
 * buttons, no status writes, no messages. Clicking the appointment opens the detail.
 *
 * Placement: to the RIGHT of the anchor when it fits, else to the LEFT, vertically
 * aligned with it and clamped inside the viewport — measured after render, so the
 * card never spills off-screen or shifts the calendar (it is `position: fixed`).
 *
 * The pointer may travel from the card INTO the preview without it closing (the
 * parent delays the hide and `onPointerEnter` here cancels it) — no flicker.
 *
 * Built from the same pieces as the detail panel (POPOVER card, StateChip, Avatar), so
 * hover → click reads as one object getting bigger. The state wears its own tone, never
 * the card's service pastel.
 * Only what the server already sent is shown: a staff login receives no
 * `primary_identity`, so no phone appears for it.
 */
export function AppointmentPreview({
  id,
  appt,
  timezone,
  anchor,
  onPointerEnter,
  onPointerLeave,
}: {
  id: string;
  appt: Appt;
  timezone: string;
  anchor: DOMRect;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const gap = 10;
    const margin = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.right + gap;
    if (left + w > vw - margin) left = anchor.left - gap - w;
    if (left < margin) left = Math.min(Math.max(margin, anchor.left), vw - w - margin);
    const top = Math.min(Math.max(margin, anchor.top), Math.max(margin, vh - h - margin));
    setPos({ left, top });
  }, [anchor]);

  const client = apptClientLabel(appt);
  const price = priceLabelCOP(appt.price);
  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden" }}
      className={`fixed z-[60] w-[19rem] ${POPOVER}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <span className="u-mono text-[13px] font-semibold">
          {fmtTime(appt.start_at, timezone)} – {fmtTime(appt.service_end_at, timezone)}
        </span>
        <StateChip status={appt.status} size="sm" toneClass={`u-appt-service ${apptCategoryClass(serviceCategory(appt.service_name, appt.service_category))}`} />
      </div>
      <div className="flex items-center gap-3 px-4 py-3">
        <AgAvatar name={appt.contact_name} size={32} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{client}</span>
          {appt.primary_identity ? <span className="u-mono truncate text-xs text-muted">{appt.primary_identity}</span> : null}
        </span>
      </div>
      <div className="flex flex-col gap-1.5 border-t border-line px-4 py-3 text-[13px]">
        <p className="flex items-start justify-between gap-3">
          <span className="min-w-0 font-medium">{appt.service_name}</span>
          <span className="u-mono shrink-0 font-medium">{price ?? "Sin precio"}</span>
        </p>
        <p className="flex items-center justify-between gap-3 text-muted">
          <span className="flex min-w-0 items-center gap-2">
            <AgAvatar name={appt.staff_name} id={appt.staff_id} size={20} />
            <span className="truncate">{appt.staff_name ?? "Sin profesional"}</span>
          </span>
          <span className="u-mono shrink-0">{appt.duration_min} min</span>
        </p>
      </div>
    </div>
  );
}
