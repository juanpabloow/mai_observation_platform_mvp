import { q, type Queryable } from './types.js';
import type { DiarizationState, MeetingMediaState, TranscriptState } from './types.js';
import type { DeletionState } from './deletion.js';

/**
 * Reuniones y sus medios.
 *
 * Toda lectura va SIEMPRE con `tenant_id` y `client_id` en el WHERE, aunque el
 * `id` sea un uuid y por tanto único. No es redundante: un uuid adivinado o
 * filtrado seguiría siendo válido, y con el ámbito en la consulta un id de otro
 * cliente no devuelve fila — que es lo que convierte «no autorizado» en
 * «no encontrado» sin que ninguna capa de arriba tenga que acordarse.
 */

export interface MeetingRow {
  id: string;
  tenant_id: string;
  client_id: string;
  title: string;
  source_kind: string;
  started_at: Date | null;
  language_hint: string | null;
  active_transcript_id: string | null;
  /** MEET-5: el resumen activo. La columna existe desde MEET-1. */
  active_analysis_id: string | null;
  media_state: MeetingMediaState;
  transcript_state: TranscriptState;
  diarization_state: DiarizationState;
  analysis_state: string;
  warnings: unknown[];
  idempotency_key: string;
  retention_policy: Record<string, unknown>;
  cancelled_at: Date | null;
  /** 'live' | 'deleting' | 'delete_failed'. Ver migración 1784200000000. */
  deletion_state: DeletionState;
  deletion_not_before: Date | null;
  original_put_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateMeetingInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly title: string;
  readonly sourceKind: 'file' | 'meet' | 'inbox' | 'room' | 'api';
  readonly idempotencyKey: string;
  readonly startedAt?: Date | null;
  readonly languageHint?: string | null;
  readonly createdByUserId?: string | null;
  readonly requestedOptions?: Record<string, unknown>;
}

export interface CreateMeetingResult {
  readonly meeting: MeetingRow;
  /** false = ya existía con esa clave de idempotencia y se devuelve la misma. */
  readonly created: boolean;
}

/**
 * Crea una reunión, o devuelve la existente si la clave de idempotencia ya se
 * usó en este cliente.
 *
 * `ON CONFLICT DO NOTHING` + relectura, en vez de `DO UPDATE`: si la fila ya
 * existe no hay nada que actualizar —la reunión es de quien la creó primero— y
 * un `DO UPDATE` permitiría que una segunda llamada con el mismo idempotency_key
 * y otro título renombrara una reunión ajena.
 */
export async function createMeeting(
  input: CreateMeetingInput,
  executor?: Queryable,
): Promise<CreateMeetingResult> {
  const inserted = await q(executor).query<MeetingRow>(
    `INSERT INTO meetings
       (tenant_id, client_id, title, source_kind, idempotency_key,
        started_at, language_hint, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, client_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      input.tenantId,
      input.clientId,
      input.title,
      input.sourceKind,
      input.idempotencyKey,
      input.startedAt ?? null,
      input.languageHint ?? null,
      input.createdByUserId ?? null,
    ],
  );
  if (inserted.rows.length === 1) return { meeting: inserted.rows[0], created: true };

  const existing = await q(executor).query<MeetingRow>(
    `SELECT * FROM meetings
      WHERE tenant_id = $1 AND client_id = $2 AND idempotency_key = $3`,
    [input.tenantId, input.clientId, input.idempotencyKey],
  );
  if (existing.rows.length !== 1) {
    // Imposible salvo carrera con un borrado: ni se inserta ni se encuentra.
    throw new Error('createMeeting: ni se insertó ni se encontró la reunión');
  }
  return { meeting: existing.rows[0], created: false };
}

export async function getMeetingScoped(
  meetingId: string,
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<MeetingRow | null> {
  const result = await q(executor).query<MeetingRow>(
    `SELECT * FROM meetings WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [meetingId, tenantId, clientId],
  );
  return result.rows[0] ?? null;
}

