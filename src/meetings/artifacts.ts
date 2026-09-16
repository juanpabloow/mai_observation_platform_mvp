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
/**
 * v1: un segmento es una línea con `i/start/end/text`.
 * v2: además puede traer `words`, y con ellas la alineación atribuye por palabra.
 * Se admiten LAS DOS: las versiones ya ingeridas son v1 y tienen que seguir leyéndose.
 */
export const SUPPORTED_TRANSCRIPT_VERSIONS: readonly number[] = [1, 2];
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

/**
 * Una palabra con su tiempo, tal y como la produce whisper con
 * `word_timestamps=True`. Es el insumo que permite atribuir hablante DENTRO de un
 * segmento sin partir el texto por proporción de caracteres — que sería inventar una
 * frontera que nadie midió.
 */
export interface TranscriptWord {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
}

export interface TranscriptSegment {
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  readonly confidence: number | null;
  /**
   * Sólo en `schema_version` 2. Ausente en los artefactos v1 ya ingeridos, y por eso
   * es opcional: sin palabras, la alineación se comporta EXACTAMENTE como antes.
   */
  readonly words?: readonly TranscriptWord[];
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

/**
 * Las palabras de una línea v2, validadas con el mismo rigor que el segmento.
 *
 * Una palabra fuera del segmento que la contiene no es un detalle cosmético: la
 * alineación la usaría para decidir hablante en un instante que no le pertenece. Se
 * rechaza el artefacto en vez de recortarla en silencio.
 *
 * `words` ausente devuelve `{}` — no `{ words: [] }`. La diferencia importa: vacío
 * significaría «se pidieron y no hay», y ausente significa «este artefacto no las
 * trae», que es lo que hace que la alineación caiga al camino de v1.
 */
function parseWords(
  value: unknown,
  segStart: number,
  segEnd: number,
  position: number,
): { words?: readonly TranscriptWord[] } {
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value)) {
    throw new ArtifactError('artifact_malformed', `Línea ${position}: 'words' debe ser una lista.`);
  }
  if (value.length === 0) return {};
  const words: TranscriptWord[] = [];
  let previousEnd = -Infinity;
  for (let w = 0; w < value.length; w += 1) {
    const entry = value[w];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ArtifactError('artifact_malformed', `Línea ${position}: 'words[${w}]' no es un objeto.`);
    }
    const row = entry as Record<string, unknown>;
    const startSec = requireFiniteNumber(row.start, `words[${w}].start`, position);
    const endSec = requireFiniteNumber(row.end, `words[${w}].end`, position);
    const text = requireString(row.word, `words[${w}].word`, position);
    if (endSec < startSec) {
      throw new ArtifactError('artifact_malformed', `Línea ${position}: 'words[${w}]' termina antes de empezar.`);
    }
    // Tolerancia de un milisegundo: los tiempos vienen redondeados a 3 decimales por
    // los dos lados, y un `start` que empata con el del segmento no debe fallar.
    if (startSec < segStart - 0.001 || endSec > segEnd + 0.001) {
      throw new ArtifactError(
        'artifact_malformed',
        `Línea ${position}: 'words[${w}]' (${startSec}–${endSec}) se sale del segmento (${segStart}–${segEnd}).`,
      );
    }
    if (startSec < previousEnd - 0.001) {
      throw new ArtifactError('artifact_malformed', `Línea ${position}: 'words[${w}]' no va en orden.`);
    }
    previousEnd = endSec;
    words.push({ startSec, endSec, text });
  }
  return { words };
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
      ...parseWords(row.words, startSec, endSec, position),
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
  /**
   * DOS VOCES a la vez en este tramo: un segundo turno cubre al menos
   * `OVERLAP_THRESHOLD` del bloque. Es una afirmación sobre el AUDIO.
   */
  readonly overlap: boolean;
  /**
   * NO estamos seguros de a quién atribuir este bloque. Es una afirmación sobre
   * NUESTRA CONFIANZA, y por eso es un campo distinto de `overlap` — confundirlos diría
   * «aquí hablan dos» cuando lo que pasa es «aquí no sabemos quién habla».
   *
   * Se marca por tres motivos, todos documentados donde se calculan: pocas palabras
   * (poca evidencia), cobertura fina del turno ganador (ambigüedad temporal real), o un
   * cambio de hablante que no se pudo situar por no corresponderse las palabras con el
   * texto.
   */
  readonly speakerUncertain: boolean;
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
 * Mínimo de palabras para considerar FIRME la atribución de un bloque.
 *
 * Esto NO decide si un bloque existe. La atribución se conserva siempre: una
 * intervención de otro hablante no se absorbe en su vecino por ser corta, porque eso
 * cambiaría quién dijo qué —que es el dato— para ganar legibilidad, que es
 * presentación. Un «Claro» de otra voz en mitad de un segmento conserva su hablante y
 * sus tiempos.
 *
 * Lo que este umbral hace es MARCAR: un bloque de una o dos palabras se atribuye
 * igual, pero se señala como atribución tentativa. La razón es de tamaño de muestra, no
 * de ambigüedad temporal — con dos palabras hay poquísima evidencia, y si el diarizador
 * se equivocó ahí, el error se concentra justo ahí.
 */
