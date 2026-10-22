"use client";

import { useEffect, useReducer, useRef, useState, useTransition, type RefObject } from "react";
import { useIsOverlayWidth, useTrappedPanel } from "@/components/ui/Overlay";
import { rescheduleAppointmentAction } from "@/lib/schedulingActions";
import {
  availabilityReducer,
  availabilityView,
  choiceStillOffered,
  compareReschedule,
  dayStatus,
  initialAvailability,
  staffFirstName,
  timesForDay,
  type AvailabilityState,
  type DayStatus,
  type RescheduleSlot,
} from "@/lib/rescheduleFlow";
import { addDays, calendarDays, dayHeadline, fmtTime, monthTitle, shiftMonth, siteDayKey, siteMidnight, timezoneLabel, todayAtSite } from "@/lib/siteCalendar";
import { Icon, ICON, MButton, MIconButton, MScreen, MStaffAvatar, M_CARD, M_SMALL, Sheet, staffColors } from "../mobile/kit";
import { Alert, Button, CARD, buttonClass } from "../ui/system";

/**
 * "CAMBIAR FECHA Y HORA" — moves ONE existing appointment (rescheduleAppointmentAction:
 * same id, client, service, price, stored duration and confirmation state; the history
 * records who moved it and the before/after). Two steps, not the three of creation:
 *
 *   1. Nuevo horario — the appointment's own professional and day are pre-selected and
 *      their month is asked AT ONCE. Changing professional (only if this login may)
 *      re-asks; changing month asks that month; changing day reads the month already
 *      loaded. The availability is computed FOR THIS APPOINTMENT (its own block is
 *      excluded, its stored duration is used) — see the internal availability route.
 *   2. Confirmar cambio — "Antes / Después" from real values; nothing is saved before.
 *
 * Availability states never blur: buscando · sin disponibilidad · error (with Reintentar)
 * · sin consultar (another month). A late answer for an older query is dropped
 * (lib/rescheduleFlow). The chosen time is dropped as soon as its conditions change.
 *
 * Phone (< md): the full-screen flow of the mobile kit. Tablet/desktop: a centred modal
 * of the Scheduling system. Same state, same rules.
 */

export interface RescheduleAppt {
  id: string;
  staff_id: string;
  staff_name: string | null;
  service_id: string;
  service_name: string;
  start_at: string;
  service_end_at: string;
  duration_min: number;
  status: string;
  contact_name: string | null;
}

interface StaffChoice {
  id: string;
  name: string;
  photoUrl?: string | null;
}

const TITLE_ID = "reschedule-title";

