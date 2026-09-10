import type { TranscriptSegment } from "./meetingsData";

/**
 * BLOQUES DE INTERVENCIÓN — agrupar para leer, sin tocar lo que se cita.
 *
 * El transcript se pintaba con una fila por segmento, y cada fila repetía avatar,
 * nombre, marca de tiempo y «Identificar». Con segmentos de dos o tres segundos eso
 * es una cabecera cada renglón: la vista deja de leerse como una conversación y pasa
 * a leerse como un log, y el texto —lo único que importa— ocupa una fracción de la
 * pantalla.
 *
 * ESTA AGRUPACIÓN ES DE PRESENTACIÓN. No fusiona segmentos ni reescribe tiempos: cada
 * bloque CONTIENE los segmentos originales, con su `index` (el identificador estable
 * dentro de la versión del transcript), su `at` y su `endsAt` intactos. La
 * reproducción, el resaltado y las citas siguen apuntando al segmento, no al bloque.
 *
 * SE AGRUPA POR `speakerLabel`, NUNCA POR EL NOMBRE MOSTRADO. Es la diferencia entre
 * correcto e incorrecto, no un detalle: los hablantes sin resolver se pintan todos
 * como «Sin asignar», así que agrupar por nombre juntaría en un mismo bloque a dos
 * personas distintas que todavía no tienen contacto asociado — exactamente la mezcla
 * que no puede ocurrir en un transcript. Y un segmento sin etiqueta (`null`) no se
 * agrupa con nadie, ni con otro sin etiqueta: no se sabe si es la misma voz, y
 * suponerlo sería inventar una atribución.
 */

/**
 * Una pausa a partir de la cual la misma voz ya no está continuando una idea, sino
 * empezando otra intervención. Por debajo de esto son respiraciones y silencios de
 * pensar, que dentro de un bloque se leen como lo que son.
 */
export const PAUSE_BREAK_SEC = 8;

/**
 * Tope de duración de un bloque. Un monólogo de cinco minutos bajo una sola cabecera
 * deja al lector sin referencia de dónde está en el audio; se parte y la cabecera se
 * repite con su propia marca de tiempo. No cambia quién habla: los dos trozos siguen
 * siendo del mismo hablante.
 */
export const MAX_BLOCK_SEC = 90;

export interface TranscriptBlock {
  /** `${index del primer segmento}` — estable, y sirve de `key` de React. */
  readonly key: string;
  readonly speaker: string;
  readonly initials: string;
  readonly speakerLabel: string | null;
  readonly unidentified: boolean;
  /** Inicio del bloque: el del primer segmento, sin redondear. */
  readonly at: number;
  readonly stamp: string;
  /** Fin del último segmento. */
  readonly endsAt: number;
  /** Los segmentos ORIGINALES, en orden, sin fusionar. */
  readonly segments: readonly TranscriptSegment[];
  /** Por qué empezó este bloque — para explicar la separación, y para probarla. */
  readonly startedBy: "first" | "speaker-change" | "pause" | "length";
}

export interface GroupOptions {
  readonly pauseBreakSec?: number;
  readonly maxBlockSec?: number;
}

/**
 * Agrupa segmentos consecutivos del mismo hablante. Corta cuando cambia el hablante,
 * cuando hay una pausa significativa, o cuando el bloque ya es demasiado largo para
 * leerse de una vez.
 *
 * Los segmentos se recorren en el orden recibido, que es el del transcript. No se
 * reordenan: el orden temporal es un hecho del artefacto, no algo que esta función
 * deba arreglar.
 */
export function groupTranscript(
  segments: readonly TranscriptSegment[],
  options: GroupOptions = {},
): TranscriptBlock[] {
  const pauseBreak = options.pauseBreakSec ?? PAUSE_BREAK_SEC;
  const maxBlock = options.maxBlockSec ?? MAX_BLOCK_SEC;

  const blocks: TranscriptBlock[] = [];
  let current: TranscriptSegment[] = [];
  let startedBy: TranscriptBlock["startedBy"] = "first";

  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    blocks.push({
      key: String(first.index),
      speaker: first.speaker,
      initials: first.initials,
      speakerLabel: first.speakerLabel,
      unidentified: first.unidentified === true,
      at: first.at,
      stamp: first.stamp,
      endsAt: last.endsAt,
      segments: current,
      startedBy,
    });
    current = [];
  };

  for (const segment of segments) {
    if (current.length === 0) {
      current = [segment];
      continue;
    }
    const previous = current[current.length - 1];
    const openedAt = current[0].at;

    // Sin etiqueta no se agrupa: ni con una etiqueta, ni con otro sin etiqueta.
    const sameSpeaker =
      segment.speakerLabel !== null &&
      previous.speakerLabel !== null &&
      segment.speakerLabel === previous.speakerLabel;

    if (!sameSpeaker) {
      flush();
      startedBy = "speaker-change";
      current = [segment];
      continue;
    }
    if (segment.at - previous.endsAt >= pauseBreak) {
      flush();
      startedBy = "pause";
      current = [segment];
      continue;
    }
    if (segment.endsAt - openedAt > maxBlock) {
      flush();
      startedBy = "length";
      current = [segment];
      continue;
    }
    current.push(segment);
  }
  flush();
  return blocks;
}