export const MIN_WORDS_FOR_FIRM_SPEAKER = 3;

/**
 * Cobertura mínima del turno ganador sobre el bloque para considerarlo firme.
 *
 * Distinto del umbral anterior: aquí la atribución descansa sobre una esquirla de
 * solape —la palabra cruza la frontera de dos turnos y gana uno por poco—, y eso es
 * ambigüedad temporal de verdad, no falta de muestra.
 */
export const FIRM_COVERAGE = 0.6;

/**
 * Cuánto tiene que cubrir un segundo hablante dentro de un segmento para que
 * consideremos que ahí HAY un cambio que no supimos situar.
 *
 * 0,2 s es del orden de la palabra más corta. Por debajo, un turno que asoma en el
 * borde de un segmento es ruido de frontera y marcarlo como duda sería marcar casi
 * todo. Por encima, es habla que el bloque contiene y atribuye a otro.
 */
export const UNPLACEABLE_MIN_SEC = 0.2;

/** El turno con más solape en un intervalo, y cuánto cubre el segundo. */
function rankLabels(
  turns: readonly DiarizationTurn[],
  span: { startSec: number; endSec: number },
): { label: string | null; best: number; runnerUp: number } {
  const byLabel = new Map<string, number>();
  for (const turn of turns) {
    const shared = overlapSeconds(span, turn);
    if (shared > 0) byLabel.set(turn.speaker, (byLabel.get(turn.speaker) ?? 0) + shared);
  }
  if (byLabel.size === 0) return { label: null, best: 0, runnerUp: 0 };
  // Empate resuelto por orden alfabético de la etiqueta: no es significativo,
  // pero es DETERMINISTA, y sin eso re-ingerir el mismo artefacto podría dar
  // dos resultados distintos.
  const ranked = [...byLabel.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { label: ranked[0][0], best: ranked[0][1], runnerUp: ranked[1]?.[1] ?? 0 };
}

/** ¿Habla alguien más ahí dentro, aparte de quien se lleva la etiqueta? */
function hasInternalSpeakerChange(
  span: { startSec: number; endSec: number },
  turns: readonly DiarizationTurn[],
): boolean {
  const { label, runnerUp } = rankLabels(turns, span);
  return label !== null && runnerUp >= UNPLACEABLE_MIN_SEC;
}

interface TextToken {
  readonly text: string;
  /** Desplazamientos en el texto ORIGINAL del segmento. */
  readonly start: number;
  readonly end: number;
}

/** Los tokens del texto tal cual vino, con su posición. No normaliza nada. */
function tokenize(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

interface SplitPart {
  readonly label: string | null;
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
  readonly wordCount: number;
}

interface SplitResult {
  /**
   * `null` significa «no se puede partir con lo que hay»: el llamador emite el
   * segmento entero, con su texto y sus tiempos ORIGINALES.
   */
  readonly parts: SplitPart[] | null;
  /**
   * Había un cambio de hablante dentro del segmento y NO se pudo situar, porque las
   * palabras no se corresponden con el texto. Se emite un bloque, y ese bloque tiene
   * que decir que su hablante es tentativo. No es solapamiento de voces: es que no
   * sabemos dónde cortar.
   */
  readonly unplaceableChange: boolean;
}

/**
 * Parte un segmento en tramos de un solo hablante, cortando SÓLO en frontera de
 * palabra y con los tiempos que whisper midió.
 *
 * ── El texto original es la fuente, no las palabras ────────────────────────
 *
 * El texto de cada bloque se saca REBANANDO el texto original entre los
 * desplazamientos de sus tokens, no concatenando los campos `word`. Así la unión de
 * los bloques es exactamente el texto original: no se puede perder ni duplicar nada,
 * y la puntuación y los espacios son los que vinieron.
 *
 * Eso exige que `words` y los tokens del texto se correspondan uno a uno. Whisper
 * normalmente los da así, pero no siempre: puede omitir palabras. Cuando la
 * correspondencia falla, NO se parte y se emite el segmento entero — porque situar la
 * frontera requeriría saber dónde va el texto que las palabras no cubren, y eso no lo
 * sabemos. Adivinarlo sería inventar la frontera que todo esto existe para no inventar.
 */
function splitByWords(
  segment: TranscriptSegment,
  turns: readonly DiarizationTurn[],
): SplitResult {
  const words = segment.words;
  // Sin palabras no se parte NADA, y no se interpola nada: un artefacto v1 no trae
  // tiempos por palabra, y fabricarlos repartiendo el segmento sería inventar.
  //
  // Pero callarse no es lo mismo que no saber. Si los TURNOS dicen que dentro de este
  // segmento habla alguien más, hay un cambio que no supimos situar, y la etiqueta
  // única es una atribución tentativa — da igual que la causa sea un artefacto v1 o
  // que el worker abandonara las palabras de este segmento por traer un tiempo
  // ilegible. Las dos son la misma situación y se declaran igual.
  if (!words || words.length === 0) {
    return { parts: null, unplaceableChange: hasInternalSpeakerChange(segment, turns) };
  }

  const labels = words.map((word) => rankLabels(turns, word).label);
  const changes = labels.some((label, i) => i > 0 && label !== labels[i - 1]);
  if (!changes) return { parts: null, unplaceableChange: false };

  const tokens = tokenize(segment.text);
  if (tokens.length !== words.length) {
    return { parts: null, unplaceableChange: true };
  }
  // Que coincida el número no basta: si los textos no se corresponden, el mapeo
  // posicional está mal aunque cuadren las cuentas, y rebanaríamos por donde no toca.
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].text !== words[i].text.trim()) {
      return { parts: null, unplaceableChange: true };
    }
  }

  // Tramos de palabras CONSECUTIVAS del mismo hablante. Todos se emiten: ninguno se
  // absorbe por corto. Los índices son rangos disjuntos que cubren todos los tokens,
  // así que la unión de los textos es el texto original.
  const parts: SplitPart[] = [];
  let from = 0;
  for (let i = 1; i <= words.length; i += 1) {
    if (i < words.length && labels[i] === labels[from]) continue;
    const to = i - 1;
    parts.push({
      label: labels[from],
      startSec: words[from].startSec,
      endSec: words[to].endSec,
      text: segment.text.slice(tokens[from].start, tokens[to].end),
      wordCount: to - from + 1,
    });
    from = i;
  }
  return { parts, unplaceableChange: false };
}

