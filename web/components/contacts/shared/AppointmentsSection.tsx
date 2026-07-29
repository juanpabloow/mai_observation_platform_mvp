"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import { agendaDateKey, type AppointmentSummary, type AppointmentView } from "@/lib/contactShared";
import { cancelAppointmentAction } from "@/lib/schedulingActions";
import type { AppointmentStatus } from "@worker/db/repositories/scheduling/appointments.js";

/**
 * SHARED appointments block (C-4). The record rail shows the next appointment + upcoming
 * + recent past; the inbox panel shows just the next one (`showHistory={false}`).
 *
 * Reschedule + Cancel go through the EXISTING appointment state machine — Cancel calls
 * cancelAppointmentAction directly; Reschedule DEEP-LINKS to the agenda on the
 * appointment's date, where the existing reschedule flow (availability picker) lives,
 * rather than duplicating that picker here.
 */

const STATUS_CLASS: Record<AppointmentStatus, string> = {
  scheduled: "bg-subtle text-muted",
  confirmed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  cancelled: "bg-subtle text-faint",
  no_show: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
};
const STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};
const BADGE = "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium";

function StatusBadge({ status }: { status: AppointmentStatus }) {
  return <span className={`${BADGE} ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>;
}

function agendaHref(clientId: string, a: AppointmentView): string {
  return `/clients/${clientId}/scheduling/agenda?date=${agendaDateKey(a.startAt)}`;
}

function NextCard({
  clientId,
  appt,
  onChanged,
}: {
  clientId: string;
  appt: AppointmentView;
  onChanged?: () => void;
}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const cancel = () => {
    setErr(null);
    start(async () => {
      const r = await cancelAppointmentAction(clientId, appt.id);
      if (!r.ok) setErr(r.error);
      else onChanged?.();
    });
  };
  return (
    <div className="rounded-xl border border-line bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{appt.serviceName}</p>
          <p className="truncate text-xs text-muted">
            {formatDateTime(new Date(appt.startAt))}
            {appt.staffName ? ` · ${appt.staffName}` : ""}
          </p>
        </div>
        <StatusBadge status={appt.status} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Link
          href={agendaHref(clientId, appt)}
          className="rounded-lg border border-line px-2 py-1 text-xs text-foreground transition-colors hover:bg-subtle"
        >
          Reschedule
        </Link>
        <button
          type="button"
          onClick={cancel}
          disabled={pending}
          className="rounded-lg border border-line px-2 py-1 text-xs text-muted transition-colors hover:bg-subtle hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
        {err ? <span className="text-xs text-danger">{err}</span> : null}
      </div>
    </div>
  );
}

function PastRow({ clientId, appt }: { clientId: string; appt: AppointmentView }) {
  return (
    <li>
      <Link
        href={agendaHref(clientId, appt)}
        className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-subtle"
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm text-foreground">{appt.serviceName}</span>
          <span className="truncate text-xs text-faint">{formatDateTime(new Date(appt.startAt))}</span>
        </span>
        <StatusBadge status={appt.status} />
      </Link>
    </li>
  );
}

export function AppointmentsSection({
  clientId,
  appointments,
  onChanged,
  showHistory = true,
}: {
  clientId: string;
  appointments: AppointmentSummary;
  onChanged?: () => void;
  showHistory?: boolean;
}) {
  const { next, upcoming, past } = appointments;
  const laterUpcoming = upcoming.slice(1); // `next` is upcoming[0]

  return (
    <div className="flex flex-col gap-3">
      {next ? (
        <NextCard clientId={clientId} appt={next} onChanged={onChanged} />
      ) : (
        <p className="text-sm text-faint">No upcoming appointment.</p>
      )}

      {showHistory && laterUpcoming.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-[10px] font-medium uppercase tracking-wider text-faint">Also upcoming</p>
          <ul className="flex flex-col">
            {laterUpcoming.map((a) => (
              <PastRow key={a.id} clientId={clientId} appt={a} />
            ))}
          </ul>
        </div>
      ) : null}

      {showHistory && past.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-[10px] font-medium uppercase tracking-wider text-faint">Recent</p>
          <ul className="flex flex-col">
            {past.slice(0, 5).map((a) => (
              <PastRow key={a.id} clientId={clientId} appt={a} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
