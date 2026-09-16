/**
 * Claves de almacenamiento de Reuniones. **Las deriva el servidor, siempre.**
 *
 * Ningún argumento de este módulo viene del navegador ni del worker: son ids de
 * la base (uuid) y enteros pequeños. No hay una sola concatenación de texto que
 * un cliente pueda influir, así que no existe la clase de fallo «clave con ../»
 * ni «clave que apunta al bucket de otro tenant». Las validaciones de abajo no
 * están para filtrar entrada hostil —no hay— sino para que un BUG de mai no
 * produzca una clave rara en silencio.
 *
 * ── La forma ────────────────────────────────────────────────────────────────
 *
 *   original     t/{tenant}/c/{client}/m/{meeting}/original/source
 *   normalized   t/{tenant}/c/{client}/m/{meeting}/r/{run}/normalized/a{n}/audio.wav
 *   transcript   t/{tenant}/c/{client}/m/{meeting}/r/{run}/transcript/a{n}/transcript.ndjson.gz
 *   diarization  t/{tenant}/c/{client}/m/{meeting}/r/{run}/diarization/a{n}/turns.ndjson.gz
 *
 * El prefijo empieza por tenant y cliente para que una política de bucket o un
 * borrado por cliente sea un prefijo, no un recorrido.
 *
 * ── Por qué son DETERMINISTAS ───────────────────────────────────────────────
 *
 * La misma (reunión, run, intento, rol) da siempre la misma clave. Tres cosas
 * salen de ahí:
 *
 *   · `upload-init` y `result/init` son idempotentes sin recordar nada. Repetir
 *     la llamada devuelve la misma clave con una URL nueva. No hace falta
 *     persistir la clave entre init y complete, y por tanto tampoco persistir
 *     una URL.
 *   · Dos intentos del mismo job escriben en objetos DISTINTOS, porque el
 *     intento está en la clave. El resultado de un intento viejo no puede pisar
 *     el del actual ni por reintento tardío ni por reloj desincronizado.
 *   · mai puede comprobar que el insumo de una etapa existe sin consultar por
 *     run: deriva la clave y pregunta al almacenamiento. `meeting_media` no
 *     tiene columna `run_id`, así que sin determinismo habría que adivinar.
 *
 * ── Por qué el original NO lleva la extensión del fichero ───────────────────
 *
 * `.../original/source`, sin sufijo. Si la clave llevara la extensión que el
 * navegador declaró, reiniciar la subida diciendo otra extensión crearía una
 * SEGUNDA clave y el objeto anterior quedaría huérfano sin fila que lo
 * mencione. La extensión se usa para VALIDAR (ver mediaLimits) y el tipo real
 * lo decide ffprobe en el worker; ninguno de los dos tiene por qué acabar en el
 * nombre del objeto. Y el índice único ya garantiza un solo original vivo por
 * reunión, así que una clave por reunión es exactamente la cardinalidad real.
 */

/** Los cuatro roles que existen en esta fase. `analyze` llega en T-4. */
export type StorageRole = 'original' | 'normalized' | 'transcript' | 'diarization';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nombre del objeto por rol, con la extensión que refleja lo que contiene. */
const OBJECT_NAME: Record<StorageRole, string> = {
  original: 'source',
  normalized: 'audio.wav',
  transcript: 'transcript.ndjson.gz',
  diarization: 'turns.ndjson.gz',
};

/** Content type que mai espera para cada rol derivado (el original lo declara
 *  el cliente y se valida contra la allowlist). */
export const ROLE_CONTENT_TYPE: Record<Exclude<StorageRole, 'original'>, string> = {
  normalized: 'audio/wav',
  transcript: 'application/x-ndjson',
  diarization: 'application/x-ndjson',
};

/** Los artefactos NDJSON viajan comprimidos; el audio normalizado no. */
export const ROLE_CONTENT_ENCODING: Record<Exclude<StorageRole, 'original'>, string | null> = {
  normalized: null,
  transcript: 'gzip',
  diarization: 'gzip',
};

export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageKeyError';
  }
}

function requireUuid(label: string, value: string): string {
  if (!UUID_RE.test(value)) {
    throw new StorageKeyError(`${label} no es un uuid: ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}

function requireAttempt(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 999) {
    throw new StorageKeyError(`attempt fuera de rango (0..999): ${value}`);
  }
  return value;
}

export interface MeetingScope {
  readonly tenantId: string;
  readonly clientId: string;
  readonly meetingId: string;
}

/** Prefijo de una reunión. Borrar una reunión es borrar este prefijo. */
export function meetingPrefix(scope: MeetingScope): string {
  const tenant = requireUuid('tenantId', scope.tenantId);
  const client = requireUuid('clientId', scope.clientId);
  const meeting = requireUuid('meetingId', scope.meetingId);
  return `t/${tenant}/c/${client}/m/${meeting}`;
}

/** Prefijo de un cliente. Una política de retención por cliente es este prefijo. */
export function clientPrefix(tenantId: string, clientId: string): string {
  return `t/${requireUuid('tenantId', tenantId)}/c/${requireUuid('clientId', clientId)}`;
}

/** La clave del medio original subido por el navegador. Una por reunión. */
export function originalMediaKey(scope: MeetingScope): string {
  return `${meetingPrefix(scope)}/original/${OBJECT_NAME.original}`;
}

export interface ArtifactKeyInput extends MeetingScope {
  readonly runId: string;
  readonly attempt: number;
  readonly role: Exclude<StorageRole, 'original'>;
}

/** La clave de un artefacto producido por una etapa. */
export function artifactKey(input: ArtifactKeyInput): string {
  const run = requireUuid('runId', input.runId);
  const attempt = requireAttempt(input.attempt);
  const name = OBJECT_NAME[input.role];
  if (!name) throw new StorageKeyError(`rol desconocido: ${JSON.stringify(input.role)}`);
  return `${meetingPrefix(input)}/r/${run}/${input.role}/a${attempt}/${name}`;
}

/** Prefijo de un run: lo que hay que borrar al podar un reprocesamiento. */
export function runPrefix(scope: MeetingScope, runId: string): string {
  return `${meetingPrefix(scope)}/r/${requireUuid('runId', runId)}`;
}

/**
 * Comprueba que una clave leída de la base pertenece al ámbito esperado. Es la
 * red de seguridad del camino de lectura: `meeting_media.storage_key` es texto,
 * y aunque hoy sólo lo escribe este módulo, firmar un GET sobre una clave que
 * no es de esta reunión sería una fuga entre clientes. Se comprueba antes de
 * firmar, no después.
 */
export function keyBelongsToMeeting(key: string, scope: MeetingScope): boolean {
  return key.startsWith(`${meetingPrefix(scope)}/`);
}
