import { siteDayKey, fmtTime, weekdayKeyOf, type DayKey, type MonthKey } from "./siteCalendar";

/**
 * RESCHEDULE — the pure rules behind "Cambiar fecha y hora" (components/scheduling/agenda/
 * RescheduleFlow.tsx), unit-tested in test/unit/rescheduleFlow.test.ts.
 *
 * The flow moves ONE existing appointment: same id, client, service, price, duration and
 * confirmation state. Only the time — and, when the login may, the professional — change.
 * The availability it shows is asked FOR THAT APPOINTMENT (the endpoint excludes its own
 * block and uses its stored duration/buffers), for the professional on screen, for one
 * month at a time; the server checks the chosen slot again when saving.
 *
 * Availability is a small state machine so the screen can never confuse "not asked yet",
 * "asking", "nothing free" and "could not ask": each request carries an id and only the
 * LATEST one may land — a slow answer for a previous month or professional is dropped.
 */

export interface RescheduleSlot {
  start_at: string;
  service_end_at: string;
  staff_id: string;
  available_staff_ids: string[];
}

/** What is being asked: one professional, one month (YYYY-MM, in the site's zone). */
export interface AvailabilityQuery {
  staffId: string;
  month: MonthKey;
}

/**
 * `requested` is the query the screen is showing (each with a new id); `landed` the last
 * answer that arrived FOR the request current at the time. Requests are dispatched from
 * event handlers (and the first one is the initial state), so the fetch effect only
 * fetches — it never sets state synchronously.
 */
export interface AvailabilityModel {
  requested: { id: number } & AvailabilityQuery;
  landed:
    | null
    | ({ id: number; kind: "ready"; slots: RescheduleSlot[] } & AvailabilityQuery)
    | ({ id: number; kind: "error" } & AvailabilityQuery);
}

export type AvailabilityEvent =
  | ({ type: "request" } & AvailabilityQuery)
  | { type: "loaded"; requestId: number; slots: RescheduleSlot[] }
  | { type: "failed"; requestId: number };

/** The model when the flow opens: the appointment's own professional and month, asked. */
export function initialAvailability(query: AvailabilityQuery): AvailabilityModel {
  return { requested: { id: 1, ...query }, landed: null };
}

/** Only the answer to the CURRENT request lands; an older one (a previous month or
 *  professional, or a superseded retry) is dropped. */
export function availabilityReducer(state: AvailabilityModel, event: AvailabilityEvent): AvailabilityModel {
  if (event.type === "request") return { ...state, requested: { id: state.requested.id + 1, staffId: event.staffId, month: event.month } };
  if (event.requestId !== state.requested.id) return state;
  const q = state.requested;
  return {
    ...state,
    landed: event.type === "loaded" ? { id: q.id, kind: "ready", slots: event.slots, staffId: q.staffId, month: q.month } : { id: q.id, kind: "error", staffId: q.staffId, month: q.month },
  };
}

/** What the screen may say right now about the CURRENT query. */
export type AvailabilityState =
  | ({ kind: "loading" } & AvailabilityQuery)
  | ({ kind: "ready"; slots: RescheduleSlot[] } & AvailabilityQuery)
  | ({ kind: "error" } & AvailabilityQuery);

export function availabilityView(model: AvailabilityModel): AvailabilityState {
  const q = model.requested;
  const l = model.landed;
  if (!l || l.id !== q.id) return { kind: "loading", staffId: q.staffId, month: q.month };
  return l.kind === "ready" ? { kind: "ready", slots: l.slots, staffId: q.staffId, month: q.month } : { kind: "error", staffId: q.staffId, month: q.month };
}

/** The free start times of one day, for the professional asked, in time order. */
export function timesForDay(state: AvailabilityState, day: DayKey, timeZone: string): RescheduleSlot[] {
  if (state.kind !== "ready") return [];
  const seen = new Set<string>();
  return state.slots
    .filter((s) => siteDayKey(s.start_at, timeZone) === day && s.available_staff_ids.includes(state.staffId))
    .filter((s) => (seen.has(s.start_at) ? false : (seen.add(s.start_at), true)))
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
}

export type DayStatus = "past" | "closed" | "unknown" | "loading" | "error" | "available" | "none";

/**
 * What ONE calendar day can honestly say. "none" (no availability) only after the search
 * for that month and professional COMPLETED; while asking it is "loading", if asking
 * failed it is "error", and for a month not asked yet "unknown" ("sin consultar").
 */
export function dayStatus(input: {
  day: DayKey;
  today: DayKey;
  /** Weekly opening hours of the site; empty / unknown = do not guess "closed". */
  openWeekdays: Set<string> | null;
  state: AvailabilityState;
  timeZone: string;
}): DayStatus {
  if (input.day < input.today) return "past";
  if (input.openWeekdays && input.openWeekdays.size > 0 && !input.openWeekdays.has(weekdayKeyOf(input.day))) return "closed";
  // Another month than the one asked: not searched (it is asked when that month opens).
  if (input.day.slice(0, 7) !== input.state.month) return "unknown";
  if (input.state.kind === "loading") return "loading";
  if (input.state.kind === "error") return "error";
  return timesForDay(input.state, input.day, input.timeZone).length > 0 ? "available" : "none";
}

