import { createHash, randomUUID } from 'node:crypto';
import * as analysesRepo from '../../../db/repositories/meetings/analyses.js';
import * as templatesRepo from '../../../db/repositories/meetings/reportTemplates.js';
import * as meetingsRepo from '../../../db/repositories/meetings/meetings.js';
import * as transcriptsRepo from '../../../db/repositories/meetings/transcripts.js';
import { getClientById } from '../../../db/repositories/clients.js';
import { MeetingsApiError, invalidRequest, notFound } from '../../errors.js';
import type { AppScope } from '../../service.js';
import type { SourceSegment, SourceSpeaker } from '../build.js';
import {
  AnalysisError,
  DEFAULT_MODEL,
  estimateTaskCost,
  runTask,
  type AnalysisTask,
  type AnalyzeDeps,
  type EstimatedCost,
} from '../openai.js';
import { renderTranscript } from '../prompt.js';
import { BUILTIN_TEMPLATES, builtinBySlug } from './templates.js';
import {
  REPORT_PROMPT_VERSION,
  RawReport,
  normalizeRawReport,
  reportJsonSchema,
} from './contract.js';
import { REPORT_SYSTEM_PROMPT, reportUserMessage } from './prompt.js';
import {
  allowedOwners,
  buildReport,
  esUtilReporte,
  personOf,
  type AllowedOwner,
  type ReportHeader,
  type ResolvedReport,
} from './build.js';

/**
 * Reportes de plantilla: leer el catálogo, editarlo y generar.
 *
 * ── Aislamiento ────────────────────────────────────────────────────────────
 *
 * Cada función recibe el `AppScope` ya resuelto —sesión, membresía, cliente real
 * y módulo habilitado— y VUELVE a acotar por tenant y cliente en cada consulta,
 * igual que `uiRead` y el servicio del resumen.
 *
 * ── Cómo no se gasta dos veces ─────────────────────────────────────────────
 *
 * La identidad de un reporte es el digest de sus ENTRADAS. Antes de llamar a
 * nadie se reserva la fila de ese digest; quien no consiga la reserva no llama.
 * Un doble clic y una recarga comparten digest, así que comparten fila y
 * llamada. Editar las instrucciones cambia el digest, así que es otro reporte y
 * otro cobro — explícitamente, que es lo que se pidió.
 *
 * ── Qué NO toca esto ───────────────────────────────────────────────────────
 *
 * `meetings.active_analysis_id` y `meetings.analysis_state`. Son del resumen.
 * Generar un reporte no los lee, no los escribe y no los bloquea.
 */

/**
 * El ámbito de los reportes, con el ROL dentro.
 *
 * Mismo patrón que `DeletionScope`: `AppScope` no lleva rol porque la mayoría
 * de las operaciones del módulo no dependen de él, y las que sí lo piden lo
 * declaran en su tipo para que no se pueda olvidar al llamarlas.
 */
export interface ReportsScope extends AppScope {
  readonly role: 'owner' | 'admin' | 'member';
}

/**
 * Sólo `owner` y `admin` editan o restauran plantillas.
 *
 * Se comprueba AQUÍ, en el servidor, y no sólo escondiendo el botón: ocultarlo
 * es cortesía con quien no puede, no una defensa contra quien llama a la ruta a
 * mano.
 */
function requireAdmin(scope: ReportsScope): void {
  if (scope.role !== 'owner' && scope.role !== 'admin') {
    throw new MeetingsApiError(
      'forbidden',
      'Editar las plantillas de reporte requiere permisos de administrador.',
    );
  }
}

async function requireMeeting(scope: AppScope, meetingId: string) {
  const meeting = await meetingsRepo.getMeetingScoped(meetingId, scope.tenantId, scope.clientId);
  if (!meeting) throw notFound();
  return meeting;
}

// ══════════════════════════════════════════════════════════════════════════
//  El catálogo de plantillas
// ══════════════════════════════════════════════════════════════════════════

