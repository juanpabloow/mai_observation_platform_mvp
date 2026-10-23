import { hoursToSpans } from './availability.js';
import { intersect, normalize, subtract, type Span } from './intervals.js';
import { localDatesInRange, utcToZonedParts, zonedPartsToUtc } from './timezone.js';
import type { AvailabilityRequest, Slot, StaffAvailabilityInput } from './types.js';

/**
 * AVAILABILITY EXPLAINER — WHY a professional has (or has no) slots on each requested
 * local day, read from the SAME inputs the engine used (availability.ts). Pure: no DB, no
 * clock; it never changes a slot, it only explains the engine's result.
 *
 * Every cause is measured on the REQUESTED interval, clipped to the day:
 *   site_closed_day       the site has no opening hours that weekday
 *   outside_site_hours    the interval lies outside the site's opening hours
 *   off_shift             the professional is not on shift (day off, outside hours, break)
 *   site_closure          a site-wide block (schedule exception, staff_id NULL)
 *   absence               a block of THIS professional
 *   booked                occupied by appointments (no detail of them is ever carried)
 *   service_does_not_fit  free time exists, but no gap holds duration + buffers
 *   no_valid_start_in_window  the service fits only by running outside the interval
 *   min_notice / beyond_booking_horizon / in_the_past  booking rules
 * and a day's `summary` is the ONE cause that explains it, `multiple` when several do
 * (never collapsed into the "most likely" one), or `unknown` when nothing above accounts
 * for an empty result. `available` when the engine returned slots.
 *
 * A block's PUBLIC reason (schedule_exceptions.public_reason) is carried only when EVERY
 * block behind that cause shares it; mixed or missing → null. The internal `reason` text
 * never enters this module.
 */

export type PublicAbsenceReason = 'vacation' | 'unavailable' | 'site_closed';

export type CauseCode =
  | 'site_closed_day'
  | 'outside_site_hours'
  | 'off_shift'
  | 'site_closure'
  | 'absence'
  | 'booked'
  | 'service_does_not_fit'
  | 'no_valid_start_in_window'
  | 'min_notice'
  | 'beyond_booking_horizon'
  | 'in_the_past';

export type SummaryCode = CauseCode | 'available' | 'multiple' | 'unknown';

export interface ExplainCause {
  code: CauseCode;
  /** 'all' = this cause alone covers the professional's whole working time in the interval. */
  coverage: 'all' | 'part';
  /** Minutes of the requested interval it accounts for (0 for booking-rule causes). */
  minutes: number;
  /** site_closure / absence only: the shared public reason of the blocks behind it. */
  public_reason: PublicAbsenceReason | null;
  /** site_closure / absence only: the blocks cover the professional's WHOLE working day,
   *  not just the requested interval (so "that day" may be said, not only "that time"). */
  covers_whole_working_day?: boolean;
  /** off_shift only: the professional has NO shift at all that day (vs. outside hours / a break). */
  no_shift_that_day?: boolean;
}

export interface DayExplanation {
  /** Local date "YYYY-MM-DD" in the site timezone. */
  date: string;
  staff_id: string;
  status: 'available' | 'unavailable';
  slot_count: number;
  summary: SummaryCode;
  /** Only when summary is site_closure/absence with a confirmed shared public reason. */
  public_reason: PublicAbsenceReason | null;
  causes: ExplainCause[];
}

/** An exception span with its PUBLIC reason (never the internal text). */
export interface ExplainException {
  from: Date;
  until: Date;
  public_reason: PublicAbsenceReason | null;
}

export interface ExplainInput {
  request: AvailabilityRequest;
  slots: Slot[];
  /** Which professionals to explain (must be among request.staff). */
  staffIds: string[];
  /** Same spans as request.siteExceptions / staff.exceptions, WITH public reasons. */
  siteExceptions: ExplainException[];
  staffExceptions: Map<string, ExplainException[]>;
  /** Usual breaks (migration 1819). Read as time the schedule does not work — exactly like
   *  the gaps in weekly hours they replace — so a lunch is "off shift", never an absence. */
  siteBreaks?: Array<{ from: Date; until: Date }>;
  staffBreaks?: Map<string, Array<{ from: Date; until: Date }>>;
}