/** A chosen start survives only while the availability on screen still offers it. */
export function choiceStillOffered(state: AvailabilityState, startAt: string | null, staffId: string): boolean {
  if (!startAt || state.kind !== "ready" || state.staffId !== staffId) return false;
  return state.slots.some((s) => s.start_at === startAt && s.available_staff_ids.includes(staffId));
}

// ── Before / after ─────────────────────────────────────────────────────────────

export interface ApptTiming {
  start_at: string;
  service_end_at: string;
  staff_id: string;
  staff_name: string | null;
}

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "sábado 17" — plus the month ("sábado 31 oct") when the two sides differ in month. */
function dayLabel(day: DayKey, withMonth: boolean): string {
  const [y, m, d] = day.split("-").map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return withMonth ? `${wd} ${d} ${MONTHS[m - 1]}` : `${wd} ${d}`;
}

/** The first word of a professional's name ("[Demo] Federico Ruiz" → "Federico"). */
export function staffFirstName(name: string | null | undefined): string {
  if (!name) return "Sin profesional";
  return name.replace(/^\s*[[(][^\])]*[\])]\s*/, "").split(/\s+/)[0] || name;
}

export interface RescheduleSide {
  day: string;
  time: string;
  staff: string;
  /** "sábado 17, 11:00–11:50 · Federico" */
  line: string;
}

export interface RescheduleComparison {
  before: RescheduleSide;
  after: RescheduleSide | null;
  staffChanged: boolean;
  timeChanged: boolean;
  /** False when nothing effective would change — "Confirmar cambio" stays disabled. */
  hasChange: boolean;
}

/**
 * The comparison shown before saving, from REAL values: the appointment as stored and
 * the slot the server offered (its end comes from the appointment's stored duration).
 */
export function compareReschedule(appt: ApptTiming, next: ApptTiming | null, timeZone: string): RescheduleComparison {
  const beforeDay = siteDayKey(appt.start_at, timeZone);
  const afterDay = next ? siteDayKey(next.start_at, timeZone) : null;
  const withMonth = afterDay !== null && afterDay.slice(0, 7) !== beforeDay.slice(0, 7);
  const side = (t: ApptTiming, day: DayKey): RescheduleSide => {
    const d = dayLabel(day, withMonth);
    const time = `${fmtTime(t.start_at, timeZone)}–${fmtTime(t.service_end_at, timeZone)}`;
    const staff = staffFirstName(t.staff_name);
    return { day: d, time, staff, line: `${d}, ${time} · ${staff}` };
  };
  const timeChanged = Boolean(next && new Date(next.start_at).getTime() !== new Date(appt.start_at).getTime());
  const staffChanged = Boolean(next && next.staff_id !== appt.staff_id);
  return {
    before: side(appt, beforeDay),
    after: next && afterDay ? side(next, afterDay) : null,
    staffChanged,
    timeChanged,
    hasChange: timeChanged || staffChanged,
  };
}

/**
 * Why the detail offers no "Cambiar fecha y hora" — said plainly instead of a missing or
 * dead button. Null when the action is offered.
 */
export function rescheduleBlockedReason(input: { status: string; allowed: boolean; staffName: string | null }): string | null {
  switch (input.status) {
    case "cancelled":
      return "Esta cita está cancelada: ya no se puede cambiar su fecha.";
    case "completed":
      return "Esta cita ya se completó: no se puede cambiar su fecha.";
    case "no_show":
      return "Esta cita quedó como inasistencia: no se puede cambiar su fecha.";
  }
  if (!input.allowed) return `Esta cita es de ${input.staffName ? staffFirstName(input.staffName) : "otro profesional"}: solo esa persona o quien administra la agenda puede cambiarla.`;
  return null;
}

// ── Why a day offers nothing, and what is close by ───────────────────────────────

/** The engine's per-day summary (internal availability `explain=1`) in the words of the
 *  agenda. Distinguishes a closed SITE from ONE professional's absence: a person's
 *  vacation never reads as "Sede cerrada". */
export function dayReasonLabel(summary: string | null | undefined): string | null {
  switch (summary) {
    case undefined:
    case null:
    case "available":
      return null;
    case "site_closed_day":
    case "outside_site_hours":
    case "site_closure":
      return "Sede cerrada";
    case "absence":
      return "Profesional ausente";
    case "off_shift":
      return "No trabaja este día";
    default:
      return "Sin horas disponibles";
  }
}

/** After "ese horario acaba de ocuparse": the free times closest to the one wanted. */
export function nearestAlternatives(times: RescheduleSlot[], wanted: string | null, n = 3): RescheduleSlot[] {
  if (!wanted) return times.slice(0, n);
  const w = Date.parse(wanted);
  return [...times].sort((a, b) => Math.abs(Date.parse(a.start_at) - w) - Math.abs(Date.parse(b.start_at) - w)).slice(0, n)
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
}
