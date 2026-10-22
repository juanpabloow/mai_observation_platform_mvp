"use server";

import { revalidatePath } from "next/cache";
import { NO_PERMISSION, canAccessSchedulingSite, canAny } from "./access";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { isUuid } from "./clientModuleValidation";
import { normalizeReason } from "./timeOffValidation";
import { parsePublicReason } from "./publicAbsenceReason";
import { withTransaction } from "@worker/db/client.js";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";
import { getStaffById, listStaff } from "@worker/db/repositories/scheduling/staff.js";
import { listActiveAppointmentsOverlapping } from "@worker/db/repositories/scheduling/appointments.js";
import { recordSchedulingEvent } from "@worker/db/repositories/scheduling/events.js";
import {
  applySeriesOps,
  getOwnerHoursForUpdate,
  getSeries,
  listOverrides,
  listSeries,
  lockOwnerSeries,
  setOwnerHours,
} from "@worker/db/repositories/scheduling/series.js";
import {
  addDays,
  applyOpsInMemory,
  endDateAfterCount,
  expandSeries,
  hhMmToMinutes,
  isLocalDate,
  localMinuteToUtc,
  localToday,
  planDelete,
  planEdit,
  planRoutine,
  splitDayRanges,
  validTimes,
  validWeekdays,
  weekdayOf,
  type EditScope,
  type MinuteRange,
  type PlanError,
  type PlanSummary,
  type ScheduleSeries,
  type SeriesKind,
  type SeriesOp,
  type SeriesOverride,
  type SeriesPatch,
} from "@worker/scheduling/series.js";
import { reviewReasons, type ReviewReason } from "@worker/scheduling/effectiveSchedule.js";
import { WEEKDAY_ORDER } from "@worker/scheduling/timezone.js";
import type { WeeklyHours } from "@worker/scheduling/types.js";

/**
 * RECURRING SCHEDULE — usual breaks, recurring blocks and the weekly hours they live in.
 * The ONE writer of schedule_series (migration 1818); the rules are the pure engine's
 * (src/scheduling/series.ts) and the conflict reading is effectiveSchedule.ts, shared with
 * the calendar, availability (every surface) and the "requires review" flag.
 *
 * PERMISSIONS — the matrix already in main, no new keys (server-side; the UI only hides):
 *   recurring block of ONE professional  agenda.block or hours.manage   (like a dated block)
 *   recurring closure of the SITE         hours.manage                   (like a closure)
 *   a professional's breaks/weekly hours  team.manage                    (like their hours)
 *   the site's breaks/weekly hours        settings.sites or hours.manage (like opening hours)
 * plus the module gate, the client's own site, a professional of that site, and the site
 * scope of the login.
 *
 * CONFLICTS — nothing is ever moved, cancelled or notified. A change that leaves active
 * future appointments inside a break/block or outside the hours returns them (`affected`)
 * WITHOUT writing; the person reschedules each one or confirms explicitly (`confirm`). The
 * policy is the one blocks already have (web/lib/timeOffActions.ts): saving with conflicts
 * needs that explicit confirmation, and the appointments then show "Requiere revisión"
 * (derived, independent of their status) until the conflict is gone.
 *
 * PAST — the cut is the business clock: an occurrence that already started is never
 * modified; "from a date" edits end the row the day before and continue it, so history and
 * the exceptions outside the chosen scope stay exactly as they were.
 */

export interface AffectedAppointment {
  id: string;
  staffId: string;
  staffName: string | null;
  serviceId: string;
  durationMin: number;
  status: string;
  serviceName: string;
  /** Contact name, else the walk-in's typed name, else null (the UI says "Sin contacto"). */
  customerName: string | null;
  startAt: string;
  endAt: string;
  reasons: ReviewReason[];
}

export interface SummaryView extends PlanSummary {
  /** Readable lines: what changes, what is kept. */
  lines: string[];
}

export type ScheduleWriteResult =
  | { ok: true; written: boolean; summary: SummaryView | null; affected: AffectedAppointment[] }
  | { ok: false; error: string; field?: string };

const UNAVAILABLE = "La agenda no está disponible para este cliente.";
const FOREIGN = "No encontrado para este cliente.";
const RETRY = "No se pudo guardar. Tus cambios siguen aquí; vuelve a intentarlo.";
const STAFF_BLOCK = ["agenda.block", "hours.manage"] as const;
const SITE_HOURS = ["settings.sites", "hours.manage"] as const;

const PLAN_ERROR: Record<PlanError, string> = {
  not_an_occurrence: "Esa fecha no pertenece a la serie.",
  occurrence_started: "Esa fecha ya empezó: lo pasado no se modifica. Elige una fecha futura.",
  starts_in_past: "La nueva hora ya pasó. Elige una hora posterior.",
  series_ended: "La serie ya terminó: no quedan fechas futuras.",
  invalid_times: "La hora de fin debe ser posterior a la de inicio.",
  invalid_weekdays: "Elige al menos un día.",
  invalid_end: "La fecha de fin no puede ser anterior a la primera fecha que cambias.",
  scope_not_allowed: "Para cambiar días, motivo o fin elige «Esta y las siguientes» o «Toda la serie futura».",
  no_change: "No hay cambios que guardar.",
};

