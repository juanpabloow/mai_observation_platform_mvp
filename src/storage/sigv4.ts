import { createHash, createHmac } from 'node:crypto';

/**
 * Firmado SigV4 de URLs prefirmadas (query-string), sin dependencias.
 *
 * ── Por qué no se usa el SDK ────────────────────────────────────────────────
 *
 * `@aws-sdk/s3-request-presigner` no está instalado, y el paquete que sí está
 * (`@aws-sdk/client-s3`, en web/) no presigna: el firmado vive en otro paquete.
 * Añadirlo traería su árbol de dependencias a un repositorio cuyo lado worker
 * hoy depende de cuatro cosas (dotenv, pg, pino, zod).
 *
 * Presignar es una función pura: (credenciales, método, host, clave, caducidad,
 * cabeceras) → una URL. No hace red, no mantiene estado y no negocia nada. Eso
 * la hace verificable de una forma que un cliente HTTP no: con una fecha y unas
 * credenciales fijas, la firma es un valor concreto y comparable.
 *
 * Y AWS publica el vector de prueba. `test/unit/sigv4Presign.test.ts` comprueba
 * que esta implementación produce EXACTAMENTE la firma documentada para el
 * ejemplo canónico (examplebucket / test.txt / 20130524T000000Z). Si algún
 * detalle del algoritmo estuviera mal —el orden de las cabeceras firmadas, la
 * codificación de la ruta, el formato de la fecha— esa prueba falla.
 *
 * ── Qué NO hace ─────────────────────────────────────────────────────────────
 *
 * Sólo presignado por query string, que es lo que un navegador o un worker
 * necesitan para un PUT o un GET directo contra el almacenamiento. No firma
 * cabeceras de peticiones normales, no soporta payload firmado (usa
 * UNSIGNED-PAYLOAD, como toda URL prefirmada) ni chunked uploads.
 */

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Sólo para credenciales temporales (STS). R2 no las usa. */
  readonly sessionToken?: string;
}

export interface PresignInput {
  readonly credentials: SigV4Credentials;
  readonly region: string;
  readonly service: string;
  /** Método HTTP en mayúsculas: 'PUT' | 'GET' | 'HEAD' | 'DELETE'. */
  readonly method: string;
  /** Host del endpoint, sin esquema ni barra: 'bucket.cuenta.r2.cloudflarestorage.com'. */
  readonly host: string;
  /** Ruta ya con la barra inicial. Se codifica aquí; no la codifiques antes. */
  readonly path: string;
  /** Segundos de validez. S3 acepta hasta 604800 (7 días). */
  readonly expiresInSeconds: number;
  /** Instante de firma. Se pasa explícito para que la firma sea reproducible. */
  readonly signedAt: Date;
  /**
   * Cabeceras que el cliente DEBE enviar y que quedan dentro de la firma. Es el
   * mecanismo por el que un PUT prefirmado puede exigir un content-type y un
   * tamaño concretos: si el cliente manda otros, S3 rechaza la petición porque
   * la firma no cuadra. Sin esto, una URL de subida aceptaría cualquier cosa.
   */
  readonly signedHeaders?: Readonly<Record<string, string>>;
  /** Parámetros extra de query que también entran en la firma. */
  readonly queryParams?: Readonly<Record<string, string>>;
}

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
/** S3 no acepta URLs prefirmadas de más de 7 días. */
export const MAX_PRESIGN_SECONDS = 604_800;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/**
 * Codificación RFC 3986 estricta. `encodeURIComponent` deja sin codificar
 * `!'()*`, que S3 sí espera codificados: una clave con un paréntesis produciría
 * una firma que no cuadra y un 403 imposible de diagnosticar desde el cliente.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** La ruta se codifica segmento a segmento: las barras se conservan. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/');
}

/** '20130524T000000Z' — ISO básico, sin guiones ni milisegundos. */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/** Query canónica: claves ordenadas por byte, clave y valor codificados. */
function canonicalQuery(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(params[key])}`)
    .join('&');
}

interface CanonicalHeaders {
  readonly canonical: string;
  readonly signed: string;
}

/**
 * Cabeceras canónicas: nombres en minúsculas, ordenados, valores con los
 * espacios internos colapsados y los de los extremos recortados.
 */
function canonicalHeaders(headers: Readonly<Record<string, string>>): CanonicalHeaders {
  const lower = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    lower.set(name.toLowerCase().trim(), String(value).trim().replace(/\s+/g, ' '));
  }
  const names = [...lower.keys()].sort();
  return {
    canonical: names.map((name) => `${name}:${lower.get(name)}\n`).join(''),
    signed: names.join(';'),
  };
}

/** La clave de firma: cuatro HMAC encadenados sobre fecha, región y servicio. */
function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export interface PresignedRequest {
  readonly url: string;
  /** Cabeceras que el cliente está OBLIGADO a enviar, o la firma no cuadra. */
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

/**
 * Devuelve una URL prefirmada. La firma no contiene el secreto: es un HMAC del
 * que no se puede recuperar la clave, así que la URL puede viajar por un canal
 * que no confíe en el cliente. Lo que sí revela es la clave del objeto y el
 * método, y por eso caduca.
 */
export function presign(input: PresignInput): PresignedRequest {
  if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 1) {
    throw new Error('presign: expiresInSeconds debe ser un entero >= 1');
  }
  if (input.expiresInSeconds > MAX_PRESIGN_SECONDS) {
    throw new Error(
      `presign: expiresInSeconds ${input.expiresInSeconds} excede el máximo de S3 (${MAX_PRESIGN_SECONDS})`,
    );
  }

  const timestamp = amzDate(input.signedAt);
  const dateStamp = timestamp.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;

  // El host SIEMPRE va firmado; sin él, la URL valdría contra otro endpoint.
  const headers: Record<string, string> = { host: input.host, ...(input.signedHeaders ?? {}) };
  const { canonical: canonicalHeaderBlock, signed } = canonicalHeaders(headers);

  const query: Record<string, string> = {
    ...(input.queryParams ?? {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': timestamp,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': signed,
  };
  if (input.credentials.sessionToken) {
    query['X-Amz-Security-Token'] = input.credentials.sessionToken;
  }

  const encodedPath = encodePath(input.path);
  const canonicalRequest = [
    input.method.toUpperCase(),
    encodedPath,
    canonicalQuery(query),
    canonicalHeaderBlock,
    signed,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = createHmac(
    'sha256',
    signingKey(input.credentials.secretAccessKey, dateStamp, input.region, input.service),
  )
    .update(stringToSign, 'utf8')
    .digest('hex');

  const finalQuery = `${canonicalQuery(query)}&X-Amz-Signature=${signature}`;

  // Las cabeceras firmadas distintas de 'host' son las que el cliente debe
  // reenviar. 'host' lo pone el propio cliente HTTP a partir de la URL.
  const requiredHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.signedHeaders ?? {})) {
    requiredHeaders[name.toLowerCase()] = value;
  }

  return {
    url: `https://${input.host}${encodedPath}?${finalQuery}`,
    requiredHeaders,
    expiresAt: new Date(input.signedAt.getTime() + input.expiresInSeconds * 1000),
  };
}
