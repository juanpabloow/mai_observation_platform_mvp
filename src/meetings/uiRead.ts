import * as jobsRepo from '../db/repositories/meetings/jobs.js';
import * as meetingsRepo from '../db/repositories/meetings/meetings.js';
import * as transcriptsRepo from '../db/repositories/meetings/transcripts.js';
import type { PrivateObjectStore } from '../storage/privateObjectStore.js';
import { notFound } from './errors.js';
import type { AppScope } from './service.js';

/**
 * Las lecturas que alimentan la pantalla de Reuniones.
 *
 * ── Por qué aquí y no en `service.ts` ───────────────────────────────────────
 *
 * `service.ts` es el contrato de la API de MÁQUINA: claim, lease, result,
 * fail. Esto es lo contrario — lecturas de sesión para una persona con un
 * navegador — y mezclarlas haría que un cambio en la pantalla tocara el fichero
 * del que depende el worker.
 *
 * `getMeetingState` sigue existiendo y sigue siendo lo que la API expone para
 * el estado del pipeline. Lo que faltaba, y es lo que hay aquí, es el TEXTO:
 * hasta W-3 no había forma de leer una transcripción, porque el repositorio
 * tenía `countSegments` y no un lector de segmentos.
 *
 * ── El aislamiento se aplica en cada función, no una vez ────────────────────
 *
 * Cada lectura recibe el `AppScope` ya resuelto —que es sesión + membresía +
 * cliente real + módulo habilitado— y vuelve a acotar por `tenant_id` y
 * `client_id` en el WHERE. Es deliberadamente redundante: el ámbito ya está
 * verificado, pero una consulta que sólo filtra por el uuid de la reunión es a
 * una refactorización de distancia de devolver la reunión de otro cliente.
 */

export interface UiSpeaker {
  readonly label: string;
  readonly speakerId: string | null;
  readonly displayName: string | null;
  readonly talkSharePct: number | null;
}

export interface UiSegment {
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly speakerLabel: string | null;
  readonly text: string;
  readonly overlap: boolean;
  readonly confidence: number | null;
}

export interface UiMeetingRow {
  readonly id: string;
  readonly title: string;
  readonly sourceKind: string;
  /** Cuándo se celebró. NULL de verdad cuando nadie lo declaró. */
  readonly startedAt: string | null;
  /** Cuándo se subió. Nunca se presenta como fecha de celebración. */
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mediaState: string;
  readonly transcriptState: string;
  readonly diarizationState: string;
  readonly analysisState: string;
  readonly cancelledAt: string | null;
  readonly warnings: readonly unknown[];
  readonly originalBytes: number | null;
  readonly durationSeconds: number | null;
  readonly segmentCount: number | null;
  readonly language: string | null;
  readonly activeTranscriptId: string | null;
  readonly speakerCount: number;
  readonly speakers: readonly UiSpeaker[];
  readonly runningStage: string | null;
  readonly runningProgressPct: number | null;
  readonly failureCode: string | null;
}

export interface UiMeetingDetail extends UiMeetingRow {
  readonly whisperModel: string | null;
  readonly diarizationBackend: string | null;
  readonly segments: readonly UiSegment[];
  /** true si hay un `normalized` vivo que se pueda firmar para reproducir. */
  readonly hasPlayableAudio: boolean;
}

const num = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * El `jsonb_agg` del listado. `numeric` viaja como número dentro del JSON de
 * PostgreSQL, así que se normaliza aquí y no se confía en el tipo que llegue.
 */
function parseSpeakers(raw: unknown): UiSpeaker[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const row = entry as Record<string, unknown>;
    return {
      label: String(row.label ?? ''),
      speakerId: row.speakerId === null || row.speakerId === undefined ? null : String(row.speakerId),
      displayName:
        row.displayName === null || row.displayName === undefined ? null : String(row.displayName),
      talkSharePct:
        row.talkSharePct === null || row.talkSharePct === undefined ? null : Number(row.talkSharePct),
    };
  });
}