/**
 * Asigna una etiqueta a cada segmento por mayor solape, y calcula el reparto de
 * tiempo hablado. Sin diarización devuelve los segmentos con `speakerLabel:
 * null`, que es el estado «Sin participantes identificados» de la UI — no un
 * error ni una etiqueta inventada.
 *
 * ── Por qué una etiqueta por segmento NO basta ──────────────────────────────
 *
 * Whisper trocea por audio, no por turno: un segmento suyo puede contener a dos
 * personas. Medido en una grabación de prueba, un segmento de 0,96 a 10,72 s llevaba
 * una pregunta de una voz y su respuesta de la otra, y por mayor solape el bloque
 * ENTERO se atribuía a quien decía la segunda mitad. Ilustrado con texto sintético:
 *
 *     0,96– 3,94  A   «Vale, ¿y qué módulo revisamos primero?»
 *     5,02–10,72  B   «No sé. Podríamos mirar índices.»
 *
 * Mejorar la diarización no lo arregla: sólo cambia cuál de las dos mitades queda
 * mal atribuida.
 *
 * Con `words` (schema v2) el segmento se parte en frontera de palabra y cada tramo
 * lleva su hablante. Sin ellas (v1) el comportamiento es el de siempre, intacto.
 *
 * Los índices se renumeran densos desde 0 sobre el resultado, que es lo que exige
 * `segments_index_key`. El reparto se sigue calculando sobre los TURNOS, así que
 * partir o no partir no lo mueve.
 */
