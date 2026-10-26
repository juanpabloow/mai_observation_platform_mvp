import { hoursToSpans } from './availability.js';
import { intersect, normalize, subtract, type Span } from './intervals.js';
import { localDatesInRange, utcToZonedParts, zonedPartsToUtc } from './timezone.js';
import type { WeeklyHours } from './types.js';

/**
 * PAST ATTENDANCE («Registrar atención realizada») — can THIS exact interval be recorded for
 * THIS professional, and if not, WHY. Pure: no DB, no clock.
 *
 * A service that already happened is a fact with a real start (10:07 is fine), so the slot
 * grid and the minimum notice do not apply. Everything else does, read exactly as the engine
 * reads it (availability.ts): the site's opening hours that day, the professional's own hours
 * (or the site's when they have none), their usual breaks, site-wide blocks and their own
 * blocks/absences. Each rule the interval runs into is returned with the part it covers, so
 * the agenda can say «pausa de 13:00 a 14:00» instead of «no disponible» — and never records
 * an exception silently.
 *
 * Other appointments are not checked here: the caller lists them (a no-show never blocks).
 */

export type PastProblemCode =
  | 'not_ended' // the service has not finished yet (now < end)
  | 'site_closed_day' // the site has no opening hours that weekday
  | 'outside_site_hours' // part of it is outside the site's opening hours
  | 'off_shift' // part of it is outside the professional's hours
  | 'break' // a usual break (schedule_series kind=break)
  | 'site_closure' // a site-wide block
  | 'absence'; // a block / absence of this professional

export interface PastProblem {
  code: PastProblemCode;
  /** The part of the interval this rule covers (ISO in the API; Dates here). */
  from: Date;
  until: Date;
}

export interface PastIntervalInput {
  timezone: string;
  siteHours: WeeklyHours;
  /** {} = inherits the site's hours (the engine's rule). */
  staffHours: WeeklyHours;
  siteBreaks: Array<{ from: Date; until: Date }>;
  staffBreaks: Array<{ from: Date; until: Date }>;
  siteBlocks: Array<{ from: Date; until: Date }>;
  staffBlocks: Array<{ from: Date; until: Date }>;
  /** The interval the appointment occupies (blocked_from → blocked_until). */
  from: Date;
  until: Date;
  /** When the service itself ends — must be ≤ now. */
  serviceEnd: Date;
  now: Date;
}

const spans = (xs: Array<{ from: Date; until: Date }>): Span[] => xs.map((x) => ({ start: x.from.getTime(), end: x.until.getTime() }));
const first = (code: PastProblemCode, s: Span[]): PastProblem | null =>
  s.length > 0 ? { code, from: new Date(s[0].start), until: new Date(s[s.length - 1].end) } : null;

export function checkPastInterval(input: PastIntervalInput): PastProblem[] {
  const out: PastProblem[] = [];
  const tz = input.timezone;
  const want: Span = { start: input.from.getTime(), end: input.until.getTime() };
  if (input.serviceEnd.getTime() > input.now.getTime()) {
    out.push({ code: 'not_ended', from: input.serviceEnd, until: input.serviceEnd });
  }

  let siteOpen: Span[] = [];
  let staffWork: Span[] = [];
  let siteHasHours = false;
  // Every local day the interval touches (one, unless it crosses midnight).
  for (const date of localDatesInRange(input.from, new Date(want.end - 1), tz)) {
    const noon = zonedPartsToUtc(date.year, date.month, date.day, 12, 0, tz);
    const weekday = utcToZonedParts(noon, tz).weekday;
    const open = normalize(hoursToSpans(input.siteHours, date, weekday, tz));
    if (open.length > 0) siteHasHours = true;
    const own = Object.keys(input.staffHours).length > 0;
    siteOpen = siteOpen.concat(open);
    staffWork = staffWork.concat(own ? normalize(hoursToSpans(input.staffHours, date, weekday, tz)) : open);
  }
  siteOpen = normalize(siteOpen);
  staffWork = normalize(staffWork);

  if (!siteHasHours) {
    out.push({ code: 'site_closed_day', from: input.from, until: input.until });
    return out;
  }
  const outsideSite = subtract([want], siteOpen);
  const p1 = first('outside_site_hours', outsideSite);
  if (p1) out.push(p1);
  const p2 = first('off_shift', subtract(intersect([want], siteOpen), staffWork));
  if (p2) out.push(p2);
  const inside = intersect([want], intersect(siteOpen, staffWork));
  const p3 = first('break', intersect(inside, [...spans(input.siteBreaks), ...spans(input.staffBreaks)]));
  if (p3) out.push(p3);
  const p4 = first('site_closure', intersect(inside, spans(input.siteBlocks)));
  if (p4) out.push(p4);
  const p5 = first('absence', intersect(inside, spans(input.staffBlocks)));
  if (p5) out.push(p5);
  return out;
}

/**
 * A back-dated registration — an agenda walk-in recorded only once its service had already
 * ended (the only way createAppointment lets a walk-in be created after its end). The machine
 * API uses it so an automation never asks a customer to review a visit that reception merely
 * wrote down afterwards.
 */
export function isRegisteredAfterService(appt: { origin: string; created_at: Date; service_end_at: Date }): boolean {
  return appt.origin === 'walk_in' && new Date(appt.created_at).getTime() >= new Date(appt.service_end_at).getTime();
}
