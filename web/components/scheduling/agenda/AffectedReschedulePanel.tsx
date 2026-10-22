"use client";

import { useCallback, useState } from "react";
import { StatusChip } from "../ui/system";
import { fmtTime, longDate } from "@/lib/siteCalendar";
import { SidePanel } from "./SidePanel";
import { RescheduleInline } from "./RescheduleInline";
import type { AffectedItem } from "./ScheduleFormParts";

/**
 * REAGENDAR one appointment listed as affected by a break/block being edited — the SAME
 * appointment (same id, contact, service, origin, history), with the unsaved draft
 * discounted (`holds`). Saving, cancelling or a failed save all return to the form, which
 * kept everything typed and recalculates its conflicts (only a real move resolves one).
 */
export function AffectedReschedulePanel(props: {
  clientId: string;
  siteId: string;
  timezone: string;
  item: AffectedItem;
  holds: string[];
  staff: Array<{ id: string; name: string; photoUrl?: string | null }>;
  openWeekdays: Set<string>;
  lockStaffId: string | null;
  returnLabel: string;
  onBack: (moved: boolean) => void;
}) {
  const { item, timezone: tz } = props;
  const [dirty, setDirty] = useState(false);
  const onDirty = useCallback((d: boolean) => setDirty(d), []);
  const appt = {
    id: item.id,
    staff_id: item.staffId ?? "",
    staff_name: item.staffName,
    service_id: item.serviceId ?? "",
    service_name: item.serviceName,
    start_at: item.startAt,
    service_end_at: item.endAt,
    duration_min: item.durationMin ?? Math.round((Date.parse(item.endAt) - Date.parse(item.startAt)) / 60_000),
    status: item.status ?? "scheduled",
    contact_name: item.customerName,
  };
  return (
    <RescheduleInline
      clientId={props.clientId}
      siteId={props.siteId}
      timezone={tz}
      appt={appt}
      staff={props.staff}
      lockStaffId={props.lockStaffId}
      openWeekdays={props.openWeekdays}
      holds={props.holds}
      onDirty={onDirty}
      onCancel={() => props.onBack(false)}
      onDone={() => props.onBack(true)}
      frame={(body, footer) => (
        <SidePanel
          name="affected-reschedule"
          title={`Reagendar · ${item.customerName ?? "Sin contacto"}`}
          subtitle={<span className="u-tnum">{longDate(item.startAt, tz)} · {fmtTime(item.startAt, tz)} – {fmtTime(item.endAt, tz)} · {item.serviceName}</span>}
          aside={<StatusChip status={appt.status} size="sm" />}
          dirty={dirty}
          onClose={() => props.onBack(false)}
          backLabel={`Volver a ${props.returnLabel}`}
          onBack={() => props.onBack(false)}
          footer={footer}
        >
          <p className="mb-4 rounded-[10px] bg-subtle px-3 py-2 text-[12.5px] text-muted">
            Lo que estás editando ya se descuenta de las horas libres. Al guardar o volver regresas a {props.returnLabel} con todo lo que escribiste.
          </p>
          {body}
        </SidePanel>
      )}
    />
  );
}