export function alignSegments(
  segments: readonly TranscriptSegment[],
  turns: readonly DiarizationTurn[] | null,
): Alignment {
  if (turns === null || turns.length === 0) {
    return {
      segments: segments.map((segment) => ({
        ...segment,
        speakerLabel: null,
        overlap: false,
        // Sin diarización no hay atribución de la que dudar: es «no hay hablantes»,
        // que la UI ya presenta como tal, no una atribución insegura.
        speakerUncertain: false,
      })),
      talkSharePct: {},
    };
  }

  const aligned: AlignedSegment[] = [];
  const spokenSeconds = new Map<string, number>();

  const emit = (
    source: TranscriptSegment,
    part: SplitPart,
    unplaceableChange: boolean,
  ): void => {
    const { label, best, runnerUp } = rankLabels(turns, part);
    const duration = Math.max(part.endSec - part.startSec, 1e-9);
    // `overlap` sigue significando exactamente lo de siempre: dos voces a la vez en
    // este tramo. No se usa para nada más.
    const overlap = label !== null && runnerUp / duration >= OVERLAP_THRESHOLD;
    // La incertidumbre es otra cosa, y va aparte.
    const thinEvidence = label !== null && part.wordCount > 0 && part.wordCount < MIN_WORDS_FOR_FIRM_SPEAKER;
    const thinCoverage = label !== null && best / duration < FIRM_COVERAGE;
    aligned.push({
      ...source,
      index: aligned.length,
      startSec: part.startSec,
      endSec: part.endSec,
      text: part.text,
      speakerLabel: label,
      overlap,
      speakerUncertain: unplaceableChange || thinEvidence || thinCoverage,
    });
    if (label !== null) spokenSeconds.set(label, (spokenSeconds.get(label) ?? 0) + best);
  };

  for (const segment of segments) {
    const { parts, unplaceableChange } = splitByWords(segment, turns);
    if (parts === null) {
      // Sin partir: se conservan el texto y los tiempos ORIGINALES del segmento.
      // Un segmento sin ningún turno solapado queda sin etiqueta en vez de heredar
      // la del vecino, porque inventar una atribución es peor que no tenerla.
      //
      // `wordCount: 0` es deliberado: este bloque no viene de un tramo de palabras, así
      // que la regla de «pocas palabras» no le aplica — un segmento v1 de tres
      // segundos no es una atribución tentativa por no traer palabras.
      emit(
        segment,
        {
          label: null,
          startSec: segment.startSec,
          endSec: segment.endSec,
          text: segment.text,
          wordCount: 0,
        },
        unplaceableChange,
      );
      continue;
    }
    for (const part of parts) emit(segment, part, false);
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