/** Sin cliente: para el worker, que conoce el job y de él saca el ámbito. */
export async function getMeetingById(
  meetingId: string,
  executor?: Queryable,
): Promise<MeetingRow | null> {
  const result = await q(executor).query<MeetingRow>(`SELECT * FROM meetings WHERE id = $1`, [meetingId]);
  return result.rows[0] ?? null;
}

export async function setMediaState(
  meetingId: string,
  state: MeetingMediaState,
  executor?: Queryable,
): Promise<void> {
  await q(executor).query(
    `UPDATE meetings SET media_state = $2, updated_at = now() WHERE id = $1`,
    [meetingId, state],
  );
}

export interface PipelineStateUpdate {
  readonly transcriptState?: TranscriptState;
  readonly diarizationState?: DiarizationState;
  readonly activeTranscriptId?: string | null;
  /** Se AÑADEN a `warnings`; nunca se reemplaza el array. */
  readonly appendWarnings?: readonly Record<string, unknown>[];
}

/**
 * Actualiza los estados del pipeline. Los avisos se CONCATENAN con `||` en SQL
 * en vez de leerse, modificarse y escribirse: dos etapas que terminan a la vez
 * perderían uno de los dos avisos con read-modify-write, y perder un aviso es
 * perder la única explicación de por qué una reunión salió «con avisos».
 */
export async function updatePipelineState(
  meetingId: string,
  update: PipelineStateUpdate,
  executor?: Queryable,
): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [meetingId];

  if (update.transcriptState !== undefined) {
    params.push(update.transcriptState);
    sets.push(`transcript_state = $${params.length}`);
  }
  if (update.diarizationState !== undefined) {
    params.push(update.diarizationState);
    sets.push(`diarization_state = $${params.length}`);
  }
  if (update.activeTranscriptId !== undefined) {
    params.push(update.activeTranscriptId);
    sets.push(`active_transcript_id = $${params.length}`);
  }
  if (update.appendWarnings && update.appendWarnings.length > 0) {
    params.push(JSON.stringify(update.appendWarnings));
    sets.push(`warnings = warnings || $${params.length}::jsonb`);
  }
  await q(executor).query(`UPDATE meetings SET ${sets.join(', ')} WHERE id = $1`, params);
}