const MIN = 60_000;
const len = (spans: Span[]): number => spans.reduce((a, s) => a + (s.end - s.start), 0);
const minutes = (spans: Span[]): number => Math.round(len(spans) / MIN);
const pad = (n: number) => String(n).padStart(2, '0');

function commonReason(blocks: ExplainException[], over: Span[]): PublicAbsenceReason | null {
  const touching = blocks.filter((b) => intersect([{ start: b.from.getTime(), end: b.until.getTime() }], over).length > 0);
  if (touching.length === 0) return null;
  const first = touching[0].public_reason;
  return first !== null && touching.every((b) => b.public_reason === first) ? first : null;
}

const toSpans = (xs: Array<{ from: Date; until: Date }>): Span[] => xs.map((x) => ({ start: x.from.getTime(), end: x.until.getTime() }));

export function explainAvailability(input: ExplainInput): DayExplanation[] {
  const { request: req, slots } = input;
  const { site, now } = req;
  const tz = site.timezone;
  const cfg = site.scheduling_config;
  const slotMs = cfg.slot_interval_min * MIN;
  const from = req.from.getTime();
  const to = req.to.getTime();
  const minStart = now.getTime() + cfg.min_notice_min * MIN;
  const maxStart = now.getTime() + cfg.booking_horizon_days * 24 * 60 * MIN;
  const siteExcSpans = toSpans(req.siteExceptions);
  const out: DayExplanation[] = [];

  const dayOf = (d: Date) => {
    const p = utcToZonedParts(d, tz);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  };

  for (const staffId of input.staffIds) {
    const st: StaffAvailabilityInput | undefined = req.staff.find((s) => s.id === staffId);
    if (!st) continue;
    const durMs = st.timing.duration_min * MIN;
    const bufBefore = st.timing.buffer_before_min * MIN;
    const bufAfter = st.timing.buffer_after_min * MIN;
    const staffExc = input.staffExceptions.get(staffId) ?? [];
    const staffExcSpans = toSpans(staffExc);
    const busySpans = toSpans(st.busy);

    for (const date of localDatesInRange(req.from, req.to, tz)) {
      const dayStart = zonedPartsToUtc(date.year, date.month, date.day, 0, 0, tz).getTime();
      const next = new Date(dayStart + 26 * 3600 * 1000);
      const np = utcToZonedParts(next, tz);
      const dayEnd = zonedPartsToUtc(np.year, np.month, np.day, 0, 0, tz).getTime();
      const win: Span = { start: Math.max(from, dayStart), end: Math.min(to, dayEnd) };
      if (win.end <= win.start) continue;
      const key = `${date.year}-${pad(date.month)}-${pad(date.day)}`;

      const slotCount = slots.filter((s) => dayOf(s.start_at) === key && s.candidates.some((c) => c.staff_id === staffId)).length;
      const causes: ExplainCause[] = [];
      const noon = zonedPartsToUtc(date.year, date.month, date.day, 12, 0, tz);
      const weekday = utcToZonedParts(noon, tz).weekday;

      const siteDay = normalize(hoursToSpans(site.opening_hours, date, weekday, tz));
      const finish = (summary: SummaryCode, publicReason: PublicAbsenceReason | null = null) =>
        out.push({ date: key, staff_id: staffId, status: slotCount > 0 ? 'available' : 'unavailable', slot_count: slotCount, summary: slotCount > 0 ? 'available' : summary, public_reason: slotCount > 0 ? null : publicReason, causes });

      if (siteDay.length === 0) {
        causes.push({ code: 'site_closed_day', coverage: 'all', minutes: Math.round((win.end - win.start) / MIN), public_reason: null });
        finish('site_closed_day');
        continue;
      }
      const open = intersect(siteDay, [win]);
      if (open.length === 0) {
        causes.push({ code: 'outside_site_hours', coverage: 'all', minutes: Math.round((win.end - win.start) / MIN), public_reason: null });
        finish('outside_site_hours');
        continue;
      }
      const ownHours = Object.keys(st.working_hours).length > 0;
      const staffDay = ownHours ? normalize(hoursToSpans(st.working_hours, date, weekday, tz)) : siteDay;
      const breaks = toSpans([...(input.siteBreaks ?? []), ...(input.staffBreaks?.get(staffId) ?? [])]);
      const workDay = subtract(intersect(siteDay, staffDay), breaks);
      const work = intersect(workDay, [win]);
      const offShift = subtract(open, work);
      if (len(offShift) > 0) {
        causes.push({ code: 'off_shift', coverage: len(work) === 0 ? 'all' : 'part', minutes: minutes(offShift), public_reason: null, no_shift_that_day: len(workDay) === 0 });
      }
      if (len(work) === 0) {
        finish('off_shift');
        continue;
      }
      const workMin = len(work);

      // Site-wide blocks, then this professional's own, then appointments — in the order
      // the engine subtracts them, so no minute is counted twice.
      const siteBlocked = intersect(work, siteExcSpans);
      if (len(siteBlocked) > 0) {
        causes.push({
          code: 'site_closure',
          coverage: len(siteBlocked) === workMin ? 'all' : 'part',
          minutes: minutes(siteBlocked),
          public_reason: commonReason(input.siteExceptions, siteBlocked),
          covers_whole_working_day: len(subtract(workDay, siteExcSpans)) === 0,
        });
      }
      const rem1 = subtract(work, siteExcSpans);
      const absent = intersect(rem1, staffExcSpans);
      if (len(absent) > 0) {
        causes.push({
          code: 'absence',
          coverage: len(absent) === workMin ? 'all' : 'part',
          minutes: minutes(absent),
          public_reason: commonReason(staffExc, absent),
          covers_whole_working_day: len(subtract(subtract(workDay, siteExcSpans), staffExcSpans)) === 0,
        });
      }
      const rem2 = subtract(rem1, staffExcSpans);
      const booked = intersect(rem2, busySpans);
      if (len(booked) > 0) {
        causes.push({ code: 'booked', coverage: len(booked) === workMin ? 'all' : 'part', minutes: minutes(booked), public_reason: null });
      }
      const free = subtract(rem2, busySpans);

      if (slotCount === 0 && len(free) > 0) {
        // Replay the engine's start grid on the DAY's free time (not clipped: a service may
        // begin inside the interval and the engine checks its full window), then apply the
        // same filters one at a time to name the one that removed every start.
        const freeDay = subtract(subtract(subtract(workDay, siteExcSpans), staffExcSpans), busySpans);
        const fits: number[] = [];
        for (const span of freeDay) {
          const first = span.start + bufBefore;
          const aligned = dayStart + Math.ceil((first - dayStart) / slotMs) * slotMs;
          for (let s = aligned; s + durMs + bufAfter <= span.end; s += slotMs) {
            if (s - bufBefore >= span.start) fits.push(s);
          }
        }
        const touching = fits.filter((s) => s + durMs > win.start && s < win.end);
        const inWindow = fits.filter((s) => s >= from && s + durMs <= to && s >= win.start && s < win.end);
        if (inWindow.length === 0) {
          causes.push({ code: touching.length > 0 ? 'no_valid_start_in_window' : 'service_does_not_fit', coverage: 'part', minutes: minutes(free), public_reason: null });
        } else {
          const past = inWindow.filter((s) => s < now.getTime());
          const soon = inWindow.filter((s) => s >= now.getTime() && s < minStart);
          const far = inWindow.filter((s) => s > maxStart);
          if (past.length) causes.push({ code: 'in_the_past', coverage: 'part', minutes: 0, public_reason: null });
          if (soon.length) causes.push({ code: 'min_notice', coverage: 'part', minutes: 0, public_reason: null });
          if (far.length) causes.push({ code: 'beyond_booking_horizon', coverage: 'part', minutes: 0, public_reason: null });
        }
      }

      // The day's ONE explanation, from the causes inside the working time only (off-shift
      // minutes outside the professional's hours do not compete with an absence inside them).
      const within = causes.filter((c) => c.code !== 'off_shift');
      if (within.length === 1) {
        const c = within[0];
        const blockLike = c.code === 'absence' || c.code === 'site_closure';
        finish(c.code, blockLike && c.coverage === 'all' ? c.public_reason : null);
      } else if (within.length > 1) {
        finish('multiple');
      } else {
        finish('unknown');
      }
    }
  }
  return out;
}

