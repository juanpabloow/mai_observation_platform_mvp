import { MeetingsApiError, invalidRequest } from './errors.js';
import type { JobStage } from '../db/repositories/meetings/types.js';

/**
 * EL FORMATO PACTADO del audio normalizado, y la única puerta por la que un
 * medio `normalized` entra en la base.
 *
 * ── Por qué existe este módulo ──────────────────────────────────────────────
 *
 * `normalize` tiene un trabajo: dejar el audio en el formato que las dos etapas
 * siguientes esperan. Hasta ahora `result/complete` aceptaba cerrar esa etapa
 * SIN sondeo —`probe` era opcional para todas— y aun así persistía el medio con
 * `probe_ok = true` y encolaba `transcribe`. Es decir: mai afirmaba haber
 * comprobado el formato de un audio que nadie midió, y la etapa siguiente
 * cargaba lo que hubiera. Un worker con un ffmpeg mal configurado producía 48
 * kHz estéreo y el pipeline seguía adelante hasta que el modelo devolviera
 * basura, a kilómetros del sitio donde se podía diagnosticar.
 *
 * ── Dónde vive el pacto y por qué aquí ─────────────────────────────────────
 *
 * Los valores son de PIPELINE, no de esquema. Ponerlos en un CHECK de
 * PostgreSQL los volvería inmutables sin migración, y el día que un modelo
 * mejor quiera 24 kHz habría que migrar el esquema para cambiar un argumento de
 * ffmpeg. La base guarda la invariante ESTRUCTURAL —un medio `normalized` lleva
 * siempre un sondeo completo y exitoso— y este módulo guarda los NÚMEROS.
 *
 * El precio, dicho: los mismos tres valores están en el worker
 * (`app/pull/stages.py`: `TARGET_SAMPLE_RATE`, `TARGET_CHANNELS`,
 * `TARGET_CODEC`) porque es quien invoca ffmpeg, y son dos repositorios. No hay
 * forma de compartir la constante; lo que sí hay es que la discrepancia se
 * detecta en el primer `result/complete` con un código estable, en vez de
 * propagarse.
 */
export const NORMALIZED_AUDIO = {
  sampleRate: 16_000,
  channels: 1,
  codec: 'pcm_s16le',
} as const;

/**
 * El sondeo tal como llega. `sampleRate`, `channels` y `codec` son
 * OBLIGATORIOS —los valida el esquema del cuerpo, así que aquí ya son números y
 * una cadena—; `durationSeconds` puede faltar, y ésa es la única concesión:
 * ffprobe no siempre informa duración (un WAV truncado, un contenedor sin
 * cabecera de duración), y rechazar el medio por eso descartaría audio
 * perfectamente transcribible.
 */
export interface MediaProbe {
  readonly durationSeconds?: number | null;
  readonly sampleRate: number;
  readonly channels: number;
  readonly codec: string;
}

/**
 * ¿Corresponde el sondeo a la etapa que lo manda, y al formato pactado?
 *
 * Se llama ANTES de tocar nada: antes de leer la subida, antes de confirmar el
 * objeto, antes de la transacción que marca el job `succeeded`. Ése es el punto
 * — si fallara más tarde, ya habría un `markVerified` escrito, o peor, un medio
 * con `probe_ok = true` que nadie midió.
 *
 * Los dos códigos son distintos a propósito:
 *
 *   · `invalid_request` (400) — la PETICIÓN está mal: falta un campo obligatorio
 *     para esta etapa, o trae uno que esta etapa no manda. El worker corrige el
 *     payload.
 *   · `media_rejected` (422) — la petición es correcta y dice la verdad; lo que
 *     no vale es el MEDIO que describe. El worker corrige su ffmpeg y rehace el
 *     intento.
 *
 * El mensaje nombra el campo y el valor ESPERADO, que son literales del
 * servidor. Nunca el recibido: iría al cuerpo de la respuesta y de ahí a un log.
 */
export function assertProbeMatchesStage(
  stage: JobStage,
  probe: MediaProbe | null | undefined,
): void {
  if (stage !== 'normalize') {
    // Aceptar y luego ignorar es lo peor de las dos opciones: el worker cree
    // que mai registró algo y mai no registró nada. Sólo `normalize` produce
    // audio, así que sólo `normalize` tiene formato que declarar.
    if (probe !== null && probe !== undefined) {
      throw invalidRequest(`probe: la etapa '${stage}' no produce audio y no debe enviarlo.`);
    }
    return;
  }

  if (probe === null || probe === undefined) {
    throw invalidRequest(
      'probe: es obligatorio al cerrar normalize (ffprobe del audio normalizado).',
    );
  }

  const mismatched: string[] = [];
  if (probe.sampleRate !== NORMALIZED_AUDIO.sampleRate) mismatched.push('sampleRate');
  if (probe.channels !== NORMALIZED_AUDIO.channels) mismatched.push('channels');
  if (probe.codec !== NORMALIZED_AUDIO.codec) mismatched.push('codec');
  if (mismatched.length > 0) {
    throw new MeetingsApiError(
      'media_rejected',
      `El audio normalizado no corresponde al formato pactado (${mismatched.join(', ')}): ` +
        `se espera ${NORMALIZED_AUDIO.sampleRate} Hz, ${NORMALIZED_AUDIO.channels} canal, ` +
        `${NORMALIZED_AUDIO.codec}.`,
    );
  }
}
