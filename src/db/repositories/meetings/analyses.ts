import { query } from '../../client.js';
import type { Queryable } from './types.js';

/** El repositorio del análisis. Todo acotado por tenant y cliente, siempre. */

export interface AnalysisRow {
  id: string;
  meeting_id: string;
  transcript_id: string;
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
}

const q = (executor?: Queryable) => executor ?? { query };

const COLUMNAS = `id, meeting_id, transcript_id, provider, model, prompt_version,
                  status, reserved_at, reserved_by, payload, input_tokens, output_tokens,
                  cost_usd, model_returned, duration_ms, created_at`;

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
 * El análisis de una versión de transcripción, si existe.
 *
 * Acotado por tenant y cliente aunque `transcript_id` ya sea único: el ámbito se
 * vuelve a aplicar en el WHERE porque una consulta que sólo filtra por un uuid
 * está a una refactorización de devolver lo de otro cliente.
 */
export async function findByTranscript(
  transcriptId: string,
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<AnalysisRow | null> {
  const result = await q(executor).query<AnalysisRow>(
    `SELECT ${COLUMNAS} FROM meeting_analyses
      WHERE transcript_id = $1 AND tenant_id = $2 AND client_id = $3`,
    [transcriptId, tenantId, clientId],
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
 * Reserva la generación, atómicamente, ANTES de gastar un céntimo.
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
 */
export async function reserve(
  input: ReserveInput,
  executor?: Queryable,
): Promise<ReserveResult> {
  const ex = q(executor);
  const insertado = await ex.query<AnalysisRow>(
    `INSERT INTO meeting_analyses
       (tenant_id, client_id, meeting_id, transcript_id, provider, model, prompt_version,
        status, reserved_at, reserved_by, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',now(),$8,$9)
     ON CONFLICT ON CONSTRAINT analyses_transcript_key DO NOTHING
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
      WHERE transcript_id = $1 AND tenant_id = $2 AND client_id = $3
        AND (status = 'failed'
             OR (status = 'pending' AND reserved_at < now() - ($7 || ' milliseconds')::interval))
      RETURNING ${COLUMNAS}`,
    [
      input.transcriptId, input.tenantId, input.clientId, input.reservedBy,
      input.model, input.promptVersion, String(RESERVA_CADUCA_MS),
    ],
  );
  if (apropiado.rows[0]) return { row: apropiado.rows[0], owned: true };

  const existente = await findByTranscript(input.transcriptId, input.tenantId, input.clientId, executor);
  if (!existente) throw new Error('reserve: no se pudo reservar ni leer la fila existente');
  return { row: existente, owned: false };
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
 * Marca el análisis como activo SÓLO si la transcripción sigue siendo la misma.
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
