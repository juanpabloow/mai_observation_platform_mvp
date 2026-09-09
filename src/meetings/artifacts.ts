import { gunzipSync } from 'node:zlib';

/**
 * Lectura y validación de los artefactos NDJSON, y la alineación
 * turno→segmento.
 *
 * ── Por qué la alineación la hace mai y no el worker ────────────────────────
 *
 * El worker podría devolver los segmentos ya etiquetados; hoy la versión
 * experimental de Transcript-Project hace algo así. Se hace aquí por dos
 * razones concretas:
 *
 *   1. **Reprocesar sólo la diarización.** Si la regla vive en el worker, cambiar
 *      cómo se resuelve un solape obliga a volver a transcribir para que la
 *      nueva regla se aplique. Viviendo en mai, se re-ingiere.
 *   2. **Una sola regla.** transcribe y diarize son jobs distintos que pueden
 *      correr en procesos distintos con versiones distintas del worker. Si cada
 *      uno alineara, dos reuniones del mismo día podrían tener criterios
 *      distintos y nada lo diría.
 *
 * ── El criterio ─────────────────────────────────────────────────────────────
 *
 * Cada segmento recibe la etiqueta del turno con MAYOR SOLAPE temporal con él.
 * No el turno que empieza antes, ni el que contiene el punto medio: el de mayor
 * solape es el único que no cambia de respuesta cuando el segmento se alarga por
 * un lado. Y `overlap = true` cuando el segundo turno con más solape cubre al
 * menos `OVERLAP_THRESHOLD` del segmento, que es la señal de que dos personas
 * hablaron encima y la etiqueta única es una simplificación.
 */

/** Un segundo turno que cubra ≥ 25 % del segmento marca solape. */
export const OVERLAP_THRESHOLD = 0.25;

export const TRANSCRIPT_SCHEMA = 'meetings.transcript';
export const DIARIZATION_SCHEMA = 'meetings.diarization';
/** Las versiones que mai sabe leer HOY. Añadir una es un cambio de código. */
export const SUPPORTED_TRANSCRIPT_VERSIONS: readonly number[] = [1];
export const SUPPORTED_DIARIZATION_VERSIONS: readonly number[] = [1];

export class ArtifactError extends Error {
  readonly code: 'artifact_malformed' | 'unsupported_schema_version';
  constructor(code: ArtifactError['code'], message: string) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
  }
}

export interface TranscriptHeader {
  readonly language: string | null;
  readonly durationSeconds: number;
  readonly model: string;
  readonly device: string | null;
  readonly computeType: string | null;
  readonly segmentCount: number;
  readonly schemaVersion: number;
}

export interface TranscriptSegment {
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  readonly confidence: number | null;
}

export interface ParsedTranscript {
  readonly header: TranscriptHeader;
  readonly segments: readonly TranscriptSegment[];
}

export interface DiarizationHeader {
  readonly backend: 'wespeaker' | 'pyannote_full';
  readonly speakerCount: number;
  readonly turnCount: number;
  readonly schemaVersion: number;
}

export interface DiarizationTurn {
  readonly startSec: number;
  readonly endSec: number;
  readonly speaker: string;
}

export interface ParsedDiarization {
  readonly header: DiarizationHeader;
  readonly turns: readonly DiarizationTurn[];
}

/**
 * Descomprime si hace falta y parte en líneas. Se detecta gzip por su firma
 * (1f 8b) en vez de confiar en el `content_encoding` declarado: el declarado
 * dice lo que el worker cree que subió, y la firma dice lo que hay.
 */
