/**
 * CONFIGURACIÓN · MÓVIL — the pure helpers behind the phone screens of the scheduling
 * settings (sedes, horarios, bloqueos, reglas). No React and no imports from the app, so
 * they are unit-tested on their own (test/unit/configMobileLogic.test.ts) and shared by
 * the desktop hours grid where it needs the same lossless conversion.
 */

export interface Range {
  start: string;
  end: string;
}

/** One weekday as the editor shows it: open/closed, the outer hours, and the PAUSES
 *  (the gaps between the day's stored intervals). Lossless both ways. */
export interface DayHours {
  on: boolean;
  start: string;
  end: string;
  pauses: Range[];
}

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_SHORT: Record<string, string> = { mon: "Lun", tue: "Mar", wed: "Mié", thu: "Jue", fri: "Vie", sat: "Sáb", sun: "Dom" };
export const WEEKDAY_LONG: Record<string, string> = {
  mon: "Lunes",
  tue: "Martes",
  wed: "Miércoles",
  thu: "Jueves",
  fri: "Viernes",
  sat: "Sábado",
  sun: "Domingo",
};
/** Sunday-first, as `Date#getUTCDay()` counts. */
const WD_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const MONTH_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export const toMin = (hm: string): number => {
  const [h, m] = hm.split(":").map((x) => Number(x));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};
export const fromMin = (min: number): string => {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// ── Weekly hours ──────────────────────────────────────────────────────────────────

const CLOSED: DayHours = { on: false, start: "09:00", end: "18:00", pauses: [] };

/** Stored intervals of one day → the editor's day (outer hours + pauses). */
export function dayFromIntervals(list: Range[] | undefined | null): DayHours {
  const sorted = [...(list ?? [])].filter((r) => r && r.start && r.end).sort((a, b) => toMin(a.start) - toMin(b.start));
  if (sorted.length === 0) return { ...CLOSED, pauses: [] };
  const pauses: Range[] = [];
  let end = sorted[0].end;
  for (const r of sorted.slice(1)) {
    if (toMin(r.start) > toMin(end)) pauses.push({ start: end, end: r.start });
    if (toMin(r.end) > toMin(end)) end = r.end;
  }
  return { on: true, start: sorted[0].start, end, pauses };
}

/** The pauses that really fall inside the day, in order, without overlaps. */
function innerPauses(d: DayHours): Range[] {
  const s = toMin(d.start);
  const e = toMin(d.end);
  return [...d.pauses]
    .filter((p) => toMin(p.start) > s && toMin(p.end) < e && toMin(p.end) > toMin(p.start))
    .sort((a, b) => toMin(a.start) - toMin(b.start))
    .filter((p, i, all) => i === 0 || toMin(p.start) >= toMin(all[i - 1].end));
}

/** The editor's day → the stored intervals (the pauses cut the day). */
export function intervalsFromDay(d: DayHours): Range[] {
  if (!d.on || toMin(d.end) <= toMin(d.start)) return [];
  const out: Range[] = [];
  let cursor = d.start;
  for (const p of innerPauses(d)) {
    out.push({ start: cursor, end: p.start });
    cursor = p.end;
  }
  out.push({ start: cursor, end: d.end });
  return out;
}

export function weekFromStored(hours: Partial<Record<string, Range[]>> | null | undefined): Record<string, DayHours> {
  return Object.fromEntries(WEEKDAYS.map((d) => [d, dayFromIntervals(hours?.[d])]));
}
export function storedFromWeek(week: Record<string, DayHours>): Partial<Record<Weekday, Range[]>> {
  const out: Partial<Record<Weekday, Range[]>> = {};
  for (const d of WEEKDAYS) {
    const list = intervalsFromDay(week[d] ?? CLOSED);
    if (list.length > 0) out[d] = list;
  }
  return out;
}

/** What is wrong with one open day, in words — null when it is fine. */
export function dayError(d: DayHours): string | null {
  if (!d.on) return null;
  const s = toMin(d.start);
  const e = toMin(d.end);
  if (e <= s) return "El cierre debe ser después de la apertura.";
  const sorted = [...d.pauses].sort((a, b) => toMin(a.start) - toMin(b.start));
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (toMin(p.end) <= toMin(p.start)) return "La pausa debe terminar después de empezar.";
    if (toMin(p.start) <= s || toMin(p.end) >= e) return "La pausa debe quedar dentro del horario del día.";
    if (i > 0 && toMin(p.start) < toMin(sorted[i - 1].end)) return "Las pausas no pueden solaparse.";
  }
  return null;
}

/** A sensible new pause: 13:00–14:00 when it fits, else one hour (or half) in the middle
 *  of the longest free stretch. null when the day has no room for one. */
