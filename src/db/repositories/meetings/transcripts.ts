import { q, type Queryable } from './types.js';
import type { AlignedSegment } from '../../../meetings/artifacts.js';

/**
 * La ingestión de una versión de transcript: la escritura que ocurre UNA vez por
 * run (ver `docs/meetings-stage-contracts.md` §5).
 *
 * ── Por qué todo va en un solo INSERT por tabla ─────────────────────────────
 *
 * Los segmentos se insertan con `unnest` de arrays en un único statement, no con
 * un INSERT por fila en un bucle. Para 205 segmentos la diferencia son 205
 * viajes a la base frente a uno, y para las 4 horas que el diseño declara
 * soportar (~3.274 segmentos medidos) el bucle empezaría a dominar el tiempo de
 * la transacción — una transacción que mantiene bloqueada la fila del job.
 */

export interface TranscriptVersionRow {
  id: string;
  tenant_id: string;
  client_id: string;
  meeting_id: string;
  run_id: string;
  whisper_model: string;
  diarization_backend: string | null;
  language: string | null;
  duration_seconds: string;
  segment_count: number;
  schema_version: number;
  metrics: Record<string, unknown>;
  created_at: Date;
}

export interface IngestTranscriptInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly meetingId: string;
  readonly runId: string;
  readonly whisperModel: string;
  readonly diarizationBackend: 'wespeaker' | 'pyannote_full' | null;
  readonly language: string | null;
  readonly durationSeconds: number;
  readonly schemaVersion: number;
  readonly metrics: Record<string, unknown>;
  readonly segments: readonly AlignedSegment[];
  /** Etiqueta cruda → porcentaje de tiempo hablado. */
  readonly talkSharePct: Readonly<Record<string, number>>;
}

export interface IngestResult {
  readonly version: TranscriptVersionRow;
  /** false = este run ya se había ingerido; no se escribió nada nuevo. */
  readonly created: boolean;
}

/**
 * Escribe la versión, sus segmentos y el mapa de hablantes. Idempotente por
 * `tv_run_key UNIQUE (run_id)`: si el run ya tiene versión, devuelve la que hay
 * sin tocar nada.
 *
 * DEBE llamarse dentro de una transacción. No lo comprueba —no hay forma
 * fiable de saberlo desde aquí— pero si se llamara fuera, un fallo a mitad
 * dejaría una versión con la mitad de sus segmentos, y `segment_count` diría
 * otra cosa que la realidad.
 */
export async function ingestTranscriptVersion(
  input: IngestTranscriptInput,
  executor: Queryable,
): Promise<IngestResult> {
  const inserted = await executor.query<TranscriptVersionRow>(
    `INSERT INTO meeting_transcript_versions
       (tenant_id, client_id, meeting_id, run_id, whisper_model, diarization_backend,
        language, duration_seconds, segment_count, schema_version, metrics)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (run_id) DO NOTHING
     RETURNING *`,
    [
      input.tenantId,
      input.clientId,
      input.meetingId,
      input.runId,
      input.whisperModel,
      input.diarizationBackend,
      input.language,
      input.durationSeconds,
      input.segments.length,
      input.schemaVersion,
      JSON.stringify(input.metrics),
    ],
  );

  if (inserted.rows.length === 0) {
    const existing = await executor.query<TranscriptVersionRow>(
      `SELECT * FROM meeting_transcript_versions WHERE run_id = $1`,
      [input.runId],
    );
    return { version: existing.rows[0], created: false };
  }

  const version = inserted.rows[0];

  if (input.segments.length > 0) {
    await executor.query(
      `INSERT INTO meeting_segments
         (tenant_id, client_id, transcript_id, segment_index, start_sec, end_sec,
          speaker_label, text, overlap, confidence)
       SELECT $1, $2, $3, s.idx, s.start_sec, s.end_sec, s.speaker_label, s.text,
              s.overlap, s.confidence
         FROM unnest(
                $4::int[], $5::numeric[], $6::numeric[], $7::text[], $8::text[],
                $9::boolean[], $10::numeric[]
              ) AS s(idx, start_sec, end_sec, speaker_label, text, overlap, confidence)`,
      [
        input.tenantId,
        input.clientId,
        version.id,
        input.segments.map((segment) => segment.index),
        input.segments.map((segment) => segment.startSec),
        input.segments.map((segment) => segment.endSec),
        input.segments.map((segment) => segment.speakerLabel),
        input.segments.map((segment) => segment.text),
        input.segments.map((segment) => segment.overlap),
        input.segments.map((segment) => segment.confidence),
      ],
    );
  }

  // Las etiquetas de esta versión: las que aparecen en algún segmento más las
  // que el diarizador reportó aunque no cayeran en ninguno.
  const labels = [
    ...new Set([
      ...input.segments.map((segment) => segment.speakerLabel).filter((l): l is string => l !== null),
      ...Object.keys(input.talkSharePct),
    ]),
  ].sort();

  if (labels.length > 0) {
    // `meeting_speakers` es por REUNIÓN, no por versión: es lo que hace que un
    // renombre sobreviva a reprocesar. Así que se REUTILIZAN los hablantes que
    // ya existan para esta reunión, emparejándolos por el orden de la etiqueta,
    // y sólo se crean los que falten.
    const existing = await executor.query<{ id: string; display_name: string | null }>(
      `SELECT id, display_name FROM meeting_speakers
        WHERE meeting_id = $1 ORDER BY created_at ASC, id ASC`,
      [input.meetingId],
    );
    const speakerIds: string[] = existing.rows.map((row) => row.id);
    const missing = labels.length - speakerIds.length;
    if (missing > 0) {
      const created = await executor.query<{ id: string }>(
        `INSERT INTO meeting_speakers (tenant_id, client_id, meeting_id)
         SELECT $1, $2, $3 FROM generate_series(1, $4)
         RETURNING id`,
        [input.tenantId, input.clientId, input.meetingId, missing],
      );
      speakerIds.push(...created.rows.map((row) => row.id));
    }

    await executor.query(
      `INSERT INTO meeting_transcript_speakers
         (transcript_id, speaker_label, tenant_id, client_id, meeting_id, speaker_id, talk_share_pct)
       SELECT $1, m.label, $2, $3, $4, m.speaker_id, m.share
         FROM unnest($5::text[], $6::uuid[], $7::numeric[]) AS m(label, speaker_id, share)`,
      [
        version.id,
        input.tenantId,
        input.clientId,
        input.meetingId,
        labels,
        labels.map((_, index) => speakerIds[index]),
        labels.map((label) => input.talkSharePct[label] ?? null),
      ],
    );
  }

  return { version, created: true };
}

