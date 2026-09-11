import * as analysesRepo from '../../db/repositories/meetings/analyses.js';
import * as meetingsRepo from '../../db/repositories/meetings/meetings.js';
import * as transcriptsRepo from '../../db/repositories/meetings/transcripts.js';
import { MeetingsApiError, notFound } from '../errors.js';
import type { AppScope } from '../service.js';
import { buildSummary, type ResolvedSummary, type SourceSegment, type SourceSpeaker } from './build.js';
import { randomUUID } from 'node:crypto';
import { ANALYSIS_PROMPT_VERSION } from './contract.js';
import { AnalysisError, DEFAULT_MODEL, analyze, estimateCost, type AnalyzeDeps, type EstimatedCost } from './openai.js';
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
  /** El que el proveedor dijo haber usado. Puede diferir del pedido. */
  readonly modelReturned: string | null;
  readonly promptVersion: number;
  readonly createdAt: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Coste ESTIMADO, nunca el importe facturado. Ver `costUsd` en
   * analysis/openai.ts: tabla local de tarifas y tokens cacheados a tarifa
   * completa. `null` = tarifa desconocida, no cero.
   */
  readonly costUsd: number | null;
  readonly costEstimated: true;
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
  if (fila) {
    const v = vista(fila, activo);
    if (v) return v;
  }
  // Pero si el puntero de la reunión apunta a un análisis de OTRA versión, hay
  // que decirlo en vez de callar: por eso se mira también el activo.
  if (!meeting.active_analysis_id) return null;
  const previo = await analysesRepo.findByIdScoped(
    meeting.active_analysis_id, scope.tenantId, scope.clientId,
  );
  return previo ? vista(previo, activo) : null;
}