// ── Status without a service ("¿trabaja hoy?") ─────────────────────────────────────

export type StatusSummary = 'working' | 'site_closed_day' | 'off_shift' | 'site_closure' | 'absence' | 'multiple';

export interface DayStatus {
  date: string;
  /** working = some shift time is not blocked; partly = blocks cover part of the shift. */
  status: 'working' | 'partly_working' | 'not_working';
  summary: StatusSummary;
  public_reason: PublicAbsenceReason | null;
  /** Shift time left after site closures and the professional's own blocks (UTC spans). */
  shift: Array<{ from: Date; until: Date }>;
  causes: ExplainCause[];
}

/**
 * Whether a professional WORKS on each local day — from opening hours, their shift and the
 * blocks only. No appointment is read (bookings depend on a service; that is the slots'
 * job), so this never says "fully booked", and it says nothing about bookable times.
 */
export function explainStaffStatus(input: {
  site: { timezone: string; opening_hours: AvailabilityRequest['site']['opening_hours'] };
  staff: { id: string; working_hours: StaffAvailabilityInput['working_hours'] };
  dates: Array<{ year: number; month: number; day: number }>;
  siteExceptions: ExplainException[];
  staffExceptions: ExplainException[];
  /** Usual breaks (site + this professional) — off shift, like weekly-hours gaps. */
  breaks?: Array<{ from: Date; until: Date }>;
}): DayStatus[] {
  const tz = input.site.timezone;
  const siteExc = toSpans(input.siteExceptions);
  const ownExc = toSpans(input.staffExceptions);
  return input.dates.map((date) => {
    const key = `${date.year}-${pad(date.month)}-${pad(date.day)}`;
    const noon = zonedPartsToUtc(date.year, date.month, date.day, 12, 0, tz);
    const weekday = utcToZonedParts(noon, tz).weekday;
    const siteDay = normalize(hoursToSpans(input.site.opening_hours, date, weekday, tz));
    const causes: ExplainCause[] = [];
    const done = (status: DayStatus['status'], summary: StatusSummary, shift: Span[], pr: PublicAbsenceReason | null = null): DayStatus => ({
      date: key,
      status,
      summary,
      public_reason: pr,
      shift: shift.map((s) => ({ from: new Date(s.start), until: new Date(s.end) })),
      causes,
    });
    if (siteDay.length === 0) {
      causes.push({ code: 'site_closed_day', coverage: 'all', minutes: 0, public_reason: null });
      return done('not_working', 'site_closed_day', []);
    }
    const own = Object.keys(input.staff.working_hours).length > 0;
    const workDay = subtract(
      intersect(siteDay, own ? normalize(hoursToSpans(input.staff.working_hours, date, weekday, tz)) : siteDay),
      toSpans(input.breaks ?? []),
    );
    if (len(workDay) === 0) {
      causes.push({ code: 'off_shift', coverage: 'all', minutes: 0, public_reason: null, no_shift_that_day: true });
      return done('not_working', 'off_shift', []);
    }
    const total = len(workDay);
    const closed = intersect(workDay, siteExc);
    if (len(closed) > 0) {
      causes.push({ code: 'site_closure', coverage: len(closed) === total ? 'all' : 'part', minutes: minutes(closed), public_reason: commonReason(input.siteExceptions, closed), covers_whole_working_day: len(closed) === total });
    }
    const rest = subtract(workDay, siteExc);
    const absent = intersect(rest, ownExc);
    if (len(absent) > 0) {
      causes.push({ code: 'absence', coverage: len(absent) === total ? 'all' : 'part', minutes: minutes(absent), public_reason: commonReason(input.staffExceptions, absent), covers_whole_working_day: len(absent) === total });
    }
    const left = subtract(rest, ownExc);
    if (len(left) === total) return done('working', 'working', left);
    if (len(left) > 0) return done('partly_working', causes.length === 1 ? (causes[0].code as StatusSummary) : 'multiple', left);
    if (causes.length === 1) return done('not_working', causes[0].code as StatusSummary, [], causes[0].public_reason);
    return done('not_working', 'multiple', []);
  });
}
