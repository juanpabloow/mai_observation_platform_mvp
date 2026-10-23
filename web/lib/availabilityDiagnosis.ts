/**
 * «Diagnóstico de disponibilidad» — what one weekday looks like for a site, derived from the
 * SAME inputs the engine uses (src/scheduling/availability.ts): the site's ranges ∩ each
 * professional's own ranges (or the site's when they inherit), minus the usual breaks.
 *
 * Every range of the day counts — not only the first (finding E: `opening_hours[dow][0]`
 * hid an afternoon). A gap between two ranges is a break that predates break rows; a break
 * series in effect on that weekday is one too. PURE so it is unit-tested
 * (test/unit/availabilityDiagnosis.test.ts) and the component only renders it.
 */

export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
type Ranges = Array<{ start: string; end: string }>;
export type WeeklyRanges = Partial<Record<string, Ranges>>;

export interface Span {
  start: number;
  end: number;
}

export interface BreakInput {
  /** null = the whole site. */
  staffId: string | null;
  /** 0 = Sunday … 6 = Saturday (schedule_series). */
  weekdays: number[];
  start: string;
  end: string;
  startsOn: string | null;
  endsOn: string | null;
}

export interface StaffDay {
  id: string;
  name: string;
  inherits: boolean;
  /** Bookable spans: site ∩ own hours, minus every break of the day. */
  spans: Span[];
  /** This professional's own breaks (gaps of their ranges + their break series). */
  breaks: Span[];
}

export interface DayDiagnosis {
  /** The site's ranges as configured, merged. */
  siteSpans: Span[];
  /** The site's breaks: gaps between its ranges + site break series. */
  siteBreaks: Span[];
  working: StaffDay[];
  allStaffInactive: boolean;
}

const KEYS: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const toMin = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 1440 ? v : null;
};

export const fmtMin = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const fmtSpans = (spans: Span[]): string => spans.map((s) => `${fmtMin(s.start)}–${fmtMin(s.end)}`).join(" · ");

function merged(ranges: Ranges | undefined): Span[] {
  const list = (ranges ?? [])
    .map((r) => ({ start: toMin(r.start), end: toMin(r.end) }))
    .filter((r): r is Span => r.start !== null && r.end !== null && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

const gapsOf = (spans: Span[]): Span[] => spans.slice(1).map((s, i) => ({ start: spans[i].end, end: s.start }));

function intersect(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  for (const x of a) for (const y of b) {
    const s = Math.max(x.start, y.start);
    const e = Math.min(x.end, y.end);
    if (e > s) out.push({ start: s, end: e });
  }
  return out.sort((p, q) => p.start - q.start);
}

function subtract(spans: Span[], cut: Span[]): Span[] {
  let out = spans;
  for (const c of cut) {
    out = out.flatMap((s) => {
      if (c.end <= s.start || c.start >= s.end) return [s];
      const parts: Span[] = [];
      if (c.start > s.start) parts.push({ start: s.start, end: c.start });
      if (c.end < s.end) parts.push({ start: c.end, end: s.end });
      return parts;
    });
  }
  return out;
}

function union(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** The next local date (YYYY-MM-DD) with weekday `dow`, from `today` inclusive. */
export function nextDateOf(dow: DayKey, today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const delta = (KEYS.indexOf(dow) - base.getUTCDay() + 7) % 7;
  const t = new Date(base.getTime() + delta * 86_400_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

export function diagnoseDay(input: {
  dow: DayKey;
  /** The date the weekday is read for (its next occurrence): which break series apply. */
  date: string;
  siteHours: WeeklyRanges;
  staff: Array<{ id: string; name: string; active: boolean; working_hours: WeeklyRanges | null }>;
  breaks: BreakInput[];
}): DayDiagnosis {
  const wd = KEYS.indexOf(input.dow);
  const live = (b: BreakInput) => b.weekdays.includes(wd) && (b.startsOn === null || b.startsOn <= input.date) && (b.endsOn === null || b.endsOn >= input.date);
  const asSpan = (b: BreakInput): Span[] => {
    const s = toMin(b.start);
    const e = toMin(b.end);
    return s !== null && e !== null && e > s ? [{ start: s, end: e }] : [];
  };
  const siteSpans = merged(input.siteHours[input.dow]);
  const siteBreaks = union([...gapsOf(siteSpans), ...input.breaks.filter((b) => b.staffId === null && live(b)).flatMap(asSpan)]);
  const siteBookable = subtract(siteSpans, siteBreaks);
  const working: StaffDay[] = [];
  for (const st of input.staff) {
    if (!st.active) continue;
    const own = st.working_hours && Object.keys(st.working_hours).length > 0 ? st.working_hours : null;
    const ownSpans = own ? merged(own[input.dow]) : siteSpans;
    if (ownSpans.length === 0) continue;
    const breaks = union([...(own ? gapsOf(ownSpans) : []), ...input.breaks.filter((b) => b.staffId === st.id && live(b)).flatMap(asSpan)]);
    const spans = subtract(intersect(siteBookable, ownSpans), breaks);
    if (spans.length === 0) continue;
    working.push({ id: st.id, name: st.name, inherits: !own, spans, breaks });
  }
  return { siteSpans, siteBreaks, working, allStaffInactive: input.staff.length > 0 && input.staff.every((s) => !s.active) };
}