export function decodeNdjson(raw: Buffer): string[] {
  let text: string;
  const looksGzipped = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  try {
    text = (looksGzipped ? gunzipSync(raw) : raw).toString('utf8');
  } catch (cause) {
    throw new ArtifactError('artifact_malformed', `No se pudo descomprimir: ${(cause as Error).message}`);
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new ArtifactError('artifact_malformed', 'El artefacto está vacío.');
  return lines;
}

function parseLine(line: string, position: number): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ArtifactError('artifact_malformed', `La línea ${position} no es JSON válido.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArtifactError('artifact_malformed', `La línea ${position} no es un objeto.`);
  }
  return value as Record<string, unknown>;
}

function requireFiniteNumber(value: unknown, field: string, position: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ArtifactError('artifact_malformed', `Línea ${position}: '${field}' debe ser un número finito.`);
  }
  return value;
}

function requireString(value: unknown, field: string, position: number): string {
  if (typeof value !== 'string') {
    throw new ArtifactError('artifact_malformed', `Línea ${position}: '${field}' debe ser texto.`);
  }
  return value;
}

export function parseTranscriptArtifact(raw: Buffer): ParsedTranscript {
  const lines = decodeNdjson(raw);
  const head = parseLine(lines[0], 1);

  if (head.schema !== TRANSCRIPT_SCHEMA) {
    throw new ArtifactError(
      'artifact_malformed',
      `Se esperaba schema '${TRANSCRIPT_SCHEMA}' en la cabecera.`,
    );
  }
  const schemaVersion = requireFiniteNumber(head.schema_version, 'schema_version', 1);
  if (!SUPPORTED_TRANSCRIPT_VERSIONS.includes(schemaVersion)) {
    throw new ArtifactError(
      'unsupported_schema_version',
      `schema_version ${schemaVersion} de transcript no está soportada (se admiten: ${SUPPORTED_TRANSCRIPT_VERSIONS.join(', ')}).`,
    );
  }

  const header: TranscriptHeader = {
    language: typeof head.language === 'string' ? head.language : null,
    durationSeconds: requireFiniteNumber(head.duration_seconds, 'duration_seconds', 1),
    model: requireString(head.model, 'model', 1),
    device: typeof head.device === 'string' ? head.device : null,
    computeType: typeof head.compute_type === 'string' ? head.compute_type : null,
    segmentCount: requireFiniteNumber(head.segment_count, 'segment_count', 1),
    schemaVersion,
  };
  if (header.durationSeconds < 0) {
    throw new ArtifactError('artifact_malformed', 'duration_seconds no puede ser negativo.');
  }

  const segments: TranscriptSegment[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const position = i + 1;
    const row = parseLine(lines[i], position);
    const index = requireFiniteNumber(row.i, 'i', position);
    const startSec = requireFiniteNumber(row.start, 'start', position);
    const endSec = requireFiniteNumber(row.end, 'end', position);
    if (!Number.isInteger(index) || index < 0) {
      throw new ArtifactError('artifact_malformed', `Línea ${position}: 'i' debe ser un entero >= 0.`);
    }
    // Las dos las exige el esquema (segments_time_order, start_sec >= 0): mejor
    // rechazar aquí con un mensaje que decirlo con una violación de constraint.
    if (startSec < 0) {
      throw new ArtifactError('artifact_malformed', `Línea ${position}: 'start' no puede ser negativo.`);
    }
    if (endSec < startSec) {
      throw new ArtifactError('artifact_malformed', `Línea ${position}: 'end' es anterior a 'start'.`);
    }
    let confidence: number | null = null;
    if (row.confidence !== undefined && row.confidence !== null) {
      confidence = requireFiniteNumber(row.confidence, 'confidence', position);
      if (confidence < 0 || confidence > 1) {
        throw new ArtifactError('artifact_malformed', `Línea ${position}: 'confidence' fuera de [0,1].`);
      }
    }
    segments.push({
      index,
      startSec,
      endSec,
      text: requireString(row.text, 'text', position),
      confidence,
    });
  }

  // El índice tiene que ser denso y desde 0: es la clave de
  // segments_index_key UNIQUE (transcript_id, segment_index), y un hueco haría
  // que "el segmento 7" no existiera para un lector que itera.
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i].index !== i) {
      throw new ArtifactError(
        'artifact_malformed',
        `Los índices de segmento deben ser densos desde 0; en la posición ${i} viene ${segments[i].index}.`,
      );
    }
  }
  // La cabecera declara un conteo: si no cuadra, el artefacto está truncado o
  // el productor tiene un fallo. Es la comprobación que detecta un NDJSON
  // cortado a mitad cuyo checksum sí cuadra porque se subió cortado.
  if (segments.length !== header.segmentCount) {
    throw new ArtifactError(
      'artifact_malformed',
      `La cabecera declara ${header.segmentCount} segmentos y hay ${segments.length}.`,
    );
  }

  return { header, segments };
}

export function parseDiarizationArtifact(raw: Buffer): ParsedDiarization {
  const lines = decodeNdjson(raw);
  const head = parseLine(lines[0], 1);

  if (head.schema !== DIARIZATION_SCHEMA) {
    throw new ArtifactError(
      'artifact_malformed',
      `Se esperaba schema '${DIARIZATION_SCHEMA}' en la cabecera.`,
    );
  }
  const schemaVersion = requireFiniteNumber(head.schema_version, 'schema_version', 1);
  if (!SUPPORTED_DIARIZATION_VERSIONS.includes(schemaVersion)) {
    throw new ArtifactError(
      'unsupported_schema_version',
      `schema_version ${schemaVersion} de diarización no está soportada.`,
    );
  }
  const backend = requireString(head.backend, 'backend', 1);
  if (backend !== 'wespeaker' && backend !== 'pyannote_full') {
    // El CHECK de meeting_transcript_versions.diarization_backend sólo admite
    // esos dos; rechazar aquí da un mensaje en vez de un error de constraint.
    throw new ArtifactError('artifact_malformed', `backend '${backend}' desconocido.`);
  }

  const turns: DiarizationTurn[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const position = i + 1;
    const row = parseLine(lines[i], position);
    const startSec = requireFiniteNumber(row.start, 'start', position);
    const endSec = requireFiniteNumber(row.end, 'end', position);
    if (startSec < 0 || endSec < startSec) {
      throw new ArtifactError('artifact_malformed', `Línea ${position}: intervalo inválido.`);
    }
    const speaker = requireString(row.speaker, 'speaker', position).trim();
    if (speaker.length === 0) {
      throw new ArtifactError('artifact_malformed', `Línea ${position}: 'speaker' vacío.`);
    }
    turns.push({ startSec, endSec, speaker });
  }

  const declaredTurns = requireFiniteNumber(head.turn_count, 'turn_count', 1);
  if (turns.length !== declaredTurns) {
    throw new ArtifactError(
      'artifact_malformed',
      `La cabecera declara ${declaredTurns} turnos y hay ${turns.length}.`,
    );
  }

  return {
    header: {
      backend,
      speakerCount: new Set(turns.map((turn) => turn.speaker)).size,
      turnCount: turns.length,
      schemaVersion,
    },
    turns,
  };
}

export interface AlignedSegment extends TranscriptSegment {
  readonly speakerLabel: string | null;
  readonly overlap: boolean;
}

export interface Alignment {
  readonly segments: readonly AlignedSegment[];
  /** Etiqueta → porcentaje del tiempo hablado, para `talk_share_pct`. */
  readonly talkSharePct: Readonly<Record<string, number>>;
}

function overlapSeconds(a: { startSec: number; endSec: number }, b: { startSec: number; endSec: number }): number {
  return Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
}

/**
 * Asigna una etiqueta a cada segmento por mayor solape, y calcula el reparto de
 * tiempo hablado. Sin diarización devuelve los segmentos con `speakerLabel:
 * null`, que es el estado «Sin participantes identificados» de la UI — no un
 * error ni una etiqueta inventada.
 */
export function alignSegments(
  segments: readonly TranscriptSegment[],
  turns: readonly DiarizationTurn[] | null,
): Alignment {
  if (turns === null || turns.length === 0) {
    return {
      segments: segments.map((segment) => ({ ...segment, speakerLabel: null, overlap: false })),
      talkSharePct: {},
    };
  }

  const aligned: AlignedSegment[] = [];
  const spokenSeconds = new Map<string, number>();

  for (const segment of segments) {
    const byLabel = new Map<string, number>();
    for (const turn of turns) {
      const shared = overlapSeconds(segment, turn);
      if (shared > 0) byLabel.set(turn.speaker, (byLabel.get(turn.speaker) ?? 0) + shared);
    }
    if (byLabel.size === 0) {
      // Un segmento sin ningún turno solapado: silencio atribuido a nadie. Se
      // deja sin etiqueta en vez de asignarle el vecino más cercano, porque
      // inventar una atribución en un transcript es peor que no tenerla.
      aligned.push({ ...segment, speakerLabel: null, overlap: false });
      continue;
    }
    // Empate resuelto por orden alfabético de la etiqueta: no es significativo,
    // pero es DETERMINISTA, y sin eso re-ingerir el mismo artefacto podría dar
    // dos resultados distintos.
    const ranked = [...byLabel.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [label, best] = ranked[0];
    const segmentDuration = Math.max(segment.endSec - segment.startSec, 1e-9);
    const runnerUp = ranked[1]?.[1] ?? 0;
    aligned.push({
      ...segment,
      speakerLabel: label,
      overlap: runnerUp / segmentDuration >= OVERLAP_THRESHOLD,
    });
    spokenSeconds.set(label, (spokenSeconds.get(label) ?? 0) + best);
  }

  // El reparto se calcula sobre los TURNOS, no sobre los segmentos alineados:
  // el tiempo que alguien habló no depende de cómo se troceó el texto.
  const turnSeconds = new Map<string, number>();
  for (const turn of turns) {
    turnSeconds.set(turn.speaker, (turnSeconds.get(turn.speaker) ?? 0) + (turn.endSec - turn.startSec));
  }
  const total = [...turnSeconds.values()].reduce((sum, value) => sum + value, 0);
  const talkSharePct: Record<string, number> = {};
  if (total > 0) {
    for (const [label, seconds] of turnSeconds) {
      // Dos decimales: es lo que admite numeric(5,2).
      talkSharePct[label] = Math.round((seconds / total) * 10_000) / 100;
    }
  }

  return { segments: aligned, talkSharePct };
}
