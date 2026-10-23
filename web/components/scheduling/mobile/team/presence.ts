/**
 * TEAM PRESENCE — pure helpers behind the phone "Equipo" screens (and unit-tested on
 * their own: test/unit/teamPresence.test.ts). No React, no aliases, so the test runner
 * can import it directly.
 *
 * Everything here is DERIVED from data the staff page already loads; nothing is stored or
 * guessed:
 *   - "En turno"      now falls inside the professional's working hours for today, in the
 *                     SITE timezone. Their own `working_hours` when they have any; an empty
 *                     map means "inherit the site's opening hours" — the same rule the
 *                     availability engine applies (src/scheduling/availability.ts), which
 *                     also intersects with the site's opening hours, so this does too.
 *   - "Ocupado según agenda"  an appointment of theirs (scheduled/confirmed) spans now. It
 *                     says what the AGENDA holds, not that the client arrived or the
 *                     service began — no event records that (finding F).
 *   - "Fuera de turno" anything else: outside hours, a staff time-off exception, or a
 *                     site-wide closure covering now.
 *   - "Inactivo"      `active = false` — they no longer take new bookings.
 */

export type HoursRange = { start: string; end: string };
export type Weekly = Record<string, HoursRange[]>;

export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
/** Monday-first, the order a Spanish week is read in. */
export const WEEK_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const WEEKDAY_ES: Record<string, string> = {
  mon: "Lunes",
  tue: "Martes",
  wed: "Miércoles",
  thu: "Jueves",
  fri: "Viernes",
  sat: "Sábado",
  sun: "Domingo",
};

export interface PresenceAppt {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
}
export interface PresenceSpan {
  startsAt: string;
  endsAt: string;
}

export type PresenceKind = "on" | "busy" | "off" | "inactive";

export interface Presence {
  kind: PresenceKind;
  /** The chip's words — glyph + text, never colour alone. */
  chip: string;
  /** The state palette class the chip wears (see `.u-m-st-*` in globals.css). */
  chipClass: string;
  /** The line beside the chip: "Siguiente a las 10:30", "Cita hasta las 10:30"… */
  sub: string;
  /** Counted under "En turno" (on shift or with a client). */
  onShift: boolean;
}

