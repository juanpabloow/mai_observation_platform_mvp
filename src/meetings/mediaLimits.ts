/**
 * Límites de los medios que se aceptan en una reunión: tamaño, duración,
 * extensión y MIME. Puro: sin base, sin red, sin SDK.
 *
 * ── Qué garantiza esto y qué no ─────────────────────────────────────────────
 *
 * Nada de lo que se valida aquí prueba que el fichero sea audio. La extensión
 * la elige quien sube, el MIME lo declara el navegador y el tamaño es lo único
 * que el almacenamiento puede hacer cumplir de verdad (va firmado en el PUT).
 *
 * Así que este módulo hace lo que un portero puede hacer: rechazar lo que
 * claramente no procede, temprano y barato, antes de firmar una URL y antes de
 * gastar un slot de GPU. **El único juez de si hay audio dentro es `ffprobe` en
 * el worker**, y por eso `probe_ok`/`probe_error` son columnas de
 * `meeting_media` y no un detalle de implementación: el veredicto real se
 * persiste.
 *
 * El orden importa. Un `.mp3` renombrado a `.wav` pasa por aquí y muere en
 * ffprobe; un `.exe` renombrado a `.wav` también. Lo que esta capa evita es que
 * un fichero de 40 GB llegue a firmarse, o que un `.pdf` consuma una descarga
 * en el worker. Es un filtro, no una prueba.
 *
 * ── Configurable ───────────────────────────────────────────────────────────
 *
 * Todo lo de aquí sale de variables de entorno con valores por defecto
 * razonables, para que apretar o soltar un límite en producción no sea un
 * despliegue de código. `parseMediaLimits` no lanza: un valor ilegible cae al
 * defecto y se reporta en `warnings`, porque un límite mal escrito no debe
 * impedir arrancar el proceso — pero tampoco debe pasar desapercibido.
 */

export interface MediaLimits
{
  readonly maxBytes: number;
  readonly maxDurationSeconds: number;
  /** Con punto y en minúsculas: '.mp3'. */
  readonly allowedExtensions: readonly string[];
  readonly allowedContentTypes: readonly string[];
}

/**
 * 4 horas de audio es el techo que el diseño declara soportar. A 128 kbps eso
 * son ~230 MB; el límite de tamaño se pone en 2 GiB para admitir formatos sin
 * comprimir sin dejar la puerta abierta a subidas absurdas.
 */
export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxDurationSeconds: 4 * 60 * 60,
  allowedExtensions: ['.mp3', '.mp4', '.m4a', '.wav', '.flac', '.ogg', '.webm'],
  allowedContentTypes: [
    'audio/mpeg',
    'audio/mp4',
    'audio/x-m4a',
    'audio/wav',
    'audio/x-wav',
    'audio/wave',
    'audio/flac',
    'audio/x-flac',
    'audio/ogg',
    'audio/webm',
    'video/mp4',
    'video/webm',
    // Un navegador que no reconoce la extensión manda esto. Se acepta porque
    // rechazarlo bloquearía subidas legítimas desde Safari y desde arrastrar y
    // soltar; el veredicto lo da ffprobe de todos modos.
    'application/octet-stream',
  ],
} as const;

function parsePositiveInt(raw: string | undefined, fallback: number, warnings: string[], name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    warnings.push(`${name}=${JSON.stringify(raw)} no es un entero positivo; se usa ${fallback}`);
    return fallback;
  }
  return value;
}

/** Lista separada por comas; se normaliza a minúsculas y sin duplicados. */
function parseList(
  raw: string | undefined,
  fallback: readonly string[],
  normalize: (item: string) => string,
): readonly string[] {
  if (raw === undefined || raw.trim() === '') return fallback;
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map(normalize);
  // Una lista vacía tras normalizar significa que alguien escribió basura: se
  // conserva el default, porque una allowlist vacía rechazaría TODO y eso
  // parecería un fallo del producto, no de la configuración.
  return items.length > 0 ? [...new Set(items)] : fallback;
}

export interface ParsedMediaLimits {
  readonly limits: MediaLimits;
  readonly warnings: readonly string[];
}

