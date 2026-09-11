import * as analysesRepo from '../../db/repositories/meetings/analyses.js';
import * as meetingsRepo from '../../db/repositories/meetings/meetings.js';
import * as transcriptsRepo from '../../db/repositories/meetings/transcripts.js';
import { MeetingsApiError, notFound } from '../errors.js';
import type { AppScope } from '../service.js';
import { buildSummary, type ResolvedSummary, type SourceSegment, type SourceSpeaker } from './build.js';
import { analyze, estimateCost, type AnalyzeDeps, type EstimatedCost } from './openai.js';
import { renderTranscript } from './prompt.js';

/**
 * Generar y leer el resumen de una reunión.
 *
 * ── Aislamiento ────────────────────────────────────────────────────────────
 *
 * Cada función recibe el `AppScope` ya resuelto —sesión, membresía, cliente real
 * y módulo habilitado— y VUELVE a acotar por tenant y cliente en cada consulta.
 * Es redundante a propósito, igual que en `uiRead`: el uuid de una reunión de
 * otro cliente no debe existir aquí ni tras una refactorización.
 *
 * ── Cómo no se gasta dos veces ─────────────────────────────────────────────
 *
 * El resumen está atado a la VERSIÓN de transcripción. Antes de llamar a nadie se
 * mira si ya hay uno para esa versión; si lo hay, se devuelve y no se gasta. Eso
 * cubre el doble clic, la recarga y el reintento, porque los tres apuntan a la
 * misma versión. La restricción UNIQUE de la base cubre el empate de dos
 * peticiones simultáneas.
 */

export interface AnalysisView {
  readonly id: string;
  readonly summary: ResolvedSummary;
  readonly transcriptId: string;
  readonly model: string;
  readonly promptVersion: number;
  readonly createdAt: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /**
   * El resumen se hizo sobre una versión que ya NO es la activa: la reunión se
   * reprocesó y el texto cambió. Se sigue mostrando —es mejor que nada— pero
   * diciendo que está desactualizado.
   */
  readonly outdated: boolean;
}

async function requireMeeting(scope: AppScope, meetingId: string) {
  const meeting = await meetingsRepo.getMeetingScoped(meetingId, scope.tenantId, scope.clientId);
  if (!meeting) throw notFound();
  return meeting;
}

/** El resumen guardado, si hay. Nunca genera nada ni gasta nada. */
export async function getAnalysis(scope: AppScope, meetingId: string): Promise<AnalysisView | null> {
  const meeting = await requireMeeting(scope, meetingId);
  const activo = meeting.active_transcript_id;
  if (!activo) return null;
  // Se busca por la transcripción ACTIVA. Si el resumen viejo es de otra versión,
  // esta consulta no lo encuentra y la pantalla queda sin resumen, que es
  // correcto: ese resumen habla de otro texto.
  const fila = await analysesRepo.findByTranscript(activo, scope.tenantId, scope.clientId);
  if (fila) return vista(fila, activo);
  // Pero si el puntero de la reunión apunta a un análisis de OTRA versión, hay
  // que decirlo en vez de callar: por eso se mira también el activo.
  if (!meeting.active_analysis_id) return null;
  const previo = await analysesRepo.findByIdScoped(
    meeting.active_analysis_id, scope.tenantId, scope.clientId,
  );
  return previo ? vista(previo, activo) : null;
}

function vista(fila: analysesRepo.AnalysisRow, transcriptActivo: string): AnalysisView {
  return {
    id: fila.id,
    summary: fila.payload as unknown as ResolvedSummary,
    transcriptId: fila.transcript_id,
    model: fila.model,
    promptVersion: fila.prompt_version,
    createdAt: fila.created_at.toISOString(),
    inputTokens: fila.input_tokens,
    outputTokens: fila.output_tokens,
    costUsd: Number(fila.cost_usd),
    outdated: fila.transcript_id !== transcriptActivo,
  };
}

async function fuente(transcriptId: string): Promise<{ segments: SourceSegment[]; speakers: SourceSpeaker[] }> {
  const [filas, hablantes] = await Promise.all([
    transcriptsRepo.listSegments(transcriptId),
    transcriptsRepo.listTranscriptSpeakers(transcriptId),
  ]);
  return {
    segments: filas.map((s) => ({
      index: s.segment_index,
      startSec: Number(s.start_sec),
      endSec: Number(s.end_sec),
      speakerLabel: s.speaker_label,
      text: s.text,
    })),
    speakers: hablantes.map((h) => ({ label: h.speaker_label, displayName: h.display_name })),
  };
}

/** Cuánto costaría, SIN llamar a nadie. Es lo que se enseña antes de la primera vez. */
export async function previewCost(scope: AppScope, meetingId: string): Promise<EstimatedCost & {
  segments: number;
  truncated: boolean;
  alreadyAnalyzed: boolean;
}> {
  const meeting = await requireMeeting(scope, meetingId);
  const activo = meeting.active_transcript_id;
  if (!activo) throw new MeetingsApiError('invalid_transition', 'La reunión todavía no tiene transcripción.');
  const existente = await analysesRepo.findByTranscript(activo, scope.tenantId, scope.clientId);
  const { segments, speakers } = await fuente(activo);
  const rendered = renderTranscript(segments, speakers);
  return {
    ...estimateCost(rendered),
    segments: rendered.includedSegments,
    truncated: rendered.truncated,
    alreadyAnalyzed: existente !== null,
  };
}

export interface GenerateResult {
  readonly view: AnalysisView;
  /** true = se devolvió el que ya había y NO se llamó al proveedor. */
  readonly reused: boolean;
  readonly droppedRefs: number;
  readonly decided: number;
  readonly proposed: number;
}

export async function generateAnalysis(
  scope: AppScope,
  meetingId: string,
  deps: AnalyzeDeps = {},
): Promise<GenerateResult> {
  const meeting = await requireMeeting(scope, meetingId);
  const activo = meeting.active_transcript_id;
  if (!activo) {
    throw new MeetingsApiError('invalid_transition', 'La reunión todavía no tiene transcripción que resumir.');
  }

  // ANTES de gastar: ¿ya hay resumen de esta versión exacta?
  const existente = await analysesRepo.findByTranscript(activo, scope.tenantId, scope.clientId);
  if (existente) {
    return { view: vista(existente, activo), reused: true, droppedRefs: 0, decided: 0, proposed: 0 };
  }

  const { segments, speakers } = await fuente(activo);
  if (segments.length === 0) {
    throw new MeetingsApiError('invalid_transition', 'La transcripción no tiene segmentos.');
  }

  const rendered = renderTranscript(segments, speakers);
  const resultado = await analyze(rendered, deps);
  const construido = buildSummary(resultado.raw, segments, speakers);

  const { row, created } = await analysesRepo.insertAnalysis({
    tenantId: scope.tenantId,
    clientId: scope.clientId,
    meetingId,
    transcriptId: activo,
    provider: 'openai',
    model: resultado.model,
    promptVersion: resultado.promptVersion,
    payload: construido.summary,
    inputTokens: resultado.inputTokens,
    outputTokens: resultado.outputTokens,
    costUsd: resultado.costUsd,
    durationMs: resultado.durationMs,
    createdByUserId: scope.userId ?? null,
  });
  await analysesRepo.setActiveAnalysis(meetingId, row.id, scope.tenantId, scope.clientId);

  return {
    view: vista(row, activo),
    // `created=false` significa que otra petición simultánea ganó la carrera.
    reused: !created,
    droppedRefs: construido.droppedRefs,
    decided: construido.decided,
    proposed: construido.proposed,
  };
}
