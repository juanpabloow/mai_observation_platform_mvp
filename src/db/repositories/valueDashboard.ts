import { query } from '../client.js';
import { VALUE_DASHBOARD_SQL } from './valueDashboardSql.js';
import {
  addBuckets,
  bucket,
  EMPTY_BUCKET,
  lensFromRows,
  periodDays,
  RESERVED_OUTCOMES,
  outcomeOf,
  localToday,
  daysBetweenInclusive,
  formatDayEs,
  type AssumptionVersion,
  type Bucket,
  type CohortRow,
  type ConversationClasses,
  type Evidence,
  type EvidenceWorkflow,
  type Franja,
  type Period,
  type Q9Estado,
  type TurnStats,
  type UnitDay,
  type ValueDashboardData,
} from '../../analytics/valueDashboardModel.js';

/**
 * VALUE DASHBOARD — server-side aggregation (spec v3.1). Every number the dashboard shows is
 * computed HERE, in PostgreSQL, from the tagged queries in valueDashboardSql.ts; the browser
 * only receives aggregates (rows per channel × status, ≤ 92 daily points, per-workflow
 * evidence) — never appointment, message or execution histories.
 *
 * Isolation: every query is filtered by BOTH tenant_id and client_id (executions by an
 * explicit tenant filter too — §1). The caller (web/lib/valueDashboardAccess.ts) has already
 * checked the session may see this client's insights; these functions trust only the ids it
 * passes, never anything from the URL.
 *
 * Cost: two bounded batches. Batch 1 is the always-available metrics (appointments, health)
 * plus the evidence gate (Q9, Q1b); batch 2 — the conversational queries Q2d/Q3 — runs ONLY
 * when the gate is open, so a client without verified instrumentation never pays for them.
 */

/** Evidence parameters: §7's starting point, not a certification. */
export const EVIDENCE_PARAMS = {
  ventana: '30 minutes',
  tolerancia: '2 minutes',
  umbral: 0.95,
  minimo: 50,
  methodVersion: 'v3.1',
} as const;

/* ------------------------------------------------------- tagged SQL runner -- */

const compiled = new Map<string, { text: string; names: string[] }>();

function compile(tag: string): { text: string; names: string[] } {
  const hit = compiled.get(tag);
  if (hit) return hit;
  const marker = `-- ${tag}\n`;
  const i = VALUE_DASHBOARD_SQL.indexOf(marker);
  if (i < 0) throw new Error(`value dashboard: unknown query ${tag}`);
  const raw = VALUE_DASHBOARD_SQL.slice(i, VALUE_DASHBOARD_SQL.indexOf(';', i) + 1);
  const names: string[] = [];
  const text = raw.replace(/:'([a-z]+)'/g, (_, name: string) => {
    if (!names.includes(name)) names.push(name);
    return `$${names.indexOf(name) + 1}`;
  });
  const out = { text, names };
  compiled.set(tag, out);
  return out;
}