export function suggestPause(d: DayHours): Range | null {
  const s = toMin(d.start);
  const e = toMin(d.end);
  const taken = [...d.pauses].sort((a, b) => toMin(a.start) - toMin(b.start));
  const free: Array<[number, number]> = [];
  let cursor = s;
  for (const p of taken) {
    if (toMin(p.start) > cursor) free.push([cursor, toMin(p.start)]);
    cursor = Math.max(cursor, toMin(p.end));
  }
  if (e > cursor) free.push([cursor, e]);
  const lunch = free.find(([a, b]) => a < 780 && b > 840);
  if (lunch) return { start: "13:00", end: "14:00" };
  const best = free.sort((x, y) => y[1] - y[0] - (x[1] - x[0]))[0];
  if (!best) return null;
  const room = best[1] - best[0];
  const len = room > 120 ? 60 : room > 60 ? 30 : 0;
  if (len === 0) return null;
  const mid = Math.round((best[0] + best[1]) / 2 / 30) * 30;
  const start = Math.max(best[0] + 30, Math.min(mid - len / 2, best[1] - 30 - len));
  return { start: fromMin(start), end: fromMin(start + len) };
}

/** "09:00 – 19:00" + its pauses, for one stored day. */
export function daySummary(list: Range[] | undefined | null): { open: boolean; value: string; pauses: string[] } {
  const d = dayFromIntervals(list);
  if (!d.on) return { open: false, value: "Cerrado", pauses: [] };
  return { open: true, value: `${d.start} – ${d.end}`, pauses: d.pauses.map((p) => `Pausa ${p.start} – ${p.end}`) };
}

/** "Lun – Sáb", "Lun, Mié, Vie", "Todos los días" or "Sin horario" — the open days. */
export function openDaysSummary(hours: Partial<Record<string, Range[]>> | null | undefined): string {
  const open = WEEKDAYS.map((d) => (hours?.[d]?.length ?? 0) > 0);
  const count = open.filter(Boolean).length;
  if (count === 0) return "Sin horario";
  if (count === 7) return "Todos los días";
  const first = open.indexOf(true);
  const last = open.lastIndexOf(true);
  const contiguous = open.slice(first, last + 1).every(Boolean);
  if (contiguous && count >= 3) return `${WEEKDAY_SHORT[WEEKDAYS[first]]} – ${WEEKDAY_SHORT[WEEKDAYS[last]]}`;
  return WEEKDAYS.filter((_, i) => open[i]).map((d) => WEEKDAY_SHORT[d]).join(", ");
}

/** Half-hour steps for the hour selects, plus any value already stored (so a 09:15 is
 *  never silently rounded away). */
export function timeOptions(extra: string[] = []): string[] {
  const set = new Set<string>();
  for (let m = 5 * 60; m <= 23 * 60 + 30; m += 30) set.add(fromMin(m));
  for (const v of extra) if (/^\d{2}:\d{2}$/.test(v)) set.add(v);
  return [...set].sort((a, b) => toMin(a) - toMin(b));
}

// ── Site fields ───────────────────────────────────────────────────────────────────

/** The same rule createSiteAction enforces. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

const CITY_ES: Record<string, string> = {
  Bogota: "Bogotá",
  Mexico_City: "Ciudad de México",
  Sao_Paulo: "São Paulo",
  New_York: "Nueva York",
  Los_Angeles: "Los Ángeles",
  Panama: "Panamá",
  Asuncion: "Asunción",
};

/** "Bogotá (GMT-5)" for an IANA zone; the raw id when the runtime does not know it. */
export function tzLabel(tz: string, at: Date = new Date()): string {
  const raw = tz.split("/").pop() ?? tz;
  const city = CITY_ES[raw] ?? raw.replace(/_/g, " ");
  try {
    const off = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    return off ? `${city} (${off === "GMT" ? "GMT+0" : off})` : city;
  } catch {
    return tz;
  }
}

/** Zones offered first in the select; every other IANA zone follows. */
export const COMMON_ZONES = [
  "America/Bogota",
  "America/Mexico_City",
  "America/Lima",
  "America/Guayaquil",
  "America/Panama",
  "America/Caracas",
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "America/New_York",
  "Europe/Madrid",
];

// ── Dates in a site's zone ────────────────────────────────────────────────────────

export interface Zoned {
  /** YYYY-MM-DD */
  key: string;
  y: number;
  m: number;
  d: number;
  /** minutes from local midnight */
  min: number;
}