const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function dateLabel(d: string): string {
  const [, m, day] = d.split("-").map(Number);
  return `${DAY_NAMES[weekdayOf(d)].slice(0, 3)} ${day} ${MONTHS[m - 1]}`;
}

type OwnerKind = "block" | "break";

async function gateOwner(
  clientId: string,
  siteId: string,
  staffId: string | null,
  kind: OwnerKind,
): Promise<
  | { ok: true; tenantId: string; userId: string; site: NonNullable<Awaited<ReturnType<typeof getSiteById>>> }
  | { ok: false; error: string }
> {
  if (!isUuid(siteId) || (staffId !== null && !isUuid(staffId))) return { ok: false, error: FOREIGN };
  const need: readonly string[] =
    kind === "block" ? (staffId ? STAFF_BLOCK : ["hours.manage"]) : staffId ? ["team.manage"] : SITE_HOURS;
  const res = await resolveClientModuleContext(clientId, "scheduling", need as never);
  if (!res.ok) return { ok: false, error: res.forbidden ? NO_PERMISSION : UNAVAILABLE };
  const scope = res.context.scope;
  if (!canAny(scope, need as never, clientId)) return { ok: false, error: NO_PERMISSION };
  if (!canAccessSchedulingSite(scope, siteId)) return { ok: false, error: NO_PERMISSION };
  const site = await getSiteById(scope.tenantId, siteId);
  if (!site || site.client_id !== clientId) return { ok: false, error: FOREIGN };
  if (staffId) {
    const st = await getStaffById(scope.tenantId, staffId);
    if (!st || st.site_id !== siteId) return { ok: false, error: FOREIGN };
  }
  return { ok: true, tenantId: scope.tenantId, userId: scope.userId, site };
}

function revalidate(clientId: string): void {
  revalidatePath(`/clients/${clientId}/scheduling/agenda`);
  revalidatePath(`/clients/${clientId}/scheduling/hours`);
  revalidatePath(`/clients/${clientId}/scheduling/staff`);
}

function summaryView(s: PlanSummary, kindLabel: string): SummaryView {
  const lines: string[] = [];
  if (s.scope === "date" && s.only) {
    lines.push(`Solo el ${dateLabel(s.only)}. Las demás fechas no cambian.`);
  } else {
    lines.push(`Desde el ${dateLabel(s.from)}, ${s.scope === "future" ? "todas las fechas que aún no empiezan" : "esta y las siguientes"}.`);
    if (s.keepsBefore) lines.push(`Lo anterior al ${dateLabel(s.from)} se conserva como estaba, con sus excepciones.`);
    lines.push(`Las fechas excluidas siguen excluidas; los cambios de una sola fecha adoptan el nuevo ${kindLabel}.`);
  }
  return { ...s, lines };
}

// ── affected appointments ────────────────────────────────────────────────────────

const HORIZON_DAYS = 400;

/** Active future appointments of the owner (one professional, or every professional of the
 *  site) that, in the AFTER state, fall inside `blocked` occurrences or — when weekly hours
 *  are given — outside the hours / inside the breaks. Read-only. */
async function affectedAfter(params: {
  tenantId: string;
  clientId: string;
  site: { id: string; timezone: string; opening_hours: WeeklyHours };
  staffId: string | null;
  from: Date;
  /** Occurrences (after state) that remove time: the series being written. */
  series: ScheduleSeries[];
  overrides: SeriesOverride[];
  reason: ReviewReason;
  /** Weekly-hours save: the after-state hours of the owner (site or professional). */
  hours?: { site: WeeklyHours; staff: Map<string, WeeklyHours> } | null;
}): Promise<AffectedAppointment[]> {
  const to = new Date(params.from.getTime() + HORIZON_DAYS * 86_400_000);
  const appts = await listActiveAppointmentsOverlapping(params.tenantId, {
    clientId: params.clientId,
    siteId: params.site.id,
    staffId: params.staffId,
    from: params.from,
    to,
  });
  const future = appts.filter((a) => a.start_at.getTime() >= params.from.getTime());
  if (future.length === 0) return [];
  const tz = params.site.timezone;
  const out: AffectedAppointment[] = [];
  for (const a of future) {
    const day = localToday(a.start_at, tz);
    const occ = expandSeries(params.series, params.overrides, day, day, tz).filter(
      (o) => o.staff_id === null || o.staff_id === a.staff_id,
    );
    const reasons = new Set<ReviewReason>();
    const span = { from: a.start_at, until: a.service_end_at };
    if (occ.some((o) => o.until.getTime() > span.from.getTime() && o.from.getTime() < span.until.getTime())) {
      reasons.add(params.reason);
    }
    if (params.hours) {
      const r = reviewReasons(span, {
        timeZone: tz,
        siteHours: params.hours.site,
        staffHours: params.hours.staff.get(a.staff_id) ?? {},
        breaks: occ.filter((o) => o.kind === "break").map((o) => ({ from: o.from, until: o.until })),
        staffBlocks: [],
        siteBlocks: [],
      });
      for (const x of r) if (x === "outside_hours" || x === "break") reasons.add(x);
    }
    if (reasons.size === 0) continue;
    out.push({
      id: a.id,
      staffId: a.staff_id,
      staffName: a.staff_name,
      serviceId: a.service_id,
      durationMin: a.duration_min,
      status: a.status,
      serviceName: a.service_name,
      customerName: a.contact_name ?? a.guest_name ?? null,
      startAt: a.start_at.toISOString(),
      endAt: a.service_end_at.toISOString(),
      reasons: [...reasons],
    });
  }
  return out;
}

