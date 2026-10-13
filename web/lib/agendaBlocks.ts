/**
 * BLOCKED TIME on the agenda (schedule_exceptions) — pure helpers shared by every
 * layout, and unit-tested on their own (test/unit/agendaBlocks.test.ts).
 *
 * These decide only what the agenda DRAWS: where a block sits on a site-local day, its
 * label, and whether an hour row may still offer "Agendar en esta hora". They never
 * decide availability — the booking modal asks the engine (slots), which applies the
 * blocks, working hours and existing appointments itself.
 */

export interface AgendaBlock {
  id: string;
  /** null = the whole site. */
  staff_id: string | null;
  starts_at: string;
  ends_at: string;
  reason: string | null;
}

/** One block on one day, ready to draw in any layout. */
export interface DayBlock {
  id: string;
  staffId: string | null;
  /** Clamped to the window asked for (the grid's hours). */
  sMin: number;
  eMin: number;
  /** "13:00 – 14:00" or "Todo el día" — from the UNclamped span. */
  when: string;
  /** "Bloqueado · toda la sede · Reunión" / "Bloqueado · Daniela Ríos". */
  label: string;
}

const DAY_MIN = 24 * 60;

function zoned(iso: string, tz: string): { dayKey: string; min: number } {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "0";
  return { dayKey: `${get("year")}-${get("month")}-${get("day")}`, min: Number(get("hour")) * 60 + Number(get("minute")) };
}

export const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** A block's part on ONE site-local day, in minutes from midnight clamped to [lo, hi];
 *  null when it does not touch that day. `from`/`to` are unclamped (0 / 1440 when the
 *  block starts before / ends after the day). */
export function blockSpanOn(b: AgendaBlock, dayKey: string, tz: string, lo = 0, hi = DAY_MIN) {
  const s = zoned(b.starts_at, tz);
  const e = zoned(b.ends_at, tz);
  if (s.dayKey > dayKey || e.dayKey < dayKey) return null;
  const from = s.dayKey === dayKey ? s.min : 0;
  const to = e.dayKey === dayKey ? e.min : DAY_MIN;
  const sMin = Math.min(Math.max(from, lo), hi);
  const eMin = Math.min(Math.max(to, sMin), hi);
  return eMin > sMin ? { sMin, eMin, from, to } : null;
}

/**
 * The blocks of one day, sorted by start. A barber filter keeps that barber's blocks
 * and the site-wide ones (both affect that barber's day).
 */
export function dayBlocks(
  blocks: readonly AgendaBlock[],
  dayKey: string,
  tz: string,
  opts: { staffFilter?: string | null; staffNames?: ReadonlyMap<string, string>; lo?: number; hi?: number } = {},
): DayBlock[] {
  const { staffFilter = null, staffNames = new Map(), lo = 0, hi = DAY_MIN } = opts;
  return blocks
    .filter((b) => !staffFilter || b.staff_id === null || b.staff_id === staffFilter)
    .flatMap((b) => {
      const span = blockSpanOn(b, dayKey, tz, lo, hi);
      if (!span) return [];
      const who = b.staff_id === null ? "toda la sede" : staffNames.get(b.staff_id) ?? "un profesional";
      return [
        {
          id: b.id,
          staffId: b.staff_id,
          sMin: span.sMin,
          eMin: span.eMin,
          when: span.from === 0 && span.to === DAY_MIN ? "Todo el día" : `${hhmm(span.from)} – ${hhmm(Math.min(span.to, DAY_MIN - 1))}`,
          label: `Bloqueado · ${who}${b.reason ? ` · ${b.reason}` : ""}`,
        },
      ];
    })
    .sort((x, y) => x.sMin - y.sMin || x.eMin - y.eMin);
}

/** True when the union of [s, e) intervals covers [from, to) completely. */
function covers(intervals: { sMin: number; eMin: number }[], from: number, to: number): boolean {
  let reached = from;
  for (const iv of [...intervals].sort((a, b) => a.sMin - b.sMin)) {
    if (iv.sMin > reached) return false;
    reached = Math.max(reached, iv.eMin);
    if (reached >= to) return true;
  }
  return reached >= to;
}

export type HourState = "open" | "partial" | "blocked";

/**
 * How blocked an hour row is for the professionals who could take a booking in it.
 *   blocked — EVERY candidate is blocked for the WHOLE hour (by own or site-wide blocks);
 *   partial — some minutes of some candidate are blocked, but someone has free time;
 *   open    — nothing in this hour is blocked for any candidate.
 * With no candidates (nobody works that day) only a site-wide block can block the hour.
 * Only `blocked` stops the row from offering a booking; `partial` keeps the offer and
 * leaves the real check to the engine.
 */
export function hourState(blocks: readonly DayBlock[], hour: number, candidateStaffIds: readonly string[]): HourState {
  const from = hour * 60;
  const to = from + 60;
  const inHour = blocks
    .filter((b) => b.sMin < to && b.eMin > from)
    .map((b) => ({ staffId: b.staffId, sMin: Math.max(b.sMin, from), eMin: Math.min(b.eMin, to) }));
  if (inHour.length === 0) return "open";
  const people = candidateStaffIds.length > 0 ? candidateStaffIds : [null];
  const forPerson = (id: string | null) => inHour.filter((b) => b.staffId === null || (id !== null && b.staffId === id));
  const allBlocked = people.every((id) => covers(forPerson(id), from, to));
  if (allBlocked) return "blocked";
  const anyTouched = people.some((id) => forPerson(id).length > 0);
  return anyTouched ? "partial" : "open";
}