export function zonedParts(at: Date | string, tz: string): Zoned {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(typeof at === "string" ? new Date(at) : at);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? "0");
  const y = get("year");
  const m = get("month");
  const d = get("day");
  return { key: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, y, m, d, min: get("hour") * 60 + get("minute") };
}

/** YYYY-MM-DD ± n days (calendar arithmetic, zone-free). */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}
function keyParts(key: string): { y: number; m: number; d: number; wd: number } {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d, wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}
/** "9 oct" (+ year when it is not the reference year). */
export function shortDate(key: string, refYear?: number): string {
  const p = keyParts(key);
  return `${p.d} ${MONTH_SHORT[p.m - 1]}${refYear && refYear !== p.y ? ` ${p.y}` : ""}`;
}
/** "Lun 12 oct". */
export function dayLabel(key: string, todayKey: string): string {
  if (key === todayKey) return "Hoy";
  if (key === addDays(todayKey, 1)) return "Mañana";
  const p = keyParts(key);
  return `${WD_SHORT[p.wd]} ${shortDate(key, keyParts(todayKey).y)}`;
}

// ── Blocks (schedule_exceptions) ──────────────────────────────────────────────────

export interface BlockSpan {
  starts_at: string;
  ends_at: string;
}

/** True when the block covers whole local days (midnight to midnight). */
export function isAllDay(b: BlockSpan, tz: string): boolean {
  const s = zonedParts(b.starts_at, tz);
  const e = zonedParts(b.ends_at, tz);
  return s.min === 0 && e.min === 0 && e.key > s.key;
}

/** "Hoy · 13:00 – 14:00", "Lun 12 – vie 16 oct · todo el día", in the SITE's zone. */
export function blockWhen(b: BlockSpan, tz: string, todayKey: string): string {
  const s = zonedParts(b.starts_at, tz);
  const e = zonedParts(b.ends_at, tz);
  const year = keyParts(todayKey).y;
  if (isAllDay(b, tz)) {
    const last = addDays(e.key, -1);
    if (last === s.key) return `${dayLabel(s.key, todayKey)} · todo el día`;
    const a = keyParts(s.key);
    const z = keyParts(last);
    const left = a.m === z.m && a.y === z.y ? `${WD_SHORT[a.wd]} ${a.d}` : dayLabel(s.key, "");
    const right = `${WD_SHORT[z.wd].toLowerCase()} ${shortDate(last, year)}`;
    return `${s.key === todayKey ? "Hoy" : left} – ${right} · todo el día`;
  }
  if (s.key === e.key) return `${dayLabel(s.key, todayKey)} · ${fromMin(s.min)} – ${fromMin(e.min)}`;
  return `${dayLabel(s.key, todayKey)} ${fromMin(s.min)} – ${dayLabel(e.key, todayKey).toLowerCase()} ${fromMin(e.min)}`;
}

export interface BlockDraft {
  siteId: string;
  scope: "site" | "staff";
  staffId: string;
  from: string;
  to: string;
  allDay: boolean;
  h1: string;
  h2: string;
  reason: string;
  /** What a customer may be told — chosen explicitly; NO template ever sets it. */
  publicReason: "vacation" | "unavailable" | "site_closed" | null;
  /** The template that prefilled the form, if any (shown, never saved by itself). */
  tpl: string | null;
}

export const BLOCK_TEMPLATES = ["Almuerzo", "Vacaciones", "Festivo", "Capacitación"] as const;

/** An empty draft, or one PREFILLED from a template — never saved on its own. */
export function blockDraft(siteId: string, todayKey: string, tpl: string | null = null): BlockDraft {
  const base: BlockDraft = { siteId, scope: "site", staffId: "", from: todayKey, to: todayKey, allDay: true, h1: "09:00", h2: "10:00", reason: "", publicReason: null, tpl: null };
  const tomorrow = addDays(todayKey, 1);
  switch (tpl) {
    case "Almuerzo":
      return { ...base, tpl, reason: "Almuerzo", allDay: false, h1: "13:00", h2: "14:00" };
    case "Vacaciones":
      return { ...base, tpl, reason: "Vacaciones", scope: "staff", from: tomorrow, to: addDays(tomorrow, 4) };
    case "Festivo":
      return { ...base, tpl, reason: "Festivo", from: tomorrow, to: tomorrow };
    case "Capacitación":
      return { ...base, tpl, reason: "Capacitación", from: tomorrow, to: tomorrow, allDay: false, h1: "08:00", h2: "10:00" };
    default:
      return base;
  }
}

export type BlockPayload =
  | { ok: true; startsAt: string; endsAt: string }
  | { ok: false; field: "dates" | "hours" | "staff" | "site"; error: string };

/** The draft → the wall-clock pair createExceptionAction expects (anchored server-side
 *  to the SITE's zone). An all-day range ends at midnight after its last day. */