// ── shared input parsing ────────────────────────────────────────────────────────

function minutesOf(v: unknown): number | null {
  return typeof v === "string" ? hhMmToMinutes(v) : null;
}

function parseWeekdays(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const w = [...new Set(v.map(Number))].sort();
  return w.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ? w : null;
}

function parseScope(v: unknown): EditScope | null {
  return v === "date" || v === "following" || v === "future" ? v : null;
}

/** Load one series of this client (tenant + client scoped). */
async function seriesOfClient(tenantId: string, clientId: string, seriesId: string) {
  if (!isUuid(seriesId)) return null;
  const s = await getSeries(tenantId, seriesId);
  return s && s.client_id === clientId ? s : null;
}

/** Gate for an existing series: resolve it via the module context first, then gate by its
 *  real owner (a block of a professional vs. a site closure vs. a break). */
async function gateSeries(clientId: string, seriesId: string) {
  const pre = await resolveClientModuleContext(clientId, "scheduling", [...STAFF_BLOCK, "team.manage", "settings.sites"] as never);
  if (!pre.ok) return { ok: false as const, error: pre.forbidden ? NO_PERMISSION : UNAVAILABLE };
  const s = await seriesOfClient(pre.context.scope.tenantId, clientId, seriesId);
  if (!s) return { ok: false as const, error: FOREIGN };
  const g = await gateOwner(clientId, s.site_id, s.staff_id, s.kind);
  if (!g.ok) return g;
  return { ok: true as const, gate: g, series: s };
}

async function finishWrite(
  g: { tenantId: string; userId: string; site: { id: string; client_id: string } },
  clientId: string,
  ops: SeriesOp[],
  lock: { staffId: string | null; kind: SeriesKind },
  extra?: (tx: import("pg").PoolClient) => Promise<void>,
): Promise<void> {
  await withTransaction(async (tx) => {
    await lockOwnerSeries(tx, g.tenantId, g.site.id, lock.staffId, lock.kind);
    if (extra) await extra(tx);
    await applySeriesOps(tx, { tenantId: g.tenantId, clientId, userId: g.userId }, ops);
  });
  await recordSchedulingEvent({
    tenantId: g.tenantId,
    clientId,
    siteId: g.site.id,
    eventType: "schedule.changed",
    payload: { kind: lock.kind, staff_id: lock.staffId },
  });
  revalidate(clientId);
}

// ── create a recurring block / absence ────────────────────────────────────────────

export interface CreateBlockSeriesInput {
  clientId: string;
  siteId: string;
  /** null = the whole site (a recurring closure). */
  staffId: string | null;
  weekdays: number[];
  allDay: boolean;
  start?: string;
  end?: string;
  startsOn: string;
  endKind: "never" | "on" | "after";
  endsOn?: string | null;
  count?: number | null;
  reason?: string | null;
  publicReason?: string | null;
  confirm?: boolean;
  dryRun?: boolean;
}

