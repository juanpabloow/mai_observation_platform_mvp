import type { UiMeetingDetail, UiMeetingRow, UiSegment, UiSpeaker } from "@worker/meetings/uiRead.js";
import type {
  MeetingDetail,
  MeetingListItem,
  MeetingSource,
  MeetingStatus,
  Participant,
  TranscriptSegment,
} from "./meetingsData";
import type { MeetingSummary } from "./meetingsSummary";

/**
 * De las filas de PostgreSQL a los tipos que la pantalla ya consumía.
 *
 * Funciones PURAS, en su propio fichero y sin tocar la base: son las decisiones
 * que hay que poder probar sin una base de datos delante y sin un navegador
 * —qué estado muestra la fila, cómo se llama un hablante sin nombre, qué pasa
 * cuando un campo es NULL— y esas decisiones son casi todo lo que hay entre el
 * esquema y lo que se ve.
 *
 * ── La regla que gobierna este fichero ──────────────────────────────────────
 *
 * **Nada se inventa.** Si la base dice NULL, la UI dice que no se sabe. Eso
 * aplica a la confianza (los 15 segmentos del recorrido de W-3 la tienen nula
 * porque el worker no la reporta), al rol de un hablante (no hay contacto
 * ligado) y a la fecha de celebración (`started_at` es nulo cuando nadie la
 * declaró). Para la fecha, en vez de mentir o dejar un hueco, se muestra la de
 * SUBIDA etiquetada como tal: es un dato verdadero y responde la pregunta que
 * el usuario tiene («¿de cuándo es esto?») sin afirmar lo que no consta.
 */

/* ── Tiempos ──────────────────────────────────────────────────────────────── */