function toRow(row: meetingsRepo.MeetingListRow): UiMeetingRow {
  return {
    id: row.id,
    title: row.title,
    sourceKind: row.source_kind,
    startedAt: row.started_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    mediaState: row.media_state,
    transcriptState: row.transcript_state,
    diarizationState: row.diarization_state,
    analysisState: row.analysis_state,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    originalBytes: num(row.original_bytes),
    durationSeconds: num(row.duration_seconds),
    segmentCount: row.segment_count,
    language: row.language,
    activeTranscriptId: row.active_transcript_id,
    speakerCount: row.speaker_count,
    speakers: parseSpeakers(row.speakers),
    runningStage: row.running_stage,
    runningProgressPct: row.running_progress_pct,
    failureCode: row.failure_code,
  };
}

export async function listMeetingsForUi(scope: AppScope): Promise<UiMeetingRow[]> {
  const rows = await meetingsRepo.listMeetingsForClient(scope.tenantId, scope.clientId);
  return rows.map(toRow);
}

/**
 * Una reunión con su texto y sus hablantes, o `null`.
 *
 * Devuelve `null` en vez de lanzar: la página lo traduce a `notFound()`, y así
 * «no existe», «es de otro cliente» y «el módulo está apagado» acaban en la
 * misma pantalla sin que esta función tenga que saber de HTTP.
 */
export async function getMeetingForUi(
  scope: AppScope,
  meetingId: string,
): Promise<UiMeetingDetail | null> {
  const row = await meetingsRepo.getMeetingListRowScoped(meetingId, scope.tenantId, scope.clientId);
  if (!row) return null;

  const transcript = row.active_transcript_id
    ? await transcriptsRepo.getActiveTranscript(meetingId)
    : null;

  const [speakers, segments, normalized] = await Promise.all([
    transcript ? transcriptsRepo.listTranscriptSpeakers(transcript.id) : Promise.resolve([]),
    transcript ? transcriptsRepo.listSegments(transcript.id) : Promise.resolve([]),
    findPlayableNormalized(meetingId, transcript?.run_id ?? null),
  ]);

  return {
    ...toRow(row),
    whisperModel: transcript?.whisper_model ?? null,
    diarizationBackend: transcript?.diarization_backend ?? null,
    speakers: speakers.map((speaker) => ({
      label: speaker.speaker_label,
      speakerId: speaker.speaker_id ?? null,
      displayName: speaker.display_name,
      talkSharePct: speaker.talk_share_pct === null ? null : Number(speaker.talk_share_pct),
    })),
    segments: segments.map((segment) => ({
      index: segment.segment_index,
      startSec: Number(segment.start_sec),
      endSec: Number(segment.end_sec),
      speakerLabel: segment.speaker_label,
      text: segment.text,
      overlap: segment.overlap,
      confidence: segment.confidence === null ? null : Number(segment.confidence),
    })),
    hasPlayableAudio: normalized !== null,
  };
}

/**
 * El audio que se reproduce es el NORMALIZADO, no el original.
 *
 * Dos razones. Es 16 kHz mono WAV, o sea un formato que todo navegador decodifica
 * sin depender de qué contenedor subió el usuario; y es el fichero sobre el que
 * se midieron los tiempos de los segmentos, así que el playhead y la
 * transcripción hablan del mismo reloj. Servir el original haría que un `.m4a`
 * con un offset de contenedor desplazara todas las marcas.
 *
 * Se prefiere el del run de la versión ACTIVA. `meeting_media_one_live_derived_idx`
 * garantiza uno por (run, rol), así que con varios runs hay varios normalizados
 * vivos y elegir «el más reciente» sería elegir uno que quizá no corresponde al
 * texto que se está leyendo.
 */
async function findPlayableNormalized(
  meetingId: string,
  runId: string | null,
): Promise<meetingsRepo.MeetingMediaRow | null> {
  if (runId) {
    const forRun = await meetingsRepo.findLiveDerived(runId, 'normalized');
    if (forRun) return forRun;
  }
  return meetingsRepo.findLatestLiveNormalized(meetingId);
}