export function parseMediaLimits(env: Readonly<Record<string, string | undefined>>): ParsedMediaLimits {
  const warnings: string[] = [];
  return {
    limits: {
      maxBytes: parsePositiveInt(
        env.MEETINGS_MAX_MEDIA_BYTES,
        DEFAULT_MEDIA_LIMITS.maxBytes,
        warnings,
        'MEETINGS_MAX_MEDIA_BYTES',
      ),
      maxDurationSeconds: parsePositiveInt(
        env.MEETINGS_MAX_DURATION_SECONDS,
        DEFAULT_MEDIA_LIMITS.maxDurationSeconds,
        warnings,
        'MEETINGS_MAX_DURATION_SECONDS',
      ),
      allowedExtensions: parseList(
        env.MEETINGS_ALLOWED_EXTENSIONS,
        DEFAULT_MEDIA_LIMITS.allowedExtensions,
        (item) => `.${item.replace(/^\.+/, '')}`.toLowerCase(),
      ),
      allowedContentTypes: parseList(
        env.MEETINGS_ALLOWED_CONTENT_TYPES,
        DEFAULT_MEDIA_LIMITS.allowedContentTypes,
        (item) => item.toLowerCase(),
      ),
    },
    warnings,
  };
}

/** Códigos estables: la UI y el worker los mapean a mensajes, no los parsean. */
export type MediaRejectCode =
  | 'filename_missing'
  | 'extension_not_allowed'
  | 'content_type_not_allowed'
  | 'size_missing'
  | 'size_too_large'
  | 'size_not_positive'
  | 'duration_too_long';

export interface MediaCandidate {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: number;
  /** Sólo la conoce el worker tras ffprobe; en `upload-init` es undefined. */
  readonly durationSeconds?: number;
}

export type MediaCheck =
  | { readonly ok: true; readonly extension: string; readonly contentType: string }
  | { readonly ok: false; readonly code: MediaRejectCode; readonly detail: string };

/**
 * Extensión en minúsculas, con punto, del último segmento del nombre. Se ignora
 * cualquier ruta que venga en el nombre: da igual, porque el nombre NUNCA entra
 * en la clave del objeto (ver storageKeys). Aquí sólo se lee la extensión.
 */
export function extensionOf(filename: string): string | null {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot).toLowerCase();
}

export function checkMedia(candidate: MediaCandidate, limits: MediaLimits): MediaCheck {
  if (!candidate.filename || candidate.filename.trim() === '') {
    return { ok: false, code: 'filename_missing', detail: 'El nombre del fichero es obligatorio.' };
  }

  const extension = extensionOf(candidate.filename);
  if (extension === null || !limits.allowedExtensions.includes(extension)) {
    return {
      ok: false,
      code: 'extension_not_allowed',
      detail: `Extensión no admitida. Se aceptan: ${limits.allowedExtensions.join(', ')}.`,
    };
  }

  // El content type puede traer parámetros ('audio/mpeg; charset=binary').
  const contentType = (candidate.contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!limits.allowedContentTypes.includes(contentType)) {
    return {
      ok: false,
      code: 'content_type_not_allowed',
      detail: 'Tipo de contenido no admitido.',
    };
  }

  if (!Number.isFinite(candidate.bytes)) {
    return { ok: false, code: 'size_missing', detail: 'El tamaño es obligatorio.' };
  }
  if (candidate.bytes <= 0) {
    return { ok: false, code: 'size_not_positive', detail: 'El fichero está vacío.' };
  }
  if (candidate.bytes > limits.maxBytes) {
    return {
      ok: false,
      code: 'size_too_large',
      detail: `El fichero supera el máximo de ${limits.maxBytes} bytes.`,
    };
  }

  // Sólo se comprueba si se conoce: en upload-init nadie la sabe todavía.
  if (candidate.durationSeconds !== undefined && candidate.durationSeconds > limits.maxDurationSeconds) {
    return {
      ok: false,
      code: 'duration_too_long',
      detail: `La duración supera el máximo de ${limits.maxDurationSeconds} segundos.`,
    };
  }

  return { ok: true, extension, contentType };
}
