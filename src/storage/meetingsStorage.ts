import { FakePrivateStore } from './fakePrivateStore.js';
import { S3PrivateStore } from './s3PrivateStore.js';
import { StorageUnavailableError, type PrivateObjectStore } from './privateObjectStore.js';

/**
 * Resolución del almacenamiento privado de Reuniones desde el entorno.
 *
 * ── El bucket privado es OTRO bucket ────────────────────────────────────────
 *
 * Todas las variables llevan el prefijo `MEETINGS_STORAGE_*`, ninguna se
 * comparte con las `R2_*` del bucket público de logos. Y no es sólo separación
 * por convención: `assertSeparateFromPublicBucket` **falla al arrancar** si el
 * bucket privado coincide con el público o si tiene una URL base pública
 * configurada. Un audio de una reunión en un bucket con lectura anónima es una
 * fuga que ninguna capa de arriba puede reparar, así que la comprobación se
 * hace donde se decide, no donde se usa.
 *
 * ── Nada de esto se persiste ────────────────────────────────────────────────
 *
 * Ni credenciales ni URLs firmadas llegan a la base. Lo que se guarda es la
 * CLAVE del objeto —derivada por el servidor, sin secretos— y la URL se vuelve
 * a firmar cada vez que alguien la necesita. Por eso la caducidad puede ser
 * corta sin coste: renovar es una llamada local, no un ciclo de vida que haya
 * que administrar.
 *
 * ── Y nada de esto entra en un log ──────────────────────────────────────────
 *
 * `describeStorage()` existe para eso: devuelve lo que se puede registrar
 * (driver, host, bucket, caducidades) y nada más. `redactSignedUrl()` recorta
 * una URL firmada a origen + ruta, tirando toda la query, que es donde viven la
 * credencial, la fecha y la firma.
 */

export type StorageDriver = 's3' | 'fake';

export interface MeetingsStorageResolution {
  readonly store: PrivateObjectStore | null;
  readonly driver: StorageDriver | null;
  /** Motivos por los que NO se pudo configurar. Vacío si `store` existe. */
  readonly problems: readonly string[];
  readonly putTtlSeconds: number;
  readonly getTtlSeconds: number;
}

const DEFAULT_PUT_TTL = 900; // 15 min: lo que tarda una subida grande de verdad.
const DEFAULT_GET_TTL = 3600; // 1 h: cubre una transcripción larga sin renovar.

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * El bucket privado NO puede ser el público. Se comprueba por nombre y por la
 * presencia de una URL pública, que es la señal de que ese bucket sirve tráfico
 * anónimo.
 */
export function assertSeparateFromPublicBucket(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const problems: string[] = [];
  const privateBucket = env.MEETINGS_STORAGE_BUCKET?.trim();
  const publicBucket = env.R2_BUCKET_NAME?.trim();
  if (privateBucket && publicBucket && privateBucket === publicBucket) {
    problems.push(
      'MEETINGS_STORAGE_BUCKET es el mismo bucket que R2_BUCKET_NAME (el público de logos). ' +
        'El audio de las reuniones no puede vivir en un bucket con lectura anónima.',
    );
  }
  if (privateBucket && env.MEETINGS_STORAGE_PUBLIC_URL?.trim()) {
    problems.push(
      'MEETINGS_STORAGE_PUBLIC_URL está definida. El bucket privado no debe tener base pública: ' +
        'todo acceso es una URL firmada que caduca.',
    );
  }
  return problems;
}

