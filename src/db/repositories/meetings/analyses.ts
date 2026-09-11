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
  payload: Record<string, unknown>;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
  duration_ms: number | null;
  created_at: Date;
}

const q = (executor?: Queryable) => executor ?? { query };

const COLUMNAS = `id, meeting_id, transcript_id, provider, model, prompt_version,
                  payload, input_tokens, output_tokens, cost_usd, duration_ms, created_at`;

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

export interface InsertAnalysisInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly meetingId: string;
  readonly transcriptId: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: number;
  readonly payload: unknown;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly durationMs: number | null;
  readonly createdByUserId: string | null;
}

/**
 * Inserta, o devuelve el que ya había.
 *
 * `ON CONFLICT DO NOTHING` sobre `analyses_transcript_key` es la defensa real
 * contra el gasto duplicado: dos peticiones simultáneas pueden pasar las dos la
 * comprobación previa, y sólo una escribe. La otra lee la existente en vez de
 * crear una segunda fila — y, sobre todo, su llamada de pago ya se hizo, así que
 * esto no evita ese gasto: lo evita la comprobación de ANTES de llamar. Esto
 * evita que la base quede con dos.
 */
export async function insertAnalysis(
  input: InsertAnalysisInput,
  executor?: Queryable,
): Promise<{ row: AnalysisRow; created: boolean }> {
  const inserted = await q(executor).query<AnalysisRow>(
    `INSERT INTO meeting_analyses
       (tenant_id, client_id, meeting_id, transcript_id, provider, model, prompt_version,
        payload, input_tokens, output_tokens, cost_usd, duration_ms, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)
     ON CONFLICT ON CONSTRAINT analyses_transcript_key DO NOTHING
     RETURNING ${COLUMNAS}`,
    [
      input.tenantId, input.clientId, input.meetingId, input.transcriptId,
      input.provider, input.model, input.promptVersion, JSON.stringify(input.payload),
      input.inputTokens, input.outputTokens, input.costUsd, input.durationMs,
      input.createdByUserId,
    ],
  );
  if (inserted.rows[0]) return { row: inserted.rows[0], created: true };
  const existente = await findByTranscript(input.transcriptId, input.tenantId, input.clientId, executor);
  if (!existente) throw new Error('insertAnalysis: conflicto sin fila existente');
  return { row: existente, created: false };
}

/** Apunta la reunión a este análisis y deja `analysis_state` en 'ready'. */
export async function setActiveAnalysis(
  meetingId: string,
  analysisId: string,
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<void> {
  await q(executor).query(
    `UPDATE meetings SET active_analysis_id = $1, analysis_state = 'ready', updated_at = now()
      WHERE id = $2 AND tenant_id = $3 AND client_id = $4`,
    [analysisId, meetingId, tenantId, clientId],
  );
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
       FROM meeting_analyses WHERE tenant_id = $1 AND client_id = $2`,
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