export function blockPayload(d: BlockDraft): BlockPayload {
  if (!d.siteId) return { ok: false, field: "site", error: "Elige la sede." };
  if (d.scope === "staff" && !d.staffId) return { ok: false, field: "staff", error: "Elige el profesional." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.from) || !/^\d{4}-\d{2}-\d{2}$/.test(d.to)) return { ok: false, field: "dates", error: "Elige las fechas." };
  if (d.to < d.from) return { ok: false, field: "dates", error: "La fecha final no puede ser anterior a la inicial." };
  if (d.allDay) return { ok: true, startsAt: `${d.from}T00:00`, endsAt: `${addDays(d.to, 1)}T00:00` };
  const startsAt = `${d.from}T${d.h1}`;
  const endsAt = `${d.to}T${d.h2}`;
  if (endsAt <= startsAt) return { ok: false, field: "hours", error: "La hora final debe ser posterior a la de inicio." };
  return { ok: true, startsAt, endsAt };
}

// ── Booking rules (sites.scheduling_config) ───────────────────────────────────────

export type RuleKey = "min_notice_min" | "booking_horizon_days" | "slot_interval_min";
export const RULE_KEYS: RuleKey[] = ["min_notice_min", "booking_horizon_days", "slot_interval_min"];
export const RULE_TITLE: Record<RuleKey, string> = {
  min_notice_min: "Anticipación mínima",
  booking_horizon_days: "Reservar con hasta",
  slot_interval_min: "Intervalo entre horarios",
};
export const RULE_DESC: Record<RuleKey, string> = {
  min_notice_min: "Cuánto antes debe hacerse una reserva.",
  booking_horizon_days: "Hasta qué fecha futura se puede reservar.",
  slot_interval_min: "Cada cuánto se ofrecen horarios.",
};
const RULE_PRESETS: Record<RuleKey, number[]> = {
  min_notice_min: [0, 30, 60, 120, 240, 1440],
  booking_horizon_days: [7, 14, 30, 60, 90, 180],
  slot_interval_min: [10, 15, 20, 30, 45, 60],
};

/** The preset values, plus the stored one when it is not a preset (never hidden). */
export function ruleOptions(key: RuleKey, current: number): number[] {
  return [...new Set([...RULE_PRESETS[key], current])].sort((a, b) => a - b);
}

export function ruleLabel(key: RuleKey, v: number): string {
  if (key === "booking_horizon_days") return plural(v, "día", "días");
  if (key === "slot_interval_min") return `${v} min`;
  if (v === 0) return "Sin mínimo";
  if (v < 60) return `${v} min`;
  const h = Math.floor(v / 60);
  const m = v % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** A concrete example of what the value means — changes live with the value. */
export function ruleExample(key: RuleKey, v: number, ctx: { todayKey: string; firstOpen: string }): string {
  if (key === "min_notice_min") {
    if (v === 0) return "Ej.: si son las 10:00, se puede reservar desde las 10:00.";
    const at = 600 + v;
    const days = Math.floor(at / 1440);
    const time = fromMin(at % 1440);
    if (days === 0) return `Ej.: si son las 10:00, el primer horario reservable es a partir de las ${time}.`;
    if (days === 1) return `Ej.: si son las 10:00, se puede reservar desde mañana a las ${time}.`;
    return `Ej.: si son las 10:00, se puede reservar desde dentro de ${days} días a las ${time}.`;
  }
  if (key === "booking_horizon_days") {
    const year = Number(ctx.todayKey.slice(0, 4));
    return `Ej.: hoy (${shortDate(ctx.todayKey)}) se puede reservar hasta el ${shortDate(addDays(ctx.todayKey, v), year)}.`;
  }
  // The engine aligns the grid to local midnight, so the first start is the first
  // multiple of the interval at or after opening.
  const open = toMin(ctx.firstOpen);
  const first = Math.ceil(open / v) * v;
  return `Ej.: ${[0, 1, 2, 3].map((i) => fromMin(first + i * v)).join(", ")}…`;
}

/** The earliest opening time of a site's week (for the interval example). */
export function firstOpening(hours: Partial<Record<string, Range[]>> | null | undefined): string {
  let best: number | null = null;
  for (const d of WEEKDAYS) for (const r of hours?.[d] ?? []) if (best === null || toMin(r.start) < best) best = toMin(r.start);
  return best === null ? "09:00" : fromMin(best);
}

// ── Prices ────────────────────────────────────────────────────────────────────────

/** "60000" → "60.000" for the COP input (digits only). */
export function formatThousands(digits: string): string {
  const clean = digits.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return clean.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
