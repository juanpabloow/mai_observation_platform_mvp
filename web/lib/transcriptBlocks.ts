import type { TranscriptSegment } from "./meetingsData";

/**
 * BLOQUES DE INTERVENCIÓN Y PÁRRAFOS — agrupar para leer, sin tocar lo que se cita.
 *
 * DOS NIVELES, y la distinción es el punto:
 *
 *   BLOQUE    = una intervención. Una cabecera (avatar, nombre, marca, «Identificar»).
 *               Cambia sólo cuando cambia el hablante o cuando hay una pausa larga.
 *   PÁRRAFO   = un trozo legible DENTRO de la intervención. Sin cabecera propia.
 *
 * La primera versión agrupaba las cabeceras pero seguía pintando un `<p>` por segmento
 * de Whisper, así que el texto salía como una lista de renglones cortos: la cabecera se
 * arreglaba y la lectura no. El texto de un párrafo tiene que fluir y ajustarse al
 * ancho, y los segmentos van EN LÍNEA dentro de él.
 *
 * Y el tope de duración ya no parte la intervención en dos cabeceras. Repetir
 * «Hablante 2 · Identificar» porque alguien lleva 91 segundos hablando no informa de
 * nada: es la misma intervención. Ahora eso abre un PÁRRAFO, que es lo que el ojo
 * necesitaba.
 *
 * LO QUE NO CAMBIA. Esto es presentación: los párrafos CONTIENEN los segmentos
 * originales, con su `index`, su `at` y su `endsAt` intactos, y no se fusiona ni se
 * reescribe ni se resume nada. La reproducción, el resaltado y las citas siguen
 * apuntando al segmento.
 *
 * SE AGRUPA POR `speakerLabel`, NUNCA POR EL NOMBRE MOSTRADO: los hablantes sin
 * resolver se pintan todos «Sin asignar», así que agrupar por nombre juntaría a dos
 * personas distintas en una intervención que nunca ocurrió. Un segmento sin etiqueta
 * (`null`) no se agrupa con nadie, ni con otro sin etiqueta: no se sabe si es la misma
 * voz, y suponerlo sería inventar una atribución.
 */

/** Pausa que separa dos INTERVENCIONES de la misma voz: ya no continúa una idea. */
export const INTERVENTION_PAUSE_SEC = 8;

/**
 * Pausa que abre PÁRRAFO dentro de la intervención. Es el silencio de terminar una
 * frase y empezar otra, no el de respirar a media frase.
 */
export const PARAGRAPH_PAUSE_SEC = 2.5;

/**
 * A partir de aquí se busca dónde cortar el párrafo — pero se corta en la PUNTUACIÓN
 * que ya está en el texto, nunca a media frase. El objetivo es un párrafo de lectura,
 * no una longitud exacta.
 */
export const PARAGRAPH_TARGET_CHARS = 420;

/**
 * Segundo nivel. Los segmentos de Whisper terminan casi siempre en COMA —trocea por
 * audio, no por frase—, así que esperar un punto dejaba párrafos pegados al tope duro:
 * medido en el navegador, una intervención de 1800 caracteres salía en dos bloques de
 * ~900, que es justo el muro que había que evitar. Pasado este umbral vale también una
 * coma o un punto y coma, que son puntuación QUE YA ESTÁ EN EL TEXTO.
 */
export const PARAGRAPH_SOFT_CHARS = 620;

/**
 * Tope duro. Si no ha aparecido ni una coma —dictado corrido, que pasa— se corta
 * igual: un muro de texto es peor que un corte imperfecto.
 */
export const PARAGRAPH_MAX_CHARS = 900;