export async function createBlockSeriesAction(input: CreateBlockSeriesInput): Promise<ScheduleWriteResult> {
  const staffId = input.staffId ?? null;
  const g = await gateOwner(input.clientId, input.siteId, staffId, "block");
  if (!g.ok) return g;
  const tz = g.site.timezone;
  const weekdays = parseWeekdays(input.weekdays);
  if (!weekdays || !validWeekdays("block", weekdays)) return { ok: false, error: PLAN_ERROR.invalid_weekdays, field: "weekdays" };
  const startMin = input.allDay ? 0 : minutesOf(input.start);
  const endMin = input.allDay ? 1440 : minutesOf(input.end);
  if (startMin === null || endMin === null || !validTimes(startMin, endMin)) return { ok: false, error: PLAN_ERROR.invalid_times, field: "end" };
  if (!isLocalDate(input.startsOn)) return { ok: false, error: "Elige la fecha de inicio.", field: "startsOn" };
  const now = new Date();
  const today = localToday(now, tz);
  if (input.startsOn < today) return { ok: false, error: "La serie no puede empezar en el pasado.", field: "startsOn" };
  let endsOn: string | null = null;
  if (input.endKind === "on") {
    if (!isLocalDate(input.endsOn) || input.endsOn < input.startsOn) return { ok: false, error: "La fecha de fin debe ser igual o posterior al inicio.", field: "endsOn" };
    endsOn = input.endsOn;
  } else if (input.endKind === "after") {
    const n = Number(input.count);
    if (!Number.isInteger(n) || n < 1 || n > 520) return { ok: false, error: "Indica cuántas veces se repite (1 a 520).", field: "count" };
    endsOn = endDateAfterCount(weekdays, input.startsOn, n);
  }
  const publicReason = parsePublicReason(input.publicReason, staffId ? "staff" : "site");
  if (!publicReason.ok) return { ok: false, error: publicReason.error, field: "publicReason" };
  // The first occurrence must not already have started (the past is not rewritten).
  const firstDate = (() => {
    for (let i = 0; i < 14; i++) {
      const d = addDays(input.startsOn, i);
      if (weekdays.includes(weekdayOf(d))) return d;
    }
    return input.startsOn;
  })();
  if (localMinuteToUtc(firstDate, startMin, tz).getTime() <= now.getTime()) {
    return { ok: false, error: "La primera fecha ya empezó. Empieza la serie en una fecha posterior.", field: "startsOn" };
  }

  const fields = {
    site_id: g.site.id,
    staff_id: staffId,
    kind: "block" as const,
    weekdays,
    start_min: startMin,
    end_min: endMin,
    starts_on: input.startsOn,
    ends_on: endsOn,
    reason: normalizeReason(input.reason),
    public_reason: publicReason.value,
  };
  const ops: SeriesOp[] = [{ op: "create", ref: "new", fields, split_from_id: null }];
  const after = applyOpsInMemory([], [], ops);
  const affected = await affectedAfter({
    tenantId: g.tenantId,
    clientId: input.clientId,
    site: g.site,
    staffId,
    from: now,
    series: after.series,
    overrides: after.overrides,
    reason: staffId ? "absence" : "site_closure",
  });
  const summary = summaryView({ scope: "following", from: input.startsOn, only: null, keepsBefore: false }, "bloqueo");
  summary.lines = [describeSeries(fields)];
  if (input.dryRun || (affected.length > 0 && !input.confirm)) return { ok: true, written: false, summary, affected };
  try {
    await finishWrite(g, input.clientId, ops, { staffId, kind: "block" });
  } catch {
    return { ok: false, error: RETRY };
  }
  return { ok: true, written: true, summary, affected };
}