/** Run one tagged query with BIND parameters (the :'name' placeholders become $n). */
export async function runTagged<T extends Record<string, unknown>>(tag: string, params: Record<string, unknown>): Promise<T[]> {
  const { text, names } = compile(tag);
  const values = names.map((n) => {
    if (!(n in params)) throw new Error(`value dashboard: ${tag} needs :${n}`);
    return params[n];
  });
  return (await query<T>(text, values)).rows;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Fingerprint of the conversation mappings of some workflows — the same expression the
 * manual review stores (docs/value-dashboard/REVISION-MANUAL.md). Mappings are upserted in
 * place and deleted without a timestamp, so comparing this hash is how an edit after the
 * review is noticed.
 */
export const MAPPINGS_FINGERPRINT_SQL = `
  SELECT md5(coalesce(string_agg(n8n_workflow_id || '|' || role || '|' || coalesce(node_name, '') || '|' || json_path, E'\n'
                                 ORDER BY n8n_workflow_id, role), '')) AS fingerprint
    FROM field_mappings
   WHERE tenant_id = $1 AND mapping_kind = 'conversation' AND n8n_workflow_id = ANY($2::text[])`;

/* ----------------------------------------------------------------- context -- */

export interface ValueDashboardContext {
  tenantId: string;
  clientId: string;
  clientName: string;
  sites: Array<{ id: string; name: string; timezone: string; createdAt: string }>;
  /** The primary site's timezone (first created) — period boundaries and day buckets. */
  tz: string;
  schedulingSince: string | null;
}

const FALLBACK_TZ = 'America/Bogota';

export async function getValueDashboardContext(tenantId: string, clientId: string): Promise<ValueDashboardContext | null> {
  const [client, sites] = await Promise.all([
    query<{ name: string }>(`SELECT name FROM clients WHERE tenant_id = $1 AND id = $2`, [tenantId, clientId]),
    query<{ id: string; name: string; timezone: string; created_at: Date }>(
      `SELECT id, name, timezone, created_at FROM sites WHERE tenant_id = $1 AND client_id = $2 ORDER BY created_at, id`,
      [tenantId, clientId],
    ),
  ]);
  if (client.rows.length === 0) return null;
  const list = sites.rows.map((s) => ({ id: s.id, name: s.name, timezone: s.timezone, createdAt: s.created_at.toISOString() }));
  return {
    tenantId,
    clientId,
    clientName: client.rows[0].name,
    sites: list,
    tz: list[0]?.timezone ?? FALLBACK_TZ,
    schedulingSince: list[0]?.createdAt ?? null,
  };
}

/* ------------------------------------------------------------- assumptions -- */

interface AssumptionRow {
  id: string;
  status: 'proposed' | 'confirmed';
  method_version: string;
  min_conversacion_atendida: number;
  min_conversacion_con_cita: number;
  min_agendar_manual: number;
  costo_hora: string;
  effective_from: string;
  proposed_by: string;
  proposed_at: Date;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  based_on_id: string | null;
}

export async function listAssumptionVersions(tenantId: string, clientId: string): Promise<AssumptionVersion[]> {
  const r = await query<AssumptionRow>(
    `SELECT id, status, method_version, min_conversacion_atendida, min_conversacion_con_cita, min_agendar_manual,
            costo_hora, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, proposed_by, proposed_at,
            confirmed_by, confirmed_at, based_on_id
       FROM value_estimate_assumptions
      WHERE tenant_id = $1 AND client_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 100`,
    [tenantId, clientId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    status: x.status,
    methodVersion: x.method_version,
    minConversacionAtendida: x.min_conversacion_atendida,
    minConversacionConCita: x.min_conversacion_con_cita,
    minAgendarManual: x.min_agendar_manual,
    costoHora: Number(x.costo_hora),
    effectiveFrom: x.effective_from,
    proposedBy: x.proposed_by,
    proposedAt: x.proposed_at.toISOString(),
    confirmedBy: x.confirmed_by,
    confirmedAt: x.confirmed_at ? x.confirmed_at.toISOString() : null,
    basedOnId: x.based_on_id,
  }));
}

async function peopleNames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const r = await query<{ id: string; label: string }>(
    `SELECT id, coalesce(nullif(btrim(name), ''), email) AS label FROM "user" WHERE id = ANY($1::text[])`,
    [ids],
  );
  return Object.fromEntries(r.rows.map((x) => [x.id, x.label]));
}

/* ---------------------------------------------------------------- the load -- */

type LensRow = { canal: string; estado: string; count: number; withPrice: number; value: number | null };

function lensRows(rows: Array<Record<string, unknown>>, countCol: string): LensRow[] {
  return rows.map((r) => ({
    canal: String(r.canal),
    estado: String(r.estado),
    count: num(r[countCol]),
    withPrice: num(r.con_precio),
    value: numOrNull(r.valor),
  }));
}

