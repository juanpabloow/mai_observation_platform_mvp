/**
 * El transcript como TEXTO. Un solo serializador para copiar y para descargar.
 *
 * ── Por qué uno y no dos ───────────────────────────────────────────────────
 *
 * Porque «copiar» y «exportar» producen el MISMO documento, y dos funciones que
 * producen el mismo documento divergen a la primera corrección que sólo se
 * aplica a una. Entonces lo que se pega y lo que se descarga dejan de
 * coincidir, y eso no se nota hasta que alguien compara dos copias del acta de
 * la misma reunión.
 *
 * ── Por qué es una función pura y vive en `lib` ────────────────────────────
 *
 * Para poder EJECUTARLA en las pruebas. Los botones son componentes de cliente
 * que el runner de la raíz no puede renderizar; si el formato viviera dentro de
 * ellos, lo único comprobable serían aserciones sobre su código fuente, y un
 * `assert.match` no distingue «el formato es éste» de «la cadena aparece».
 *
 * ── Lo que NO sale ─────────────────────────────────────────────────────────
 *
 * Ni uuid, ni ids de transcripción, ni estados del pipeline, ni nada interno.
 * Lo que entra aquí son los datos que ya se están pintando en la pantalla, y
 * esta función no tiene acceso a nada más.
 */

export interface TranscriptExportMeta {
  readonly title: string;
  /** Omitidos si faltan: una línea «Cliente:» vacía es peor que ninguna. */
  readonly clientName?: string | null;
  /** Ya formateada para una persona. No se reformatea aquí. */
  readonly date?: string | null;
  readonly durationSeconds?: number | null;
}

export interface TranscriptExportLine {
  /** Segundo de inicio. Es de donde sale la marca, y también el orden. */
  readonly at: number;
  /** Nombre identificado, o «Hablante N». Nunca un uuid ni una etiqueta cruda. */
  readonly speaker: string;
  readonly text: string;
}

/**
 * La marca de una intervención: `mm:ss`, y `h:mm:ss` al pasar de la hora.
 *
 * Los minutos van a dos dígitos incluso por debajo del minuto uno —`[00:07]`—
 * porque las marcas se leen en columna y un ancho variable las desalinea.
 *
 * No se reutiliza la marca que ya trae el segmento para la pantalla: ésa es una
 * decisión de presentación que puede cambiar, y el formato del fichero es un
 * contrato. Aquí se calcula desde el segundo.
 */
export function transcriptStamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const dos = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${dos(m)}:${dos(s)}` : `${dos(m)}:${dos(s)}`;
}

/** La duración de la cabecera, siempre `HH:MM:SS`. */
export function durationLabel(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${dos(Math.floor(total / 3600))}:${dos(Math.floor(total / 60) % 60)}:${dos(total % 60)}`;
}

/**
 * El documento completo, o `null` si no hay nada que serializar.
 *
 * `null` y no una cabecera suelta: un fichero con el título de la reunión y
 * ninguna intervención parece un transcript vacío cuando en realidad es un
 * transcript que no se pudo leer. Devolver `null` obliga a quien llama a
 * decidir, y lo que decide la pantalla es no ofrecer la acción.
 */
export function serializeTranscript(
  meta: TranscriptExportMeta,
  lines: readonly TranscriptExportLine[],
): string | null {
  const utiles = lines.filter((l) => l.text.trim() !== '');
  if (utiles.length === 0) return null;

  const cabecera: string[] = [meta.title.trim()];
  // Cada metadato sólo si existe. Nada de «Cliente: —».
  const cliente = meta.clientName?.trim();
  if (cliente) cabecera.push(`Cliente: ${cliente}`);
  const fecha = meta.date?.trim();
  if (fecha) cabecera.push(`Fecha: ${fecha}`);
  if (typeof meta.durationSeconds === 'number' && meta.durationSeconds > 0) {
    cabecera.push(`Duración: ${durationLabel(meta.durationSeconds)}`);
  }

  // ORDEN CRONOLÓGICO, y estable entre marcas iguales: dos intervenciones que
  // arrancan en el mismo segundo conservan el orden en que llegaron, que es el
  // del transcript.
  const ordenadas = utiles
    .map((l, i) => ({ l, i }))
    .sort((a, b) => (a.l.at === b.l.at ? a.i - b.i : a.l.at - b.l.at))
    .map(({ l }) => l);

  const cuerpo = ordenadas.map(
    (l) => `[${transcriptStamp(l.at)}] ${l.speaker.trim()}\n${l.text.trim()}`,
  );

  // Una línea en blanco entre la cabecera y el cuerpo, y otra entre
  // intervenciones. Y salto final: un fichero de texto termina en uno.
  return `${cabecera.join('\n')}\n\n${cuerpo.join('\n\n')}\n`;
}

/**
 * El nombre del fichero: `titulo-saneado-transcript.txt`.
 *
 * Se quitan tildes y eñes del NOMBRE aunque el contenido las conserve, porque
 * son dos problemas distintos: dentro del fichero la codificación es nuestra y
 * es UTF-8; el nombre lo interpreta el sistema de ficheros de quien descarga, y
 * ahí un carácter compuesto puede llegar mal a un Windows o a un zip.
 */
export function transcriptFileName(title: string): string {
  const base = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Todo lo que no sea letra ASCII o dígito pasa a guion: espacios, barras,
    // dos puntos y los demás caracteres que un sistema de ficheros reserva.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    // Un título largo produciría un nombre que algunos sistemas truncan por su
    // cuenta, y truncado por ellos puede perder el sufijo.
    .slice(0, 80)
    .replace(/-$/, '');
  return `${base === '' ? 'reunion' : base}-transcript.txt`;
}