/**
 * ¿Hay audio reproducible? Una consulta, sin leer la transcripción.
 *
 * La página del detalle necesita esto para decidir el estado del reproductor, y
 * llamarlo con `getMeetingForUi` traía los quince segmentos otra vez sólo para
 * mirar un booleano.
 */
export async function hasPlayableAudio(scope: AppScope, meetingId: string): Promise<boolean> {
  const row = await meetingsRepo.getMeetingListRowScoped(meetingId, scope.tenantId, scope.clientId);
  if (!row) return false;
  const transcript = row.active_transcript_id
    ? await transcriptsRepo.getActiveTranscript(meetingId)
    : null;
  return (await findPlayableNormalized(meetingId, transcript?.run_id ?? null)) !== null;
}

export interface SignedMedia {
  readonly url: string;
  readonly expiresAt: string;
  readonly bytes: number;
  readonly durationSeconds: number | null;
  readonly contentType: string;
}

/**
 * Firma un GET temporal del audio normalizado de una reunión.
 *
 * Las tres comprobaciones ocurren ANTES de tocar el almacenamiento:
 *
 *   1. `scope` ya trae sesión + membresía + cliente real + módulo habilitado
 *      (lo resuelve `resolveAppScope`, el mismo resolutor de las otras rutas);
 *   2. la reunión se lee acotada por `tenant_id` y `client_id`, así que un uuid
 *      de otro cliente no existe;
 *   3. el medio se busca por `meeting_id`, y su clave se verifica contra el
 *      ámbito antes de firmar.
 *
 * La comprobación 3 es el cinturón. La clave la deriva el servidor y no debería
 * poder apuntar fuera de la reunión, pero firmar un GET es dar acceso al objeto
 * durante toda su vigencia: si algún día una clave mal escrita entra en la
 * tabla, esto se niega en vez de emitir la URL.
 *
 * El bucket sigue siendo PRIVADO. No se configura dominio público ni se hace
 * proxy del audio por la aplicación: lo que se entrega es una URL firmada que
 * caduca, y la caducidad es la de `MEETINGS_STORAGE_GET_TTL_SECONDS`.
 */
export async function signMeetingAudio(
  scope: AppScope,
  meetingId: string,
  deps: { readonly store: PrivateObjectStore },
): Promise<SignedMedia> {
  const row = await meetingsRepo.getMeetingListRowScoped(meetingId, scope.tenantId, scope.clientId);
  if (!row) throw notFound();

  const transcript = row.active_transcript_id
    ? await transcriptsRepo.getActiveTranscript(meetingId)
    : null;
  const media = await findPlayableNormalized(meetingId, transcript?.run_id ?? null);
  // Un 404 y no un 409: desde el navegador, «esta reunión todavía no tiene
  // audio reproducible» y «esta reunión no existe» no necesitan distinguirse, y
  // distinguirlos diría que el uuid es real.
  if (!media) throw notFound();

  if (!keyBelongsToMeeting(media.storage_key, scope.tenantId, scope.clientId, meetingId)) {
    throw notFound();
  }

  const signed = await deps.store.signGet({ key: media.storage_key, forRangeReads: true });
  return {
    url: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
    bytes: Number(media.bytes),
    durationSeconds: media.duration_seconds === null ? null : Number(media.duration_seconds),
    contentType: media.content_type,
  };
}

/**
 * La clave la deriva el servidor con el esquema
 * `t/{tenant}/c/{client}/m/{meeting}/…`, así que comprobar el prefijo es
 * comprobar que el objeto pertenece a esta reunión de este cliente de este
 * tenant. No se parsea la clave para extraer datos —eso convertiría una cadena
 * opaca en un índice—; sólo se compara con el prefijo que debería tener.
 */
export function keyBelongsToMeeting(
  key: string,
  tenantId: string,
  clientId: string,
  meetingId: string,
): boolean {
  return key.startsWith(`t/${tenantId}/c/${clientId}/m/${meetingId}/`);
}