export function resolveMeetingsStorage(
  env: Readonly<Record<string, string | undefined>>,
  options?: { fetchImpl?: S3Options['fetchImpl']; clock?: () => Date },
): MeetingsStorageResolution {
  const putTtlSeconds = positiveInt(env.MEETINGS_STORAGE_PUT_TTL_SECONDS, DEFAULT_PUT_TTL);
  const getTtlSeconds = positiveInt(env.MEETINGS_STORAGE_GET_TTL_SECONDS, DEFAULT_GET_TTL);
  const problems = assertSeparateFromPublicBucket(env);

  const driverRaw = (env.MEETINGS_STORAGE_DRIVER ?? '').trim().toLowerCase();

  if (driverRaw === 'fake') {
    // Explícito, nunca por defecto: un almacenamiento en memoria elegido por
    // omisión en producción perdería las reuniones en el siguiente reinicio y
    // parecería que funcionaba.
    if (problems.length > 0) {
      return { store: null, driver: null, problems, putTtlSeconds, getTtlSeconds };
    }
    return {
      store: new FakePrivateStore({ putTtlSeconds, getTtlSeconds, clock: options?.clock }),
      driver: 'fake',
      problems: [],
      putTtlSeconds,
      getTtlSeconds,
    };
  }

  const endpoint = env.MEETINGS_STORAGE_ENDPOINT?.trim();
  const bucket = env.MEETINGS_STORAGE_BUCKET?.trim();
  const accessKeyId = env.MEETINGS_STORAGE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.MEETINGS_STORAGE_SECRET_ACCESS_KEY?.trim();

  const missing: string[] = [];
  if (!endpoint) missing.push('MEETINGS_STORAGE_ENDPOINT');
  if (!bucket) missing.push('MEETINGS_STORAGE_BUCKET');
  if (!accessKeyId) missing.push('MEETINGS_STORAGE_ACCESS_KEY_ID');
  if (!secretAccessKey) missing.push('MEETINGS_STORAGE_SECRET_ACCESS_KEY');
  if (missing.length > 0) {
    problems.push(`Falta configuración del almacenamiento privado: ${missing.join(', ')}.`);
  }
  if (problems.length > 0) {
    return { store: null, driver: null, problems, putTtlSeconds, getTtlSeconds };
  }

  try {
    const store = new S3PrivateStore(
      {
        endpoint: endpoint as string,
        bucket: bucket as string,
        region: env.MEETINGS_STORAGE_REGION?.trim() || 'auto',
        credentials: {
          accessKeyId: accessKeyId as string,
          secretAccessKey: secretAccessKey as string,
          ...(env.MEETINGS_STORAGE_SESSION_TOKEN?.trim()
            ? { sessionToken: env.MEETINGS_STORAGE_SESSION_TOKEN.trim() }
            : {}),
        },
        putTtlSeconds,
        getTtlSeconds,
        // R2 y MinIO usan bucket en la ruta. Se puede desactivar para un S3 real.
        forcePathStyle: (env.MEETINGS_STORAGE_FORCE_PATH_STYLE ?? 'true').trim().toLowerCase() !== 'false',
      },
      { fetchImpl: options?.fetchImpl, clock: options?.clock },
    );
    return { store, driver: 's3', problems: [], putTtlSeconds, getTtlSeconds };
  } catch (cause) {
    return {
      store: null,
      driver: null,
      problems: [
        cause instanceof StorageUnavailableError
          ? cause.message
          : `No se pudo construir el almacenamiento privado: ${(cause as Error).message}`,
      ],
      putTtlSeconds,
      getTtlSeconds,
    };
  }
}

interface S3Options {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Lo que se puede escribir en un log. Ninguna credencial, ninguna URL firmada.
 * El bucket y el host se registran porque diagnosticar «está apuntando al
 * bucket equivocado» sin ellos es imposible, y ninguno de los dos es un
 * secreto: sin las credenciales, saber el nombre del bucket no da acceso.
 */
export function describeStorage(resolution: MeetingsStorageResolution, env: Readonly<Record<string, string | undefined>>): Record<string, unknown> {
  return {
    driver: resolution.driver,
    configured: resolution.store !== null,
    bucket: env.MEETINGS_STORAGE_BUCKET ?? null,
    host: env.MEETINGS_STORAGE_ENDPOINT ? safeHost(env.MEETINGS_STORAGE_ENDPOINT) : null,
    putTtlSeconds: resolution.putTtlSeconds,
    getTtlSeconds: resolution.getTtlSeconds,
    problems: resolution.problems,
  };
}

function safeHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

/**
 * Recorta una URL firmada a lo que se puede registrar: esquema, host y ruta.
 * TODA la query se descarta, porque ahí van `X-Amz-Credential` (que contiene el
 * access key id), `X-Amz-Date` y `X-Amz-Signature`. Una URL firmada completa en
 * un log es una credencial de acceso al objeto durante toda su vigencia — y los
 * logs se agregan, se reenvían y se conservan mucho más que 15 minutos.
 */
export function redactSignedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}?<firma-omitida>`;
  } catch {
    return '<url-ilegible>';
  }
}