/** Cancela dejando el autor como etiqueta (ver `meetings_cancel_coherent`). */
export async function cancelMeeting(
  meetingId: string,
  tenantId: string,
  clientId: string,
  actorLabel: string,
  actorUserId: string | null,
  executor?: Queryable,
): Promise<boolean> {
  const result = await q(executor).query(
    `UPDATE meetings
        SET cancelled_at = now(), cancelled_by_label = $4, cancelled_by_user_id = $5,
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND cancelled_at IS NULL`,
    [meetingId, tenantId, clientId, actorLabel, actorUserId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ── meeting_media ──────────────────────────────────────────────────────────

export interface MeetingMediaRow {
  id: string;
  tenant_id: string;
  client_id: string;
  meeting_id: string;
  run_id: string | null;
  role: 'original' | 'normalized' | 'raw_result';
  storage_key: string;
  bytes: string;
  checksum_sha256: string;
  content_type: string;
  duration_seconds: string | null;
  sample_rate: number | null;
  channels: number | null;
  codec: string | null;
  /** `true` = medido; NULL = nadie lo midió (el original). `false` es imposible. */
  probe_ok: boolean | null;
  created_at: Date;
}

export interface InsertMediaInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly meetingId: string;
  /** Obligatorio para todo lo que no sea 'original' (lo exige un CHECK). */
  readonly runId?: string | null;
  readonly role: 'original' | 'normalized' | 'raw_result';
  readonly storageKey: string;
  readonly bytes: number;
  readonly checksumSha256: string;
  readonly contentType: string;
  readonly durationSeconds?: number | null;
  readonly sampleRate?: number | null;
  readonly channels?: number | null;
  readonly codec?: string | null;
  readonly probeOk?: boolean | null;
}

/**
 * Inserta un medio. Si la clave ya existe devuelve la fila que había: es la
 * idempotencia de `upload-complete` y de `result/complete` reenviados, apoyada
 * en `meeting_media_key_unique UNIQUE (storage_key)` — una garantía de la base,
 * no un `SELECT` previo que otra transacción podría invalidar entre la lectura
 * y la escritura.
 */
export async function insertMedia(
  input: InsertMediaInput,
  executor?: Queryable,
): Promise<{ media: MeetingMediaRow; created: boolean }> {
  const inserted = await q(executor).query<MeetingMediaRow>(
    `INSERT INTO meeting_media
       (tenant_id, client_id, meeting_id, run_id, role, storage_key, bytes, checksum_sha256,
        content_type, duration_seconds, sample_rate, channels, codec, probe_ok)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (storage_key) DO NOTHING
     RETURNING *`,
    [
      input.tenantId,
      input.clientId,
      input.meetingId,
      input.runId ?? null,
      input.role,
      input.storageKey,
      input.bytes,
      input.checksumSha256,
      input.contentType,
      input.durationSeconds ?? null,
      input.sampleRate ?? null,
      input.channels ?? null,
      input.codec ?? null,
      input.probeOk ?? null,
    ],
  );
  if (inserted.rows.length === 1) return { media: inserted.rows[0], created: true };

  const existing = await q(executor).query<MeetingMediaRow>(
    `SELECT * FROM meeting_media WHERE storage_key = $1`,
    [input.storageKey],
  );
  if (existing.rows.length !== 1) throw new Error('insertMedia: conflicto sin fila');
  return { media: existing.rows[0], created: false };
}

export async function findMediaByKey(
  storageKey: string,
  executor?: Queryable,
): Promise<MeetingMediaRow | null> {
  const result = await q(executor).query<MeetingMediaRow>(
    `SELECT * FROM meeting_media WHERE storage_key = $1 AND deleted_at IS NULL`,
    [storageKey],
  );
  return result.rows[0] ?? null;
}

export async function findLiveOriginal(
  meetingId: string,
  executor?: Queryable,
): Promise<MeetingMediaRow | null> {
  const result = await q(executor).query<MeetingMediaRow>(
    `SELECT * FROM meeting_media
      WHERE meeting_id = $1 AND role = 'original' AND deleted_at IS NULL`,
    [meetingId],
  );
  return result.rows[0] ?? null;
}

/**
 * El medio derivado VIVO de un run, por rol. Una consulta por `run_id`, no una
 * reconstrucción de claves de objeto.
 *
 * `meeting_media_one_live_derived_idx` garantiza que hay como máximo uno, así
 * que esto devuelve una fila o ninguna — no «la más reciente de varias», que
 * sería una decisión escondida en un ORDER BY.
 */
export async function findLiveDerived(
  runId: string,
  role: 'normalized' | 'raw_result',
  executor?: Queryable,
): Promise<MeetingMediaRow | null> {
  const result = await q(executor).query<MeetingMediaRow>(
    `SELECT * FROM meeting_media
      WHERE run_id = $1 AND role = $2 AND deleted_at IS NULL`,
    [runId, role],
  );
  return result.rows[0] ?? null;
}

/**
 * El medio derivado que produjo UNA subida concreta, viva o ya superada.
 *
 * `findLiveDerived` responde «¿cuál es el insumo actual de este run?», que es
 * lo que necesita la etapa siguiente. Esto responde otra pregunta: «¿qué se
 * registró exactamente cuando se cerró esta subida?». La distinción importa
 * para la idempotencia terminal — se compara contra lo que quedó escrito para
 * ESE artefacto, no contra lo que hoy sea el vivo, que un reintento posterior
 * pudo haber sustituido.
 */
/**
 * El normalizado vivo más reciente de una reunión, sin importar el run.
 *
 * Sólo es el plan B de `findLiveDerived(runId, 'normalized')`: se usa cuando la
 * reunión no tiene versión de transcript activa —todavía no hay texto— y aun
 * así hay audio convertido que se puede reproducir. Con una versión activa se
 * prefiere SIEMPRE el del run de esa versión, porque es el fichero sobre el que
 * se midieron los tiempos de sus segmentos.
 */
export async function findLatestLiveNormalized(
  meetingId: string,
  executor?: Queryable,
): Promise<MeetingMediaRow | null> {
  const result = await q(executor).query<MeetingMediaRow>(
    `SELECT * FROM meeting_media
      WHERE meeting_id = $1 AND role = 'normalized' AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [meetingId],
  );
  return result.rows[0] ?? null;
}

export async function findDerivedByStorageKey(
  runId: string,
  role: 'normalized' | 'raw_result',
  storageKey: string,
  executor?: Queryable,
): Promise<MeetingMediaRow | null> {
  const result = await q(executor).query<MeetingMediaRow>(
    `SELECT * FROM meeting_media
      WHERE run_id = $1 AND role = $2 AND storage_key = $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [runId, role, storageKey],
  );
  return result.rows[0] ?? null;
}

/**
 * Retira el derivado vivo anterior de un (run, rol) antes de insertar el nuevo.
 *
 * Un reintento de `normalize` que vuelve a subir produce una versión nueva del
 * mismo insumo, no un segundo insumo. Se marca `deleted_at` en vez de borrar la
 * fila: el histórico sigue ahí para diagnosticar, simplemente deja de estar
 * VIVO — y el índice único parcial es lo que hace que «vivo» signifique algo.
 */
export async function supersedeLiveDerived(
  runId: string,
  role: 'normalized' | 'raw_result',
  keepStorageKey: string,
  executor?: Queryable,
): Promise<number> {
  const result = await q(executor).query(
    `UPDATE meeting_media
        SET deleted_at = now()
      WHERE run_id = $1 AND role = $2 AND deleted_at IS NULL AND storage_key <> $3`,
    [runId, role, keepStorageKey],
  );
  return result.rowCount ?? 0;
}

// ── La lectura del listado, para la UI ─────────────────────────────────────

export interface MeetingListRow {
  id: string;
  title: string;
  source_kind: string;
  started_at: Date | null;
  created_at: Date;
  updated_at: Date;
  media_state: MeetingMediaState;
  transcript_state: TranscriptState;
  diarization_state: DiarizationState;
  analysis_state: string;
  cancelled_at: Date | null;
  deletion_state: DeletionState;
  warnings: unknown[];
  /** Del medio original: lo que el usuario subió. NULL si aún no hay. */
  original_bytes: string | null;
  /** Del normalizado del run de la versión activa, que es lo que se reproduce. */
  duration_seconds: string | null;
  segment_count: number | null;
  language: string | null;
  active_transcript_id: string | null;
  /** Hablantes de la versión activa. 0 mientras no haya diarización. */
  speaker_count: number;
  /** Los mismos, con etiqueta, nombre y cuota. `[]` si no hay. */
  speakers: unknown;
  /** El progreso de la etapa en curso, para la fila del listado. */
  running_stage: string | null;
  running_progress_pct: number | null;
  failure_code: string | null;
}

/**
 * El listado de reuniones de UN cliente.
 *
 * Una sola consulta con laterales, no N+1: el listado muestra duración,
 * segmentos, hablantes y la etapa en curso de cada fila, y resolver eso con una
 * consulta por reunión convierte una pantalla en una tormenta de round-trips
 * contra una base que está al otro lado de internet.
 *
 * El filtro por `tenant_id` Y `client_id` va en el WHERE, no en la capa de
 * arriba: es la frontera de aislamiento del módulo y tiene que estar donde no se
 * pueda olvidar.
 *
 * Orden: `started_at` cuando existe y `created_at` si no —el mismo criterio que
 * `meetings_list_idx`—, porque una reunión importada puede tener fecha de
 * celebración anterior a su subida.
 */
/**
 * El SELECT, una sola vez. La lista y el detalle comparten exactamente las
 * mismas columnas derivadas; duplicar el SQL garantizaría que algún día la fila
 * del detalle diga una cosa y la del listado otra sobre la misma reunión.
 */
const LIST_SELECT = `
  SELECT m.id, m.title, m.source_kind, m.started_at, m.created_at, m.updated_at,
         m.media_state, m.transcript_state, m.diarization_state, m.analysis_state,
         m.cancelled_at, m.deletion_state, m.warnings, m.active_transcript_id,
         orig.bytes::text                       AS original_bytes,
         tv.duration_seconds::text              AS duration_seconds,
         tv.segment_count                       AS segment_count,
         tv.language                            AS language,
         COALESCE(sp.n, 0)::int                 AS speaker_count,
         COALESCE(sp.people, '[]'::jsonb)       AS speakers,
         run.stage                              AS running_stage,
         run.progress_pct                       AS running_progress_pct,
         fail.failure_code                      AS failure_code
    FROM meetings m
    LEFT JOIN LATERAL (
      SELECT bytes FROM meeting_media
       WHERE meeting_id = m.id AND role = 'original' AND deleted_at IS NULL
       LIMIT 1
    ) orig ON true
    LEFT JOIN meeting_transcript_versions tv ON tv.id = m.active_transcript_id
    -- Los hablantes de la fila, agregados en la MISMA consulta. El listado
    -- muestra avatares con la cuota de cada uno, y resolverlo con una consulta
    -- por reunión sería el N+1 que estos laterales existen para evitar.
    LEFT JOIN LATERAL (
      SELECT count(*) AS n,
             jsonb_agg(jsonb_build_object(
               'label', ts.speaker_label,
               'speakerId', ts.speaker_id,
               'displayName', s.display_name,
               'talkSharePct', ts.talk_share_pct
             ) ORDER BY ts.speaker_label) AS people
        FROM meeting_transcript_speakers ts
        LEFT JOIN meeting_speakers s ON s.id = ts.speaker_id
       WHERE ts.transcript_id = m.active_transcript_id
    ) sp ON true
    -- La etapa EN CURSO: la que tiene el lease o está en cola. Con varias, la
    -- más avanzada del pipeline, que es la que el usuario espera leer.
    LEFT JOIN LATERAL (
      SELECT stage, progress_pct FROM meeting_processing_jobs
       WHERE meeting_id = m.id AND status IN ('queued', 'leased', 'uploading_result')
       ORDER BY CASE stage WHEN 'normalize' THEN 1 WHEN 'transcribe' THEN 2 ELSE 3 END DESC
       LIMIT 1
    ) run ON true
    -- Y el último fallo terminal, para la fila «requiere atención».
    LEFT JOIN LATERAL (
      SELECT failure_code FROM meeting_processing_jobs
       WHERE meeting_id = m.id AND status = 'failed' AND failure_code IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 1
    ) fail ON true
`;

/**
 * El listado de reuniones de UN cliente.
 *
 * Una sola consulta con laterales, no N+1: el listado muestra duración,
 * segmentos, hablantes y la etapa en curso de cada fila, y resolver eso con una
 * consulta por reunión convierte una pantalla en una tormenta de round-trips
 * contra una base que está al otro lado de internet.
 *
 * El filtro por `tenant_id` Y `client_id` va en el WHERE, no en la capa de
 * arriba: es la frontera de aislamiento del módulo y tiene que estar donde no se
 * pueda olvidar.
 *
 * Orden: `started_at` cuando existe y `created_at` si no —el mismo criterio que
 * `meetings_list_idx`—, porque una reunión importada puede tener fecha de
 * celebración anterior a su subida.
 */
export async function listMeetingsForClient(
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<MeetingListRow[]> {
  const result = await q(executor).query<MeetingListRow>(
    `${LIST_SELECT}
      WHERE m.tenant_id = $1 AND m.client_id = $2
      ORDER BY COALESCE(m.started_at, m.created_at) DESC, m.created_at DESC`,
    [tenantId, clientId],
  );
  return result.rows;
}

/**
 * La misma fila, para UNA reunión y acotada por su ámbito.
 *
 * Los tres identificadores van en el WHERE. Leer por `id` y comparar el tenant
 * después dejaría una ventana en la que la fila de otro cliente ya se cargó, y
 * el criterio de este módulo es que un uuid ajeno sea indistinguible de uno
 * inexistente.
 */
export async function getMeetingListRowScoped(
  meetingId: string,
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<MeetingListRow | null> {
  const result = await q(executor).query<MeetingListRow>(
    `${LIST_SELECT} WHERE m.id = $1 AND m.tenant_id = $2 AND m.client_id = $3`,
    [meetingId, tenantId, clientId],
  );
  return result.rows[0] ?? null;
}
