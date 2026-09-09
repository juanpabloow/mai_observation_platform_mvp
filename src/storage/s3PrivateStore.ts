import { createHash } from 'node:crypto';
import { presign, type SigV4Credentials } from './sigv4.js';
import {
  base64ToHex,
  hexToBase64,
  StorageUnavailableError,
  type ByteRange,
  type ConfirmInput,
  type ConfirmResult,
  type ObjectStat,
  type PrivateObjectStore,
  type SignGetInput,
  type SignPutInput,
  type SignedUrl,
  type StoreCapabilities,
} from './privateObjectStore.js';

/**
 * Adaptador S3-compatible, pensado para Cloudflare R2.
 *
 * ── Por qué `fetch` y no `@aws-sdk/client-s3` ───────────────────────────────
 *
 * Lo único que este adaptador hace por red es HEAD, GET y DELETE de un objeto.
 * Son tres peticiones firmadas por query string, es decir, tres URLs que
 * `presign()` ya sabe construir y que cualquier cliente HTTP puede pedir. El
 * SDK aportaría reintentos y paginación —que aquí no hacen falta— a cambio de
 * traer su árbol de dependencias al lado worker del repositorio, que hoy
 * depende de cuatro paquetes.
 *
 * `fetch` se inyecta. No por purismo: es lo que permite probar el adaptador
 * —incluidas las respuestas raras de un almacenamiento real: 404, 206, un
 * content-length que no cuadra, un checksum ausente— sin red y sin emulador.
 *
 * ── R2 frente a S3 ──────────────────────────────────────────────────────────
 *
 * R2 firma con `region: 'auto'` y expone el bucket en la ruta
 * (`https://<cuenta>.r2.cloudflarestorage.com/<bucket>/<clave>`). Se soportan
 * las dos formas —ruta y subdominio— porque MinIO, que es el emulador
 * desechable de la validación local, usa ruta, y un S3 real usa subdominio.
 *
 * R2 **sí** soporta `x-amz-checksum-sha256` en el PUT y lo devuelve en el HEAD
 * cuando se pide `x-amz-checksum-mode: ENABLED`. Cuando el almacenamiento no lo
 * devuelve, `confirm()` responde `checksumVerified: false` en vez de dar por
 * bueno lo que no comprobó.
 */

export interface S3PrivateStoreConfig {
  /** Endpoint completo: 'https://cuenta.r2.cloudflarestorage.com'. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly credentials: SigV4Credentials;
  readonly putTtlSeconds: number;
  readonly getTtlSeconds: number;
  /**
   * true = 'https://host/bucket/clave' (R2, MinIO).
   * false = 'https://bucket.host/clave' (S3 clásico).
   */
  readonly forcePathStyle: boolean;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Reloj inyectable: sin él, ninguna firma sería reproducible en una prueba. */
export type Clock = () => Date;

export class S3PrivateStore implements PrivateObjectStore {
  readonly driver = 's3';
  readonly capabilities: StoreCapabilities = { range: true, checksumOnHead: true };

  private readonly config: S3PrivateStoreConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: Clock;
  private readonly host: string;
  private readonly basePath: string;

  constructor(config: S3PrivateStoreConfig, options?: { fetchImpl?: FetchLike; clock?: Clock }) {
    this.config = config;
    this.fetchImpl = options?.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = options?.clock ?? (() => new Date());

    const parsed = new URL(config.endpoint);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      // http sólo se tolera contra un emulador local. En cualquier otro sitio
      // sería una URL firmada viajando en claro.
      throw new StorageUnavailableError(
        `El endpoint de almacenamiento privado debe ser https (recibido ${parsed.protocol}//${parsed.hostname})`,
      );
    }
    this.host = config.forcePathStyle ? parsed.host : `${config.bucket}.${parsed.host}`;
    this.basePath = config.forcePathStyle ? `/${config.bucket}` : '';
  }

  private objectPath(key: string): string {
    if (key.startsWith('/')) throw new Error('la clave no debe empezar por /');
    return `${this.basePath}/${key}`;
  }

  private sign(
    method: string,
    key: string,
    expiresInSeconds: number,
    signedHeaders?: Record<string, string>,
    queryParams?: Record<string, string>,
  ): SignedUrl {
    const result = presign({
      credentials: this.config.credentials,
      region: this.config.region,
      service: 's3',
      method,
      host: this.host,
      path: this.objectPath(key),
      expiresInSeconds,
      signedAt: this.now(),
      signedHeaders,
      queryParams,
    });
    return { url: result.url, requiredHeaders: result.requiredHeaders, expiresAt: result.expiresAt };
  }

  /**
   * URL de subida. El tipo, el tamaño y (si se da) el checksum van DENTRO de la
   * firma: el almacenamiento rechaza una subida que no los respete, así que los
   * límites no dependen de que el cliente coopere.
   */
  signPut(input: SignPutInput): SignedUrl {
    if (!Number.isInteger(input.contentLength) || input.contentLength <= 0) {
      throw new Error('signPut: contentLength debe ser un entero positivo');
    }
    const headers: Record<string, string> = {
      'content-type': input.contentType,
      'content-length': String(input.contentLength),
    };
    if (input.contentEncoding) headers['content-encoding'] = input.contentEncoding;
    if (input.checksumSha256Hex) {
      headers['x-amz-checksum-sha256'] = hexToBase64(input.checksumSha256Hex);
    }
    return this.sign('PUT', input.key, input.expiresInSeconds ?? this.config.putTtlSeconds, headers);
  }