/** Cierre de frase en el texto TAL CUAL vino. No se añade puntuación que no exista. */
const SENTENCE_END = /[.!?…:]["'”’)]?\s*$/;
/** Pausa escrita: sirve de corte cuando la frase no acaba en un buen rato. */
const CLAUSE_END = /[,;]["'”’)]?\s*$/;

export interface TranscriptParagraph {
  /** `${index del primer segmento}` — estable, y sirve de `key` de React. */
  readonly key: string;
  readonly at: number;
  readonly endsAt: number;
  /** Los segmentos ORIGINALES, en orden, sin fusionar. Se pintan en línea. */
  readonly segments: readonly TranscriptSegment[];
  /** Por qué empezó — para explicarlo y para poder probarlo. */
  readonly startedBy: "first" | "pause" | "sentence" | "clause" | "length";
}

export interface TranscriptBlock {
  readonly key: string;
  readonly speaker: string;
  readonly initials: string;
  readonly speakerLabel: string | null;
  readonly unidentified: boolean;
  readonly at: number;
  readonly stamp: string;
  readonly endsAt: number;
  readonly paragraphs: readonly TranscriptParagraph[];
  /** Todos los segmentos de la intervención, aplanados: para buscar el enfocado. */
  readonly segments: readonly TranscriptSegment[];
  readonly startedBy: "first" | "speaker-change" | "pause";
}

export interface GroupOptions {
  readonly interventionPauseSec?: number;
  readonly paragraphPauseSec?: number;
  readonly paragraphTargetChars?: number;
  readonly paragraphSoftChars?: number;
  readonly paragraphMaxChars?: number;
}

/** Trozos de una intervención en párrafos, por pausa y por puntuación existente. */
function paragraphsOf(
  segments: readonly TranscriptSegment[],
  options: GroupOptions,
): TranscriptParagraph[] {
  const pausa = options.paragraphPauseSec ?? PARAGRAPH_PAUSE_SEC;
  const objetivo = options.paragraphTargetChars ?? PARAGRAPH_TARGET_CHARS;
  const blando = options.paragraphSoftChars ?? PARAGRAPH_SOFT_CHARS;
  const tope = options.paragraphMaxChars ?? PARAGRAPH_MAX_CHARS;

  const out: TranscriptParagraph[] = [];
  let current: TranscriptSegment[] = [];
  let chars = 0;
  let startedBy: TranscriptParagraph["startedBy"] = "first";

  const flush = (): void => {
    if (current.length === 0) return;
    out.push({
      key: String(current[0].index),
      at: current[0].at,
      endsAt: current[current.length - 1].endsAt,
      segments: current,
      startedBy,
    });
    current = [];
    chars = 0;
  };

  for (const segment of segments) {
    if (current.length === 0) {
      current = [segment];
      chars = segment.text.length;
      continue;
    }
    const previous = current[current.length - 1];
    const gap = segment.at - previous.endsAt;
    // El orden importa: la pausa manda sobre la longitud, porque es una señal del
    // audio y no una heurística de ancho.
    if (gap >= pausa) {
      flush();
      startedBy = "pause";
      current = [segment];
      chars = segment.text.length;
      continue;
    }
    if (chars >= objetivo && SENTENCE_END.test(previous.text)) {
      flush();
      startedBy = "sentence";
      current = [segment];
      chars = segment.text.length;
      continue;
    }
    if (chars >= blando && CLAUSE_END.test(previous.text)) {
      flush();
      startedBy = "clause";
      current = [segment];
      chars = segment.text.length;
      continue;
    }
    if (chars >= tope) {
      flush();
      startedBy = "length";
      current = [segment];
      chars = segment.text.length;
      continue;
    }
    current.push(segment);
    chars += segment.text.length + 1;
  }
  flush();
  return out;
}

/**
 * Agrupa segmentos consecutivos del mismo hablante en intervenciones, y cada
 * intervención en párrafos. El orden recibido es el del transcript y no se reordena:
 * el orden temporal es un hecho del artefacto.
 */
export function groupTranscript(
  segments: readonly TranscriptSegment[],
  options: GroupOptions = {},
): TranscriptBlock[] {
  const pausaIntervencion = options.interventionPauseSec ?? INTERVENTION_PAUSE_SEC;

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
      paragraphs: paragraphsOf(current, options),
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
    if (segment.at - previous.endsAt >= pausaIntervencion) {
      flush();
      startedBy = "pause";
      current = [segment];
      continue;
    }
    current.push(segment);
  }
  flush();
  return blocks;
}

/**
 * A QUÉ ALTURA DEJAR EL SCROLL al navegar a un segmento.
 *
 * Se calcula el destino y se hace UN desplazamiento, en vez de desplazar a la cabecera
 * y luego corregir. La primera versión hacía las dos cosas y medía la corrección dentro
 * de un `requestAnimationFrame` — y en el arnés interactivo se vio que ese callback
 * PUEDE NO EJECUTARSE NUNCA: un navegador no pinta las pestañas que no ve, así que rAF
 * no se dispara y la corrección no llegaba. Un salto que sólo funciona si la pestaña
 * está en primer plano no es un salto que funcione.
 *
 * La regla, en orden:
 *   1 · se prefiere ver la CABECERA (menos su margen de scroll): dice de quién es la
 *       intervención y desde cuándo;
 *   2 · pero si desde ahí el segmento buscado queda fuera de pantalla, se CENTRA el
 *       segmento: la cabecera es contexto, el segmento es a lo que se navegó.
 *
 * Todo en coordenadas del contenido del contenedor que hace scroll, y acotado a
 * [0, maxScroll] para no pedir posiciones que no existen.
 */
export function targetScrollTop(input: {
  /** Alto visible del contenedor. */
  readonly viewHeight: number;
  readonly maxScroll: number;
  /** Posición de la cabecera del bloque dentro del contenido. */
  readonly blockTop: number;
  readonly segmentTop: number;
  readonly segmentBottom: number;
  /** El `scroll-margin-top` del bloque: el aire que se le deja arriba. */
  readonly marginTop: number;
}): number {
  const clamp = (value: number): number => Math.max(0, Math.min(value, Math.max(input.maxScroll, 0)));
  const conCabecera = clamp(input.blockTop - input.marginTop);

  // ¿Cabe el segmento con la cabecera arriba? Se compara contra el BORDE INFERIOR del
  // visor en esa posición.
  const cabe =
    input.segmentTop >= conCabecera && input.segmentBottom <= conCabecera + input.viewHeight;
  if (cabe) return conCabecera;

  const alto = Math.max(input.segmentBottom - input.segmentTop, 0);
  return clamp(input.segmentTop - Math.max((input.viewHeight - alto) / 2, 0));
}

/**
 * EL SEGMENTO QUE SUENA en el segundo `t`.
 *
 * Devuelve su índice en el array, o null si ninguno lo cubre — un silencio entre
 * segmentos no hereda el anterior, por la misma razón que una etiqueta ausente no se
 * hereda: sería inventar.
 *
 * Los segmentos vienen ordenados por tiempo, así que se busca por BISECCIÓN. Con un
 * transcript de media hora son cientos de segmentos y esto corre en cada segundo de
 * reproducción; un recorrido lineal ahí es trabajo tirado cuatro veces por segundo.
 */
export function segmentIndexAtTime(
  segments: readonly TranscriptSegment[],
  t: number,
): number | null {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (t < segment.at) high = mid - 1;
    else if (t >= segment.endsAt) low = mid + 1;
    else return mid;
  }
  return null;
}

/**
 * ¿SUSPENDER EL SEGUIMIENTO por este evento de scroll?
 *
 * Se decide por VENTANA DE TIEMPO y no con una bandera de «el próximo evento es mío»,
 * y eso salió de que la bandera falla de verdad: los eventos de scroll se despachan de
 * forma asíncrona, así que un desplazamiento manual podía llegar antes que el evento
 * del automático, consumir la marca y hacerse pasar por propio — el seguimiento no se
 * suspendía nunca. Y un desplazamiento suave emite MUCHOS eventos con posiciones
 * intermedias, que una bandera de un solo uso tampoco cubre.
 */
export function shouldSuspendFollow(now: number, suppressUntil: number): boolean {
  return now >= suppressUntil;
}