/** "HH:MM" → minutes after midnight; NaN for anything malformed. */
export function toMin(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}
export function fromMin(min: number): string {
  const h = Math.floor(min / 60);
  return `${String(h).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

const clockFmt = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = clockFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    clockFmt.set(tz, f);
  }
  return f;
}

/** The site-local wall clock for an instant: weekday key, minutes, and the yyyy-mm-dd day. */
export function zonedClock(ms: number, tz: string): { weekday: string; minutes: number; day: string } {
  const parts = Object.fromEntries(fmtFor(tz).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  return {
    weekday: String(parts.weekday).toLowerCase().slice(0, 3),
    minutes: hour * 60 + Number(parts.minute),
    day: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** "10:30" for an ISO instant, in the site timezone. */
export function fmtHM(iso: string | number, tz: string): string {
  const c = zonedClock(typeof iso === "number" ? iso : Date.parse(iso), tz);
  return fromMin(c.minutes);
}

type Span = [number, number];

function spansOf(ranges: HoursRange[] | undefined): Span[] {
  return (ranges ?? [])
    .map((r) => [toMin(r.start), toMin(r.end)] as Span)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
}

function intersect(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      const s = Math.max(a0, b0);
      const e = Math.min(a1, b1);
      if (e > s) out.push([s, e]);
    }
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/** Does this professional have hours of their own, or inherit the site's? */
export function inheritsSiteHours(working: Weekly | null | undefined): boolean {
  return !working || Object.keys(working).length === 0;
}

/**
 * The spans (minutes) a professional works on a weekday: their own hours ∩ the site's
 * opening hours, or the site's hours when they have none of their own.
 */
export function workSpans(working: Weekly | null | undefined, site: Weekly | null | undefined, weekday: string): Span[] {
  const open = spansOf(site?.[weekday]);
  if (inheritsSiteHours(working)) return open;
  return intersect(spansOf(working?.[weekday]), open);
}

const LIVE = new Set(["scheduled", "confirmed"]);
const covers = (s: PresenceSpan, now: number) => Date.parse(s.startsAt) <= now && Date.parse(s.endsAt) > now;

/**
 * "Trabaja hoy": the professional has working hours on today's SITE-local weekday (their
 * own ∩ the site's opening hours, or the site's when they inherit). It says nothing about
 * the clock — someone whose shift ended at 19:00 still "works today" at 22:30. "En turno
 * ahora" is `presenceFor(...).onShift`.
 */
export function worksToday(working: Weekly | null | undefined, site: Weekly | null | undefined, now: number, tz: string): boolean {
  return workSpans(working, site, zonedClock(now, tz).weekday).length > 0;
}

export interface PresenceInput {
  active: boolean;
  workingHours: Weekly | null | undefined;
  siteHours: Weekly | null | undefined;
  /** This professional's appointments today (any status; cancelled ones are ignored). */
  appts: PresenceAppt[];
  /** This professional's time-off exceptions. */
  timeOff: PresenceSpan[];
  /** Site-wide closures (exceptions with no staff). */
  closures: PresenceSpan[];
  now: number;
  tz: string;
  /** Formats a day for "Ausencia hasta el …". */
  fmtDay?: (iso: string) => string;
}

export function presenceFor(input: PresenceInput): Presence {
  const { now, tz } = input;
  if (!input.active) {
    return { kind: "inactive", chip: "⊘ Inactivo", chipClass: "u-m-st-no_show", sub: "No recibe citas nuevas", onShift: false };
  }
  const live = input.appts
    .filter((a) => LIVE.has(a.status))
    .sort((x, y) => Date.parse(x.startAt) - Date.parse(y.startAt));
  const inChair = live.find((a) => Date.parse(a.startAt) <= now && Date.parse(a.endAt) > now);
  if (inChair) {
    return {
      kind: "busy",
      chip: "◐ Ocupado según agenda",
      chipClass: "u-m-st-scheduled",
      sub: `Cita hasta las ${fmtHM(inChair.endAt, tz)}`,
      onShift: true,
    };
  }

  const OFF = { kind: "off" as const, chip: "○ Fuera de turno", chipClass: "u-m-st-completed", onShift: false };
  const away = input.timeOff.find((t) => covers(t, now));
  if (away) {
    const sameDay = zonedClock(Date.parse(away.endsAt), tz).day === zonedClock(now, tz).day;
    const until = sameDay ? `hasta las ${fmtHM(away.endsAt, tz)}` : `hasta el ${input.fmtDay ? input.fmtDay(away.endsAt) : zonedClock(Date.parse(away.endsAt), tz).day}`;
    return { ...OFF, sub: `Ausencia ${until}` };
  }
  const closed = input.closures.find((t) => covers(t, now));
  if (closed) return { ...OFF, sub: `Sede cerrada hasta las ${fmtHM(closed.endsAt, tz)}` };

  const clock = zonedClock(now, tz);
  const spans = workSpans(input.workingHours, input.siteHours, clock.weekday);
  const current = spans.find(([s, e]) => s <= clock.minutes && e > clock.minutes);
  if (current) {
    const next = live.find((a) => Date.parse(a.startAt) > now);
    return {
      kind: "on",
      chip: "● En turno",
      chipClass: "u-m-st-confirmed",
      sub: next ? `Siguiente a las ${fmtHM(next.startAt, tz)}` : `Libre hasta las ${fromMin(current[1])}`,
      onShift: true,
    };
  }
  const later = spans.find(([s]) => s > clock.minutes);
  if (later) return { ...OFF, sub: `Entra a las ${fromMin(later[0])}` };
  const last = spans[spans.length - 1];
  if (last) return { ...OFF, sub: `Terminó a las ${fromMin(last[1])}` };
  return { ...OFF, sub: "No trabaja hoy" };
}

/**
 * The desktop/tablet roster's status (StaffTab), derived FROM `presenceFor` so every
 * width answers "who is on shift now" the same way. The roster keeps its finer words —
 * "Disponible" (on shift, has bookings today) vs "En turno" (on shift, none), "Ausente",
 * "Sin silla" — but on/off shift is always the shared presence, never a guess from
 * "has hours today". "Fuera de turno" (works today, not now) and "Sin turno hoy" (no
 * hours today) are the two halves of "Trabaja hoy" vs "En turno ahora".
 */
export type RosterStatus =
  | "with_client"
  | "available"
  | "on_shift"
  | "off_shift"
  | "off_today"
  | "time_off"
  | "no_chair"
  | "inactive";

export function rosterStatus(input: Omit<PresenceInput, "active"> & { takesBookings: boolean; active?: boolean }): {
  status: RosterStatus;
  presence: Presence;
  /** Counted under "En turno" — identical to the phone's segment. */
  onShift: boolean;
  worksToday: boolean;
  /** The time-off exception covering now, if any. */
  away?: PresenceSpan;
} {
  // INACTIVE (`active = false`, no new bookings) is listed on every width, labelled, and
  // is never on shift — the same answer the phone gives.
  const active = input.active ?? true;
  const presence = presenceFor({ ...input, active });
  const works = worksToday(input.workingHours, input.siteHours, input.now, input.tz);
  const away = input.timeOff.find((t) => covers(t, input.now));
  const hasBookings = input.appts.some((a) => a.status !== "cancelled");
  let status: RosterStatus;
  // NO CHAIR is a fact about bookings (takes_bookings = false), not about presence: a
  // front-desk hire still counts as on/off shift by their hours, like on the phone.
  if (!active) status = "inactive";
  else if (!input.takesBookings) status = "no_chair";
  else if (presence.kind === "busy") status = "with_client";
  else if (away) status = "time_off";
  else if (presence.kind === "on") status = hasBookings ? "available" : "on_shift";
  else status = works ? "off_shift" : "off_today";
  return { status, presence, onShift: presence.onShift, worksToday: works, away };
}

/**
 * The roster's facet pills. "En turno" is everyone on shift NOW, a client in the chair
 * included — the phone's "En turno" segment — and "Fuera" is everyone else, INACTIVE
 * professionals included (they are not working), so En turno + Fuera = Todos on both
 * widths and match the phone. ("available" / "off_today" are the pills' historical keys.)
 */
export type RosterFacet = "with_client" | "available" | "off_today";

export function inRosterFacet(r: { status: RosterStatus; onShift: boolean }, facet: RosterFacet): boolean {
  if (facet === "with_client") return r.status === "with_client";
  return facet === "available" ? r.onShift : !r.onShift;
}

export function rosterFacetCounts(list: { status: RosterStatus; onShift: boolean }[]): Record<RosterFacet, number> {
  return {
    with_client: list.filter((r) => inRosterFacet(r, "with_client")).length,
    available: list.filter((r) => inRosterFacet(r, "available")).length,
    off_today: list.filter((r) => inRosterFacet(r, "off_today")).length,
  };
}

/**
 * ONE roster for every width: every professional of the site, active first (in the
 * server's order, by name), inactive last — listed and labelled, never dropped.
 */
export function rosterOrder<T extends { active: boolean }>(members: T[]): T[] {
  return [...members].sort((a, b) => Number(b.active) - Number(a.active));
}

/** The phone's segments over the same roster: Todos / En turno / Fuera. */
export function presenceSegCounts(list: { onShift: boolean }[]): { all: number; on: number; off: number } {
  const on = list.filter((r) => r.onShift).length;
  return { all: list.length, on, off: list.length - on };
}

/** "3 citas hoy · 2,3 h" — cancelled appointments do not count. */
export function todayLoad(appts: PresenceAppt[]): { count: number; minutes: number; label: string } {
  const kept = appts.filter((a) => a.status !== "cancelled");
  const minutes = kept.reduce((n, a) => n + Math.max(0, Math.round((Date.parse(a.endAt) - Date.parse(a.startAt)) / 60_000)), 0);
  if (kept.length === 0) return { count: 0, minutes: 0, label: "Sin citas hoy" };
  return { count: kept.length, minutes, label: `${citas(kept.length)} hoy · ${hoursEs(minutes)}` };
}

export function citas(n: number): string {
  return `${n} ${n === 1 ? "cita" : "citas"}`;
}

/** 138 → "2,3 h" (one decimal, Spanish comma). */
export function hoursEs(minutes: number): string {
  const v = Math.round(minutes / 6) / 10;
  return `${String(v).replace(".", ",")} h`;
}

/** The weekly grid as rows: "Lunes" → "09:00 – 13:00, 15:00 – 19:00" | "Libre". */
export function weekRows(weekly: Weekly | null | undefined): { key: string; day: string; value: string; open: boolean }[] {
  return WEEK_ORDER.map((key) => {
    const spans = spansOf(weekly?.[key]);
    return {
      key,
      day: WEEKDAY_ES[key],
      open: spans.length > 0,
      value: spans.length > 0 ? spans.map(([s, e]) => `${fromMin(s)} – ${fromMin(e)}`).join(", ") : "Libre",
    };
  });
}

/** A draft of the weekly hours is storable when every range is a real, ordered pair. */
export function hoursDraftError(draft: Weekly): string | null {
  for (const key of WEEK_ORDER) {
    for (const r of draft[key] ?? []) {
      const s = toMin(r.start);
      const e = toMin(r.end);
      if (!Number.isFinite(s) || !Number.isFinite(e)) return `${WEEKDAY_ES[key]}: completa las horas.`;
      if (e <= s) return `${WEEKDAY_ES[key]}: la hora de fin debe ser posterior a la de inicio.`;
    }
  }
  return null;
}
