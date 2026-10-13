"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createTimeOffAction,
  updateTimeOffAction,
  type TimeOffConflict,
  type TimeOffResult,
} from "@/lib/timeOffActions";

/**
 * The ONE Time Off form — used from the agenda header ("Bloquear horario"), a staff
 * member's Time Off tab, and the site's closures list. It creates/edits a block (vacations,
 * a day off, a few hours out, or a whole-site closure) that removes availability WITHOUT
 * touching the weekly schedule. Times are entered as local wall-clock in the site timezone;
 * the server anchors them to that tz. When a block overlaps booked appointments the server
 * returns them here and the person decides to keep them (they stay, flagged in the agenda)
 * or cancel — nothing is ever auto-cancelled.
 */

const INPUT =
  "h-[44px] lg:h-[36px] w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-foreground outline-none transition focus:border-foreground";
const BTN =
  "inline-flex h-[44px] lg:h-[36px] items-center justify-center rounded-lg bg-foreground px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50";
const GHOST =
  "inline-flex h-[44px] lg:h-[36px] items-center justify-center rounded-lg border border-line-strong px-3.5 text-sm font-medium text-foreground transition hover:bg-subtle";

export interface TimeOffEdit {
  id: string;
  staffId: string | null;
  startsAt: string; // ISO UTC
  endsAt: string; // ISO UTC
  reason: string | null;
}

/** UTC ISO → local {date:"YYYY-MM-DD", time:"HH:MM"} in the given IANA tz (display only). */
function toLocal(iso: string, tz: string): { date: string; time: string } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** The calendar day before `date` — the inclusive last day of a full-day block whose stored
 *  end is the exclusive midnight after it. */
function prevDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function todayLocal(tz: string): string {
  return toLocal(new Date().toISOString(), tz).date;
}

