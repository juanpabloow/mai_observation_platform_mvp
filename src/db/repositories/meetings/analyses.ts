import { query } from '../../client.js';
import type { Queryable } from './types.js';

/** El repositorio del análisis. Todo acotado por tenant y cliente, siempre. */

/**
 * 'summary' = el resumen ejecutivo, uno por versión de transcripción.
 * 'report'  = un reporte de plantilla, varios por versión. Ver 1784300000000.
 */
export type AnalysisKind = 'summary' | 'report';

export interface AnalysisRow {
  id: string;
  meeting_id: string;
  transcript_id: string;
  kind: AnalysisKind;
  provider: string;
  model: string;
  prompt_version: number;
  status: 'pending' | 'ready' | 'failed';
  reserved_at: Date;
  reserved_by: string | null;
  payload: Record<string, unknown> | null;
  input_tokens: number;
  output_tokens: number;
  /** NULL = precio desconocido. No es cero. */
  cost_usd: string | null;
  model_returned: string | null;
  duration_ms: number | null;
  created_at: Date;
  /* ── Sólo en kind='report'; NULL en un resumen (`analyses_summary_plain`). ── */
  template_id: string | null;
  template_version: number | null;
  /** Las instrucciones EXACTAS usadas. Editar la plantilla no altera esto. */
  instructions_snapshot: string | null;
  /** sha256 de las entradas. La clave de idempotencia del reporte. */
  inputs_digest: string | null;
}

const q = (executor?: Queryable) => executor ?? { query };

const COLUMNAS = `id, meeting_id, transcript_id, kind, provider, model, prompt_version,
                  status, reserved_at, reserved_by, payload, input_tokens, output_tokens,
                  cost_usd, model_returned, duration_ms, created_at,
                  template_id, template_version, instructions_snapshot, inputs_digest`;

/**
 * Cuánto puede durar una reserva antes de considerarla abandonada.
 *
 * El proceso que reserva puede morirse —un despliegue, un OOM, un corte— y sin
 * este plazo la reunión quedaría bloqueada en `pending` para siempre. Diez
 * minutos es holgado frente al tiempo de la llamada (60 s más un reintento) y
 * corto frente a la paciencia de una persona.
 */
export const RESERVA_CADUCA_MS = 10 * 60 * 1000;

/**
 * El RESUMEN de una versión de transcripción, si existe.
 *
 * `kind` es obligatorio y no tiene valor por omisión a propósito. Una misma
 * transcripción tiene ahora un resumen y N reportes, así que una consulta sin
 * `kind` devolvería «uno de ellos» según el plan que eligiera PostgreSQL. Un
 * parámetro opcional aquí sería exactamente esa trampa con mejor aspecto.
 *
 * Para reportes esta función NO sirve: son varios por transcripción y se buscan
 * por `inputs_digest`. Ver `findReportByInputs` y `listReports`.
 *
 * Acotado por tenant y cliente aunque el par ya sea único: el ámbito se vuelve a
 * aplicar en el WHERE porque una consulta que sólo filtra por un uuid está a una
 * refactorización de devolver lo de otro cliente.
 */
