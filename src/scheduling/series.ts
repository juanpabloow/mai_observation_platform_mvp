/**
 * RECURRING SCHEDULE ENGINE — usual breaks and recurring blocks (schedule_series) with their
 * per-date overrides. PURE: no DB, no clock (`now` is injected), so the calendar, the
 * availability loader, the "affected appointments" check and the editors all read the SAME
 * rules from here.
 *
 * A series = repeat weekdays + local start/end minutes + first date (NULL = open start) +
 * optional last date, plus overrides per local date: `skip` (excluded date) or `move` (that
 * date only, other times). All dates are LOCAL calendar dates of the SITE ("YYYY-MM-DD"); the
 * cut between past and future is the business timezone's clock: an occurrence whose start is
 * at or before `now` has started — it is past and is never modified.
 *
 * Scopes for an edit/delete chosen from one occurrence D:
 *   date       only D                     → an override of the series (never a 2nd block)
 *   following  D and every later one      → the series is ENDED the day before D and continued
 *   future     every not-yet-started one  → same, cut at the first occurrence not started yet
 * Splitting never rewrites a row's past: the earlier segment keeps its dates and its
 * overrides; in the new segment excluded dates stay excluded and moved dates adopt the new
 * times (they would otherwise silently keep times the person just replaced).
 */
import { localDatesInRange, utcToZonedParts, zonedPartsToUtc } from './timezone.js';

export type SeriesKind = 'break' | 'block';
export type SeriesPublicReason = 'vacation' | 'unavailable' | 'site_closed';
export type EditScope = 'date' | 'following' | 'future';

export interface ScheduleSeries {
  id: string;
  site_id: string;
  staff_id: string | null;
  kind: SeriesKind;
  /** 0 = Sunday … 6 = Saturday (same index as WEEKDAY_ORDER). */
  weekdays: number[];
  start_min: number;
  end_min: number;
  /** NULL = open start (a break that existed before it became a row). */
  starts_on: string | null;
  ends_on: string | null;
  reason: string | null;
  public_reason: SeriesPublicReason | null;
}

export interface SeriesOverride {
  series_id: string;
  occurrence_date: string;
  action: 'skip' | 'move';
  start_min: number | null;
  end_min: number | null;
}

export interface Occurrence {
  series_id: string;
  kind: SeriesKind;
  site_id: string;
  staff_id: string | null;
  date: string;
  start_min: number;
  end_min: number;
  from: Date;
  until: Date;
  /** This date has its own times (an override), not the series' usual ones. */
  moved: boolean;
  reason: string | null;
  public_reason: SeriesPublicReason | null;
}

const MS_PER_MIN = 60_000;
const DAY_MS = 86_400_000;

// ── local-date arithmetic ("YYYY-MM-DD", calendar math only — no timezone involved) ──

const pad = (n: number) => String(n).padStart(2, '0');

export function isLocalDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function toUtcDay(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtcDay(ms: number): string {
  const t = new Date(ms);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function addDays(date: string, n: number): string {
  return fromUtcDay(toUtcDay(date) + n * DAY_MS);
}

export function weekdayOf(date: string): number {
  return new Date(toUtcDay(date)).getUTCDay();
}

export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcDay(b) - toUtcDay(a)) / DAY_MS);
}