function describeSeries(f: { weekdays: number[]; start_min: number; end_min: number; starts_on: string | null; ends_on: string | null }): string {
  const days = f.weekdays.length === 7 ? "todos los días" : `cada ${f.weekdays.map((d) => DAY_NAMES[d]).join(", ")}`;
  const hours = f.start_min === 0 && f.end_min === 1440 ? "todo el día" : `${hhmm(f.start_min)} – ${hhmm(f.end_min)}`;
  const from = f.starts_on ? `desde el ${dateLabel(f.starts_on)}` : "";
  const to = f.ends_on ? `hasta el ${dateLabel(f.ends_on)}` : "sin fecha de fin";
  return [days, hours, from, to].filter(Boolean).join(" · ");
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// ── edit / delete one series (block or break) with a scope ──────────────────────────

export interface EditSeriesInput {
  clientId: string;
  seriesId: string;
  /** The occurrence the person opened (local date). */
  date: string;
  scope: EditScope;
  start?: string;
  end?: string;
  allDay?: boolean;
  weekdays?: number[];
  /** undefined = keep; null = no end. */
  endsOn?: string | null;
  reason?: string | null;
  publicReason?: string | null;
  confirm?: boolean;
  dryRun?: boolean;
}

export async function editSeriesAction(input: EditSeriesInput): Promise<ScheduleWriteResult> {
  const gs = await gateSeries(input.clientId, input.seriesId);
  if (!gs.ok) return gs;
  const { gate: g, series } = gs;
  const scope = parseScope(input.scope);
  if (!scope || !isLocalDate(input.date)) return { ok: false, error: FOREIGN };
  const tz = g.site.timezone;
  const now = new Date();
  const patch: SeriesPatch = {};
  if (input.allDay) {
    patch.start_min = 0;
    patch.end_min = 1440;
  } else {
    if (input.start !== undefined) {
      const m = minutesOf(input.start);
      if (m === null) return { ok: false, error: PLAN_ERROR.invalid_times, field: "start" };
      patch.start_min = m;
    }
    if (input.end !== undefined) {
      const m = minutesOf(input.end);
      if (m === null) return { ok: false, error: PLAN_ERROR.invalid_times, field: "end" };
      patch.end_min = m;
    }
  }
  if (input.weekdays !== undefined) {
    const w = parseWeekdays(input.weekdays);
    if (!w) return { ok: false, error: PLAN_ERROR.invalid_weekdays, field: "weekdays" };
    if (series.kind === "block" && !sameSet(w, series.weekdays)) patch.weekdays = w;
  }
  if (input.endsOn !== undefined && input.endsOn !== series.ends_on) {
    if (input.endsOn !== null && !isLocalDate(input.endsOn)) return { ok: false, error: PLAN_ERROR.invalid_end, field: "endsOn" };
    patch.ends_on = input.endsOn;
  }
  if (input.reason !== undefined && series.kind === "block") {
    const r = normalizeReason(input.reason);
    if (r !== series.reason) patch.reason = r;
  }
  if (input.publicReason !== undefined && series.kind === "block") {
    const pr = parsePublicReason(input.publicReason, series.staff_id ? "staff" : "site");
    if (!pr.ok) return { ok: false, error: pr.error, field: "publicReason" };
    if (pr.value !== series.public_reason) patch.public_reason = pr.value;
  }

  // A break's "whole future series" is the owner's whole routine: every weekday with a
  // break moves to the new times from its first date not started yet.
  const targets: ScheduleSeries[] =
    series.kind === "break" && scope === "future"
      ? (await listSeries(g.tenantId, g.site.id, { kind: "break", staffIds: series.staff_id ? [series.staff_id] : null, siteWide: series.staff_id ? false : true, fromDate: localToday(now, tz) }))
      : [series];
  const overrides = await listOverrides(g.tenantId, targets.map((t) => t.id));
  const ops: SeriesOp[] = [];
  let summary: PlanSummary | null = null;
  for (const t of targets) {
    const timesOnly: SeriesPatch = t.id === series.id ? patch : { start_min: patch.start_min, end_min: patch.end_min };
    const plan = planEdit({ series: t, overrides, scope, date: input.date, patch: timesOnly, now, timeZone: tz });
    if (!plan.ok) {
      if (t.id !== series.id && plan.error === "no_change") continue;
      return { ok: false, error: PLAN_ERROR[plan.error] };
    }
    ops.push(...plan.ops.map((op) => (op.op === "create" ? { ...op, ref: `${op.ref}-${t.id}` } : op.op === "upsert_override" && "ref" in op.series ? { ...op, series: { ref: `${op.series.ref}-${t.id}` } } : op)));
    if (t.id === series.id || !summary) summary = plan.summary;
  }
  if (ops.length === 0 || !summary) return { ok: false, error: PLAN_ERROR.no_change };

  const all = await listSeries(g.tenantId, g.site.id, { kind: series.kind, staffIds: series.staff_id ? [series.staff_id] : null, siteWide: series.staff_id ? false : true });
  const allOverrides = await listOverrides(g.tenantId, all.map((s) => s.id));
  const after = applyOpsInMemory(all, allOverrides, ops);
  const touched = after.series.filter((s) => after.touched.has(s.id));
  const cutStart = localMinuteToUtc(summary.from, 0, tz);
  const affected = await affectedAfter({
    tenantId: g.tenantId,
    clientId: input.clientId,
    site: g.site,
    staffId: series.staff_id,
    from: new Date(Math.max(now.getTime(), cutStart.getTime())),
    series: touched,
    overrides: after.overrides,
    reason: series.kind === "break" ? "break" : series.staff_id ? "absence" : "site_closure",
  });
  const view = summaryView(summary, series.kind === "break" ? "horario de la pausa" : "horario del bloqueo");
  if (input.dryRun || (affected.length > 0 && !input.confirm)) return { ok: true, written: false, summary: view, affected };
  try {
    await finishWrite(g, input.clientId, ops, { staffId: series.staff_id, kind: series.kind });
  } catch {
    return { ok: false, error: RETRY };
  }
  return { ok: true, written: true, summary: view, affected };
}

function sameSet(a: number[], b: number[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

export async function deleteSeriesAction(input: {
  clientId: string;
  seriesId: string;
  date: string;
  scope: EditScope;
  dryRun?: boolean;
}): Promise<ScheduleWriteResult> {
  const gs = await gateSeries(input.clientId, input.seriesId);
  if (!gs.ok) return gs;
  const { gate: g, series } = gs;
  const scope = parseScope(input.scope);
  if (!scope || !isLocalDate(input.date)) return { ok: false, error: FOREIGN };
  const tz = g.site.timezone;
  const now = new Date();
  const targets: ScheduleSeries[] =
    series.kind === "break" && scope === "future"
      ? await listSeries(g.tenantId, g.site.id, { kind: "break", staffIds: series.staff_id ? [series.staff_id] : null, siteWide: series.staff_id ? false : true, fromDate: localToday(now, tz) })
      : [series];
  const overrides = await listOverrides(g.tenantId, targets.map((t) => t.id));
  const ops: SeriesOp[] = [];
  let summary: PlanSummary | null = null;
  for (const t of targets) {
    const plan = planDelete({ series: t, overrides, scope, date: input.date, now, timeZone: tz });
    if (!plan.ok) {
      if (t.id !== series.id) continue;
      return { ok: false, error: PLAN_ERROR[plan.error] };
    }
    ops.push(...plan.ops);
    if (t.id === series.id || !summary) summary = plan.summary;
  }
  if (ops.length === 0 || !summary) return { ok: false, error: PLAN_ERROR.no_change };
  const view = summaryView(summary, series.kind === "break" ? "horario de la pausa" : "horario del bloqueo");
  view.lines =
    summary.scope === "date"
      ? [`Se excluye el ${dateLabel(summary.from)}. La serie sigue en las demás fechas.`]
      : [`Termina el ${dateLabel(addDays(summary.from, -1))}: desde el ${dateLabel(summary.from)} deja de aplicarse.`, ...(summary.keepsBefore ? ["Las fechas anteriores se conservan en el historial."] : [])];
  if (input.dryRun) return { ok: true, written: false, summary: view, affected: [] };
  try {
    await finishWrite(g, input.clientId, ops, { staffId: series.staff_id, kind: series.kind });
  } catch {
    return { ok: false, error: RETRY };
  }
  return { ok: true, written: true, summary: view, affected: [] };
}

// ── a break that still lives as a gap in the weekly hours ─────────────────────────

/**
 * Turn the gaps of ONE weekday of an owner's weekly hours into break rows (open start, so
 * every past date reads as before) and return the row for the gap the person opened. The
 * weekly hours of that weekday become one span. Same availability before and after: a gap
 * and a break remove exactly the same time. Runs only when someone edits that break.
 */
export async function adoptLegacyBreakAction(input: {
  clientId: string;
  siteId: string;
  staffId: string | null;
  weekday: number;
  start: string;
  end: string;
}): Promise<{ ok: true; seriesId: string } | { ok: false; error: string }> {
  const staffId = input.staffId ?? null;
  const g = await gateOwner(input.clientId, input.siteId, staffId, "break");
  if (!g.ok) return g;
  const wd = Number(input.weekday);
  const s = minutesOf(input.start);
  const e = minutesOf(input.end);
  if (!Number.isInteger(wd) || wd < 0 || wd > 6 || s === null || e === null) return { ok: false, error: FOREIGN };
  try {
    const id = await withTransaction(async (tx) => {
      await lockOwnerSeries(tx, g.tenantId, g.site.id, staffId, "break");
      const hours = await getOwnerHoursForUpdate(tx, g.tenantId, g.site.id, staffId);
      if (!hours) return null;
      const key = WEEKDAY_ORDER[wd];
      const split = splitDayRanges(hours[key] ?? []);
      const gap = split.gaps.find((x) => x.start_min === s && x.end_min === e);
      if (!split.span || !gap) return null;
      const ops: SeriesOp[] = split.gaps.map((x, i) => ({
        op: "create" as const,
        ref: `g${i}`,
        fields: { site_id: g.site.id, staff_id: staffId, kind: "break" as const, weekdays: [wd], start_min: x.start_min, end_min: x.end_min, starts_on: null, ends_on: null, reason: null, public_reason: null },
        split_from_id: null,
      }));
      const created = await applySeriesOps(tx, { tenantId: g.tenantId, clientId: input.clientId, userId: g.userId }, ops);
      await setOwnerHours(tx, g.tenantId, g.site.id, staffId, { ...hours, [key]: [{ start: hhmm(split.span.start_min), end: hhmm(split.span.end_min) }] });
      return created[`g${split.gaps.indexOf(gap)}`];
    });
    if (!id) return { ok: false, error: "Ese horario cambió mientras lo editabas. Vuelve a abrirlo." };
    revalidate(input.clientId);
    return { ok: true, seriesId: id };
  } catch {
    return { ok: false, error: RETRY };
  }
}

// ── weekly hours + usual breaks (one save) ────────────────────────────────────────

export interface WeeklyScheduleInput {
  clientId: string;
  siteId: string;
  /** null = the site's weekly hours. */
  staffId: string | null;
  /** Professional only: true = attends with the site's hours (own hours and breaks end). */
  inherit?: boolean;
  /** Per weekday (0 = Sunday): the working span, or null = closed / day off. */
  days: Array<{ start: string; end: string } | null>;
  /** Per weekday: the usual breaks inside that day's span. */
  breaks: Array<Array<{ start: string; end: string }>>;
  confirm?: boolean;
  dryRun?: boolean;
}

export async function saveWeeklyScheduleAction(input: WeeklyScheduleInput): Promise<ScheduleWriteResult> {
  const staffId = input.staffId ?? null;
  const g = await gateOwner(input.clientId, input.siteId, staffId, "break");
  if (!g.ok) return g;
  if (!Array.isArray(input.days) || input.days.length !== 7 || !Array.isArray(input.breaks) || input.breaks.length !== 7) {
    return { ok: false, error: "Horario incompleto." };
  }
  const tz = g.site.timezone;
  const now = new Date();
  const inherit = staffId !== null && input.inherit === true;

  // Validate and build the new weekly hours + the desired breaks per weekday.
  const hours: Record<string, Array<{ start: string; end: string }>> = {};
  const desired: Partial<Record<number, MinuteRange[]>> = {};
  if (!inherit) {
    for (let wd = 0; wd < 7; wd++) {
      const day = input.days[wd];
      const pauses = input.breaks[wd] ?? [];
      if (!day) {
        if (pauses.length > 0) return { ok: false, error: `El ${DAY_NAMES[wd]} está cerrado: quita sus pausas.`, field: `day-${wd}` };
        continue;
      }
      const s = minutesOf(day.start);
      const e = minutesOf(day.end);
      if (s === null || e === null || !validTimes(s, e)) return { ok: false, error: `Revisa el horario del ${DAY_NAMES[wd]}: el fin debe ser posterior al inicio.`, field: `day-${wd}` };
      const ranges: MinuteRange[] = [];
      for (const p of pauses) {
        const ps = minutesOf(p.start);
        const pe = minutesOf(p.end);
        if (ps === null || pe === null || !validTimes(ps, pe) || ps <= s || pe >= e) {
          return { ok: false, error: `La pausa del ${DAY_NAMES[wd]} debe quedar dentro de su horario.`, field: `break-${wd}` };
        }
        ranges.push({ start_min: ps, end_min: pe });
      }
      ranges.sort((a, b) => a.start_min - b.start_min);
      for (let i = 1; i < ranges.length; i++) {
        if (ranges[i].start_min < ranges[i - 1].end_min) return { ok: false, error: `Las pausas del ${DAY_NAMES[wd]} se cruzan.`, field: `break-${wd}` };
      }
      hours[WEEKDAY_ORDER[wd]] = [{ start: hhmm(s), end: hhmm(e) }];
      desired[wd] = ranges;
    }
    if (staffId === null && Object.keys(hours).length === 0) {
      return { ok: false, error: "La sede debe abrir al menos un día. Para cerrarla unas fechas usa una ausencia o cierre." };
    }
  }

  const run = async (tx: import("pg").PoolClient | null) => {
    const current = tx
      ? await getOwnerHoursForUpdate(tx, g.tenantId, g.site.id, staffId)
      : staffId
        ? ((await getStaffById(g.tenantId, staffId))?.working_hours as Record<string, Array<{ start: string; end: string }>>)
        : (g.site.opening_hours as Record<string, Array<{ start: string; end: string }>>);
    if (!current) return null;
    // Gaps in the hours being replaced are breaks that existed before rows did.
    const legacy: Partial<Record<number, MinuteRange[]>> = {};
    for (let wd = 0; wd < 7; wd++) {
      const gaps = splitDayRanges(current[WEEKDAY_ORDER[wd]] ?? []).gaps;
      if (gaps.length) legacy[wd] = gaps;
    }
    const existing = tx
      ? await lockOwnerSeries(tx, g.tenantId, g.site.id, staffId, "break")
      : await listSeries(g.tenantId, g.site.id, { kind: "break", staffIds: staffId ? [staffId] : null, siteWide: staffId ? false : true });
    const overrides = await listOverrides(g.tenantId, existing.map((s) => s.id));
    const plan = planRoutine({ owner: { site_id: g.site.id, staff_id: staffId }, series: existing, overrides, desired, legacy, now, timeZone: tz });
    return { current, existing, overrides, plan };
  };

  const pre = await run(null);
  if (!pre) return { ok: false, error: FOREIGN };
  if (!pre.plan.ok) return { ok: false, error: PLAN_ERROR[pre.plan.error] };
  const hoursChanged = JSON.stringify(normalizeHours(pre.current)) !== JSON.stringify(normalizeHours(hours));
  if (!hoursChanged && pre.plan.changedWeekdays.length === 0) return { ok: false, error: PLAN_ERROR.no_change };

  // After state → affected appointments (outside the new hours, or inside a new break).
  const after = applyOpsInMemory(pre.existing, pre.overrides, pre.plan.ops);
  const siteHoursAfter = staffId ? (g.site.opening_hours as WeeklyHours) : (hours as WeeklyHours);
  const staffHours = new Map<string, WeeklyHours>();
  const staffRows = await listStaff(g.tenantId, { siteId: g.site.id });
  for (const st of staffRows) staffHours.set(st.id, st.working_hours);
  if (staffId) staffHours.set(staffId, inherit ? {} : (hours as WeeklyHours));
  const siteBreaks = staffId ? await listSeries(g.tenantId, g.site.id, { kind: "break", siteWide: true }) : [];
  const siteBreakOverrides = await listOverrides(g.tenantId, siteBreaks.map((s) => s.id));
  const affected = await affectedAfter({
    tenantId: g.tenantId,
    clientId: input.clientId,
    site: g.site,
    staffId,
    from: now,
    series: [...after.series, ...siteBreaks],
    overrides: [...after.overrides, ...siteBreakOverrides],
    reason: "break",
    hours: { site: siteHoursAfter, staff: staffHours },
  });
  const firstCut = Object.values(pre.plan.cuts).sort()[0] ?? localToday(now, tz);
  const summary: SummaryView = {
    scope: "future",
    from: firstCut,
    only: null,
    keepsBefore: true,
    lines: [
      hoursChanged ? "El horario semanal cambia desde hoy." : "El horario semanal no cambia.",
      pre.plan.changedWeekdays.length
        ? `Las pausas cambian desde ${pre.plan.changedWeekdays.map((d) => `el ${dateLabel(pre.plan.ok ? pre.plan.cuts[d] : firstCut)}`).join(", ")}.`
        : "Las pausas no cambian.",
      "Las fechas pasadas y sus excepciones se conservan.",
    ],
  };
  if (input.dryRun || (affected.length > 0 && !input.confirm)) return { ok: true, written: false, summary, affected };

  try {
    const ok = await withTransaction(async (tx) => {
      const fresh = await run(tx);
      if (!fresh || !fresh.plan.ok) return false;
      // Someone saved in between: the plan is recomputed on the locked rows.
      await applySeriesOps(tx, { tenantId: g.tenantId, clientId: input.clientId, userId: g.userId }, fresh.plan.ops);
      await setOwnerHours(tx, g.tenantId, g.site.id, staffId, inherit ? {} : hours);
      return true;
    });
    if (!ok) return { ok: false, error: RETRY };
  } catch {
    return { ok: false, error: RETRY };
  }
  await recordSchedulingEvent({ tenantId: g.tenantId, clientId: input.clientId, siteId: g.site.id, eventType: "schedule.changed", payload: { kind: "hours", staff_id: staffId } });
  revalidate(input.clientId);
  return { ok: true, written: true, summary, affected };
}

function normalizeHours(h: Record<string, Array<{ start: string; end: string }>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of WEEKDAY_ORDER) {
    const r = h[k];
    if (r && r.length) out[k] = r.map((x) => `${x.start}-${x.end}`).join(",");
  }
  return out;
}

// ── read: everything the editors need for one owner ───────────────────────────────

export interface SeriesView {
  id: string;
  staffId: string | null;
  kind: SeriesKind;
  weekdays: number[];
  start: string;
  end: string;
  startsOn: string | null;
  endsOn: string | null;
  reason: string | null;
  publicReason: string | null;
  /** Local dates with an override, for "tiene excepción" badges. */
  overrides: Array<{ date: string; action: "skip" | "move"; start: string | null; end: string | null }>;
}

/** Series (breaks + recurring blocks) of a site that are still in effect from today, with
 *  their overrides. Gated like the hours page (any of the schedule editors may read). */
export async function listScheduleSeriesAction(
  clientId: string,
  siteId: string,
): Promise<{ ok: true; series: SeriesView[]; today: string } | { ok: false; error: string }> {
  if (!isUuid(siteId)) return { ok: false, error: FOREIGN };
  const need = ["hours.manage", "team.manage", "agenda.block", "settings.sites", "agenda.view"] as const;
  const res = await resolveClientModuleContext(clientId, "scheduling", need as never);
  if (!res.ok) return { ok: false, error: res.forbidden ? NO_PERMISSION : UNAVAILABLE };
  const scope = res.context.scope;
  if (!canAccessSchedulingSite(scope, siteId)) return { ok: false, error: NO_PERMISSION };
  const site = await getSiteById(scope.tenantId, siteId);
  if (!site || site.client_id !== clientId) return { ok: false, error: FOREIGN };
  const today = localToday(new Date(), site.timezone);
  const rows = await listSeries(scope.tenantId, siteId, { fromDate: today });
  const ov = await listOverrides(scope.tenantId, rows.map((r) => r.id), { fromDate: today });
  // A professional login sees only what is its own or the site's — and never the internal reason.
  const restricted = !canAny(scope, ["hours.manage", "team.manage", "agenda.block", "settings.sites"], clientId);
  return {
    ok: true,
    today,
    series: rows.map((r) => seriesView(r, ov, restricted)),
  };
}

function seriesView(r: ScheduleSeries, ov: SeriesOverride[], hideReason: boolean): SeriesView {
  return {
    id: r.id,
    staffId: r.staff_id,
    kind: r.kind,
    weekdays: r.weekdays,
    start: hhmm(r.start_min),
    end: hhmm(r.end_min),
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    reason: hideReason ? null : r.reason,
    publicReason: r.public_reason,
    overrides: ov
      .filter((o) => o.series_id === r.id)
      .map((o) => ({ date: o.occurrence_date, action: o.action, start: o.start_min === null ? null : hhmm(o.start_min), end: o.end_min === null ? null : hhmm(o.end_min) })),
  };
}
