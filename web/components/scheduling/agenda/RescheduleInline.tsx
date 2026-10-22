"use client";

import { useEffect, useMemo, useReducer, useRef, useState, useTransition, type ReactNode } from "react";
import { rescheduleAppointmentAction } from "@/lib/schedulingActions";
import {
  availabilityReducer,
  availabilityView,
  choiceStillOffered,
  compareReschedule,
  dayReasonLabel,
  dayStatus,
  initialAvailability,
  nearestAlternatives,
  staffFirstName,
  timesForDay,
  type RescheduleSlot,
} from "@/lib/rescheduleFlow";
import { addDays, dayHeadline, fmtTime, shiftMonth, siteDayKey, siteMidnight, todayAtSite } from "@/lib/siteCalendar";
import { Avatar, Button } from "../ui/system";
import type { RescheduleAppt } from "./RescheduleFlow";

/**
 * REAGENDAR inside the appointment's own panel (desktop). It MOVES the same appointment
 * (rescheduleAppointmentAction): same id, contact, service, origin and history — never a
 * cancel + new booking. Professional, day and ONLY the free start times that fit the
 * appointment's whole stored duration (the internal availability route computes them for
 * this appointment: its own time is excluded, every break/block/absence/appointment counts).
 *
 * The server checks the slot again when saving. If it was just taken, the professional and
 * day stay chosen, the time leaves the list and the closest free times are offered; a
 * network/server error keeps the whole selection and the button becomes «Reintentar».
 * `holds` are unsaved blocks being edited elsewhere (a break or block whose affected
 * appointments are being moved) — they are discounted from the times offered.
 */
const WD = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

