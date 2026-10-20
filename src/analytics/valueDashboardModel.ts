import { utcToZonedParts, zonedPartsToUtc } from '../scheduling/timezone.js';

/**
 * VALUE DASHBOARD — the pure model (spec v3.1, docs/value-dashboard/ESPECIFICACION.md).
 *
 * No database, no React: the server builds the payload with it and the client re-runs the
 * SAME estimate function for the assumptions preview, so the two can never disagree.
 *
 * Conventions that every function here keeps:
 *  - an UNKNOWN amount is `null`, never 0. A 0 means "measured, and there was none";
 *  - a price is "present" when the appointment HAS a price_snapshot — a $0 snapshot is a
 *    valid, present price (a free service), so presence is counted, never positivity;
 *  - money is list price saved on the appointment (price_snapshot), never money collected:
 *    the schema has no payments.
 */

/* ------------------------------------------------------------------ periods -- */

export type PeriodKey = '7' | '30' | 'custom';
export const PERIOD_MAX_DAYS = 92;

export interface Period {
  key: PeriodKey;
  /** Local calendar days, inclusive: [fromDay, toDay]. */
  fromDay: string;
  toDay: string;
  days: number;
  /** The equally long window right before it (the comparison). */
  prevFromDay: string;
  prevToDay: string;
  /** UTC instants: [startUtc, endUtc) and [prevStartUtc, startUtc). */
  startUtc: string;
  endUtc: string;
  prevStartUtc: string;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" + n calendar days (pure calendar math, no timezone involved). */
export function addDays(day: string, n: number): string {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`invalid day ${day}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return d.toISOString().slice(0, 10);
}

export function daysBetweenInclusive(fromDay: string, toDay: string): number {
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDay}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

export function isValidDay(day: unknown): day is string {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  return addDays(day, 0) === day; // rejects 2026-02-30
}

export function localToday(now: Date, tz: string): string {
  const p = utcToZonedParts(now, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function localMidnightUtc(day: string, tz: string): Date {
  const m = DAY_RE.exec(day)!;
  return zonedPartsToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, tz);
}

export type PeriodInput = { key: PeriodKey; from?: string | null; to?: string | null };
export type PeriodResult = { ok: true; period: Period } | { ok: false; error: string };

/**
 * Resolve a period in the business's timezone. "7 días" / "30 días" end TODAY (local) and
 * include it; a custom period is two local dates, ≤ PERIOD_MAX_DAYS long, not in the future.
 */
export function resolvePeriod(input: PeriodInput, now: Date, tz: string): PeriodResult {
  const today = localToday(now, tz);
  let fromDay: string;
  let toDay: string;
  if (input.key === 'custom') {
    if (!isValidDay(input.from) || !isValidDay(input.to)) return { ok: false, error: 'Elige dos fechas válidas.' };
    fromDay = input.from;
    toDay = input.to;
    if (fromDay > toDay) return { ok: false, error: 'La fecha inicial debe ser anterior a la final.' };
    if (toDay > today) return { ok: false, error: 'El periodo no puede terminar después de hoy.' };
    if (daysBetweenInclusive(fromDay, toDay) > PERIOD_MAX_DAYS) {
      return { ok: false, error: `El periodo puede tener como máximo ${PERIOD_MAX_DAYS} días.` };
    }
    if (fromDay < addDays(today, -730)) return { ok: false, error: 'El periodo no puede empezar hace más de dos años.' };
  } else if (input.key === '7' || input.key === '30') {
    toDay = today;
    fromDay = addDays(today, -(Number(input.key) - 1));
  } else {
    return { ok: false, error: 'Periodo no válido.' };
  }
  const days = daysBetweenInclusive(fromDay, toDay);
  const prevToDay = addDays(fromDay, -1);
  const prevFromDay = addDays(fromDay, -days);
  return {
    ok: true,
    period: {
      key: input.key,
      fromDay,
      toDay,
      days,
      prevFromDay,
      prevToDay,
      startUtc: localMidnightUtc(fromDay, tz).toISOString(),
      endUtc: localMidnightUtc(addDays(toDay, 1), tz).toISOString(),
      prevStartUtc: localMidnightUtc(prevFromDay, tz).toISOString(),
    },
  };
}

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** "2026-09-09" → "9 sep 2026" (the dashboard's date style). */
export function formatDayEs(day: string, withYear = true): string {
  const m = DAY_RE.exec(day);
  if (!m) return day;
  return `${Number(m[3])} ${MONTHS_ES[Number(m[2]) - 1]}${withYear ? ` ${m[1]}` : ''}`;
}

/** Every local day of the period, in order. */
export function periodDays(period: Pick<Period, 'fromDay' | 'days'>): string[] {
  return Array.from({ length: period.days }, (_, i) => addDays(period.fromDay, i));
}

/* ------------------------------------------------------------ money buckets -- */

/**
 * A group of appointments and their saved prices. `value` is the sum of the PRESENT
 * prices; it is null when the group has appointments but none has a price (unknown), and
 * 0 when the group is empty (measured none) or every present price is $0.
 */
export interface Bucket {
  count: number;
  withPrice: number;
  value: number | null;
}

export const EMPTY_BUCKET: Bucket = { count: 0, withPrice: 0, value: 0 };

export function bucket(count: number, withPrice: number, sum: number | null): Bucket {
  if (count === 0) return EMPTY_BUCKET;
  return { count, withPrice, value: withPrice === 0 ? null : (sum ?? 0) };
}

export function addBuckets(...bs: Bucket[]): Bucket {
  let count = 0;
  let withPrice = 0;
  let sum = 0;
  for (const b of bs) {
    count += b.count;
    withPrice += b.withPrice;
    sum += b.value ?? 0;
  }
  return bucket(count, withPrice, sum);
}

export type BucketState = 'zero' | 'unknown' | 'partial' | 'complete';

/** zero = no appointments · unknown = none has a price · partial = some lack one. */
export function bucketState(b: Bucket): BucketState {
  if (b.count === 0) return 'zero';
  if (b.withPrice === 0) return 'unknown';
  if (b.withPrice < b.count) return 'partial';
  return 'complete';
}

export const missingPrices = (b: Bucket): number => b.count - b.withPrice;

/* --------------------------------------------------- channels and outcomes -- */

export type Channel = 'n8n' | 'public' | 'team';
export type Outcome = 'completed' | 'pending' | 'no_show' | 'cancelled';
export const CHANNELS: Channel[] = ['n8n', 'public', 'team'];
export const OUTCOMES: Outcome[] = ['completed', 'pending', 'no_show', 'cancelled'];
export const AUTOMATED: Channel[] = ['n8n', 'public'];

export type ChannelBuckets = Record<Outcome, Bucket>;
export type Lens = Record<Channel, ChannelBuckets>;

/** appointments.origin → channel. internal and walk_in are the team (reference only). */
export function channelOf(origin: string): Channel {
  if (origin === 'n8n') return 'n8n';
  if (origin === 'public') return 'public';
  return 'team';
}

/** appointments.status → outcome. scheduled/confirmed are not yet closed: «pendientes». */
export function outcomeOf(status: string): Outcome {
  if (status === 'completed') return 'completed';
  if (status === 'no_show') return 'no_show';
  if (status === 'cancelled') return 'cancelled';
  return 'pending';
}

export function emptyLens(): Lens {
  const ch = (): ChannelBuckets => ({ completed: EMPTY_BUCKET, pending: EMPTY_BUCKET, no_show: EMPTY_BUCKET, cancelled: EMPTY_BUCKET });
  return { n8n: ch(), public: ch(), team: ch() };
}

/** Fold Q4a/Q4b rows (one per canal × estado) into a Lens. A missing row = 0 measured. */
export function lensFromRows(rows: Array<{ canal: string; estado: string; count: number; withPrice: number; value: number | null }>): Lens {
  const lens = emptyLens();
  for (const r of rows) {
    const c = channelOf(r.canal);
    const o = outcomeOf(r.estado);
    lens[c][o] = addBuckets(lens[c][o], bucket(r.count, r.withPrice, r.value));
  }
  return lens;
}

export function channelTotal(cb: ChannelBuckets, outcomes: Outcome[] = OUTCOMES): Bucket {
  return addBuckets(...outcomes.map((o) => cb[o]));
}

export function automatedTotal(lens: Lens, outcomes: Outcome[] = OUTCOMES): Bucket {
  return addBuckets(...AUTOMATED.map((c) => channelTotal(lens[c], outcomes)));
}

/** Outcomes that make up «valor de reservas creadas»: everything but cancelled. */
export const RESERVED_OUTCOMES: Outcome[] = ['completed', 'pending', 'no_show'];

/* ------------------------------------------------------------------ deltas -- */

export type Delta =
  | { kind: 'pct'; pct: number; prevLabel: string }
  | { kind: 'no_prev_activity'; prevLabel: string }
  | { kind: 'unavailable'; reason: string };

/**
 * Change vs the previous period. Never computed from an unknown or partial amount on
 * either side (that would compare different sets of appointments).
 */
export function deltaOf(
  cur: { value: number | null; exact: boolean },
  prev: { value: number | null; exact: boolean },
  prevLabel: string,
  comparison: { available: boolean; reason: string | null },
): Delta {
  if (!comparison.available) return { kind: 'unavailable', reason: comparison.reason ?? 'Sin comparación disponible' };
  if (cur.value === null || prev.value === null) return { kind: 'unavailable', reason: 'Sin precios guardados: no hay valor que comparar' };
  if (!cur.exact || !prev.exact) return { kind: 'unavailable', reason: 'Sin comparación exacta: faltan precios' };
  if (prev.value === 0) return { kind: 'no_prev_activity', prevLabel };
  return { kind: 'pct', pct: Math.round(((cur.value - prev.value) / prev.value) * 100), prevLabel };
}

/* ------------------------------------------------------------- assumptions -- */

export interface AssumptionValues {
  minConversacionAtendida: number;
  minConversacionConCita: number;
  minAgendarManual: number;
  costoHora: number;
}

export interface AssumptionVersion extends AssumptionValues {
  id: string;
  status: 'proposed' | 'confirmed';
  methodVersion: string;
  effectiveFrom: string;
  proposedBy: string | null;
  proposedAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  basedOnId: string | null;
}

export const ASSUMPTION_LIMITS = { minutesMax: 240, costMax: 100_000_000 } as const;

/** The confirmed versions, most recently confirmed first. */
function confirmedNewestFirst(versions: AssumptionVersion[]): AssumptionVersion[] {
  return versions
    .filter((v) => v.status === 'confirmed' && v.confirmedAt)
    .sort((a, b) => (a.confirmedAt! < b.confirmedAt! ? 1 : a.confirmedAt! > b.confirmedAt! ? -1 : 0));
}

/**
 * The version that applies on `day`: the MOST RECENTLY CONFIRMED one whose effective_from
 * is on or before that day. A later confirmation therefore supersedes earlier ones from
 * its own effective date on — and only from there: it never reaches further back than the
 * date its confirmer chose. null = no estimate for that day.
 */
export function versionForDay(confirmed: AssumptionVersion[], day: string): AssumptionVersion | null {
  for (const v of confirmed) if (v.effectiveFrom <= day) return v;
  return null;
}

/** A proposal newer than every confirmation (what the business still has to look at). */
export function pendingProposal(versions: AssumptionVersion[]): AssumptionVersion | null {
  const lastConfirmed = confirmedNewestFirst(versions)[0]?.confirmedAt ?? null;
  const proposals = versions
    .filter((v) => v.status === 'proposed' && (lastConfirmed === null || v.proposedAt > lastConfirmed))
    .sort((a, b) => (a.proposedAt < b.proposedAt ? 1 : -1));
  return proposals[0] ?? null;
}

/* ---------------------------------------------------------------- estimate -- */

/** Countable units per local day (§4). u1/u2 are null while conversations are disabled. */
export interface UnitDay {
  day: string;
  u1: number | null;
  u2: number | null;
  u3: number;
}

export type EstimateState = 'not_configured' | 'proposed' | 'not_in_effect' | 'confirmed';

export interface EstimateComponent {
  units: number;
  minutes: number;
  /** The minutes per unit when ONE version covers every estimated day, else null. */
  perUnit: number | null;
}

export interface Estimate {
  state: EstimateState;
  /** true when only U3 (booking page) is included because conversations are disabled. */
  publicOnly: boolean;
  minutes: number | null;
  value: number | null;
  /** Days of the period with a confirmed version in effect / days in the period. */
  coveredDays: number;
  totalDays: number;
  firstCoveredDay: string | null;
  u1: EstimateComponent | null;
  u2: EstimateComponent | null;
  u3: EstimateComponent | null;
  /** The single version in effect for every covered day, if there is one. */
  version: AssumptionVersion | null;
  perDayMinutes: Array<{ day: string; minutes: number | null }>;
}

/**
 * Tiempo liberado estimado = U1 × min_conversacion_atendida + U2 × min_conversacion_con_cita
 * + U3 × min_agendar_manual, each DAY with the version in effect that day; valor estimado =
 * Σ horas × costo_hora of that day's version. With conversations disabled only U3 counts and
 * the result says so (publicOnly) — U1/U2 are never shown as 0.
 */
export function computeEstimate(units: UnitDay[], versions: AssumptionVersion[], conversationsEnabled: boolean): Estimate {
  const confirmed = confirmedNewestFirst(versions);
  const base: Estimate = {
    state: 'not_configured',
    publicOnly: !conversationsEnabled,
    minutes: null,
    value: null,
    coveredDays: 0,
    totalDays: units.length,
    firstCoveredDay: null,
    u1: null,
    u2: null,
    u3: null,
    version: null,
    perDayMinutes: units.map((u) => ({ day: u.day, minutes: null })),
  };
  if (confirmed.length === 0) {
    return { ...base, state: versions.some((v) => v.status === 'proposed') ? 'proposed' : 'not_configured' };
  }
  const acc = {
    u1: { units: 0, minutes: 0, rates: new Set<number>() },
    u2: { units: 0, minutes: 0, rates: new Set<number>() },
    u3: { units: 0, minutes: 0, rates: new Set<number>() },
  };
  let minutes = 0;
  let value = 0;
  let covered = 0;
  let first: string | null = null;
  const used = new Set<string>();
  const perDay: Array<{ day: string; minutes: number | null }> = [];
  for (const u of units) {
    const v = versionForDay(confirmed, u.day);
    if (!v) {
      perDay.push({ day: u.day, minutes: null });
      continue;
    }
    covered++;
    first ??= u.day;
    used.add(v.id);
    let m = u.u3 * v.minAgendarManual;
    acc.u3.units += u.u3;
    acc.u3.minutes += u.u3 * v.minAgendarManual;
    acc.u3.rates.add(v.minAgendarManual);
    if (conversationsEnabled) {
      const u1 = u.u1 ?? 0;
      const u2 = u.u2 ?? 0;
      m += u1 * v.minConversacionAtendida + u2 * v.minConversacionConCita;
      acc.u1.units += u1;
      acc.u1.minutes += u1 * v.minConversacionAtendida;
      acc.u1.rates.add(v.minConversacionAtendida);
      acc.u2.units += u2;
      acc.u2.minutes += u2 * v.minConversacionConCita;
      acc.u2.rates.add(v.minConversacionConCita);
    }
    minutes += m;
    value += (m / 60) * v.costoHora;
    perDay.push({ day: u.day, minutes: m });
  }
  if (covered === 0) return { ...base, state: 'not_in_effect', version: confirmed[0] };
  const comp = (a: { units: number; minutes: number; rates: Set<number> }): EstimateComponent => ({
    units: a.units,
    minutes: a.minutes,
    perUnit: a.rates.size === 1 ? [...a.rates][0] : null,
  });
  return {
    ...base,
    state: 'confirmed',
    minutes,
    value: Math.round(value),
    coveredDays: covered,
    firstCoveredDay: first,
    u1: conversationsEnabled ? comp(acc.u1) : null,
    u2: conversationsEnabled ? comp(acc.u2) : null,
    u3: comp(acc.u3),
    version: used.size === 1 ? confirmed.find((v) => used.has(v.id)) ?? null : null,
    perDayMinutes: perDay,
  };
}

/* ------------------------------------------------------- the payload shape -- */

export type Franja = 'antes_de_abrir' | 'despues_de_cerrar' | 'dia_sin_atencion' | 'en_pausa' | 'dentro' | 'sin_horario';

export type Q9Estado =
  | 'no_conversacional'
  | 'sin_ejecuciones_para_contrastar'
  | 'sin_mapeos_configurados'
  | 'mapeos_sin_turnos'
  | 'muestra_insuficiente'
  | 'por_debajo_del_umbral'
  | 'contraste_suficiente';

export interface EvidenceWorkflow {
  id: string;
  name: string | null;
  conversational: boolean;
  estado: Q9Estado;
  ejecuciones: number;
  mensajesReportados: number;
  turnos: number;
  pConversacion: number | null;
  pMensajeCliente: number | null;
  pRespuestaBot: number | null;
  /** Q1b: the conversation roles configured (only for workflows Q1b lists). */
  rolesConfigurados: string[] | null;
}

export type EvidenceReason = 'no_conversational' | 'contrast_insufficient' | 'no_review' | 'review_rejected' | 'review_stale' | null;

export interface Evidence {
  /** Q9 habilitable for this client and period. */
  habilitable: boolean;
  hasConversational: boolean;
  review: { status: 'approved' | 'rejected'; reviewedAt: string; methodVersion: string; coversAll: boolean } | null;
  /** habilitable AND an approved review that covers every conversational workflow. */
  enabled: boolean;
  reason: EvidenceReason;
  workflows: EvidenceWorkflow[];
  params: { ventana: string; tolerancia: string; umbral: number; minimo: number; methodVersion: string };
}

export interface ConversationClasses {
  conIntervencionHumana: number;
  conIntervencionHumanaYCitaBot: number;
  u2CitaBot: number;
  enCurso: number;
  u1RespondidaPorBot: number;
  conTurnosSinRespuesta: number;
}

export interface TurnStats {
  turnos: number;
  respondidosPorBot: number;
  respondidosPorPersona: number;
  respuestaTardia: number;
  sinRespuestaObservable: number;
  enCurso: number;
  medianaBotS: number | null;
  p90BotS: number | null;
}

export interface CohortRow {
  origen: string;
  clientesNuevos: number;
  completadas: number;
  completadasSinPrecio: number;
  /** 0 = none completed · null = completed but none priced · partial when some lack it. */
  valor: number | null;
}

export interface ValueDashboardData {
  generatedAt: string;
  tz: string;
  client: { id: string; name: string };
  sites: Array<{ id: string; name: string }>;
  viewer: 'owner' | 'agency';
  canPropose: boolean;
  canConfirm: boolean;
  period: Period;
  /** When the scheduling records of this client start (its first site), if any. */
  schedulingSince: string | null;
  comparison: { available: boolean; reason: string | null };
  /** Set when the period starts before the scheduling records do. */
  coverage: { coveredDays: number; since: string } | null;
  created: Lens;
  dated: Lens;
  prevCreated: Lens;
  prevDated: Lens;
  daily: Array<{ day: string; created: number; reserved: Bucket; completed: Bucket }>;
  outOfHours: Record<Franja, number>;
  botActions: { rescheduled: number; cancelled: number; confirmed: number };
  cohort: { tracking: { startedAt: string | null; effectiveStart: string | null; partial: boolean } | null; rows: CohortRow[] };
  health: { executions: number; errors: number; workflows: Array<{ id: string; name: string | null; executions: number; errors: number }> };
  evidence: Evidence;
  conversations: { classes: ConversationClasses; turns: TurnStats } | null;
  units: UnitDay[];
  prevUnits: UnitDay[];
  assumptions: { versions: AssumptionVersion[]; people: Record<string, string> };
}