export async function findByTranscript(
  transcriptId: string,
  kind: AnalysisKind,
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<AnalysisRow | null> {
  const result = await q(executor).query<AnalysisRow>(
    `SELECT ${COLUMNAS} FROM meeting_analyses
      WHERE transcript_id = $1 AND kind = $2 AND tenant_id = $3 AND client_id = $4`,
    [transcriptId, kind, tenantId, clientId],
  );
  return result.rows[0] ?? null;
}

/** Por id, acotado. Para resolver `meetings.active_analysis_id`. */
export async function findByIdScoped(
  id: string,
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<AnalysisRow | null> {
  const result = await q(executor).query<AnalysisRow>(
    `SELECT ${COLUMNAS} FROM meeting_analyses
      WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [id, tenantId, clientId],
  );
  return result.rows[0] ?? null;
}

export interface ReserveInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly meetingId: string;
  readonly transcriptId: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: number;
  readonly reservedBy: string;
  readonly createdByUserId: string | null;
}

export interface ReserveResult {
  readonly row: AnalysisRow;
  /**
   * `true` = esta petición es la dueña y es la ÚNICA que puede llamar al
   * proveedor. `false` = otra la tiene, o ya está hecho.
   */
  readonly owned: boolean;
}

/**
 * Reserva la generación del RESUMEN, atómicamente, ANTES de gastar un céntimo.
 *
 * Tres caminos, y los tres son una sola sentencia SQL cada uno:
 *
 *   1. `INSERT … ON CONFLICT DO NOTHING`. Si devuelve fila, la reserva es
 *      nuestra. Dos peticiones simultáneas entran las dos aquí y exactamente
 *      una sale con fila: lo decide el índice único, no el orden de lectura.
 *   2. Si no devolvió fila, hay una existente. Si está `ready`, se devuelve y no
 *      se llama a nadie. Si está `pending` y fresca, tampoco: alguien está en
 *      ello.
 *   3. Si está `failed`, o `pending` pero abandonada, se intenta APROPIARSE con
 *      un UPDATE condicional. El `WHERE` con el estado y la antigüedad hace que
 *      sólo una petición pueda ganarlo, igual que el INSERT.
 *
 * El conflicto se declara repitiendo el PREDICADO del índice parcial
 * —`(transcript_id) WHERE kind = 'summary'`— porque desde 1784300000000 la
 * unicidad del resumen y la del reporte son reglas distintas y no comparten
 * índice. Declararlo así, y no por el nombre de la restricción, hace que el SQL
 * diga cuál es la regla en vez de apuntar a un nombre que una migración puede
 * cambiar sin avisar.
 */
export async function reserve(
  input: ReserveInput,
  executor?: Queryable,
): Promise<ReserveResult> {
  const ex = q(executor);
  const insertado = await ex.query<AnalysisRow>(
    `INSERT INTO meeting_analyses
       (tenant_id, client_id, meeting_id, transcript_id, kind, provider, model, prompt_version,
        status, reserved_at, reserved_by, created_by_user_id)
     VALUES ($1,$2,$3,$4,'summary',$5,$6,$7,'pending',now(),$8,$9)
     ON CONFLICT (transcript_id) WHERE kind = 'summary' DO NOTHING
     RETURNING ${COLUMNAS}`,
    [
      input.tenantId, input.clientId, input.meetingId, input.transcriptId,
      input.provider, input.model, input.promptVersion, input.reservedBy,
      input.createdByUserId,
    ],
  );
  if (insertado.rows[0]) return { row: insertado.rows[0], owned: true };

  const apropiado = await ex.query<AnalysisRow>(
    `UPDATE meeting_analyses
        SET status = 'pending', reserved_at = now(), reserved_by = $4,
            model = $5, prompt_version = $6
      WHERE transcript_id = $1 AND kind = 'summary' AND tenant_id = $2 AND client_id = $3
        AND (status = 'failed'
             OR (status = 'pending' AND reserved_at < now() - ($7 || ' milliseconds')::interval))
      RETURNING ${COLUMNAS}`,
    [
      input.transcriptId, input.tenantId, input.clientId, input.reservedBy,
      input.model, input.promptVersion, String(RESERVA_CADUCA_MS),
    ],
  );
  if (apropiado.rows[0]) return { row: apropiado.rows[0], owned: true };

  const existente = await findByTranscript(
    input.transcriptId, 'summary', input.tenantId, input.clientId, executor,
  );
  if (!existente) throw new Error('reserve: no se pudo reservar ni leer la fila existente');
  return { row: existente, owned: false };
}

export interface ReserveReportInput extends ReserveInput {
  readonly templateId: string;
  readonly templateVersion: number;
  /** El texto EXACTO usado. Se guarda para que la plantilla pueda cambiar después. */
  readonly instructionsSnapshot: string;
  /** sha256 de las entradas. Es la identidad del reporte. */
  readonly inputsDigest: string;
}

/**
 * Reserva la generación de un REPORTE. Mismo mecanismo, otra identidad.
 *
 * La clave es `(transcript_id, inputs_digest)`, no el tipo: la misma
 * transcripción puede tener cuatro reportes de cuatro plantillas, y el mismo
 * reporte regenerado tras editar sus instrucciones debe ser una fila nueva.
 * Eso hace que cada caso caiga donde debe sin ningún `if`:
 *
 *   - doble clic o recarga → mismo digest → una sola fila y una sola llamada;
 *   - regenerar sin tocar nada → mismo digest → se devuelve el existente, gratis;
 *   - instrucciones editadas → digest distinto → fila nueva, la anterior intacta.
 */
export async function reserveReport(
  input: ReserveReportInput,
  executor?: Queryable,
): Promise<ReserveResult> {
  const ex = q(executor);
  const insertado = await ex.query<AnalysisRow>(
    `INSERT INTO meeting_analyses
       (tenant_id, client_id, meeting_id, transcript_id, kind, provider, model, prompt_version,
        status, reserved_at, reserved_by, created_by_user_id,
        template_id, template_version, instructions_snapshot, inputs_digest)
     VALUES ($1,$2,$3,$4,'report',$5,$6,$7,'pending',now(),$8,$9,$10,$11,$12,$13)
     ON CONFLICT (transcript_id, inputs_digest) WHERE kind = 'report' DO NOTHING
     RETURNING ${COLUMNAS}`,
    [
      input.tenantId, input.clientId, input.meetingId, input.transcriptId,
      input.provider, input.model, input.promptVersion, input.reservedBy,
      input.createdByUserId, input.templateId, input.templateVersion,
      input.instructionsSnapshot, input.inputsDigest,
    ],
  );
  if (insertado.rows[0]) return { row: insertado.rows[0], owned: true };

  const apropiado = await ex.query<AnalysisRow>(
    `UPDATE meeting_analyses
        SET status = 'pending', reserved_at = now(), reserved_by = $5, model = $6
      WHERE transcript_id = $1 AND inputs_digest = $2 AND kind = 'report'
        AND tenant_id = $3 AND client_id = $4
        AND (status = 'failed'
             OR (status = 'pending' AND reserved_at < now() - ($7 || ' milliseconds')::interval))
      RETURNING ${COLUMNAS}`,
    [
      input.transcriptId, input.inputsDigest, input.tenantId, input.clientId,
      input.reservedBy, input.model, String(RESERVA_CADUCA_MS),
    ],
  );
  if (apropiado.rows[0]) return { row: apropiado.rows[0], owned: true };

  const existente = await findReportByInputs(
    input.transcriptId, input.inputsDigest, input.tenantId, input.clientId, executor,
  );
  if (!existente) throw new Error('reserveReport: no se pudo reservar ni leer la fila existente');
  return { row: existente, owned: false };
}

/** El reporte de unas entradas exactas, si ya existe. */
export async function findReportByInputs(
  transcriptId: string,
  inputsDigest: string,
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<AnalysisRow | null> {
  const r = await q(executor).query<AnalysisRow>(
    `SELECT ${COLUMNAS} FROM meeting_analyses
      WHERE transcript_id = $1 AND inputs_digest = $2 AND kind = 'report'
        AND tenant_id = $3 AND client_id = $4`,
    [transcriptId, inputsDigest, tenantId, clientId],
  );
  return r.rows[0] ?? null;
}

/**
 * El historial de reportes de una reunión, del más nuevo al más viejo.
 *
 * TODAS las versiones de transcripción, no sólo la activa: un reporte hecho
 * sobre el texto anterior sigue siendo un documento que alguien generó y puede
 * necesitar volver a leer. La pantalla marca los que no son de la versión
 * vigente; esconderlos sería borrarlos sin decirlo.
 */
export async function listReports(
  meetingId: string,
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<AnalysisRow[]> {
  const r = await q(executor).query<AnalysisRow>(
    `SELECT ${COLUMNAS} FROM meeting_analyses
      WHERE meeting_id = $1 AND kind = 'report' AND tenant_id = $2 AND client_id = $3
      ORDER BY created_at DESC`,
    [meetingId, tenantId, clientId],
  );
  return r.rows;
}

/** Un reporte por id, acotado. Para abrir uno del historial. */
export async function findReportByIdScoped(
  id: string,
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<AnalysisRow | null> {
  const r = await q(executor).query<AnalysisRow>(
    `SELECT ${COLUMNAS} FROM meeting_analyses
      WHERE id = $1 AND kind = 'report' AND tenant_id = $2 AND client_id = $3`,
    [id, tenantId, clientId],
  );
  return r.rows[0] ?? null;
}

export interface CompleteInput {
  readonly id: string;
  readonly reservedBy: string;
  readonly payload: unknown;
  readonly modelReturned: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** `null` cuando no conocemos el precio del modelo. */
  readonly costUsd: number | null;
  readonly durationMs: number | null;
}

/**
 * Cierra la reserva con el resultado. El `WHERE` exige seguir siendo el dueño:
 * si otra petición se apropió por caducidad, ésta ya no escribe.
 */
export async function complete(input: CompleteInput, executor?: Queryable): Promise<AnalysisRow | null> {
  const r = await q(executor).query<AnalysisRow>(
    `UPDATE meeting_analyses
        SET status='ready', payload=$3::jsonb, model_returned=$4, input_tokens=$5,
            output_tokens=$6, cost_usd=$7, duration_ms=$8
      WHERE id=$1 AND reserved_by=$2 AND status='pending'
      RETURNING ${COLUMNAS}`,
    [
      input.id, input.reservedBy, JSON.stringify(input.payload), input.modelReturned,
      input.inputTokens, input.outputTokens, input.costUsd, input.durationMs,
    ],
  );
  return r.rows[0] ?? null;
}

/**
 * Marca la reserva como fallida, conservando el consumo.
 *
 * No se borra la fila: la llamada pudo costar dinero aunque el resultado no
 * sirviera, y ese gasto tiene que quedar contado. Una reserva `failed` puede ser
 * reclamada de nuevo por `reserve`.
 */
export async function failReservation(
  id: string,
  reservedBy: string,
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null; durationMs: number | null; modelReturned: string | null },
  executor?: Queryable,
): Promise<void> {
  await q(executor).query(
    `UPDATE meeting_analyses
        SET status='failed', input_tokens=$3, output_tokens=$4, cost_usd=$5,
            duration_ms=$6, model_returned=$7
      WHERE id=$1 AND reserved_by=$2 AND status='pending'`,
    [id, reservedBy, usage.inputTokens, usage.outputTokens, usage.costUsd, usage.durationMs, usage.modelReturned],
  );
}

/**
 * Marca el RESUMEN como activo SÓLO si la transcripción sigue siendo la misma.
 *
 * Es exclusiva del `kind = 'summary'`. `meetings.active_analysis_id` y
 * `analysis_state` describen el resumen vigente, y el acta no tiene ni debe
 * tener puntero: se localiza por `(transcript_id, 'minutes')`. Si el acta
 * escribiera aquí, la pestaña Resumen resolvería el acta como si fuera su
 * análisis y pintaría un documento con la forma equivocada.
 *
 * Entre que empieza la generación y que termina, la reunión puede reprocesarse.
 * Ese resumen habla de un texto que ya no es el vigente, así que activarlo sería
 * mostrar citas que no corresponden. Se conserva como histórico y no se activa.
 *
 * La comprobación va en el `WHERE` de la propia actualización, no en un `SELECT`
 * previo: entre leer y escribir cabe exactamente la carrera que esto evita.
 *
 * Devuelve `true` si quedó activo.
 */
export async function activateIfTranscriptUnchanged(
  meetingId: string,
  analysisId: string,
  expectedTranscriptId: string,
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<boolean> {
  const r = await q(executor).query(
    `UPDATE meetings
        SET active_analysis_id = $1, analysis_state = 'ready', updated_at = now()
      WHERE id = $2 AND tenant_id = $3 AND client_id = $4
        AND active_transcript_id = $5`,
    [analysisId, meetingId, tenantId, clientId, expectedTranscriptId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Gasto acumulado, para poder mirarlo sin abrir la base fila a fila. */
export async function usageTotals(
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<{ analyses: number; inputTokens: number; outputTokens: number; costUsd: number }> {
  const result = await q(executor).query<{ n: string; i: string; o: string; c: string }>(
    `SELECT count(*)::text n, coalesce(sum(input_tokens),0)::text i,
            coalesce(sum(output_tokens),0)::text o, coalesce(sum(cost_usd),0)::text c
       FROM meeting_analyses WHERE tenant_id = $1 AND client_id = $2 AND status = 'ready'`,
    [tenantId, clientId],
  );
  const r = result.rows[0];
  return {
    analyses: Number(r.n),
    inputTokens: Number(r.i),
    outputTokens: Number(r.o),
    costUsd: Number(r.c),
  };
}