export function RescheduleFlow(props: {
  clientId: string;
  siteId: string;
  siteName: string;
  timezone: string;
  /** Weekdays the site opens ("mon"…), from its opening hours; empty = unknown. */
  openWeekdays: Set<string>;
  appt: RescheduleAppt;
  /** Active professionals of the site. */
  staff: StaffChoice[];
  /** A staff login: pinned to its own column — no professional change is offered. */
  lockStaffId: string | null;
  onClose: () => void;
  /** Saved: the day the appointment now lives on, to navigate there and highlight it. */
  onDone: (result: { dayKey: string; appointmentId: string }) => void;
}) {
  const { appt, timezone: tz } = props;
  const isPhone = useIsOverlayWidth(767.98);
  const apptDay = siteDayKey(appt.start_at, tz);
  const today = todayAtSite(tz);
  // The appointment's own day, unless it is already in the past (then today).
  const startDay = apptDay < today ? today : apptDay;
  const [step, setStep] = useState<1 | 2>(1);
  const [staffId, setStaffId] = useState(appt.staff_id);
  const [day, setDay] = useState(startDay);
  const [model, dispatch] = useReducer(availabilityReducer, { staffId: appt.staff_id, month: startDay.slice(0, 7) }, initialAvailability);
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [monthSheet, setMonthSheet] = useState(false);
  const sending = useRef(false);

  const view = availabilityView(model);
  const month = model.requested.month;

  // THE fetch: one per request (the first one is the initial state, so the month opens
  // already being asked). Only dispatches from the async callbacks.
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
    });
    fetch(`/api/scheduling/internal/availability?${params.toString()}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { slots: RescheduleSlot[] };
        dispatch({ type: "loaded", requestId: q.id, slots: data.slots });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) dispatch({ type: "failed", requestId: q.id });
      });
    return () => ctrl.abort();
  }, [model.requested, props.clientId, props.siteId, appt.service_id, appt.id, tz]);

  // ── Choices (every change of condition drops the chosen time) ──────────────────
  const ask = (next: { staffId?: string; month?: string }) => dispatch({ type: "request", staffId: next.staffId ?? staffId, month: next.month ?? month });
  const retry = () => ask({});
  const pickStaff = (id: string) => {
    if (id === staffId) return;
    setStaffId(id);
    setChoice(null);
    setError(null);
    ask({ staffId: id });
  };
  const pickDay = (d: string) => {
    setDay(d);
    setChoice(null);
    setError(null);
    if (d.slice(0, 7) !== month) ask({ month: d.slice(0, 7) });
  };
  const goMonth = (delta: number) => {
    const m = shiftMonth(month, delta);
    const first = `${m}-01`;
    pickDay(first < today ? today : first);
  };

  const offered = choiceStillOffered(view, choice, staffId) ? choice : null;
  const slot = offered && view.kind === "ready" ? view.slots.find((s) => s.start_at === offered) ?? null : null;
  const staffName = props.staff.find((s) => s.id === staffId)?.name ?? (staffId === appt.staff_id ? appt.staff_name : null);
  const comparison = compareReschedule(
    appt,
    slot ? { start_at: slot.start_at, service_end_at: slot.service_end_at, staff_id: staffId, staff_name: staffName } : null,
    tz,
  );
  const canContinue = Boolean(slot) && comparison.hasChange;
  const times = timesForDay(view, day, tz);
  const status: DayStatus = dayStatus({ day, today, openWeekdays: props.openWeekdays, state: view, timeZone: tz });
  const isCurrent = (s: RescheduleSlot) => s.start_at === appt.start_at && staffId === appt.staff_id;
  const nextWithTimes = (() => {
    if (view.kind !== "ready") return null;
    for (let i = 1; i <= 31; i++) {
      const d = addDays(day, i);
      if (d.slice(0, 7) !== month) break;
      if (timesForDay(view, d, tz).some((s) => !isCurrent(s))) return d;
    }
    return null;
  })();
  const canChangeStaff = !props.lockStaffId && props.staff.length > 1;
  const first = staffFirstName(staffName);

  const submit = () => {
    if (!slot || !comparison.hasChange || sending.current) return;
    sending.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const r = await rescheduleAppointmentAction(props.clientId, appt.id, slot.start_at, staffId === appt.staff_id ? null : staffId, {
          startAt: appt.start_at,
          staffId: appt.staff_id,
        });
        if (!r.ok) {
          setError(r.error);
          // The time may have just been taken: ask again (the selection drops itself if
          // it is no longer offered; everything else stays as chosen).
          ask({});
          return;
        }
        props.onDone({ dayKey: siteDayKey(slot.start_at, tz), appointmentId: appt.id });
      } catch {
        setError("No se pudo guardar: revisa la conexión e inténtalo de nuevo. Tu selección se conserva.");
      } finally {
        sending.current = false;
      }
    });
  };

  // Phone Back (Android back / iOS swipe) acts on the FLOW: step 2 → step 1, an open
  // month sheet closes, otherwise the flow closes. Same contract as the booking flow.
  const back = useRef<() => boolean>(() => false);
  useEffect(() => {
    back.current = () => {
      if (monthSheet) {
        setMonthSheet(false);
        return true;
      }
      if (step === 2) {
        setStep(1);
        return true;
      }
      props.onClose();
      return false;
    };
  });
  useEffect(() => {
    if (!isPhone) return;
    let leaving = false;
    const mark = () => window.history.pushState({ ...window.history.state, mReschedule: true }, "");
    mark();
    const onPop = () => {
      if (leaving) return;
      if (back.current()) mark();
      else leaving = true;
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!leaving && window.history.state?.mReschedule) {
        leaving = true;
        window.history.back();
      }
    };
  }, [isPhone]);

  const dialogRef = useTrappedPanel({ active: !isPhone, onClose: props.onClose });

  const stepName = step === 1 ? "Nuevo horario" : "Confirmar cambio";
  const keep = `${appt.contact_name ?? "Atención sin cita"} · ${appt.service_name} · ${appt.duration_min} min`;

  // ── Shared pieces ────────────────────────────────────────────────────────────────
  const timesBlock = (phone: boolean) => (
    <TimesBlock
      phone={phone}
      status={status}
      view={view}
      times={times}
      dayTitle={dayHeadline(day)}
      tzLabel={timezoneLabel(tz)}
      staffFirst={first}
      siteName={props.siteName}
      selected={offered}
      isCurrent={isCurrent}
      onPick={(s) => {
        setChoice(s.start_at);
        setError(null);
      }}
      onRetry={retry}
      nextDay={nextWithTimes}
      onNextDay={pickDay}
      onToday={() => pickDay(today)}
      tz={tz}
    />
  );

  const compareBlock = (phone: boolean) => (
    <div className="flex flex-col gap-3">
      <div className={phone ? M_CARD : `${CARD} overflow-hidden`}>
        <CompareRow phone={phone} label="Antes" line={comparison.before.line} muted />
        <CompareRow phone={phone} label="Después" line={comparison.after?.line ?? "—"} strong />
      </div>
      {comparison.staffChanged ? (
        <p className={phone ? "m-0 text-[14px] text-m-tx2" : "m-0 text-[13px] text-muted"}>
          Cambia el profesional: de {comparison.before.staff} a {comparison.after?.staff}.
        </p>
      ) : null}
      <p className={phone ? "m-0 text-[14px] leading-[1.45] text-m-tx3" : "m-0 text-[13px] leading-[1.45] text-muted"}>
        Se conservan el cliente, el servicio, el precio, la duración ({appt.duration_min} min) y el estado de la cita. No se envía ningún mensaje al cliente.
      </p>
    </div>
  );

  // ── PHONE ─────────────────────────────────────────────────────────────────────────
  if (isPhone) {
    const stripStart = addDays(day, -3) < today ? today : addDays(day, -3);
    const strip = Array.from({ length: 7 }, (_, i) => addDays(stripStart, i));
    const team = staffColors(props.staff.map((s) => s.id));
    return (
      <MScreen
        label="Reagendar"
        onEscape={() => (monthSheet ? setMonthSheet(false) : step === 2 ? setStep(1) : props.onClose())}
        header={
          <div className="flex flex-col gap-[10px]">
            <div className="flex min-h-[44px] items-center gap-1.5">
              <MIconButton label={step === 2 ? "Volver al horario" : "Cerrar sin cambiar"} onClick={step === 2 ? () => setStep(1) : props.onClose}>
                <Icon d={step === 2 ? ICON.back : ICON.close} size={18} width={1.6} />
              </MIconButton>
              <div className="-ml-1 flex min-w-0 flex-1 flex-col">
                <h2 id={TITLE_ID} className="m-0 truncate text-[17px] font-semibold leading-[1.25]">
                  Reagendar
                </h2>
                <span className="text-[13px] text-m-tx3">
                  Paso {step} de 2 · {stepName}
                </span>
              </div>
            </div>
            <div aria-hidden className="grid grid-cols-2 gap-1.5">
              {[1, 2].map((i) => (
                <span key={i} className={`block h-1 rounded-[2px] ${i <= step ? "bg-m-tx" : "bg-m-bd"}`} />
              ))}
            </div>
          </div>
        }
        footer={
          <div className="flex flex-col gap-[10px]">
            {error ? (
              <p role="alert" className="m-0 rounded-[12px] bg-m-dnbg px-3 py-2 text-[14px] text-m-dn">
                {error}
              </p>
            ) : null}
            {step === 1 ? (
              <>
                <div aria-live="polite" className="flex min-h-5 items-center gap-2">
                  <span aria-hidden className={`size-2 flex-none rounded-full ${canContinue ? "bg-m-ok" : "bg-m-tx3"}`} />
                  <span className={`min-w-0 truncate text-[14px] ${canContinue ? "font-semibold text-m-tx" : "text-m-tx3"}`}>
                    {canContinue && comparison.after ? comparison.after.line : "Elige un horario nuevo"}
                  </span>
                </div>
                <div className="flex">
                  <MButton kind="primary" grow disabled={!canContinue} onClick={() => setStep(2)}>
                    Continuar
                  </MButton>
                </div>
              </>
            ) : (
              <div className="flex gap-2">
                <MButton onClick={() => setStep(1)} disabled={pending}>
                  Volver
                </MButton>
                <MButton kind="primary" grow disabled={!canContinue || pending} loading={pending} loadingLabel="Guardando…" onClick={submit}>
                  Confirmar cambio
                </MButton>
              </div>
            )}
          </div>
        }
      >
        <div className="flex flex-col gap-[22px]">
          {step === 1 ? (
            <>
              <section aria-label="Cita actual" className="flex flex-col gap-1 rounded-[16px] border border-m-bd bg-m-sf px-[14px] py-3">
                <span className="text-[13px] text-m-tx3">Ahora</span>
                <span className="u-tnum text-[16px] font-semibold">{comparison.before.line}</span>
                <span className="text-[14px] text-m-tx3">{keep}</span>
              </section>

              <section className="flex flex-col gap-[10px]">
                <h3 className="m-0 text-[15px] font-semibold">Profesional</h3>
                {canChangeStaff ? (
                  <div role="radiogroup" aria-label="Profesional" className="flex flex-wrap gap-2">
                    {props.staff.map((s) => {
                      const sel = s.id === staffId;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          role="radio"
                          aria-checked={sel}
                          onClick={() => pickStaff(s.id)}
                          className={`flex min-h-[48px] items-center gap-2 rounded-[12px] bg-m-sf py-1.5 pl-1.5 pr-3 text-[15px] text-m-tx ${sel ? "border border-m-tx font-semibold shadow-[inset_0_0_0_1px_var(--m-tx)]" : "border border-m-bd"}`}
                        >
                          <MStaffAvatar id={s.id} name={s.name} size={32} color={team.get(s.id)} photoUrl={s.photoUrl} />
                          {staffFirstName(s.name)}
                          {s.id === appt.staff_id ? <span className="text-[13px] font-normal text-m-tx3">(actual)</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex min-h-[48px] items-center gap-2 text-[15px]">
                    <MStaffAvatar id={staffId} name={staffName} size={32} color={team.get(staffId)} />
                    {staffName ?? "Sin profesional"}
                  </div>
                )}
              </section>

              <section className="flex flex-col gap-[10px]">
                <div className="flex items-center gap-2">
                  <h3 className="m-0 text-[15px] font-semibold">Fecha</h3>
                  <span className="whitespace-nowrap text-[14px] text-m-tx3">{monthTitle(day.slice(0, 7))}</span>
                  <button type="button" onClick={() => setMonthSheet(true)} className={`${M_SMALL} ml-auto`}>
                    <Icon d={ICON.calendar} size={16} width={1.4} />
                    Ver mes
                  </button>
                </div>
                <div className="flex gap-[2px]">
                  {strip.map((d) => {
                    const st = dayStatus({ day: d, today, openWeekdays: props.openWeekdays, state: view, timeZone: tz });
                    const sel = d === day;
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-label={`${dayHeadline(d)} · ${DAY_WORDS[st]}`}
                        aria-pressed={sel}
                        disabled={st === "past"}
                        onClick={() => pickDay(d)}
                        className={`flex min-h-[68px] min-w-0 flex-1 flex-col items-center justify-center gap-[3px] rounded-[12px] border p-0 disabled:opacity-50 ${sel ? "border-m-pri bg-m-pri" : st === "closed" ? "border-m-bd bg-m-sf2" : "border-m-bd bg-m-sf"}`}
                      >
                        <span className={`text-[12px] ${sel ? "text-m-onpri" : "text-m-tx3"}`}>{WD_SHORT[new Date(`${d}T00:00:00Z`).getUTCDay()]}</span>
                        <span className={`text-[17px] font-semibold ${sel ? "text-m-onpri" : st === "none" || st === "closed" ? "text-m-tx3" : "text-m-tx"} ${st === "closed" ? "line-through" : ""}`}>
                          {Number(d.slice(8))}
                        </span>
                        <DayDot status={st} selected={sel} phone />
                      </button>
                    );
                  })}
                </div>
                <Legend phone />
              </section>

              <section className="flex flex-col gap-[10px]">{timesBlock(true)}</section>
            </>
          ) : (
            compareBlock(true)
          )}
        </div>

        <Sheet open={monthSheet} onClose={() => setMonthSheet(false)} label="Elegir fecha" bodyClassName="flex flex-col gap-3 px-4 pb-[max(20px,env(safe-area-inset-bottom))]">
          <MonthGrid
            phone
            month={month}
            day={day}
            today={today}
            view={view}
            openWeekdays={props.openWeekdays}
            tz={tz}
            onMonth={goMonth}
            onDay={(d) => {
              pickDay(d);
              setMonthSheet(false);
            }}
          />
          <MButton className="w-full" onClick={() => setMonthSheet(false)}>
            Cerrar
          </MButton>
        </Sheet>
      </MScreen>
    );
  }

  // ── TABLET / DESKTOP ──────────────────────────────────────────────────────────────
  return (
    <div className="u-module-modal z-50 flex items-center justify-center bg-black/45 sm:p-4" onClick={props.onClose}>
      <div
        ref={dialogRef as RefObject<HTMLDivElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        className="flex h-dvh w-dvw flex-col overflow-hidden bg-popover text-popover-foreground shadow-2xl sm:h-[min(640px,calc(100dvh-2rem))] sm:w-[min(880px,calc(100vw-2rem))] sm:rounded-sch-modal sm:border sm:border-line"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-line px-5 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id={TITLE_ID} className="truncate text-base font-semibold">
              Cambiar fecha y hora
            </h2>
            <p className="truncate text-xs text-muted">
              Paso {step} de 2 · {stepName} · {keep}
            </p>
          </div>
          <button type="button" aria-label="Cerrar sin cambiar" onClick={props.onClose} className={buttonClass({ variant: "tertiary", className: "w-[44px] px-0" })}>
            <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {step === 1 ? (
            <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
              <div className="flex min-w-0 flex-col gap-4">
                <section aria-label="Cita actual" className={`${CARD} flex flex-col gap-0.5 px-4 py-3`}>
                  <span className="text-xs text-muted">Ahora</span>
                  <span className="u-mono text-[15px] font-semibold">{comparison.before.line}</span>
                </section>
                {canChangeStaff ? (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-semibold">Profesional</span>
                    <select
                      value={staffId}
                      onChange={(e) => pickStaff(e.target.value)}
                      className="u-focus h-[44px] rounded-sch-control border border-line bg-surface px-3 text-sm"
                    >
                      {props.staff.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.id === appt.staff_id ? " (actual)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="m-0 text-[13px]">
                    <span className="font-semibold">Profesional:</span> {staffName ?? "Sin profesional"}
                  </p>
                )}
                <MonthGrid month={month} day={day} today={today} view={view} openWeekdays={props.openWeekdays} tz={tz} onMonth={goMonth} onDay={pickDay} />
              </div>
              <section className="flex min-w-0 flex-col gap-2.5 md:border-l md:border-line md:pl-5">{timesBlock(false)}</section>
            </div>
          ) : (
            <div className="mx-auto flex max-w-[560px] flex-col gap-4 p-5">{compareBlock(false)}</div>
          )}
        </div>

        <footer className="flex shrink-0 flex-col gap-2.5 border-t border-line px-5 py-3">
          {error ? <Alert>{error}</Alert> : null}
          <div className="flex flex-wrap items-center gap-3">
            <p aria-live="polite" className="m-0 min-w-0 flex-1 truncate text-[13px] text-muted">
              {step === 1 ? (canContinue && comparison.after ? `Nuevo: ${comparison.after.line}` : "Elige un horario nuevo") : "Nada se guarda hasta que confirmes"}
            </p>
            {step === 1 ? (
              <>
                <Button onClick={props.onClose}>Cancelar</Button>
                <Button variant="primary" disabled={!canContinue} onClick={() => setStep(2)}>
                  Continuar
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => setStep(1)} disabled={pending}>
                  Volver
                </Button>
                <Button variant="primary" disabled={!canContinue || pending} loading={pending} loadingLabel="Guardando…" onClick={submit}>
                  Confirmar cambio
                </Button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────────────

const WD_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const DAY_WORDS: Record<DayStatus, string> = {
  past: "pasado",
  closed: "cerrado",
  unknown: "sin consultar",
  loading: "buscando horarios",
  error: "no se pudo consultar",
  available: "con horarios",
  none: "sin disponibilidad",
};

function DayDot({ status, selected, phone = false }: { status: DayStatus; selected: boolean; phone?: boolean }) {
  const ok = phone ? (selected ? "bg-m-onpri" : "bg-m-ok") : selected ? "bg-background" : "bg-success";
  const ring = phone ? (selected ? "shadow-[inset_0_0_0_1.5px_var(--m-onpri)]" : "shadow-[inset_0_0_0_1.5px_var(--m-tx3)]") : "shadow-[inset_0_0_0_1.5px_currentColor] opacity-50";
  return <span aria-hidden className={`size-1.5 rounded-full ${status === "available" ? ok : "bg-transparent"} ${status === "none" ? ring : ""}`} />;
}

function Legend({ phone = false }: { phone?: boolean }) {
  return (
    <div className={`flex flex-wrap gap-[14px] ${phone ? "text-[12.5px] text-m-tx3" : "text-xs text-muted"}`}>
      <span className="flex items-center gap-1.5">
        <DayDot status="available" selected={false} phone={phone} />
        Con horarios
      </span>
      <span className="flex items-center gap-1.5">
        <DayDot status="none" selected={false} phone={phone} />
        Sin disponibilidad
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="line-through">
          12
        </span>
        Cerrado
      </span>
    </div>
  );
}

function MonthGrid(props: {
  phone?: boolean;
  month: string;
  day: string;
  today: string;
  view: AvailabilityState;
  openWeekdays: Set<string>;
  tz: string;
  onMonth: (delta: number) => void;
  onDay: (day: string) => void;
}) {
  const phone = Boolean(props.phone);
  const navBtn = phone
    ? "flex size-[44px] items-center justify-center rounded-[12px] border border-m-bd bg-m-sf text-m-tx disabled:text-m-tx3"
    : buttonClass({ size: "sm", className: "w-[44px] px-0 text-base" });
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1">
        <span className={`flex-1 font-semibold ${phone ? "text-[18px]" : "text-[15px]"}`}>{monthTitle(props.month)}</span>
        <button type="button" aria-label="Mes anterior" disabled={props.month <= props.today.slice(0, 7)} onClick={() => props.onMonth(-1)} className={navBtn}>
          ‹
        </button>
        <button type="button" aria-label="Mes siguiente" onClick={() => props.onMonth(1)} className={navBtn}>
          ›
        </button>
      </div>
      <div aria-hidden className={`grid grid-cols-7 text-center ${phone ? "text-[12px] text-m-tx3" : "text-xs text-muted"}`}>
        {["L", "M", "X", "J", "V", "S", "D"].map((l, i) => (
          <span key={`${l}${i}`}>{l}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-[2px]">
        {calendarDays(props.month).map((cell) => {
          if (!cell.inMonth) return <span key={cell.key} />;
          const st = dayStatus({ day: cell.key, today: props.today, openWeekdays: props.openWeekdays, state: props.view, timeZone: props.tz });
          const sel = cell.key === props.day;
          const tone = phone
            ? sel
              ? "bg-m-pri font-semibold text-m-onpri"
              : `bg-transparent ${st === "closed" ? "text-m-tx3 line-through" : st === "none" ? "text-m-tx3" : "text-m-tx"}`
            : sel
              ? "bg-foreground font-semibold text-background"
              : `hover:bg-subtle ${st === "closed" ? "text-muted line-through" : st === "none" ? "text-muted" : ""}`;
          return (
            <button
              key={cell.key}
              type="button"
              aria-label={`${dayHeadline(cell.key)} · ${DAY_WORDS[st]}`}
              aria-pressed={sel}
              disabled={st === "past" || st === "closed"}
              onClick={() => props.onDay(cell.key)}
              className={`u-focus flex min-h-[44px] flex-col items-center justify-center gap-[3px] rounded-[12px] border-0 p-0 text-[15px] disabled:cursor-default ${st === "past" ? "opacity-40" : ""} ${tone}`}
            >
              <span>{cell.day}</span>
              <DayDot status={st} selected={sel} phone={phone} />
            </button>
          );
        })}
      </div>
      <Legend phone={phone} />
    </div>
  );
}

function TimesBlock(props: {
  phone: boolean;
  status: DayStatus;
  view: AvailabilityState;
  times: RescheduleSlot[];
  dayTitle: string;
  tzLabel: string;
  staffFirst: string;
  siteName: string;
  selected: string | null;
  isCurrent: (s: RescheduleSlot) => boolean;
  onPick: (s: RescheduleSlot) => void;
  onRetry: () => void;
  nextDay: string | null;
  onNextDay: (d: string) => void;
  onToday: () => void;
  tz: string;
}) {
  const { phone } = props;
  const muted = phone ? "text-m-tx3" : "text-muted";
  const box = phone ? "flex flex-col gap-1.5 rounded-[16px] border border-m-bd bg-m-sf px-4 py-[18px]" : `${CARD} flex flex-col gap-1.5 px-4 py-4`;
  const small = phone ? `${M_SMALL} mt-1.5 self-start` : buttonClass({ size: "sm", className: "mt-1.5 self-start" });
  const groups = [
    { key: "am", label: "Mañana", slots: props.times.filter((s) => Number(fmtTime(s.start_at, props.tz).slice(0, 2)) < 12) },
    { key: "pm", label: "Tarde", slots: props.times.filter((s) => Number(fmtTime(s.start_at, props.tz).slice(0, 2)) >= 12) },
  ].filter((g) => g.slots.length > 0);
  const message = (title: string, body: string, action?: { label: string; onClick: () => void }) => (
    <div className={box}>
      <span className={phone ? "text-[16px] font-semibold" : "text-[14px] font-semibold"}>{title}</span>
      <span className={`${phone ? "text-[14px]" : "text-[13px]"} leading-[1.45] ${muted}`}>{body}</span>
      {action ? (
        <button type="button" onClick={action.onClick} className={small}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className={`m-0 font-semibold ${phone ? "text-[15px]" : "text-[14px]"}`}>{props.dayTitle}</h3>
        <span className={`${phone ? "text-[13px]" : "text-xs"} ${muted}`}>{props.tzLabel}</span>
      </div>
      <div aria-live="polite" aria-busy={props.status === "loading"} className="flex flex-col gap-2.5">
        {props.status === "loading" ? (
          <div role="status" className="flex flex-col gap-2">
            <span className={`text-[13px] ${muted}`}>Buscando horarios con {props.staffFirst}…</span>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <span key={i} className={`h-[48px] animate-pulse rounded-[12px] ${phone ? "bg-m-sk" : "bg-subtle"}`} />
              ))}
            </div>
          </div>
        ) : props.status === "error" ? (
          <div role="alert">{message("No se pudieron cargar los horarios", "Revisa la conexión. Esto no significa que no haya cupos.", { label: "Reintentar", onClick: props.onRetry })}</div>
        ) : props.status === "past" ? (
          message("Fecha pasada", "Elige hoy o un día posterior.", { label: "Ir a hoy", onClick: props.onToday })
        ) : props.status === "closed" ? (
          message("Cerrado", `${props.siteName} no abre este día.`, props.nextDay ? { label: `Ir al ${dayShortLabel(props.nextDay)}`, onClick: () => props.onNextDay(props.nextDay as string) } : undefined)
        ) : props.status === "unknown" ? (
          message("Sin consultar", "Este mes todavía no se ha consultado.")
        ) : groups.length === 0 || props.times.every(props.isCurrent) ? (
          message(
            `Sin disponibilidad con ${props.staffFirst}`,
            props.times.length > 0 ? "El único horario libre es el actual de la cita. Elige otro día u otro profesional." : "Elige otro día u otro profesional.",
            props.nextDay ? { label: `Próximo con horarios: ${dayShortLabel(props.nextDay)}`, onClick: () => props.onNextDay(props.nextDay as string) } : undefined,
          )
        ) : (
          groups.map((g) => (
            <div key={g.key} className="flex flex-col gap-2 pb-1">
              <div className="flex items-baseline gap-2">
                <span className={`font-semibold ${phone ? "text-[14px] text-m-tx2" : "text-[13px]"}`}>{g.label}</span>
                <span className={`text-[13px] ${muted}`}>
                  {g.slots.length} horario{g.slots.length === 1 ? "" : "s"}
                </span>
              </div>
              <div role="radiogroup" aria-label={g.label} className="grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-2">
                {g.slots.map((s) => {
                  const sel = s.start_at === props.selected;
                  const current = props.isCurrent(s);
                  const cls = phone
                    ? sel
                      ? "border-m-pri bg-m-pri font-semibold text-m-onpri"
                      : current
                        ? "border-dashed border-m-bd bg-m-sf2 text-m-tx3"
                        : "border-m-bd bg-m-sf text-m-tx"
                    : sel
                      ? "border-foreground bg-foreground font-semibold text-background"
                      : current
                        ? "border-dashed border-line bg-subtle text-muted"
                        : "border-line bg-surface hover:border-foreground/40";
                  return (
                    <button
                      key={s.start_at}
                      type="button"
                      role="radio"
                      aria-checked={sel}
                      aria-label={`${fmtTime(s.start_at, props.tz)}${current ? ", horario actual de la cita" : ""}`}
                      disabled={current}
                      onClick={() => props.onPick(s)}
                      className={`u-tnum u-focus flex min-h-[48px] flex-col items-center justify-center rounded-[12px] border p-0 text-[15px] disabled:cursor-default ${cls}`}
                    >
                      {fmtTime(s.start_at, props.tz)}
                      {current ? <span className="text-[11px] leading-none">actual</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function CompareRow({ phone, label, line, muted = false, strong = false }: { phone: boolean; label: string; line: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className={`flex min-h-[56px] items-center gap-3 border-t px-4 py-3 first:border-t-0 ${phone ? "border-m-dv" : "border-line"}`}>
      <span className={`w-20 flex-none text-[14px] ${phone ? "text-m-tx3" : "text-muted"}`}>{label}</span>
      <span className={`u-tnum min-w-0 flex-1 break-words text-[15px] leading-[1.35] ${strong ? "font-semibold" : ""} ${muted ? (phone ? "text-m-tx2 line-through decoration-1" : "text-muted line-through decoration-1") : ""}`}>{line}</span>
    </div>
  );
}

function dayShortLabel(day: string): string {
  return `${WD_SHORT[new Date(`${day}T00:00:00Z`).getUTCDay()].toLowerCase()} ${Number(day.slice(8))}`;
}