/** Today's local date at the site. */
export function localToday(now: Date, timeZone: string): string {
  const p = utcToZonedParts(now, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The UTC instant of a local date + minutes from local midnight (1440 = next midnight),
 *  read exactly like the availability engine reads weekly hours. */
export function localMinuteToUtc(date: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  if (minutes < 1440) {
    return zonedPartsToUtc(y, m, d, Math.floor(minutes / 60), minutes % 60, timeZone);
  }
  const midnight = zonedPartsToUtc(y, m, d, 0, 0, timeZone);
  return new Date(midnight.getTime() + minutes * MS_PER_MIN);
}

export function minutesToHhMm(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

export function hhMmToMinutes(s: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59 || h > 24 || (h === 24 && mi !== 0)) return null;
  return h * 60 + mi;
}

// ── occurrences ──

/** Whether `date` is one of the series' repeat dates (ignoring overrides). */
export function isSeriesDate(series: ScheduleSeries, date: string): boolean {
  if (!series.weekdays.includes(weekdayOf(date))) return false;
  if (series.starts_on !== null && date < series.starts_on) return false;
  if (series.ends_on !== null && date > series.ends_on) return false;
  return true;
}

function overrideIndex(overrides: SeriesOverride[]): Map<string, SeriesOverride> {
  const m = new Map<string, SeriesOverride>();
  for (const o of overrides) m.set(`${o.series_id}|${o.occurrence_date}`, o);
  return m;
}

/** The effective times of one occurrence, or null if `date` is not an occurrence / excluded. */
export function effectiveOccurrence(
  series: ScheduleSeries,
  overrides: SeriesOverride[],
  date: string,
  timeZone: string,
): Occurrence | null {
  if (!isSeriesDate(series, date)) return null;
  const o = overrides.find((x) => x.series_id === series.id && x.occurrence_date === date);
  if (o?.action === 'skip') return null;
  const moved = o?.action === 'move';
  const start = moved ? (o!.start_min as number) : series.start_min;
  const end = moved ? (o!.end_min as number) : series.end_min;
  return {
    series_id: series.id,
    kind: series.kind,
    site_id: series.site_id,
    staff_id: series.staff_id,
    date,
    start_min: start,
    end_min: end,
    from: localMinuteToUtc(date, start, timeZone),
    until: localMinuteToUtc(date, end, timeZone),
    moved,
    reason: series.reason,
    public_reason: series.public_reason,
  };
}

/** Every occurrence on the local dates [fromDate, toDate] (inclusive). */
export function expandSeries(
  series: ScheduleSeries[],
  overrides: SeriesOverride[],
  fromDate: string,
  toDate: string,
  timeZone: string,
): Occurrence[] {
  const idx = overrideIndex(overrides);
  const out: Occurrence[] = [];
  const span = daysBetween(fromDate, toDate);
  for (let i = 0; i <= span && i <= 800; i++) {
    const date = addDays(fromDate, i);
    for (const s of series) {
      if (!isSeriesDate(s, date)) continue;
      const o = idx.get(`${s.id}|${date}`);
      if (o?.action === 'skip') continue;
      const moved = o?.action === 'move';
      const start = moved ? (o!.start_min as number) : s.start_min;
      const end = moved ? (o!.end_min as number) : s.end_min;
      out.push({
        series_id: s.id,
        kind: s.kind,
        site_id: s.site_id,
        staff_id: s.staff_id,
        date,
        start_min: start,
        end_min: end,
        from: localMinuteToUtc(date, start, timeZone),
        until: localMinuteToUtc(date, end, timeZone),
        moved,
        reason: s.reason,
        public_reason: s.public_reason,
      });
    }
  }
  return out;
}

/** Occurrences that overlap the UTC window [from, to). */
export function occurrencesInWindow(
  series: ScheduleSeries[],
  overrides: SeriesOverride[],
  from: Date,
  to: Date,
  timeZone: string,
): Occurrence[] {
  if (series.length === 0 || to.getTime() <= from.getTime()) return [];
  const dates = localDatesInRange(from, to, timeZone);
  if (dates.length === 0) return [];
  const first = `${dates[0].year}-${pad(dates[0].month)}-${pad(dates[0].day)}`;
  const last = dates[dates.length - 1];
  const lastS = `${last.year}-${pad(last.month)}-${pad(last.day)}`;
  return expandSeries(series, overrides, first, lastS, timeZone).filter(
    (o) => o.until.getTime() > from.getTime() && o.from.getTime() < to.getTime(),
  );
}

/** Has the occurrence on `date` already started (business clock)? Uses its effective start. */
export function occurrenceStarted(
  series: ScheduleSeries,
  overrides: SeriesOverride[],
  date: string,
  now: Date,
  timeZone: string,
): boolean {
  const o = overrides.find((x) => x.series_id === series.id && x.occurrence_date === date);
  const start = o?.action === 'move' ? (o.start_min as number) : series.start_min;
  return localMinuteToUtc(date, start, timeZone).getTime() <= now.getTime();
}

/** The first repeat date (excluded ones included) whose occurrence has not started yet. */
export function firstOpenDate(
  series: ScheduleSeries,
  overrides: SeriesOverride[],
  now: Date,
  timeZone: string,
): string | null {
  let date = localToday(now, timeZone);
  if (series.starts_on !== null && series.starts_on > date) date = series.starts_on;
  for (let i = 0; i < 380; i++) {
    const d = addDays(date, i);
    if (series.ends_on !== null && d > series.ends_on) return null;
    if (!isSeriesDate(series, d)) continue;
    if (!occurrenceStarted(series, overrides, d, now, timeZone)) return d;
  }
  return null;
}

/** The last date of a series that ends "after N occurrences", counted from `startsOn`. */
export function endDateAfterCount(weekdays: number[], startsOn: string, count: number): string | null {
  if (count < 1 || weekdays.length === 0) return null;
  let seen = 0;
  for (let i = 0; i < 3700; i++) {
    const d = addDays(startsOn, i);
    if (weekdays.includes(weekdayOf(d))) {
      seen++;
      if (seen === count) return d;
    }
  }
  return null;
}

// ── plans: what an edit/delete with a scope does, as explicit operations ──

export interface SeriesFields {
  site_id: string;
  staff_id: string | null;
  kind: SeriesKind;
  weekdays: number[];
  start_min: number;
  end_min: number;
  starts_on: string | null;
  ends_on: string | null;
  reason: string | null;
  public_reason: SeriesPublicReason | null;
}

export interface SeriesPatch {
  weekdays?: number[];
  start_min?: number;
  end_min?: number;
  ends_on?: string | null;
  reason?: string | null;
  public_reason?: SeriesPublicReason | null;
}

/** `ref` names a series created by this plan, so later ops can point at it. */
export type SeriesOp =
  | { op: 'update'; id: string; set: SeriesPatch }
  | { op: 'end'; id: string; ends_on: string }
  | { op: 'delete'; id: string }
  | { op: 'create'; ref: string; fields: SeriesFields; split_from_id: string | null }
  | { op: 'upsert_override'; series: { id: string } | { ref: string }; date: string; action: 'skip' | 'move'; start_min: number | null; end_min: number | null }
  | { op: 'delete_override'; series_id: string; date: string }
  | { op: 'delete_overrides_from'; series_id: string; from: string; action?: 'skip' | 'move' };

export type PlanError =
  | 'not_an_occurrence'
  | 'occurrence_started'
  | 'starts_in_past'
  | 'series_ended'
  | 'invalid_times'
  | 'invalid_weekdays'
  | 'invalid_end'
  | 'scope_not_allowed'
  | 'no_change';

export type PlanResult =
  | { ok: true; ops: SeriesOp[]; cut: string; summary: PlanSummary }
  | { ok: false; error: PlanError };

/** What the person is told before confirming ("Se conserva … / Cambia …"). */
export interface PlanSummary {
  scope: EditScope;
  /** First local date the change applies to. */
  from: string;
  /** Only D (scope=date) — otherwise null. */
  only: string | null;
  /** Earlier dates of this series that are kept untouched (null = none / open). */
  keepsBefore: boolean;
}

export function fieldsOf(s: ScheduleSeries): SeriesFields {
  return {
    site_id: s.site_id,
    staff_id: s.staff_id,
    kind: s.kind,
    weekdays: [...s.weekdays],
    start_min: s.start_min,
    end_min: s.end_min,
    starts_on: s.starts_on,
    ends_on: s.ends_on,
    reason: s.reason,
    public_reason: s.public_reason,
  };
}

export function validTimes(start: number, end: number): boolean {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= 1440 && end > start;
}

export function validWeekdays(kind: SeriesKind, w: number[]): boolean {
  if (w.length === 0 || w.length > 7) return false;
  if (new Set(w).size !== w.length) return false;
  if (!w.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return false;
  return kind === 'block' || w.length === 1;
}

function sameDays(a: number[], b: number[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

function cutFor(
  series: ScheduleSeries,
  overrides: SeriesOverride[],
  scope: Exclude<EditScope, 'date'>,
  date: string,
  now: Date,
  timeZone: string,
): { ok: true; cut: string } | { ok: false; error: PlanError } {
  if (scope === 'following') {
    if (!isSeriesDate(series, date)) return { ok: false, error: 'not_an_occurrence' };
    if (occurrenceStarted(series, overrides, date, now, timeZone)) return { ok: false, error: 'occurrence_started' };
    return { ok: true, cut: date };
  }
  const cut = firstOpenDate(series, overrides, now, timeZone);
  return cut ? { ok: true, cut } : { ok: false, error: 'series_ended' };
}

/** Edit one series from occurrence `date` with `scope`. */
export function planEdit(params: {
  series: ScheduleSeries;
  overrides: SeriesOverride[];
  scope: EditScope;
  date: string;
  patch: SeriesPatch;
  now: Date;
  timeZone: string;
}): PlanResult {
  const { series, scope, date, patch, now, timeZone } = params;
  const overrides = params.overrides.filter((o) => o.series_id === series.id);

  if (scope === 'date') {
    if (patch.weekdays !== undefined || patch.ends_on !== undefined || patch.reason !== undefined || patch.public_reason !== undefined) {
      return { ok: false, error: 'scope_not_allowed' };
    }
    if (!isSeriesDate(series, date)) return { ok: false, error: 'not_an_occurrence' };
    if (occurrenceStarted(series, overrides, date, now, timeZone)) return { ok: false, error: 'occurrence_started' };
    const current = overrides.find((o) => o.occurrence_date === date);
    const start = patch.start_min ?? (current?.action === 'move' ? (current.start_min as number) : series.start_min);
    const end = patch.end_min ?? (current?.action === 'move' ? (current.end_min as number) : series.end_min);
    if (!validTimes(start, end)) return { ok: false, error: 'invalid_times' };
    if (localMinuteToUtc(date, start, timeZone).getTime() <= now.getTime()) return { ok: false, error: 'starts_in_past' };
    const summary: PlanSummary = { scope, from: date, only: date, keepsBefore: true };
    if (start === series.start_min && end === series.end_min) {
      // Back to the series' usual times: the exception goes away.
      if (!current) return { ok: false, error: 'no_change' };
      if (current.action === 'skip') {
        return { ok: true, cut: date, summary, ops: [{ op: 'delete_override', series_id: series.id, date }] };
      }
      return { ok: true, cut: date, summary, ops: [{ op: 'delete_override', series_id: series.id, date }] };
    }
    if (current?.action === 'move' && current.start_min === start && current.end_min === end) {
      return { ok: false, error: 'no_change' };
    }
    return {
      ok: true,
      cut: date,
      summary,
      ops: [{ op: 'upsert_override', series: { id: series.id }, date, action: 'move', start_min: start, end_min: end }],
    };
  }

  const c = cutFor(series, overrides, scope, date, now, timeZone);
  if (!c.ok) return c;
  const cut = c.cut;
  const next: SeriesFields = { ...fieldsOf(series) };
  if (patch.weekdays !== undefined) next.weekdays = [...patch.weekdays];
  if (patch.start_min !== undefined) next.start_min = patch.start_min;
  if (patch.end_min !== undefined) next.end_min = patch.end_min;
  if (patch.ends_on !== undefined) next.ends_on = patch.ends_on;
  if (patch.reason !== undefined) next.reason = patch.reason;
  if (patch.public_reason !== undefined) next.public_reason = patch.public_reason;
  if (!validTimes(next.start_min, next.end_min)) return { ok: false, error: 'invalid_times' };
  if (!validWeekdays(next.kind, next.weekdays)) return { ok: false, error: 'invalid_weekdays' };
  if (next.ends_on !== null && next.ends_on < cut) return { ok: false, error: 'invalid_end' };
  if (next.kind === 'break') next.public_reason = null;

  const timesChanged =
    next.start_min !== series.start_min || next.end_min !== series.end_min || !sameDays(next.weekdays, series.weekdays);
  const changed =
    timesChanged ||
    next.ends_on !== series.ends_on ||
    next.reason !== series.reason ||
    next.public_reason !== series.public_reason;
  if (!changed) return { ok: false, error: 'no_change' };

  const inScope = overrides.filter((o) => o.occurrence_date >= cut);
  const keepsBefore = series.starts_on === null || series.starts_on < cut;
  const summary: PlanSummary = { scope, from: cut, only: null, keepsBefore };

  if (!keepsBefore) {
    // Nothing of this series is before the cut: edit the row itself.
    const ops: SeriesOp[] = [{ op: 'update', id: series.id, set: patchOf(series, next) }];
    if (timesChanged) ops.push({ op: 'delete_overrides_from', series_id: series.id, from: cut, action: 'move' });
    return { ok: true, cut, summary, ops };
  }

  const ref = 'continuation';
  const ops: SeriesOp[] = [
    { op: 'end', id: series.id, ends_on: addDays(cut, -1) },
    { op: 'create', ref, fields: { ...next, starts_on: cut }, split_from_id: series.id },
  ];
  for (const o of inScope) {
    if (o.action === 'skip' && next.weekdays.includes(weekdayOf(o.occurrence_date))) {
      ops.push({ op: 'upsert_override', series: { ref }, date: o.occurrence_date, action: 'skip', start_min: null, end_min: null });
    } else if (o.action === 'move' && !timesChanged) {
      ops.push({ op: 'upsert_override', series: { ref }, date: o.occurrence_date, action: 'move', start_min: o.start_min, end_min: o.end_min });
    }
  }
  if (inScope.length > 0) ops.push({ op: 'delete_overrides_from', series_id: series.id, from: cut });
  return { ok: true, cut, summary, ops };
}

function patchOf(series: ScheduleSeries, next: SeriesFields): SeriesPatch {
  const set: SeriesPatch = {};
  if (!sameDays(next.weekdays, series.weekdays)) set.weekdays = next.weekdays;
  if (next.start_min !== series.start_min) set.start_min = next.start_min;
  if (next.end_min !== series.end_min) set.end_min = next.end_min;
  if (next.ends_on !== series.ends_on) set.ends_on = next.ends_on;
  if (next.reason !== series.reason) set.reason = next.reason;
  if (next.public_reason !== series.public_reason) set.public_reason = next.public_reason;
  return set;
}

/** Delete one series from occurrence `date` with `scope`. */
export function planDelete(params: {
  series: ScheduleSeries;
  overrides: SeriesOverride[];
  scope: EditScope;
  date: string;
  now: Date;
  timeZone: string;
}): PlanResult {
  const { series, scope, date, now, timeZone } = params;
  const overrides = params.overrides.filter((o) => o.series_id === series.id);
  if (scope === 'date') {
    if (!isSeriesDate(series, date)) return { ok: false, error: 'not_an_occurrence' };
    if (occurrenceStarted(series, overrides, date, now, timeZone)) return { ok: false, error: 'occurrence_started' };
    const current = overrides.find((o) => o.occurrence_date === date);
    if (current?.action === 'skip') return { ok: false, error: 'no_change' };
    return {
      ok: true,
      cut: date,
      summary: { scope, from: date, only: date, keepsBefore: true },
      ops: [{ op: 'upsert_override', series: { id: series.id }, date, action: 'skip', start_min: null, end_min: null }],
    };
  }
  const c = cutFor(series, overrides, scope, date, now, timeZone);
  if (!c.ok) return c;
  const cut = c.cut;
  const keepsBefore = series.starts_on === null || series.starts_on < cut;
  const summary: PlanSummary = { scope, from: cut, only: null, keepsBefore };
  if (!keepsBefore) return { ok: true, cut, summary, ops: [{ op: 'delete', id: series.id }] };
  const ops: SeriesOp[] = [{ op: 'end', id: series.id, ends_on: addDays(cut, -1) }];
  if (overrides.some((o) => o.occurrence_date >= cut)) ops.push({ op: 'delete_overrides_from', series_id: series.id, from: cut });
  return { ok: true, cut, summary, ops };
}

// ── weekly routine of breaks (the weekly-hours editor) ──

export interface MinuteRange {
  start_min: number;
  end_min: number;
}

/**
 * Replace the usual breaks of ONE owner (site or professional) with `desired`, weekday by
 * weekday, from each weekday's first not-yet-started date. `legacy` are breaks that today
 * exist only as gaps in the weekly hours being saved: they become rows with an OPEN start (so
 * every past date reads exactly as before), ended the day before the cut if they change.
 * Unchanged weekdays are left alone (their overrides too).
 */
export function planRoutine(params: {
  owner: { site_id: string; staff_id: string | null };
  series: ScheduleSeries[];
  overrides: SeriesOverride[];
  desired: Partial<Record<number, MinuteRange[]>>;
  legacy: Partial<Record<number, MinuteRange[]>>;
  now: Date;
  timeZone: string;
}): { ok: true; ops: SeriesOp[]; changedWeekdays: number[]; cuts: Record<number, string> } | { ok: false; error: PlanError } {
  const { owner, now, timeZone } = params;
  const today = localToday(now, timeZone);
  const nowLocal = minutesOfDay(now, timeZone);
  const ops: SeriesOp[] = [];
  const changedWeekdays: number[] = [];
  const cuts: Record<number, string> = {};
  let n = 0;
  for (let wd = 0; wd <= 6; wd++) {
    const desired = normalizeRanges(params.desired[wd] ?? []);
    for (const r of desired) if (!validTimes(r.start_min, r.end_min)) return { ok: false, error: 'invalid_times' };
    const legacy = normalizeRanges(params.legacy[wd] ?? []);
    const offset = (wd - weekdayOf(today) + 7) % 7;
    let cut = addDays(today, offset);
    const real = params.series.filter(
      (s) => s.kind === 'break' && s.weekdays[0] === wd && (s.ends_on === null || s.ends_on >= cut),
    );
    // Today's breaks that already started keep today: the routine changes from next week.
    if (offset === 0) {
      const starts = [...real.map((s) => s.start_min), ...legacy.map((r) => r.start_min), ...desired.map((r) => r.start_min)];
      if (starts.some((m) => m <= nowLocal)) cut = addDays(today, 7);
    }
    const active = real.filter((s) => (s.starts_on === null || s.starts_on <= cut) && (s.ends_on === null || s.ends_on >= cut));
    const current = normalizeRanges([...active.map((s) => ({ start_min: s.start_min, end_min: s.end_min })), ...legacy]);
    const same =
      current.length === desired.length && current.every((r, i) => r.start_min === desired[i].start_min && r.end_min === desired[i].end_min);
    const fields = (r: MinuteRange, starts_on: string | null, ends_on: string | null): SeriesFields => ({
      site_id: owner.site_id,
      staff_id: owner.staff_id,
      kind: 'break',
      weekdays: [wd],
      start_min: r.start_min,
      end_min: r.end_min,
      starts_on,
      ends_on,
      reason: null,
      public_reason: null,
    });
    if (same) {
      for (const r of legacy) ops.push({ op: 'create', ref: `r${n++}`, fields: fields(r, null, null), split_from_id: null });
      continue;
    }
    changedWeekdays.push(wd);
    cuts[wd] = cut;
    // Excluded dates of this weekday stay excluded in the new routine.
    const skips = params.overrides.filter(
      (o) => o.action === 'skip' && o.occurrence_date >= cut && active.some((s) => s.id === o.series_id),
    );
    for (const s of real) {
      if (s.starts_on !== null && s.starts_on >= cut) ops.push({ op: 'delete', id: s.id });
      else {
        ops.push({ op: 'end', id: s.id, ends_on: addDays(cut, -1) });
        ops.push({ op: 'delete_overrides_from', series_id: s.id, from: cut });
      }
    }
    for (const r of legacy) ops.push({ op: 'create', ref: `r${n++}`, fields: fields(r, null, addDays(cut, -1)), split_from_id: null });
    for (const r of desired) {
      const ref = `r${n++}`;
      ops.push({ op: 'create', ref, fields: fields(r, cut, null), split_from_id: null });
      for (const sk of skips) ops.push({ op: 'upsert_override', series: { ref }, date: sk.occurrence_date, action: 'skip', start_min: null, end_min: null });
    }
  }
  return { ok: true, ops, changedWeekdays, cuts };
}

function minutesOfDay(now: Date, timeZone: string): number {
  const p = utcToZonedParts(now, timeZone);
  return p.hour * 60 + p.minute;
}

function normalizeRanges(r: MinuteRange[]): MinuteRange[] {
  return [...r].sort((a, b) => a.start_min - b.start_min || a.end_min - b.end_min);
}

/**
 * Split weekly hours that hold several ranges in one day into ONE working span + the gaps
 * between them (the breaks they always meant). `{ "mon": [10–13, 14–20] }` →
 * span 10–20, gap 13–14.
 */
export function splitDayRanges(ranges: Array<{ start: string; end: string }>): { span: MinuteRange | null; gaps: MinuteRange[] } {
  const mins = ranges
    .map((r) => ({ start_min: hhMmToMinutes(r.start), end_min: hhMmToMinutes(r.end) }))
    .filter((r): r is MinuteRange => r.start_min !== null && r.end_min !== null && r.end_min > r.start_min)
    .sort((a, b) => a.start_min - b.start_min);
  if (mins.length === 0) return { span: null, gaps: [] };
  const merged: MinuteRange[] = [];
  for (const r of mins) {
    const last = merged[merged.length - 1];
    if (last && r.start_min <= last.end_min) last.end_min = Math.max(last.end_min, r.end_min);
    else merged.push({ ...r });
  }
  const gaps: MinuteRange[] = [];
  for (let i = 1; i < merged.length; i++) gaps.push({ start_min: merged[i - 1].end_min, end_min: merged[i].start_min });
  return { span: { start_min: merged[0].start_min, end_min: merged[merged.length - 1].end_min }, gaps };
}

// ── in-memory application (previews: "what would the schedule be after this change?") ──

/** Apply a plan to in-memory rows (ids for created series are `new:<ref>`). Pure mirror of
 *  applySeriesOps, used to compute affected appointments BEFORE anything is written. */
export function applyOpsInMemory(
  series: ScheduleSeries[],
  overrides: SeriesOverride[],
  ops: SeriesOp[],
): { series: ScheduleSeries[]; overrides: SeriesOverride[]; touched: Set<string> } {
  let S = series.map((s) => ({ ...s, weekdays: [...s.weekdays] }));
  let O = overrides.map((o) => ({ ...o }));
  const touched = new Set<string>();
  const idOf = (x: { id: string } | { ref: string }) => ('id' in x ? x.id : `new:${x.ref}`);
  for (const op of ops) {
    switch (op.op) {
      case 'create':
        S.push({ id: `new:${op.ref}`, ...op.fields, weekdays: [...op.fields.weekdays] });
        touched.add(`new:${op.ref}`);
        break;
      case 'update':
        S = S.map((s) => (s.id === op.id ? { ...s, ...op.set, weekdays: op.set.weekdays ? [...op.set.weekdays] : s.weekdays } : s));
        touched.add(op.id);
        break;
      case 'end':
        S = S.map((s) => (s.id === op.id ? { ...s, ends_on: op.ends_on } : s));
        touched.add(op.id);
        break;
      case 'delete':
        S = S.filter((s) => s.id !== op.id);
        O = O.filter((o) => o.series_id !== op.id);
        touched.add(op.id);
        break;
      case 'upsert_override': {
        const sid = idOf(op.series);
        O = O.filter((o) => !(o.series_id === sid && o.occurrence_date === op.date));
        O.push({ series_id: sid, occurrence_date: op.date, action: op.action, start_min: op.start_min, end_min: op.end_min });
        touched.add(sid);
        break;
      }
      case 'delete_override':
        O = O.filter((o) => !(o.series_id === op.series_id && o.occurrence_date === op.date));
        touched.add(op.series_id);
        break;
      case 'delete_overrides_from':
        O = O.filter((o) => !(o.series_id === op.series_id && o.occurrence_date >= op.from && (!op.action || o.action === op.action)));
        touched.add(op.series_id);
        break;
    }
  }
  return { series: S, overrides: O, touched };
}