  /**
   * URL de descarga. `Range` NO va firmado —no es una cabecera que S3 exija en
   * la firma— así que la misma URL sirve para el objeto completo y para
   * cualquier rango. Es lo que permite al worker reintentar una descarga
   * interrumpida sin pedir otra URL.
   */
  signGet(input: SignGetInput): SignedUrl {
    return this.sign('GET', input.key, input.expiresInSeconds ?? this.config.getTtlSeconds);
  }

  async head(key: string): Promise<ObjectStat | null> {
    const signed = this.sign('HEAD', key, 60);
    let response: Response;
    try {
      response = await this.fetchImpl(signed.url, {
        method: 'HEAD',
        headers: { 'x-amz-checksum-mode': 'ENABLED' },
      });
    } catch (cause) {
      throw new StorageUnavailableError(`HEAD falló: ${(cause as Error).message}`);
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new StorageUnavailableError(`HEAD devolvió ${response.status}`);
    }
    return statFromHeaders(key, response);
  }

  async getBytes(key: string, range?: ByteRange): Promise<Buffer> {
    const signed = this.signGet({ key, expiresInSeconds: 300 });
    const headers: Record<string, string> = {};
    if (range) {
      headers.range = range.end === undefined
        ? `bytes=${range.start}-`
        : `bytes=${range.start}-${range.end}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(signed.url, { method: 'GET', headers });
    } catch (cause) {
      throw new StorageUnavailableError(`GET falló: ${(cause as Error).message}`);
    }
    // 206 es la respuesta correcta a un Range; 200 significa que el
    // almacenamiento lo ignoró y mandó todo, y eso hay que notarlo.
    if (range && response.status === 200) {
      throw new StorageUnavailableError(
        'El almacenamiento ignoró la cabecera Range y devolvió el objeto completo',
      );
    }
    if (!response.ok) throw new StorageUnavailableError(`GET devolvió ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Confirma que el objeto que se prometió es el que está. Sólo HEAD: no
   * descarga. Para el medio original eso es la diferencia entre confirmar en
   * una petición y transferir cientos de megas por segunda vez.
   */
  async confirm(input: ConfirmInput): Promise<ConfirmResult> {
    let stat: ObjectStat | null;
    try {
      stat = await this.head(input.key);
    } catch (cause) {
      return {
        ok: false,
        code: 'storage_unavailable',
        detail: (cause as Error).message,
        stat: null,
      };
    }
    return evaluateConfirm(input, stat);
  }

  async delete(key: string): Promise<void> {
    const signed = this.sign('DELETE', key, 60);
    const response = await this.fetchImpl(signed.url, { method: 'DELETE' });
    // 204 es lo normal; 404 significa que ya no estaba, que es el estado
    // deseado. Cualquier otra cosa sí es un fallo.
    if (!response.ok && response.status !== 404) {
      throw new StorageUnavailableError(`DELETE devolvió ${response.status}`);
    }
  }
}

function statFromHeaders(key: string, response: Response): ObjectStat {
  const length = response.headers.get('content-length');
  const checksumB64 = response.headers.get('x-amz-checksum-sha256');
  const lastModified = response.headers.get('last-modified');
  const parsedDate = lastModified ? new Date(lastModified) : null;
  return {
    key,
    bytes: length === null ? -1 : Number(length),
    contentType: response.headers.get('content-type'),
    contentEncoding: response.headers.get('content-encoding'),
    checksumSha256Hex: checksumB64 ? base64ToHex(checksumB64) : null,
    lastModified: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
  };
}

/**
 * La decisión de confirmación, separada del transporte para que se pueda probar
 * en aislamiento y para que el fake y el adaptador real la compartan: si cada
 * uno decidiera por su cuenta, las pruebas contra el fake dejarían de decir
 * nada sobre producción.
 */
export function evaluateConfirm(input: ConfirmInput, stat: ObjectStat | null): ConfirmResult {
  if (stat === null) {
    return {
      ok: false,
      code: 'object_missing',
      detail: 'El objeto no existe en el almacenamiento.',
      stat: null,
    };
  }
  if (stat.bytes !== input.expectedBytes) {
    return {
      ok: false,
      code: 'size_mismatch',
      detail: `Se esperaban ${input.expectedBytes} bytes y el objeto tiene ${stat.bytes}.`,
      stat,
    };
  }
  if (input.expectedContentType !== undefined && stat.contentType !== null) {
    const actual = stat.contentType.split(';')[0].trim().toLowerCase();
    if (actual !== input.expectedContentType.split(';')[0].trim().toLowerCase()) {
      return {
        ok: false,
        code: 'content_type_mismatch',
        detail: `Se esperaba ${input.expectedContentType} y el objeto declara ${stat.contentType}.`,
        stat,
      };
    }
  }
  if (stat.checksumSha256Hex !== null) {
    if (stat.checksumSha256Hex.toLowerCase() !== input.expectedChecksumSha256Hex.toLowerCase()) {
      return {
        ok: false,
        code: 'checksum_mismatch',
        detail: 'El SHA-256 del objeto no coincide con el declarado.',
        stat,
      };
    }
    return { ok: true, stat, checksumVerified: true };
  }
  // Sin checksum reportado: el tamaño cuadra y el objeto está, pero el
  // contenido NO se ha verificado. Se dice, no se supone. Un llamador que
  // necesite certeza descarga y rehashea; uno que no, decide con el tamaño.
  return { ok: true, stat, checksumVerified: false };
}

/** SHA-256 en hex de un buffer. Lo usa la verificación de artefactos pequeños. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
