import { expandSeries } from "@worker/scheduling/series.js";
import type { SeriesView } from "@/lib/scheduleSeriesActions";

/** The occurrence a series editor opens on: the next one that has not started yet (within
 *  ~4 months), with that date's own values when it was moved. Shared by Horarios y ausencias
 *  on the desktop and on the phone, so both open the SAME editor on the same date. */
export interface NextOccurrence {
  seriesId: string;
  kind: "break" | "block";
  staffId: string | null;
  date: string;
  startsAt: string;
  endsAt: string;
  moved: boolean;
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export function nextOccurrence(s: SeriesView, siteId: string, today: string, tz: string, nowMs: number): NextOccurrence | null {
  const row = { id: s.id, site_id: siteId, staff_id: s.staffId, kind: s.kind, weekdays: s.weekdays, start_min: toMin(s.start), end_min: toMin(s.end), starts_on: s.startsOn, ends_on: s.endsOn, reason: s.reason, public_reason: null };
  const ov = s.overrides.map((o) => ({ series_id: s.id, occurrence_date: o.date, action: o.action, start_min: o.start ? toMin(o.start) : null, end_min: o.end ? toMin(o.end) : null }));
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 120));
  const until = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
  const o = expandSeries([row], ov, today, until, tz).find((x) => x.from.getTime() > nowMs);
  return o ? { seriesId: s.id, kind: s.kind, staffId: s.staffId, date: o.date, startsAt: o.from.toISOString(), endsAt: o.until.toISOString(), moved: o.moved } : null;
}

const WD = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
/** «Cada martes, viernes · 17:30–18:30 · hasta 30/11» */
export function seriesWhen(s: SeriesView): string {
  const hours = s.start === "00:00" && s.end === "24:00" ? "todo el día" : `${s.start}–${s.end}`;
  return `Cada ${s.weekdays.map((d) => WD[d]).join(", ")} · ${hours}${s.endsOn ? ` · hasta ${s.endsOn.split("-").reverse().join("/")}` : ""}`;
}