function vista(fila: analysesRepo.AnalysisRow, transcriptActivo: string): AnalysisView | null {
  // Una reserva viva o fallida no es un resumen: no hay nada que pintar.
  if (fila.status !== 'ready' || fila.payload === null) return null;
  return {
    id: fila.id,
    summary: fila.payload as unknown as ResolvedSummary,
    transcriptId: fila.transcript_id,
    model: fila.model,
    modelReturned: fila.model_returned,
    promptVersion: fila.prompt_version,
    createdAt: fila.created_at.toISOString(),
    inputTokens: fila.input_tokens,
    outputTokens: fila.output_tokens,
    // `null` = no se conoce el precio de ese modelo. La pantalla dice «no
    // disponible» en vez de enseñar un cero que se leería como gratis.
    costUsd: fila.cost_usd === null ? null : Number(fila.cost_usd),
    costEstimated: true,
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
  /** `ready` = hay resumen. `generating` = otra petición lo está haciendo. */
  readonly state: 'ready' | 'generating';
  readonly view: AnalysisView | null;
  /** true = no se llamó al proveedor. */
  readonly reused: boolean;
  /**
   * El resumen se hizo, pero la transcripción cambió mientras tanto, así que se
   * guarda como histórico y NO se marca activo.
   */
  readonly supersededDuringGeneration: boolean;
  readonly droppedRefs: number;
  readonly decided: number;
  readonly proposed: number;
}

/** ¿Hay algo que enseñar, o el modelo no produjo nada utilizable? */
function esUtil(r: ResolvedSummary): boolean {
  return (
    r.executive.trim() !== '' ||
    r.themes.length > 0 ||
    r.findings.length > 0 ||
    r.nextSteps.length > 0
  );
}

export async function generateAnalysis(
  scope: AppScope,
  meetingId: string,
  deps: AnalyzeDeps = {},
): Promise<GenerateResult> {
  const meeting = await requireMeeting(scope, meetingId);
  // Una reunión en eliminación no genera resúmenes nuevos. No escribe en R2,
  // pero sí crea una fila y cuesta dinero: pagarle a un proveedor por resumir
  // algo que está a punto de desaparecer no tiene defensa.
  if (meeting.deletion_state !== 'live') {
    throw new MeetingsApiError('invalid_transition', 'Esta reunión está en proceso de eliminación.');
  }
  // La generación queda ATADA a la transcripción leída aquí. Si cambia después,
  // el resultado se conserva pero no se activa.
  const activoAlEmpezar = meeting.active_transcript_id;
  if (!activoAlEmpezar) {
    throw new MeetingsApiError('invalid_transition', 'La reunión todavía no tiene transcripción que resumir.');
  }

  const { segments, speakers } = await fuente(activoAlEmpezar);
  if (segments.length === 0) {
    throw new MeetingsApiError('invalid_transition', 'La transcripción no tiene segmentos.');
  }

  // ── La reserva, ANTES de gastar ─────────────────────────────────────────
  //
  // Consultar y luego insertar deja hueco para que dos peticiones llamen las dos
  // al proveedor. Aquí la fila se crea primero, y sólo quien sale con ella llama.
  const reservedBy = randomUUID();
  const { row: reservada, owned } = await analysesRepo.reserve({
    tenantId: scope.tenantId,
    clientId: scope.clientId,
    meetingId,
    transcriptId: activoAlEmpezar,
    provider: 'openai',
    model: deps.model ?? process.env.MEETINGS_ANALYSIS_MODEL ?? DEFAULT_MODEL,
    promptVersion: ANALYSIS_PROMPT_VERSION,
    reservedBy,
    createdByUserId: scope.userId ?? null,
  });

  if (!owned) {
    // Otra petición la tiene, o ya está hecho. En ninguno de los dos casos se
    // vuelve a llamar al proveedor.
    const v = vista(reservada, activoAlEmpezar);
    return {
      state: v ? 'ready' : 'generating',
      view: v,
      reused: true,
      supersededDuringGeneration: false,
      droppedRefs: 0,
      decided: 0,
      proposed: 0,
    };
  }

  const rendered = renderTranscript(segments, speakers);
  let resultado;
  try {
    resultado = await analyze(rendered, deps);
  } catch (causa) {
    // Se traduce a un error de la API con un mensaje ÚTIL y sin contenido: los
    // mensajes de `AnalysisError` sólo llevan código, estado HTTP y nombres de
    // campo. Sin esto, la pantalla mostraría «Error interno» y nadie sabría si
    // falta la clave o el proveedor está caído.
    // La reserva se libera para que se pueda reintentar; el consumo de una
    // llamada que falló a mitad no se conoce, así que queda en cero.
    await analysesRepo.failReservation(reservada.id, reservedBy, {
      inputTokens: 0, outputTokens: 0, costUsd: null, durationMs: null, modelReturned: null,
    });
    if (causa instanceof AnalysisError) {
      throw new MeetingsApiError(
        causa.code === 'no_key' ? 'analysis_not_configured' : 'analysis_failed',
        causa.code === 'no_key'
          ? 'El resumen no está configurado en este entorno: falta la clave del proveedor.'
          : `No se pudo generar el resumen (${causa.code}).`,
      );
    }
    throw causa;
  }

  const construido = buildSummary(resultado.raw, segments, speakers);

  // ── Validación de servidor ──────────────────────────────────────────────
  //
  // La salida estructurada garantiza la FORMA, no que las referencias sean
  // ciertas. `buildSummary` ya comprobó que cada índice existe EN ESTA versión
  // —los segmentos se cargaron de `activoAlEmpezar`, así que un índice válido
  // pertenece por construcción a esa versión—. Lo que queda es decidir si lo que
  // sobrevivió sirve para algo.
  if (!esUtil(construido.summary)) {
    await analysesRepo.failReservation(reservada.id, reservedBy, {
      inputTokens: resultado.inputTokens,
      outputTokens: resultado.outputTokens,
      costUsd: resultado.costUsd,
      durationMs: resultado.durationMs,
      modelReturned: resultado.modelReturned,
    });
    throw new MeetingsApiError(
      'invalid_transition',
      construido.droppedRefs > 0
        ? `El análisis no citó ningún segmento válido de esta transcripción (${construido.droppedRefs} referencia(s) descartadas). No se reemplazó el resumen anterior.`
        : 'El análisis no produjo contenido utilizable. No se reemplazó el resumen anterior.',
    );
  }

  const fila = await analysesRepo.complete({
    id: reservada.id,
    reservedBy,
    payload: construido.summary,
    modelReturned: resultado.modelReturned,
    inputTokens: resultado.inputTokens,
    outputTokens: resultado.outputTokens,
    costUsd: resultado.costUsd,
    durationMs: resultado.durationMs,
  });
  if (!fila) {
    // Otra petición se apropió de la reserva por caducidad mientras llamábamos.
    const actual = await analysesRepo.findByTranscript(activoAlEmpezar, scope.tenantId, scope.clientId);
    const v = actual ? vista(actual, activoAlEmpezar) : null;
    return {
      state: v ? 'ready' : 'generating',
      view: v,
      reused: true,
      supersededDuringGeneration: false,
      droppedRefs: construido.droppedRefs,
      decided: construido.decided,
      proposed: construido.proposed,
    };
  }

  // ── Activación, comprobando que el texto no cambió mientras tanto ───────
  const activado = await analysesRepo.activateIfTranscriptUnchanged(
    meetingId, fila.id, activoAlEmpezar, scope.tenantId, scope.clientId,
  );

  // El `outdated` de la vista se calcula contra la transcripción de partida; si
  // no se activó es justo porque ya hay otra, y hay que decirlo.
  const v = vista(fila, activado ? activoAlEmpezar : '—cambió—');
  return {
    state: 'ready',
    view: v,
    reused: false,
    supersededDuringGeneration: !activado,
    droppedRefs: construido.droppedRefs,
    decided: construido.decided,
    proposed: construido.proposed,
  };
}