export function TimeOffForm({
  clientId,
  siteId,
  staff,
  fixedStaffId,
  canSiteClosure,
  tz,
  edit,
  onDone,
  onClose,
}: {
  clientId: string;
  siteId: string;
  staff: { id: string; name: string }[];
  fixedStaffId?: string | null;
  canSiteClosure: boolean;
  tz: string;
  edit?: TimeOffEdit;
  onDone: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<TimeOffConflict[] | null>(null);

  // Initial values, inferred from an edited block or sensible defaults.
  const initial = useMemo(() => {
    if (edit) {
      const start = toLocal(edit.startsAt, tz);
      const end = toLocal(edit.endsAt, tz);
      const fullDay = start.time === "00:00" && end.time === "00:00";
      return {
        scope: edit.staffId ? ("staff" as const) : ("site" as const),
        staffId: edit.staffId ?? "",
        kind: fullDay ? ("full_day" as const) : ("partial" as const),
        startDate: start.date,
        endDate: fullDay ? prevDay(end.date) : start.date,
        date: start.date,
        startTime: start.time,
        endTime: end.time,
        reason: edit.reason ?? "",
      };
    }
    const today = todayLocal(tz);
    return {
      scope: (fixedStaffId ? "staff" : canSiteClosure ? "staff" : "staff") as "staff" | "site",
      staffId: fixedStaffId ?? staff[0]?.id ?? "",
      kind: "full_day" as "full_day" | "partial",
      startDate: today,
      endDate: today,
      date: today,
      startTime: "09:00",
      endTime: "13:00",
      reason: "",
    };
  }, [edit, tz, fixedStaffId, staff, canSiteClosure]);

  const [scope, setScope] = useState<"staff" | "site">(initial.scope);
  const [staffId, setStaffId] = useState(initial.staffId);
  const [kind, setKind] = useState<"full_day" | "partial">(initial.kind);
  const [startDate, setStartDate] = useState(initial.startDate);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [date, setDate] = useState(initial.date);
  const [startTime, setStartTime] = useState(initial.startTime);
  const [endTime, setEndTime] = useState(initial.endTime);
  const [reason, setReason] = useState(initial.reason);

  const lockScope = !!fixedStaffId || !!edit; // scope/staff can't move on an existing block or a column form

  const submit = (confirm: boolean) => {
    setError(null);
    setConflicts(null);
    startTransition(async () => {
      const common = { clientId, reason, confirm };
      const timing =
        kind === "full_day"
          ? ({ mode: "full_day", startDate, endDate } as const)
          : ({ mode: "partial", date, startTime, endTime } as const);
      const staffScope = scope === "staff" ? staffId || null : null;
      let r: TimeOffResult;
      if (edit) {
        r = await updateTimeOffAction(clientId, edit.id, { ...common, ...timing });
      } else {
        r = await createTimeOffAction({ ...common, siteId, staffId: staffScope, ...timing });
      }
      if (r.ok) {
        router.refresh();
        onDone();
        return;
      }
      if ("conflicts" in r) {
        setConflicts(r.conflicts);
        return;
      }
      setError(r.error);
    });
  };

  const fmtConflict = (c: TimeOffConflict) => {
    const t = toLocal(c.start_at, tz);
    return `${t.date} ${t.time} · ${c.service_name}${c.contact_name ? ` · ${c.contact_name}` : ""}${
      c.staff_name ? ` · ${c.staff_name}` : ""
    }`;
  };

  return (
    <div className="flex flex-col gap-4">
      {error ? <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}

      {/* Scope — hidden when locked to one staff member (a column / existing block). Site
          closures are offered only to those who may create them. */}
      {!lockScope ? (
        <div className="flex flex-wrap gap-1.5">
          <ScopeChip active={scope === "staff"} onClick={() => setScope("staff")}>Un profesional</ScopeChip>
          {canSiteClosure ? (
            <ScopeChip active={scope === "site"} onClick={() => setScope("site")}>Toda la sede</ScopeChip>
          ) : null}
        </div>
      ) : null}

      {scope === "staff" && !fixedStaffId && !edit ? (
        <Field label="Profesional">
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className={INPUT}>
            {staff.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </Field>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        <ScopeChip active={kind === "full_day"} onClick={() => setKind("full_day")}>Día(s) completo(s)</ScopeChip>
        <ScopeChip active={kind === "partial"} onClick={() => setKind("partial")}>Unas horas</ScopeChip>
      </div>

      {kind === "full_day" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Desde"><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={INPUT} /></Field>
          <Field label="Hasta" hint="Incluye el día completo."><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={INPUT} /></Field>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Fecha"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={INPUT} /></Field>
          <Field label="Desde"><input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={INPUT} /></Field>
          <Field label="Hasta"><input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={INPUT} /></Field>
        </div>
      )}

      <Field label="Motivo" hint="Interno — el asistente nunca lo menciona a un cliente.">
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej. Vacaciones, Festivo" maxLength={200} className={INPUT} />
      </Field>

      {conflicts ? (
        <div className="rounded-lg border border-timeoff-edge bg-timeoff-bg/40 p-3">
          <p className="text-sm font-semibold text-foreground">
            Hay {conflicts.length} cita{conflicts.length === 1 ? "" : "s"} dentro de este bloqueo
          </p>
          <p className="mt-0.5 text-xs text-muted">
            No se cancelan automáticamente. Puedes crear el bloqueo y mantenerlas (quedarán marcadas como
            conflicto en la agenda), o cancelar y gestionarlas con cada cliente.
          </p>
          <ul className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
            {conflicts.map((c) => (
              <li key={c.id} className="u-mono truncate text-xs text-muted">{fmtConflict(c)}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button type="button" className={GHOST} onClick={() => setConflicts(null)}>Cancelar</button>
            <button type="button" className={BTN} disabled={pending} onClick={() => submit(true)}>
              Crear y mantener las citas
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={GHOST} onClick={onClose}>Cancelar</button>
          <button type="button" className={BTN} disabled={pending} onClick={() => submit(false)}>
            {edit ? "Guardar cambios" : "Bloquear horario"}
          </button>
        </div>
      )}
    </div>
  );
}

function ScopeChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
        active ? "border-foreground bg-foreground text-background" : "border-line text-muted hover:bg-subtle"
      }`}
    >
      {children}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="text-[0.6875rem] text-faint">{hint}</span> : null}
    </label>
  );
}