/** `mm:ss`, o `h:mm:ss` cuando pasa de la hora. El formato del diseño. */
export function stamp(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

const MONTHS = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

/**
 * La fecha, y de QUÉ es la fecha.
 *
 * `started_at` es la celebración; `created_at` es la subida. Cuando falta la
 * primera se muestra la segunda **con el prefijo «Subida»**, porque presentar
 * una fecha de subida donde el usuario espera la de la reunión es exactamente
 * el tipo de dato inventado que no queremos: una grabación de marzo subida en
 * septiembre aparecería como reunión de septiembre.
 *
 * ── Y por qué dice «UTC» ────────────────────────────────────────────────────
 *
 * Esto lo formatea el SERVIDOR, porque las páginas de Reuniones son Server
 * Components. Con `getHours()` la hora salía en la zona del proceso: en esta
 * Mac (UTC−5) `00:34Z` se imprimía como «19:34» del día anterior, y en Railway
 * —que corre en UTC— como «00:34». Dos servidores, dos respuestas para el mismo
 * instante, y ninguna es la zona del usuario.
 *
 * Se formatea en UTC y se dice. Una hora etiquetada que el lector puede
 * convertir es correcta; una hora sin etiqueta que depende de dónde se
 * despliegue no lo es. Mostrarla en la zona del navegador exige un componente
 * de cliente con `<time dateTime>`, que es la mejora natural de esto y no un
 * arreglo de última hora.
 */
export function whenLabel(startedAt: string | null, createdAt: string): string {
  const iso = startedAt ?? createdAt;
  const d = new Date(iso);
  const day = d.getUTCDate();
  const month = MONTHS[d.getUTCMonth()];
  const time = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const body = `${day} ${month} ${d.getUTCFullYear()} · ${time} UTC`;
  return startedAt ? body : `Subida ${body}`;
}

/** «hace 4 min», «hace 2 h», «hace 3 d». Para la columna `updated`. */
export function relativeLabel(iso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "hace instantes";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `hace ${days} d`;
  return whenLabel(iso, iso).replace(/^Subida /, "");
}

export function bytesLabel(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/* ── Estado ───────────────────────────────────────────────────────────────── */

/**
 * Las cuatro máquinas de estado y el job en curso, en el único estado que la
 * fila muestra.
 *
 * El orden de las ramas ES el criterio, y va de lo más específico a lo más
 * general:
 *
 *   cancelada → cualquier cosa que estuviera corriendo ya no importa;
 *   medio inválido o etapa fallida → «requiere atención», con su motivo;
 *   hay un job en curso → la etapa CONCRETA, no un «procesando» genérico;
 *   transcripción lista → hecha, y se distingue si hubo hablantes;
 *   nada de lo anterior → sigue subiendo.
 *
 * `progress_pct` es nulo mientras el worker no reporta avance —el de W-3 no
 * envió ni un evento `progress`—, y en ese caso se muestra 0 en vez de fingir
 * un porcentaje: una barra a la mitad que no se mueve miente más que una a cero.
 */
export function statusOf(row: UiMeetingRow): MeetingStatus {
  if (row.cancelledAt !== null) return { kind: "cancelled" };

  const pct = row.runningProgressPct ?? 0;

  if (row.mediaState === "invalid") {
    return { kind: "failed", reason: "El audio no se pudo procesar" };
  }
  if (row.runningStage === null && row.failureCode !== null && row.transcriptState === "failed") {
    return { kind: "failed", reason: reasonFor(row.failureCode) };
  }
  // `normalize` NO es «Subiendo»: los bytes ya están en R2 y lo que corre es la
  // conversión a 16 kHz mono, que es el primer paso de producir el transcript.
  // Mapearlo a «Subiendo» hacía que una reunión ya subida mostrara «Subiendo ·
  // 0 %» indefinidamente, que se lee como una subida atascada.
  if (row.runningStage === "normalize" || row.runningStage === "transcribe") {
    return { kind: "transcribing", percent: pct };
  }
  if (row.runningStage === "diarize") return { kind: "diarizing", percent: pct };
  if (row.analysisState === "running") return { kind: "analyzing", percent: pct };

  if (row.transcriptState === "ready") {
    // «Sin hablantes» no es un fallo: es el resultado cuando la diarización se
    // omitió o no encontró a nadie, y la pantalla tiene un estado propio para
    // eso en vez de mostrar una lista de participantes vacía sin explicación.
    return row.speakerCount > 0 ? { kind: "done" } : { kind: "done-no-speakers" };
  }
  if (row.transcriptState === "failed") {
    return { kind: "failed", reason: reasonFor(row.failureCode) };
  }
  if (row.mediaState === "ready") return { kind: "transcribing", percent: pct };
  return { kind: "uploading", percent: pct };
}

/**
 * El código del worker, en una frase.
 *
 * Los códigos son vocabulario cerrado del worker; los que no están mapeados se
 * muestran tal cual en vez de traducirse a «error desconocido», porque el
 * código es lo que permite buscarlo en los logs.
 */
export function reasonFor(failureCode: string | null): string {
  if (failureCode === null) return "El procesamiento falló";
  const known: Record<string, string> = {
    audio_unreadable: "El fichero no es audio legible",
    audio_empty: "El fichero está vacío",
    audio_too_short: "El audio es demasiado corto",
    no_audio_stream: "El fichero no tiene pista de audio",
    normalize_timeout: "La conversión del audio agotó su tiempo",
    normalize_format_mismatch: "La conversión no produjo el formato esperado",
    ffmpeg_unavailable: "El worker no tiene ffmpeg",
    model_unavailable: "El modelo de transcripción no se pudo cargar",
    transcribe_failed: "La transcripción falló",
    diarize_failed: "La diarización falló",
    transport_error: "No se pudo hablar con el almacenamiento",
    worker_error: "Fallo interno del worker",
    lease_expired: "El worker dejó de responder",
  };
  return known[failureCode] ?? `Fallo: ${failureCode}`;
}

/* ── Hablantes ────────────────────────────────────────────────────────────── */

/**
 * «Hablante 1», «Hablante 2»… por ORDEN DE ETIQUETA, no por cuota.
 *
 * La etiqueta viene del diarizador (`SPEAKER_00`, `SPEAKER_01`), y ordenar por
 * ella hace que el número sea estable: si se ordenara por tiempo hablado,
 * volver a diarizar la misma reunión podría intercambiar «Hablante 1» y
 * «Hablante 2» y las citas guardadas apuntarían a la persona equivocada.
 *
 * En cuanto alguien identifica al hablante, `display_name` gana. Nunca se
 * inventa un nombre ni un rol: `role` es null mientras no haya contacto ligado,
 * y la pantalla ya sabe mostrar eso como «sin identificar».
 */
export function speakerNames(speakers: readonly UiSpeaker[]): Map<string, { name: string; identified: boolean }> {
  const ordered = [...speakers].sort((a, b) => a.label.localeCompare(b.label));
  const out = new Map<string, { name: string; identified: boolean }>();
  ordered.forEach((speaker, index) => {
    const identified = speaker.displayName !== null && speaker.displayName.trim() !== "";
    out.set(speaker.label, {
      name: identified ? (speaker.displayName as string) : `Hablante ${index + 1}`,
      identified,
    });
  });
  return out;
}

/**
 * Las iniciales. De un nombre real, sus letras; de «Hablante 3», `H3`.
 *
 * `H3` y no `HA`: el avatar tiene que distinguir a los hablantes sin nombre
 * entre sí, y las iniciales de «Hablante» son las mismas para todos.
 */
export function initialsOf(name: string): string {
  const generic = /^Hablante\s+(\d+)$/.exec(name);
  if (generic) return `H${generic[1]}`;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function participantsOf(speakers: readonly UiSpeaker[]): Participant[] {
  const names = speakerNames(speakers);
  return [...speakers]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((speaker) => {
      const resolved = names.get(speaker.label)!;
      return {
        initials: initialsOf(resolved.name),
        name: resolved.name,
        // NUNCA un rol inventado. No hay contacto ligado, así que no hay cargo
        // ni empresa que mostrar, y la pantalla usa null para decirlo.
        role: null,
        share: speaker.talkSharePct,
      };
    });
}

/* ── Transcripción ────────────────────────────────────────────────────────── */

/**
 * Los segmentos, con el nombre del hablante ya resuelto.
 *
 * Se conservan las asignaciones REALES. En el recorrido de W-3 los 15 segmentos
 * están asignados al primer hablante porque el segundo tiene el 1,90 % del
 * tiempo y no es mayoría en ninguno; repartirlos «para que se vean los dos»
 * sería inventar quién dijo qué, que es lo peor que puede hacer una
 * transcripción.
 */
export function transcriptOf(
  segments: readonly UiSegment[],
  speakers: readonly UiSpeaker[],
): TranscriptSegment[] {
  const names = speakerNames(speakers);
  return segments.map((segment) => {
    const resolved = segment.speakerLabel ? names.get(segment.speakerLabel) : undefined;
    const name = resolved?.name ?? "Sin asignar";
    return {
      index: segment.index,
      at: segment.startSec,
      endsAt: segment.endSec,
      stamp: stamp(segment.startSec),
      speakerLabel: segment.speakerLabel,
      speaker: name,
      initials: resolved ? initialsOf(name) : "—",
      text: segment.text,
      ...(resolved?.identified === false || !resolved ? { unidentified: true } : {}),
    };
  });
}

/** Turnos como fracciones, para el tooltip de la onda del reproductor. */
export function speakerTurnsOf(
  segments: readonly UiSegment[],
  speakers: readonly UiSpeaker[],
  durationSeconds: number,
): { from: number; to: number; name: string }[] {
  if (durationSeconds <= 0) return [];
  const names = speakerNames(speakers);
  return segments
    .filter((segment) => segment.speakerLabel !== null)
    .map((segment) => ({
      from: Math.max(0, segment.startSec / durationSeconds),
      to: Math.min(1, segment.endSec / durationSeconds),
      name: names.get(segment.speakerLabel as string)?.name ?? "Sin asignar",
    }));
}

/* ── El origen y los huecos honestos ──────────────────────────────────────── */

export function sourceOf(row: UiMeetingRow): MeetingSource {
  if (row.cancelledAt !== null) return { kind: "cancelled", by: "el operador" };
  switch (row.sourceKind) {
    case "meet":
      return { kind: "meet" };
    case "inbox":
      return { kind: "inbox", thread: row.title };
    case "room":
      return { kind: "room" };
    default:
      return {
        kind: "file",
        // El nombre real del fichero no se persiste —la clave del objeto la
        // deriva el servidor— así que se nombra por lo que SÍ consta.
        filename: "Audio original",
        size: bytesLabel(row.originalBytes),
      };
  }
}

/**
 * El resumen VACÍO. Todas las secciones sin contenido, que es lo que hay:
 * `analysis_state` es `pending` y no existe etapa de análisis todavía.
 *
 * Se devuelve un objeto válido y vacío en vez de `null` para no cambiar el tipo
 * que la pantalla consume, y las tres pestañas que dependen de él muestran su
 * estado vacío. Lo que NO se hace es dejar los fixtures: la pantalla habría
 * mostrado el kickoff inventado junto a una transcripción real, que es peor que
 * una pestaña honesta.
 */
export const EMPTY_SUMMARY: MeetingSummary = {
  executive: "",
  highlights: [],
  themes: [],
  findings: [],
  nextSteps: [],
};

/* ── Las dos conversiones completas ───────────────────────────────────────── */

export function toListItem(row: UiMeetingRow, now?: Date): MeetingListItem {
  return {
    id: row.id,
    title: row.title,
    source: sourceOf(row),
    when: whenLabel(row.startedAt, row.createdAt),
    duration: row.durationSeconds === null ? null : stamp(row.durationSeconds),
    // Los hablantes vienen en la MISMA consulta del listado (un lateral con
    // jsonb_agg), así que la columna muestra avatares de verdad con su cuota en
    // vez de un guion. Se dibujan hasta tres y el resto va como «+N», que es lo
    // que `AvatarStack` espera.
    participants: participantsOf(row.speakers).slice(0, 3),
    extraParticipants: Math.max(0, row.speakerCount - 3),
    status: statusOf(row),
    // Sin almacenamiento de análisis no hay tareas ni informes. `null` es
    // «no se sabe», y la tabla lo pinta como «—» en vez de un 0 que afirmaría
    // que se buscaron y no había.
    tasks: null,
    reports: null,
    updated: relativeLabel(row.updatedAt, now),
    deletionState: row.deletionState,
  };
}

/** Lo que el servicio de análisis devuelve, sin acoplar este módulo a su import. */
export interface StoredAnalysis {
  readonly id: string;
  readonly summary: unknown;
  readonly outdated: boolean;
  readonly model: string;
  readonly createdAt: string;
  /**
   * Coste ESTIMADO en dólares a partir de la tabla local de tarifas. NO es el
   * importe facturado: la tabla puede quedarse atrás, y los tokens de entrada
   * CACHEADOS —que el proveedor factura más baratos— se cuentan aquí a tarifa
   * completa, así que la estimación sobreestima antes que quedarse corta.
   *
   * `null` = no conocemos la tarifa de ese modelo. No es cero.
   */
  readonly costUsd: number | null;
}

export function toDetail(
  detail: UiMeetingDetail,
  now?: Date,
  analysis?: StoredAnalysis | null,
): MeetingDetail {
  const participants = participantsOf(detail.speakers);
  const durationSeconds = detail.durationSeconds ?? 0;
  return {
    ...toListItem(detail, now),
    participants,
    extraParticipants: 0,
    durationSeconds,
    language: detail.language ?? "—",
    // La confianza NO se inventa: los segmentos la traen nula porque el worker
    // no la reporta, y un «95 %» decorativo en una pantalla de transcripción es
    // una afirmación sobre la exactitud del texto.
    confidence: confidenceLabel(detail.segments),
    segments: detail.segmentCount ?? detail.segments.length,
    fileSize: bytesLabel(detail.originalBytes),
    // Sin taxonomía ni etiquetado todavía. Vacío, no inventado.
    tags: [],
    transcript: transcriptOf(detail.segments, detail.speakers),
    // El resumen VALIDADO que se guardó, o vacío. No se compone aquí nada: las
    // referencias ya se comprobaron contra los segmentos al generarlo, y volver
    // a tocarlas aquí sería una segunda fuente de verdad.
    summary: analysis ? (analysis.summary as unknown as MeetingSummary) : EMPTY_SUMMARY,
    analysis: analysis
      ? {
          id: analysis.id,
          outdated: analysis.outdated,
          model: analysis.model,
          createdAt: analysis.createdAt,
          costUsd: analysis.costUsd,
        }
      : null,
    reportList: [],
    evidence: [],
  };
}

/**
 * La confianza media, sólo si hay alguna.
 *
 * Con todos los segmentos en NULL —el caso de hoy— devuelve «No reportada», que
 * es la verdad. Cuando el worker empiece a reportarla, esto la promedia sin más
 * cambios.
 */
export function confidenceLabel(segments: readonly UiSegment[]): string {
  const values = segments.map((s) => s.confidence).filter((c): c is number => c !== null);
  if (values.length === 0) return "No reportada";
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return `${Math.round(mean * 100)} %`;
}