export async function loadValueDashboard(
  ctx: ValueDashboardContext,
  period: Period,
  now: Date,
): Promise<Omit<ValueDashboardData, 'viewer' | 'canPropose' | 'canConfirm'>> {
  const { tenantId: tenant, clientId: client, tz } = ctx;
  const cur = { tenant, client, from: period.startUtc, to: period.endUtc };
  const prev = { tenant, client, from: period.prevStartUtc, to: period.startUtc };
  const ev = {
    ...cur,
    ventana: EVIDENCE_PARAMS.ventana,
    tolerancia: EVIDENCE_PARAMS.tolerancia,
    umbral: String(EVIDENCE_PARAMS.umbral),
    minimo: String(EVIDENCE_PARAMS.minimo),
  };
  const nowIso = now.toISOString();

  const [
    q4a, q4aPrev, q4b, q4bPrev, q4d, q4dPrev, q4bd, q5h, q6, q7, q7s, q8w, q9, q1b, wfNames, review, versions,
  ] = await Promise.all([
    runTagged('Q4a', cur),
    runTagged('Q4a', prev),
    runTagged('Q4b', cur),
    runTagged('Q4b', prev),
    runTagged('Q4d', { ...cur, tz }),
    runTagged('Q4d', { ...prev, tz }),
    runTagged('Q4bd', { ...cur, tz }),
    runTagged('Q5h', cur),
    runTagged('Q6', cur),
    runTagged('Q7', cur),
    runTagged('Q7s', { tenant, client, from: period.startUtc }),
    runTagged('Q8w', cur),
    runTagged('Q9', ev),
    runTagged('Q1b', cur),
    query<{ n8n_workflow_id: string; name: string | null }>(
      `SELECT n8n_workflow_id, name FROM workflows WHERE tenant_id = $1 AND client_id = $2`,
      [tenant, client],
    ),
    query<{ status: 'approved' | 'rejected'; method_version: string; conversational_workflow_ids: string[]; mappings_fingerprint: string; reviewed_at: Date }>(
      `SELECT status, method_version, conversational_workflow_ids, mappings_fingerprint, reviewed_at
         FROM instrumentation_reviews WHERE tenant_id = $1 AND client_id = $2
        ORDER BY reviewed_at DESC, created_at DESC LIMIT 1`,
      [tenant, client],
    ),
    listAssumptionVersions(tenant, client),
  ]);

  /* evidence gate (§5.2) */
  const names = new Map(wfNames.rows.map((w) => [w.n8n_workflow_id, w.name]));
  const q1bById = new Map(q1b.map((r) => [String(r.n8n_workflow_id), r]));
  const workflows: EvidenceWorkflow[] = q9.map((r) => {
    const id = String(r.n8n_workflow_id);
    const roles = q1bById.get(id)?.roles_configurados;
    return {
      id,
      name: names.get(id) ?? null,
      conversational: Boolean(r.conversacional),
      estado: String(r.estado) as Q9Estado,
      ejecuciones: num(r.ejecuciones),
      mensajesReportados: num(r.mensajes_reportados),
      turnos: num(r.turnos),
      pConversacion: numOrNull(r.p_conversacion),
      pMensajeCliente: numOrNull(r.p_mensaje_cliente),
      pRespuestaBot: numOrNull(r.p_respuesta_bot),
      rolesConfigurados: Array.isArray(roles) ? (roles as string[]) : null,
    };
  });
  const hasConversational = workflows.some((w) => w.conversational);
  const habilitable = q9.length > 0 && Boolean(q9[0].habilitable);
  const rv = review.rows[0];
  const conversationalIds = workflows.filter((w) => w.conversational).map((w) => w.id);
  // A review is current only if it lists every workflow Q9 now sees as conversational, uses
  // this method version, and the mappings it reviewed are unchanged (fingerprint).
  let coversAll = false;
  if (rv && rv.method_version === EVIDENCE_PARAMS.methodVersion && conversationalIds.every((id) => rv.conversational_workflow_ids.includes(id))) {
    const fp = await query<{ fingerprint: string }>(MAPPINGS_FINGERPRINT_SQL, [tenant, rv.conversational_workflow_ids]);
    coversAll = fp.rows[0]?.fingerprint === rv.mappings_fingerprint;
  }
  const enabled = habilitable && rv?.status === 'approved' && coversAll;
  const evidence: Evidence = {
    habilitable,
    hasConversational,
    review: rv ? { status: rv.status, reviewedAt: rv.reviewed_at.toISOString(), methodVersion: rv.method_version, coversAll } : null,
    enabled,
    reason: enabled
      ? null
      : !hasConversational
        ? 'no_conversational'
        : !habilitable
          ? 'contrast_insufficient'
          : !rv
            ? 'no_review'
            : rv.status === 'rejected'
              ? 'review_rejected'
              : 'review_stale',
    workflows,
    params: {
      ventana: EVIDENCE_PARAMS.ventana,
      tolerancia: EVIDENCE_PARAMS.tolerancia,
      umbral: EVIDENCE_PARAMS.umbral,
      minimo: EVIDENCE_PARAMS.minimo,
      methodVersion: EVIDENCE_PARAMS.methodVersion,
    },
  };

  /* batch 2: conversational metrics, only behind the gate */
  let conversations: ValueDashboardData['conversations'] = null;
  let q2dCur: Array<Record<string, unknown>> = [];
  let q2dPrev: Array<Record<string, unknown>> = [];
  if (enabled) {
    const conv = { ...ev, now: nowIso, tz };
    const [a, b, q3] = await Promise.all([
      runTagged('Q2d', conv),
      runTagged('Q2d', { ...conv, from: period.prevStartUtc, to: period.startUtc }),
      runTagged('Q3', conv),
    ]);
    q2dCur = a;
    q2dPrev = b;
    const sum = (k: string) => q2dCur.reduce((s, r) => s + num(r[k]), 0);
    const classes: ConversationClasses = {
      conIntervencionHumana: sum('con_intervencion_humana'),
      conIntervencionHumanaYCitaBot: sum('con_intervencion_humana_y_cita_bot'),
      u2CitaBot: sum('u2_cita_bot'),
      enCurso: sum('en_curso'),
      u1RespondidaPorBot: sum('u1_respondida_por_bot'),
      conTurnosSinRespuesta: sum('con_turnos_sin_respuesta'),
    };
    const t = q3[0] ?? {};
    const turns: TurnStats = {
      turnos: num(t.turnos),
      respondidosPorBot: num(t.respondidos_por_bot),
      respondidosPorPersona: num(t.respondidos_por_persona),
      respuestaTardia: num(t.respuesta_tardia),
      sinRespuestaObservable: num(t.sin_respuesta_observable),
      enCurso: num(t.en_curso),
      medianaBotS: numOrNull(t.mediana_bot_s),
      p90BotS: numOrNull(t.p90_bot_s),
    };
    conversations = { classes, turns };
  }

  /* daily series and countable units */
  const days = periodDays(period);
  const prevDays = periodDays({ fromDay: period.prevFromDay, days: period.days });
  const byDay = new Map(days.map((d) => [d, { day: d, created: 0, reserved: EMPTY_BUCKET as Bucket, completed: EMPTY_BUCKET as Bucket }]));
  const u3 = new Map<string, number>();
  for (const r of q4d) {
    const d = byDay.get(String(r.dia));
    const n = num(r.citas);
    if (String(r.canal) === 'public') u3.set(String(r.dia), (u3.get(String(r.dia)) ?? 0) + n);
    if (!d) continue;
    d.created += n;
    if (RESERVED_OUTCOMES.includes(outcomeOf(String(r.estado)))) {
      d.reserved = addBuckets(d.reserved, bucket(n, num(r.con_precio), numOrNull(r.valor)));
    }
  }
  for (const r of q4bd) {
    const d = byDay.get(String(r.dia));
    if (d) d.completed = addBuckets(d.completed, bucket(num(r.citas), num(r.con_precio), numOrNull(r.valor)));
  }
  const u3Prev = new Map<string, number>();
  for (const r of q4dPrev) if (String(r.canal) === 'public') u3Prev.set(String(r.dia), (u3Prev.get(String(r.dia)) ?? 0) + num(r.citas));
  const convByDay = (rows: Array<Record<string, unknown>>) =>
    new Map(rows.map((r) => [String(r.dia), { u1: num(r.u1_respondida_por_bot), u2: num(r.u2_cita_bot) }]));
  const cCur = convByDay(q2dCur);
  const cPrev = convByDay(q2dPrev);
  const units: UnitDay[] = days.map((d) => ({
    day: d,
    u1: enabled ? cCur.get(d)?.u1 ?? 0 : null,
    u2: enabled ? cCur.get(d)?.u2 ?? 0 : null,
    u3: u3.get(d) ?? 0,
  }));
  const prevUnits: UnitDay[] = prevDays.map((d) => ({
    day: d,
    u1: enabled ? cPrev.get(d)?.u1 ?? 0 : null,
    u2: enabled ? cPrev.get(d)?.u2 ?? 0 : null,
    u3: u3Prev.get(d) ?? 0,
  }));

  /* out of hours */
  const outOfHours: Record<Franja, number> = { antes_de_abrir: 0, despues_de_cerrar: 0, dia_sin_atencion: 0, en_pausa: 0, dentro: 0, sin_horario: 0 };
  for (const r of q5h) outOfHours[String(r.franja) as Franja] = num(r.reservas);

  /* bot actions on existing appointments (count only) */
  const q6m = new Map(q6.map((r) => [String(r.event_type), num(r.gestiones)]));
  const botActions = {
    rescheduled: q6m.get('appointment_rescheduled') ?? 0,
    cancelled: q6m.get('appointment_cancelled') ?? 0,
    confirmed: q6m.get('appointment_confirmed') ?? 0,
  };

  /* new-client cohort */
  const s7 = q7s[0];
  const startedAt = s7?.tracking_started_at instanceof Date ? s7.tracking_started_at.toISOString() : null;
  const tracking = startedAt
    ? {
        startedAt,
        effectiveStart: s7.inicio_efectivo instanceof Date ? s7.inicio_efectivo.toISOString() : null,
        partial: Boolean(s7.periodo_parcial),
      }
    : null;
  const cohortRows: CohortRow[] = q7
    .map((r) => ({
      origen: String(r.origen),
      clientesNuevos: num(r.clientes_nuevos),
      completadas: num(r.completadas),
      completadasSinPrecio: num(r.completadas_sin_precio),
      valor: numOrNull(r.valor_servicios_completados_en_periodo),
    }))
    .sort((a, b) => b.clientesNuevos - a.clientesNuevos);

  /* health */
  const healthWf = q8w
    .map((r) => ({ id: String(r.n8n_workflow_id), name: (r.name as string | null) ?? null, executions: num(r.ejecuciones), errors: num(r.con_error) }))
    .sort((a, b) => b.errors - a.errors || b.executions - a.executions);
  const health = {
    executions: healthWf.reduce((s, w) => s + w.executions, 0),
    errors: healthWf.reduce((s, w) => s + w.errors, 0),
    workflows: healthWf,
  };

  /* comparison and coverage: the scheduling records start with the first site */
  const sinceDay = ctx.schedulingSince ? localToday(new Date(ctx.schedulingSince), tz) : null;
  const comparison =
    sinceDay === null
      ? { available: false, reason: 'Sin agenda configurada' }
      : sinceDay > period.prevFromDay
        ? { available: false, reason: `Sin comparación: la agenda registra citas desde el ${formatDayEs(sinceDay)}` }
        : { available: true, reason: null };
  const coverage =
    sinceDay !== null && sinceDay > period.fromDay && sinceDay <= period.toDay
      ? { coveredDays: daysBetweenInclusive(sinceDay, period.toDay), since: sinceDay }
      : null;

  const peopleIds = [...new Set(versions.flatMap((v) => [v.proposedBy, v.confirmedBy]).filter((x): x is string => !!x))];

  return {
    generatedAt: nowIso,
    tz,
    client: { id: client, name: ctx.clientName },
    sites: ctx.sites.map((s) => ({ id: s.id, name: s.name })),
    period,
    schedulingSince: ctx.schedulingSince,
    comparison,
    coverage,
    created: lensFromRows(lensRows(q4a, 'reservas_creadas')),
    dated: lensFromRows(lensRows(q4b, 'citas_del_periodo')),
    prevCreated: lensFromRows(lensRows(q4aPrev, 'reservas_creadas')),
    prevDated: lensFromRows(lensRows(q4bPrev, 'citas_del_periodo')),
    daily: [...byDay.values()],
    outOfHours,
    botActions,
    cohort: { tracking, rows: cohortRows },
    health,
    evidence,
    conversations,
    units,
    prevUnits,
    assumptions: { versions, people: await peopleNames(peopleIds) },
  };
}