export async function getActiveTranscript(
  meetingId: string,
  executor?: Queryable,
): Promise<TranscriptVersionRow | null> {
  const result = await q(executor).query<TranscriptVersionRow>(
    `SELECT v.*
       FROM meetings m
       JOIN meeting_transcript_versions v ON v.id = m.active_transcript_id
      WHERE m.id = $1`,
    [meetingId],
  );
  return result.rows[0] ?? null;
}

export async function countSegments(transcriptId: string, executor?: Queryable): Promise<number> {
  const result = await q(executor).query<{ n: string }>(
    `SELECT count(*)::text AS n FROM meeting_segments WHERE transcript_id = $1`,
    [transcriptId],
  );
  return Number(result.rows[0].n);
}

export interface TranscriptSegmentRow {
  id: string;
  segment_index: number;
  start_sec: string;
  end_sec: string;
  speaker_label: string | null;
  text: string;
  overlap: boolean;
  confidence: string | null;
}

/**
 * Los segmentos de una versión, en orden de lectura.
 *
 * Existía `countSegments` y no existía esto, así que hasta W-3 el texto de una
 * transcripción no se podía leer: la API devolvía `segmentCount` y ninguna
 * forma de obtener las frases. Es lo único que faltaba en la capa de datos para
 * que la pantalla de Reuniones tenga algo que mostrar.
 *
 * `numeric` sale como string por el driver y se convierte en la capa de arriba,
 * a propósito: convertir aquí perdería precisión en silencio para duraciones
 * largas, y el que mapea a la UI ya sabe qué precisión necesita.
 *
 * ORDER BY segment_index, no por `start_sec`: el índice es el orden que declaró
 * el artefacto, y dos segmentos pueden empezar en el mismo instante cuando dos
 * personas hablan encima.
 */
export async function listSegments(
  transcriptId: string,
  executor?: Queryable,
): Promise<TranscriptSegmentRow[]> {
  const result = await q(executor).query<TranscriptSegmentRow>(
    `SELECT id, segment_index, start_sec, end_sec, speaker_label, text, overlap, confidence
       FROM meeting_segments
      WHERE transcript_id = $1
      ORDER BY segment_index`,
    [transcriptId],
  );
  return result.rows;
}

export async function listTranscriptSpeakers(
  transcriptId: string,
  executor?: Queryable,
): Promise<Array<{ speaker_label: string; speaker_id: string | null; display_name: string | null; talk_share_pct: string | null }>> {
  const result = await q(executor).query<{
    speaker_label: string;
    speaker_id: string | null;
    display_name: string | null;
    talk_share_pct: string | null;
  }>(
    `SELECT ts.speaker_label, ts.speaker_id, s.display_name, ts.talk_share_pct
       FROM meeting_transcript_speakers ts
       LEFT JOIN meeting_speakers s ON s.id = ts.speaker_id
      WHERE ts.transcript_id = $1
      ORDER BY ts.speaker_label ASC`,
    [transcriptId],
  );
  return result.rows;
}