export interface TemplateView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** Lo editable. Es lo único del prompt que sale por la API. */
  readonly instructions: string;
  readonly version: number;
  /** true = tiene predeterminado en código, así que se puede restaurar. */
  readonly isBuiltin: boolean;
  /** true = las instrucciones ya no son las del predeterminado. */
  readonly modified: boolean;
  readonly updatedAt: string;
}

function vistaPlantilla(row: templatesRepo.TemplateRow): TemplateView {
  const builtin = row.is_builtin ? builtinBySlug(row.slug) : null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    version: row.version,
    isBuiltin: row.is_builtin,
    // Se compara con el predeterminado DEL CÓDIGO, que es el único que puede
    // decir si esto está modificado. Sin `trim` sería «modificado» por un salto
    // de línea de más al guardar.
    modified: builtin !== null && builtin.instructions.trim() !== row.instructions.trim(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * El catálogo del cliente, materializando lo que falte.
 *
 * La siembra ocurre en la LECTURA y no en la migración: enumerar todos los
 * clientes en un `up()` dejaría sin plantillas a los que se creen después, y
 * obligaría a un backfill que hay que recordar. Aquí es idempotente —el UNIQUE
 * por `(tenant, cliente, slug)` la hace inofensiva— y funciona igual para un
 * cliente creado mañana.
 */
export async function listTemplates(scope: AppScope): Promise<TemplateView[]> {
  const existentes = await templatesRepo.listForClient(scope.tenantId, scope.clientId);
  const presentes = new Set(existentes.map((t) => t.slug));
  const faltan = BUILTIN_TEMPLATES.filter((b) => !presentes.has(b.slug));

  if (faltan.length > 0) {
    await templatesRepo.seedMissing(
      faltan.map((b) => ({
        tenantId: scope.tenantId,
        clientId: scope.clientId,
        slug: b.slug,
        name: b.name,
        description: b.description,
        instructions: b.instructions,
        userId: scope.userId ?? null,
      })),
    );
    const tras = await templatesRepo.listForClient(scope.tenantId, scope.clientId);
    return tras.map(vistaPlantilla);
  }
  return existentes.map(vistaPlantilla);
}

export interface EditTemplateInput {
  readonly templateId: string;
  readonly instructions: string;
  /** La versión que el editor creía estar editando. Evita perder ediciones. */
  readonly expectedVersion: number;
}

/**
 * Guarda instrucciones nuevas como una versión nueva.
 *
 * Falla con `conflict` si alguien guardó antes: el testigo de versión no
 * coincide y NO se sobrescribe. La pantalla vuelve a leer y el usuario decide.
 */
export async function editTemplate(
  scope: ReportsScope,
  input: EditTemplateInput,
): Promise<TemplateView> {
  requireAdmin(scope);
  const actual = await templatesRepo.findByIdScoped(input.templateId, scope.tenantId, scope.clientId);
  if (!actual) throw notFound();

  const texto = input.instructions.trim();
  if (texto === '') {
    throw invalidRequest('Las instrucciones no pueden quedar vacías.');
  }
  if (texto.length > 6000) {
    throw invalidRequest('Las instrucciones son demasiado largas (máximo 6000 caracteres).');
  }

  const r = await templatesRepo.writeNewVersion({
    id: actual.id,
    tenantId: scope.tenantId,
    clientId: scope.clientId,
    expectedVersion: input.expectedVersion,
    name: actual.name,
    description: actual.description,
    instructions: texto,
    changeKind: 'edit',
    userId: scope.userId ?? null,
  });
  if (!r.ok) {
    throw new MeetingsApiError(
      // 409, y el mismo código que usa el módulo para «el estado cambió
      // debajo». No se sobrescribe nada: quien edite vuelve a leer.
      'invalid_transition',
      `Alguien guardó otra versión de esta plantilla mientras la editabas (ahora es la v${r.current?.version ?? '?'}). Vuelve a abrirla para no perder su cambio.`,
    );
  }
  return vistaPlantilla(r.row);
}

/**
 * Devuelve la plantilla a su predeterminado, como versión NUEVA.
 *
 * No revierte el historial ni baja el número de versión: restaurar es un cambio
 * más, y un contador que baja haría que dos versiones distintas compartieran
 * número. Queda anotado como `restore` para distinguirlo de una edición.
 */
export async function restoreTemplate(
  scope: ReportsScope,
  templateId: string,
  expectedVersion: number,
): Promise<TemplateView> {
  requireAdmin(scope);
  const actual = await templatesRepo.findByIdScoped(templateId, scope.tenantId, scope.clientId);
  if (!actual) throw notFound();
  const builtin = actual.is_builtin ? builtinBySlug(actual.slug) : null;
  if (!builtin) {
    throw new MeetingsApiError(
      'invalid_transition',
      'Esta plantilla no tiene versión predeterminada a la que volver.',
    );
  }

  const r = await templatesRepo.writeNewVersion({
    id: actual.id,
    tenantId: scope.tenantId,
    clientId: scope.clientId,
    expectedVersion,
    name: builtin.name,
    description: builtin.description,
    instructions: builtin.instructions,
    changeKind: 'restore',
    userId: scope.userId ?? null,
  });
  if (!r.ok) {
    throw new MeetingsApiError(
      'invalid_transition',
      `Alguien guardó otra versión de esta plantilla mientras la mirabas (ahora es la v${r.current?.version ?? '?'}). Vuelve a abrirla.`,
    );
  }
  return vistaPlantilla(r.row);
}

// ══════════════════════════════════════════════════════════════════════════
//  Los reportes
// ══════════════════════════════════════════════════════════════════════════

export interface ReportView {
  readonly id: string;
  readonly templateId: string;
  readonly templateName: string;
  readonly templateVersion: number;
  readonly transcriptId: string;
  /** true = se hizo sobre una versión de transcripción que ya no es la activa. */
  readonly outdated: boolean;
  readonly status: 'pending' | 'ready' | 'failed';
  readonly report: ResolvedReport | null;
  readonly model: string;
  readonly modelReturned: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Coste ESTIMADO, nunca el facturado. `null` = tarifa desconocida. */
  readonly costUsd: number | null;
  readonly costEstimated: true;
  readonly createdAt: string;
  /**
   * Las instrucciones con las que se generó. Se devuelven porque son del
   * usuario y son la única forma de entender por qué un reporte viejo dice lo
   * que dice; el prompt interno NUNCA sale por aquí.
   */
  readonly instructionsSnapshot: string;
}

function vistaReporte(
  row: analysesRepo.AnalysisRow,
  transcriptActivo: string | null,
  nombrePlantilla: string,
): ReportView {
  return {
    id: row.id,
    templateId: row.template_id ?? '',
    templateName: nombrePlantilla,
    templateVersion: row.template_version ?? 0,
    transcriptId: row.transcript_id,
    outdated: transcriptActivo !== null && row.transcript_id !== transcriptActivo,
    status: row.status,
    report: row.status === 'ready' && row.payload ? (row.payload as unknown as ResolvedReport) : null,
    model: row.model,
    modelReturned: row.model_returned,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    costEstimated: true,
    createdAt: row.created_at.toISOString(),
    instructionsSnapshot: row.instructions_snapshot ?? '',
  };
}

/** El historial de reportes de una reunión. Nunca genera nada ni gasta nada. */
export async function listReports(scope: AppScope, meetingId: string): Promise<ReportView[]> {
  const meeting = await requireMeeting(scope, meetingId);
  const [filas, plantillas] = await Promise.all([
    analysesRepo.listReports(meetingId, scope.tenantId, scope.clientId),
    templatesRepo.listForClient(scope.tenantId, scope.clientId),
  ]);
  const nombres = new Map(plantillas.map((t) => [t.id, t.name]));
  return filas.map((f) =>
    vistaReporte(f, meeting.active_transcript_id, nombres.get(f.template_id ?? '') ?? 'Plantilla eliminada'),
  );
}

/**
 * El digest de las entradas: la identidad de un reporte.
 *
 * Entra TODO lo que puede cambiar el resultado. Si algo que influye quedara
 * fuera, dos generaciones distintas compartirían fila y la segunda devolvería
 * el resultado de la primera como si fuera suyo.
 *
 * La versión del prompt interno entra también: cuando cambiemos las reglas del
 * sistema, los reportes nuevos deben poder convivir con los viejos en vez de
 * chocar con ellos.
 *
 * Las partes van separadas por `\\n` y prefijadas: sin separador, mover un
 * carácter de un campo al siguiente daría el mismo digest.
 */
export function inputsDigest(parts: {
  readonly transcriptId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly instructions: string;
  readonly model: string;
  readonly promptVersion: number;
}): string {
  const h = createHash('sha256');
  h.update(`transcript:${parts.transcriptId}\n`);
  h.update(`template:${parts.templateId}\n`);
  h.update(`templateVersion:${parts.templateVersion}\n`);
  h.update(`model:${parts.model}\n`);
  h.update(`promptVersion:${parts.promptVersion}\n`);
  h.update(`instructions:${parts.instructions}`);
  return h.digest('hex');
}

async function fuente(
  transcriptId: string,
): Promise<{ segments: SourceSegment[]; speakers: SourceSpeaker[] }> {
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

/** La tarea, con la lista cerrada de responsables ya dentro del esquema. */
function tareaDeReporte(
  instructions: string,
  allowed: readonly AllowedOwner[],
): AnalysisTask<RawReport> {
  return {
    name: 'meeting_report',
    systemPrompt: REPORT_SYSTEM_PROMPT,
    jsonSchema: reportJsonSchema(allowed.map((o) => o.display)),
    userMessage: (rendered) => reportUserMessage(instructions, rendered),
    parse: (json) => {
      const parsed = RawReport.safeParse(json);
      if (parsed.success) return { ok: true, value: parsed.data };
      return {
        ok: false,
        fields: parsed.error.issues.map((i) => i.path.join('.')).slice(0, 6).join(', '),
      };
    },
    normalize: normalizeRawReport,
    promptVersion: REPORT_PROMPT_VERSION,
  };
}

/**
 * La cabecera, ENTERA desde la base.
 *
 * El modelo no escribe nada de esto y no tiene dónde escribirlo. Es lo que
 * convierte «no inventar asistentes» en una propiedad estructural: los
 * participantes son los hablantes de esta versión, con su nombre real si lo
 * tienen y su «Hablante N» si no.
 */
async function cabecera(
  scope: AppScope,
  meeting: meetingsRepo.MeetingRow,
  speakers: readonly SourceSpeaker[],
  durationSeconds: number | null,
): Promise<ReportHeader> {
  const client = await getClientById({ tenantId: scope.tenantId, clientId: scope.clientId });
  return {
    title: meeting.title,
    clientName: client?.name ?? '—',
    dateIso: (meeting.started_at ?? meeting.created_at).toISOString(),
    dateIsUpload: meeting.started_at === null,
    durationSeconds,
    participants: speakers.map((s) => personOf(s.label, speakers).by),
  };
}

/**
 * La duración, medida sobre los SEGMENTOS de esta versión exacta.
 *
 * No se consulta `duration_seconds` de la versión activa: si la reunión se
 * reprocesó mientras generábamos, esa consulta devolvería la duración de otro
 * texto. Lo que ya tenemos en memoria pertenece con certeza a la versión con la
 * que se hizo este reporte.
 */
function duracionDe(segments: readonly SourceSegment[]): number | null {
  if (segments.length === 0) return null;
  return Math.max(...segments.map((s) => s.endSec));
}

export interface PreviewReportCost extends EstimatedCost {
  readonly segments: number;
  readonly truncated: boolean;
  readonly alreadyGenerated: boolean;
  readonly allowedOwners: number;
}

/** Cuánto costaría, SIN llamar a nadie. Lo que se enseña antes de la primera vez. */
export async function previewReportCost(
  scope: AppScope,
  meetingId: string,
  templateId: string,
): Promise<PreviewReportCost> {
  const meeting = await requireMeeting(scope, meetingId);
  const activo = meeting.active_transcript_id;
  if (!activo) {
    throw new MeetingsApiError('invalid_transition', 'La reunión todavía no tiene transcripción.');
  }
  const plantilla = await templatesRepo.findByIdScoped(templateId, scope.tenantId, scope.clientId);
  if (!plantilla) throw notFound();

  const { segments, speakers } = await fuente(activo);
  const participantes = await transcriptsRepo.listMeetingParticipants(
    meetingId, scope.tenantId, scope.clientId,
  );
  const allowed = allowedOwners(speakers, participantes.map((p) => p.display_name));
  const rendered = renderTranscript(segments, speakers);
  const model = process.env.MEETINGS_ANALYSIS_MODEL ?? DEFAULT_MODEL;
  const digest = inputsDigest({
    transcriptId: activo,
    templateId: plantilla.id,
    templateVersion: plantilla.version,
    instructions: plantilla.instructions,
    model,
    promptVersion: REPORT_PROMPT_VERSION,
  });
  const existente = await analysesRepo.findReportByInputs(
    activo, digest, scope.tenantId, scope.clientId,
  );
  return {
    ...estimateTaskCost(tareaDeReporte(plantilla.instructions, allowed), rendered, model),
    segments: rendered.includedSegments,
    truncated: rendered.truncated,
    alreadyGenerated: existente !== null && existente.status === 'ready',
    allowedOwners: allowed.length,
  };
}

export interface GenerateReportResult {
  readonly state: 'ready' | 'generating';
  readonly view: ReportView | null;
  /** true = no se llamó al proveedor. */
  readonly reused: boolean;
  readonly droppedRefs: number;
  readonly rejectedOwners: number;
  readonly rejectedDues: number;
  readonly items: number;
}

export async function generateReport(
  scope: ReportsScope,
  meetingId: string,
  templateId: string,
  deps: AnalyzeDeps = {},
): Promise<GenerateReportResult> {
  const meeting = await requireMeeting(scope, meetingId);
  // Una reunión en eliminación no genera reportes. No escribe en R2, pero sí
  // crea una fila y cuesta dinero: pagar por informar de algo que está a punto
  // de desaparecer no tiene defensa.
  if (meeting.deletion_state !== 'live') {
    throw new MeetingsApiError('invalid_transition', 'Esta reunión está en proceso de eliminación.');
  }

  // LA VERSIÓN SE CAPTURA AQUÍ Y NO SE VUELVE A LEER. Si la reunión se
  // reprocesa mientras generamos, las entradas de esta generación no cambian a
  // mitad: el reporte se guarda contra la versión con la que se hizo, y la
  // pantalla lo marcará como desactualizado.
  const transcriptId = meeting.active_transcript_id;
  if (!transcriptId) {
    throw new MeetingsApiError(
      'invalid_transition',
      'La reunión todavía no tiene transcripción sobre la que informar.',
    );
  }

  const plantilla = await templatesRepo.findByIdScoped(templateId, scope.tenantId, scope.clientId);
  if (!plantilla) throw notFound();
  // El snapshot se toma AQUÍ, de la misma lectura que fija la versión. Si la
  // plantilla se edita después, este reporte ya no depende de ella.
  const instructions = plantilla.instructions;
  const templateVersion = plantilla.version;

  const { segments, speakers } = await fuente(transcriptId);
  if (segments.length === 0) {
    throw new MeetingsApiError('invalid_transition', 'La transcripción no tiene segmentos.');
  }
  const participantes = await transcriptsRepo.listMeetingParticipants(
    meetingId, scope.tenantId, scope.clientId,
  );
  const allowed = allowedOwners(speakers, participantes.map((p) => p.display_name));

  const model = deps.model ?? process.env.MEETINGS_ANALYSIS_MODEL ?? DEFAULT_MODEL;
  const digest = inputsDigest({
    transcriptId,
    templateId: plantilla.id,
    templateVersion,
    instructions,
    model,
    promptVersion: REPORT_PROMPT_VERSION,
  });

  // ── La reserva, ANTES de gastar ─────────────────────────────────────────
  const reservedBy = randomUUID();
  const { row: reservada, owned } = await analysesRepo.reserveReport({
    tenantId: scope.tenantId,
    clientId: scope.clientId,
    meetingId,
    transcriptId,
    provider: 'openai',
    model,
    promptVersion: REPORT_PROMPT_VERSION,
    reservedBy,
    createdByUserId: scope.userId ?? null,
    templateId: plantilla.id,
    templateVersion,
    instructionsSnapshot: instructions,
    inputsDigest: digest,
  });

  if (!owned) {
    // Otra petición la tiene, o ya está hecho. En ninguno de los dos casos se
    // vuelve a llamar al proveedor.
    const v = vistaReporte(reservada, transcriptId, plantilla.name);
    return {
      state: reservada.status === 'ready' ? 'ready' : 'generating',
      view: reservada.status === 'ready' ? v : null,
      reused: true,
      droppedRefs: 0,
      rejectedOwners: 0,
      rejectedDues: 0,
      items: 0,
    };
  }

  const rendered = renderTranscript(segments, speakers);
  const tarea = tareaDeReporte(instructions, allowed);
  let resultado;
  try {
    resultado = await runTask(tarea, rendered, { ...deps, model });
  } catch (causa) {
    // La reserva se libera para que se pueda reintentar; el consumo de una
    // llamada que falló a mitad no se conoce, así que queda en cero.
    await analysesRepo.failReservation(reservada.id, reservedBy, {
      inputTokens: 0, outputTokens: 0, costUsd: null, durationMs: null, modelReturned: null,
    });
    if (causa instanceof AnalysisError) {
      throw new MeetingsApiError(
        causa.code === 'no_key' ? 'analysis_not_configured' : 'analysis_failed',
        causa.code === 'no_key'
          ? 'Los reportes no están configurados en este entorno: falta la clave del proveedor.'
          : `No se pudo generar el reporte (${causa.code}).`,
      );
    }
    throw causa;
  }

  const construido = buildReport({
    raw: resultado.raw,
    segments,
    speakers,
    allowed,
    header: await cabecera(scope, meeting, speakers, duracionDe(segments)),
  });

  if (!esUtilReporte(construido.report)) {
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
        ? `El reporte no citó ningún segmento válido de esta transcripción (${construido.droppedRefs} referencia(s) descartadas).`
        : 'El reporte no produjo contenido utilizable.',
    );
  }

  const fila = await analysesRepo.complete({
    id: reservada.id,
    reservedBy,
    payload: construido.report,
    modelReturned: resultado.modelReturned,
    inputTokens: resultado.inputTokens,
    outputTokens: resultado.outputTokens,
    costUsd: resultado.costUsd,
    durationMs: resultado.durationMs,
  });
  if (!fila) {
    // Otra petición se apropió de la reserva por caducidad mientras llamábamos.
    const actual = await analysesRepo.findReportByInputs(
      transcriptId, digest, scope.tenantId, scope.clientId,
    );
    return {
      state: actual?.status === 'ready' ? 'ready' : 'generating',
      view: actual && actual.status === 'ready' ? vistaReporte(actual, transcriptId, plantilla.name) : null,
      reused: true,
      droppedRefs: construido.droppedRefs,
      rejectedOwners: construido.rejectedOwners,
      rejectedDues: construido.rejectedDues,
      items: construido.items,
    };
  }

  // NO se toca `active_analysis_id` ni `analysis_state`: son del resumen. Un
  // reporte no tiene puntero porque no lo necesita — se encuentra por su
  // digest, y el historial se lista por reunión.
  return {
    state: 'ready',
    view: vistaReporte(fila, meeting.active_transcript_id, plantilla.name),
    reused: false,
    droppedRefs: construido.droppedRefs,
    rejectedOwners: construido.rejectedOwners,
    rejectedDues: construido.rejectedDues,
    items: construido.items,
  };
}