export function RescheduleInline(props: {
  clientId: string;
  siteId: string;
  timezone: string;
  appt: RescheduleAppt;
  staff: Array<{ id: string; name: string; photoUrl?: string | null }>;
  lockStaffId: string | null;
  openWeekdays: Set<string>;
  holds?: string[];
  onCancel: () => void;
  onDirty: (dirty: boolean) => void;
  onDone: (result: { dayKey: string; appointmentId: string; startAt: string }) => void;
  /** The parent panel draws the body and the footer. */
  frame: (body: ReactNode, footer: ReactNode) => ReactNode;
}) {
  const { appt, timezone: tz } = props;
  const today = todayAtSite(tz);
  const apptDay = siteDayKey(appt.start_at, tz);
  const startDay = apptDay < today ? today : apptDay;
  const [staffId, setStaffId] = useState(props.lockStaffId ?? appt.staff_id);
  const [day, setDay] = useState(startDay);
  const [model, dispatch] = useReducer(availabilityReducer, { staffId: props.lockStaffId ?? appt.staff_id, month: startDay.slice(0, 7) }, initialAvailability);
  const [choice, setChoice] = useState<string | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  const view = availabilityView(model);
  const month = model.requested.month;
  const holdsKey = (props.holds ?? []).join("|");

  useEffect(() => {
    const q = model.requested;
    const ctrl = new AbortController();
    const params = new URLSearchParams({
      client_id: props.clientId,
      site_id: props.siteId,
      service_id: appt.service_id,
      staff_id: q.staffId,
      appointment_id: appt.id,
      from: siteMidnight(`${q.month}-01`, tz).toISOString(),
      to: siteMidnight(`${shiftMonth(q.month, 1)}-01`, tz).toISOString(),
      explain: "1",
    });
    for (const h of holdsKey ? holdsKey.split("|") : []) params.append("hold", h);
    fetch(`/api/scheduling/internal/availability?${params.toString()}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { slots: RescheduleSlot[]; days?: Array<{ date: string; summary: string }> };
        setReasons(Object.fromEntries((data.days ?? []).map((d) => [d.date, d.summary])));
        dispatch({ type: "loaded", requestId: q.id, slots: data.slots });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) dispatch({ type: "failed", requestId: q.id });
      });
    return () => ctrl.abort();
  }, [model.requested, props.clientId, props.siteId, appt.service_id, appt.id, tz, holdsKey]);

  const ask = (next: { staffId?: string; month?: string } = {}) =>
    dispatch({ type: "request", staffId: next.staffId ?? staffId, month: next.month ?? month });

  const offered = choiceStillOffered(view, choice, staffId) ? choice : null;
  const times = timesForDay(view, day, tz).filter((s) => !(s.start_at === appt.start_at && staffId === appt.staff_id));
  const slot = offered && view.kind === "ready" ? view.slots.find((s) => s.start_at === offered) ?? null : null;
  const staffName = props.staff.find((s) => s.id === staffId)?.name ?? (staffId === appt.staff_id ? appt.staff_name : null);
  const comparison = compareReschedule(appt, slot ? { start_at: slot.start_at, service_end_at: slot.service_end_at, staff_id: staffId, staff_name: staffName } : null, tz);
  const canSave = Boolean(slot) && comparison.hasChange && !pending;
  const status = dayStatus({ day, today, openWeekdays: props.openWeekdays, state: view, timeZone: tz });
  const reason = status === "none" ? dayReasonLabel(reasons[day]) ?? "Sin horas disponibles" : status === "closed" ? "Sede cerrada" : null;
  const alternatives = taken ? nearestAlternatives(times, taken) : [];
  const canChangeStaff = !props.lockStaffId && props.staff.length > 1;

  const dirty = Boolean(choice) || staffId !== appt.staff_id || day !== startDay;
  const onDirty = props.onDirty;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  // Week strip of the chosen day (Monday first).
  const week = useMemo(() => {
    const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
    const monday = addDays(day, wd === 0 ? -6 : 1 - wd);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }, [day]);

  const pickStaff = (id: string) => {
    if (id === staffId) return;
    setStaffId(id);
    setChoice(null);
    setTaken(null);
    setFailed(null);
    ask({ staffId: id });
  };
  const pickDay = (d: string) => {
    if (d < today) return;
    setDay(d);
    setChoice(null);
    setTaken(null);
    setFailed(null);
    if (d.slice(0, 7) !== month) ask({ month: d.slice(0, 7) });
  };

  const submit = () => {
    if (!slot || !comparison.hasChange || sending.current) return;
    sending.current = true;
    setFailed(null);
    const wanted = slot.start_at;
    startTransition(async () => {
      try {
        const r = await rescheduleAppointmentAction(props.clientId, appt.id, wanted, staffId === appt.staff_id ? null : staffId, {
          startAt: appt.start_at,
          staffId: appt.staff_id,
        });
        if (!r.ok) {
          if (r.code === "conflict_slot" || r.code === "unavailable" || r.code === "no_staff") {
            // Just taken: professional and day stay; the list is asked again (the time
            // drops out on its own) and the nearest free times are offered.
            setTaken(wanted);
            setChoice(null);
            ask();
          } else {
            setFailed(r.error);
          }
          return;
        }
        props.onDone({ dayKey: siteDayKey(wanted, tz), appointmentId: appt.id, startAt: wanted });
      } catch {
        setFailed("No se pudo guardar: revisa la conexión. Tu selección se conserva.");
      } finally {
        sending.current = false;
      }
    });
  };

  const body = (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="rs-staff" className="flex flex-col gap-2">
        <h3 id="rs-staff" className="text-[13px] font-semibold">Profesional</h3>
        {canChangeStaff ? (
          <div role="radiogroup" aria-labelledby="rs-staff" className="flex flex-wrap gap-2">
            {props.staff.map((s) => {
              const sel = s.id === staffId;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={sel}
                  onClick={() => pickStaff(s.id)}
                  className={`u-focus flex h-[44px] items-center gap-2 rounded-full border pl-1.5 pr-3.5 text-[13px] transition-[box-shadow,opacity] duration-150 md:h-[36px] ${
                    sel ? "border-foreground font-semibold shadow-[inset_0_0_0_1px_var(--foreground)]" : "border-line hover:bg-subtle"
                  }`}
                >
                  <Avatar name={s.name} size="sm" photoUrl={s.photoUrl ?? undefined} />
                  {staffFirstName(s.name)}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="flex items-center gap-2 text-[13px]">
            <Avatar name={staffName} size="sm" />
            {staffName ?? "Sin profesional"}
          </p>
        )}
      </section>

      <section aria-labelledby="rs-day" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 id="rs-day" className="min-w-0 flex-1 text-[13px] font-semibold">Día</h3>
          <button type="button" aria-label="Semana anterior" disabled={week[0] <= today} onClick={() => pickDay(addDays(day, -7) < today ? today : addDays(day, -7))} className="u-focus grid size-[36px] place-items-center rounded-full text-muted hover:bg-chip disabled:opacity-40">
            <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M10 3.5L5.5 8l4.5 4.5" /></svg>
          </button>
          <button type="button" aria-label="Semana siguiente" onClick={() => pickDay(addDays(day, 7))} className="u-focus grid size-[36px] place-items-center rounded-full text-muted hover:bg-chip">
            <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 3.5L10.5 8 6 12.5" /></svg>
          </button>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {week.map((d) => {
            const st = dayStatus({ day: d, today, openWeekdays: props.openWeekdays, state: view, timeZone: tz });
            const sel = d === day;
            const why = st === "none" ? dayReasonLabel(reasons[d]) : st === "closed" ? "Sede cerrada" : null;
            return (
              <button
                key={d}
                type="button"
                aria-pressed={sel}
                aria-label={`${dayHeadline(d)}${why ? ` · ${why}` : st === "available" ? " · con horas libres" : ""}`}
                disabled={st === "past"}
                onClick={() => pickDay(d)}
                className={`u-focus flex h-[56px] flex-col items-center justify-center rounded-[10px] text-[12px] leading-tight transition-colors disabled:opacity-40 ${
                  sel ? "bg-foreground text-background" : st === "available" ? "bg-chip text-foreground hover:bg-subtle" : "text-muted hover:bg-subtle"
                }`}
              >
                <span>{WD[new Date(`${d}T00:00:00Z`).getUTCDay()]}</span>
                <span className={`text-[15px] font-semibold ${st === "closed" && !sel ? "line-through" : ""}`}>{Number(d.slice(8))}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="rs-time" className="flex flex-col gap-2">
        <h3 id="rs-time" className="text-[13px] font-semibold">
          Hora libre <span className="font-normal text-muted">· {formatDuration(appt.duration_min)}</span>
        </h3>
        {taken ? (
          <div role="alert" className="rounded-[10px] bg-[var(--warn-soft)] px-3 py-2.5 text-[13px] text-[var(--warn)]">
            Ese horario ({fmtTime(taken, tz)}) acaba de ocuparse. La cita sigue donde estaba.
            {alternatives.length > 0 ? " Horas cercanas libres:" : " No quedan horas cercanas este día."}
          </div>
        ) : null}
        {view.kind === "loading" ? (
          <div className="grid grid-cols-4 gap-1.5" aria-busy="true" aria-label="Buscando horas libres">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} className="h-[40px] rounded-[10px] bg-subtle" />
            ))}
          </div>
        ) : view.kind === "error" ? (
          <div className="flex items-center gap-3 text-[13px] text-muted">
            No pudimos cargar las horas libres.
            <Button size="sm" onClick={() => ask()}>Reintentar</Button>
          </div>
        ) : reason ? (
          <p className="rounded-[10px] bg-subtle px-3 py-2.5 text-[13px] text-muted">
            {reason === "Profesional ausente"
              ? `${staffFirstName(staffName)} está ausente este día: no se ofrecen horas. Los demás profesionales siguen disponibles.`
              : reason === "No trabaja este día"
                ? `${staffFirstName(staffName)} no trabaja este día según su horario.`
                : reason === "Sede cerrada"
                  ? "La sede está cerrada este día."
                  : `No quedan horas libres de ${formatDuration(appt.duration_min)} este día.`}
          </p>
        ) : (
          <div role="radiogroup" aria-labelledby="rs-time" className="grid max-h-[208px] grid-cols-4 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-5">
            {(taken && alternatives.length > 0 ? alternatives : times).map((s) => {
              const sel = s.start_at === offered;
              return (
                <button
                  key={s.start_at}
                  type="button"
                  role="radio"
                  aria-checked={sel}
                  onClick={() => {
                    setChoice(s.start_at);
                    setFailed(null);
                  }}
                  className={`u-focus u-tnum h-[44px] rounded-[10px] border text-[13px] font-medium transition-colors md:h-[40px] ${
                    sel ? "border-foreground bg-foreground text-background" : "border-line hover:bg-subtle"
                  }`}
                >
                  {fmtTime(s.start_at, tz)}
                </button>
              );
            })}
          </div>
        )}
        {taken && alternatives.length > 0 ? (
          <button type="button" onClick={() => setTaken(null)} className="u-focus self-start text-[13px] font-medium underline underline-offset-2">
            Ver todas las horas del día
          </button>
        ) : null}
      </section>

      <section aria-label="Antes y después" className="rounded-[12px] border border-line px-3.5 py-3 text-[13px]">
        <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-muted">Antes</dt>
          <dd className="u-tnum text-muted line-through decoration-1">{comparison.before.line}</dd>
          <dt className="text-muted">Después</dt>
          <dd className="u-tnum font-semibold">{comparison.after?.line ?? "Elige una hora libre"}</dd>
        </dl>
        <p className="mt-2 text-[12.5px] leading-5 text-muted">
          Misma cita: cliente, servicio, origen e historial no cambian. No se avisa al cliente automáticamente.
        </p>
      </section>
      {failed ? (
        <p role="alert" className="rounded-[10px] bg-[var(--danger-soft,rgba(192,38,45,0.08))] px-3 py-2.5 text-[13px] text-danger">
          {failed}
        </p>
      ) : null}
    </div>
  );

  const footer = (
    <div className="flex flex-wrap items-center gap-2">
      <p aria-live="polite" className="u-tnum w-full min-w-0 truncate text-[13px] text-muted sm:w-auto sm:flex-1">
        {comparison.after ? comparison.after.line : "Sin horario nuevo"}
      </p>
      <span className="flex-1 sm:hidden" />
      <Button onClick={props.onCancel} disabled={pending}>
        Volver
      </Button>
      <Button variant="primary" onClick={submit} disabled={!canSave} loading={pending} loadingLabel="Guardando…">
        {failed ? "Reintentar" : "Guardar nuevo horario"}
      </Button>
    </div>
  );

  return <>{props.frame(body, footer)}</>;
}

function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
