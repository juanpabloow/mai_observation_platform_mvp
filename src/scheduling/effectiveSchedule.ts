/**
 * EFFECTIVE SCHEDULE of a professional on a local date, and the conflicts an existing
 * appointment has with it — PURE (no DB, no clock). Same reading of hours as the
 * availability engine (src/scheduling/availability.ts): working time = site opening hours ∩
 * the professional's hours (`{}` = inherits the site), minus usual breaks; blocks, absences
 * and closures are removed on top.
 *
 * "Requiere revisión" is DERIVED from this, never stored: an active appointment whose service
 * time falls outside the effective working time or inside a break / block / absence /
 * closure needs a person to look at it. It goes away only when the conflict does (the
 * appointment is moved or cancelled, or the schedule changes back) — opening the appointment,
 * closing a dialog or a failed reschedule leave it in place. It is independent of the
 * appointment's status.
 */
import { hoursToSpans } from './availability.js';
import { intersect, normalize, subtract, type Span } from './intervals.js';
import { utcToZonedParts, zonedPartsToUtc } from './timezone.js';
import type { WeeklyHours } from './types.js';

export type ReviewReason = 'outside_hours' | 'break' | 'absence' | 'site_closure';

export const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  outside_hours: 'Fuera del horario del profesional',
  break: 'Dentro de una pausa habitual',
  absence: 'Dentro de una ausencia o bloqueo',
  site_closure: 'Dentro de un cierre de la sede',
};

export interface TimeRange {
  from: Date;
  until: Date;
}

export interface ScheduleContext {
  timeZone: string;
  siteHours: WeeklyHours;
  /** `{}` = inherits the site's hours. */
  staffHours: WeeklyHours;
  /** Usual breaks that apply to this professional (the site's and their own). */
  breaks: TimeRange[];
  /** This professional's blocks/absences (dated and recurring). */
  staffBlocks: TimeRange[];
  /** Site-wide blocks/closures (dated and recurring). */
  siteBlocks: TimeRange[];
}

const toSpans = (xs: TimeRange[]): Span[] => xs.map((x) => ({ start: x.from.getTime(), end: x.until.getTime() }));

function localDay(at: Date, timeZone: string) {
  const p = utcToZonedParts(at, timeZone);
  const noon = zonedPartsToUtc(p.year, p.month, p.day, 12, 0, timeZone);
  return { date: { year: p.year, month: p.month, day: p.day }, weekday: utcToZonedParts(noon, timeZone).weekday };
}

/** Working spans (before breaks) on the local day that contains `at`. */
export function workingSpans(ctx: Pick<ScheduleContext, 'timeZone' | 'siteHours' | 'staffHours'>, at: Date): Span[] {
  const { date, weekday } = localDay(at, ctx.timeZone);
  const site = normalize(hoursToSpans(ctx.siteHours, date, weekday, ctx.timeZone));
  const own = Object.keys(ctx.staffHours).length > 0;
  const staff = own ? normalize(hoursToSpans(ctx.staffHours, date, weekday, ctx.timeZone)) : site;
  return intersect(site, staff);
}

/** Why an appointment's service time conflicts with the effective schedule (empty = fine). */
export function reviewReasons(appt: TimeRange, ctx: ScheduleContext): ReviewReason[] {
  const span: Span[] = [{ start: appt.from.getTime(), end: appt.until.getTime() }];
  if (span[0].end <= span[0].start) return [];
  const reasons: ReviewReason[] = [];
  // A service can run across a day boundary only in theory; read each day it touches.
  const work = normalize([...workingSpans(ctx, appt.from), ...workingSpans(ctx, new Date(span[0].end - 1))]);
  if (subtract(span, work).length > 0) reasons.push('outside_hours');
  if (intersect(span, toSpans(ctx.breaks)).length > 0) reasons.push('break');
  if (intersect(span, toSpans(ctx.staffBlocks)).length > 0) reasons.push('absence');
  if (intersect(span, toSpans(ctx.siteBlocks)).length > 0) reasons.push('site_closure');
  return reasons;
}

/** Whether `inner` overlaps any of `ranges`. */
export function overlapsAny(inner: TimeRange, ranges: TimeRange[]): boolean {
  const a = inner.from.getTime();
  const b = inner.until.getTime();
  return ranges.some((r) => r.until.getTime() > a && r.from.getTime() < b);
}
