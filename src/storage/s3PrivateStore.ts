import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  base64ToHex,
  hexToBase64,
  DELETE_BATCH_MAX,
  StorageUnavailableError,
  type ByteRange,
  type DeleteManyResult,
  type PrefixPage,
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
 * Adaptador S3-compatible sobre el SDK oficial de AWS, configurado para
 * Cloudflare R2.
 *
 * ── Por qué el SDK y no una implementación propia de SigV4 ─────────────────
 *
 * La revisión anterior firmaba a mano con `node:crypto` y se validaba contra el
 * vector canónico de AWS. Ese vector prueba UN camino: un GET, sin cabeceras
 * firmadas más allá de `host`, sin token de sesión, con una ruta sin caracteres
 * especiales. No dice nada de la codificación de una clave con espacios o
 * paréntesis, del orden canónico cuando hay varias cabeceras firmadas, ni de
 * `X-Amz-Security-Token`. Mantener criptografía propia con esa cobertura es
 * cambiar un riesgo conocido —una dependencia más— por uno que sólo aparece en
 * producción, como un 403 que nadie sabe explicar.
 *
 * El SDK ya está en el árbol (`web/` lo usa para el bucket público de logos), así
 * que el coste real es el paquete de presignado.
 *
 * ── R2 frente a S3 ─────────────────────────────────────────────────────────
 *
 * R2 quiere `region: 'auto'` y expone el bucket en la ruta
 * (`https://<cuenta>.r2.cloudflarestorage.com/<bucket>/<clave>`), así que
 * `forcePathStyle` es el defecto. Se soporta también el estilo subdominio para
 * un S3 real y para MinIO, que es el emulador desechable de la validación local.
 *
 * ── Lo que va DENTRO de la firma ───────────────────────────────────────────
 *
 * `signPut` firma `ContentType`, `ContentLength` y, cuando se da,
 * `ChecksumSHA256`. Eso es lo que hace que los límites no dependan de que el
 * cliente coopere: si manda otro tipo, otro tamaño u otros bytes, el
 * almacenamiento rechaza la petición porque la firma no cuadra. El SDK traduce
 * esos campos a las cabeceras que el cliente debe reenviar, y
 * `signableHeaders` le dice explícitamente cuáles firmar — sin eso, el
 * presigner firmaría sólo `host` y el resto serían sugerencias.
 */

export interface S3PrivateStoreConfig {
  /** Endpoint completo: 'https://cuenta.r2.cloudflarestorage.com'. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    /** Sólo para credenciales temporales (STS). R2 no las usa. */
    readonly sessionToken?: string;
  };
  readonly putTtlSeconds: number;
  readonly getTtlSeconds: number;
  /**
   * true = 'https://host/bucket/clave' (R2, MinIO).
   * false = 'https://bucket.host/clave' (S3 clásico).
   */
  readonly forcePathStyle: boolean;
}

/** S3 no acepta URLs prefirmadas de más de 7 días. */
export const MAX_PRESIGN_SECONDS = 604_800;

export class S3PrivateStore implements PrivateObjectStore {
  readonly driver = 's3';
  readonly capabilities: StoreCapabilities = { range: true, checksumOnHead: true };
  get putTtlSeconds(): number { return this.config.putTtlSeconds; }

  private readonly config: S3PrivateStoreConfig;
  private readonly client: S3Client;

  constructor(config: S3PrivateStoreConfig, options?: { client?: S3Client }) {
    this.config = config;

    const parsed = new URL(config.endpoint);
    if (
      parsed.protocol !== 'https:' &&
      parsed.hostname !== 'localhost' &&
      parsed.hostname !== '127.0.0.1'
    ) {
      // http sólo se tolera contra un emulador local. En cualquier otro sitio
      // sería una URL firmada viajando en claro.
      throw new StorageUnavailableError(
        `El endpoint de almacenamiento privado debe ser https (recibido ${parsed.protocol}//${parsed.hostname})`,
      );
    }

    const clientConfig: S3ClientConfig = {
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      // CRÍTICO para el presignado. Por defecto el SDK calcula un checksum él
      // mismo y añade `x-amz-checksum-crc32`, PISANDO el SHA-256 que le pasamos
      // — al prefirmar no hay cuerpo del que calcular nada, así que lo que
      // acababa firmado era un crc32 vacío y nuestro checksum desaparecía.
      //
      // 'WHEN_REQUIRED' le dice que no invente: usa el que se le da, y sólo si
      // se le da. Lo destapó la prueba que exige ver `x-amz-checksum-sha256`
      // dentro de `X-Amz-SignedHeaders`.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: config.credentials.accessKeyId,
        secretAccessKey: config.credentials.secretAccessKey,
        ...(config.credentials.sessionToken
          ? { sessionToken: config.credentials.sessionToken }
          : {}),
      },
    };
    // El cliente se puede inyectar para las pruebas: `client.send` se sustituye
    // por un doble y así se prueban las respuestas que rompen cosas (404, un 200
    // a un Range, un checksum ausente) sin red y sin emulador.
    this.client = options?.client ?? new S3Client(clientConfig);
  }

  private assertTtl(seconds: number): number {
    if (!Number.isInteger(seconds) || seconds < 1) {
      throw new Error('expiresInSeconds debe ser un entero >= 1');
    }
    if (seconds > MAX_PRESIGN_SECONDS) {
      throw new Error(
        `expiresInSeconds ${seconds} excede el máximo de S3 (${MAX_PRESIGN_SECONDS})`,
      );
    }
    return seconds;
  }

  private assertKey(key: string): string {
    if (key.startsWith('/')) throw new Error('la clave no debe empezar por /');
    if (key.length === 0) throw new Error('la clave no puede estar vacía');
    return key;
  }

  /**
   * `getSignedUrl` es asíncrono en el SDK, así que estos dos métodos devuelven
   * una promesa. La interfaz los declara así por eso: un firmado síncrono
   * obligaría a mantener la criptografía propia.
   */
  async signPut(input: SignPutInput): Promise<SignedUrl> {
    if (!Number.isInteger(input.contentLength) || input.contentLength <= 0) {
      throw new Error('signPut: contentLength debe ser un entero positivo');
    }
    const ttl = this.assertTtl(input.expiresInSeconds ?? this.config.putTtlSeconds);

    const requiredHeaders: Record<string, string> = {
      'content-type': input.contentType,
      'content-length': String(input.contentLength),
    };
    if (input.contentEncoding) requiredHeaders['content-encoding'] = input.contentEncoding;
    if (input.checksumSha256Hex) {
      requiredHeaders['x-amz-checksum-sha256'] = hexToBase64(input.checksumSha256Hex);
    }

    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: this.assertKey(input.key),
      ContentType: input.contentType,
      ContentLength: input.contentLength,
      ...(input.contentEncoding ? { ContentEncoding: input.contentEncoding } : {}),
      ...(input.checksumSha256Hex
        ? { ChecksumSHA256: hexToBase64(input.checksumSha256Hex) }
        : {}),
    });

    const signedAt = new Date();
    const url = await getSignedUrl(this.client, command, {
      expiresIn: ttl,
      // Sin esto el presigner firma sólo `host` y las demás cabeceras pasarían a
      // ser sugerencias que el cliente puede ignorar — que es exactamente lo
      // contrario de lo que este método existe para garantizar.
      signableHeaders: new Set(Object.keys(requiredHeaders)),
      // SigV4 mueve por defecto las cabeceras `x-amz-*` a la query string. Ahí
      // también van firmadas, pero entonces el cliente NO debe mandar la
      // cabecera y `requiredHeaders` estaría mintiendo. Se mantiene como
      // cabecera para que lo que decimos que hay que enviar sea lo que hay que
      // enviar.
      ...(input.checksumSha256Hex
        ? { unhoistableHeaders: new Set(['x-amz-checksum-sha256']) }
        : {}),
    });

    return {
      url,
      requiredHeaders,
      expiresAt: new Date(signedAt.getTime() + ttl * 1000),
    };
  }

  /**
   * URL de descarga. `Range` NO va firmado —no es una cabecera que S3 exija en
   * la firma— así que la misma URL sirve para el objeto completo y para
   * cualquier rango. Es lo que permite al worker reintentar una descarga
   * interrumpida sin pedir otra URL.
   */
  async signGet(input: SignGetInput): Promise<SignedUrl> {
    const ttl = this.assertTtl(input.expiresInSeconds ?? this.config.getTtlSeconds);
    const signedAt = new Date();
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: this.assertKey(input.key) }),
      { expiresIn: ttl },
    );
    return {
      url,
      requiredHeaders: {},
      expiresAt: new Date(signedAt.getTime() + ttl * 1000),
    };
  }

  async head(key: string): Promise<ObjectStat | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: this.assertKey(key),
          // S3 no devuelve el checksum si no se pide explícitamente.
          ChecksumMode: 'ENABLED',
        }),
      );
      const checksum = response.ChecksumSHA256 ? base64ToHex(response.ChecksumSHA256) : null;
      return {
        key,
        bytes: typeof response.ContentLength === 'number' ? response.ContentLength : -1,
        contentType: response.ContentType ?? null,
        contentEncoding: response.ContentEncoding ?? null,
        checksumSha256Hex: checksum,
        lastModified: response.LastModified ?? null,
      };
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw new StorageUnavailableError(`HEAD falló: ${describeError(cause)}`);
    }
  }

  async getBytes(key: string, range?: ByteRange): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: this.assertKey(key),
          ...(range
            ? {
                Range:
                  range.end === undefined
                    ? `bytes=${range.start}-`
                    : `bytes=${range.start}-${range.end}`,
              }
            : {}),
        }),
      );
      // Un 200 a un Range significa que el almacenamiento lo ignoró y mandó
      // todo. Hay que notarlo: leer 4 bytes y recibir 300 MB no es «casi
      // correcto». El SDK expone el estado en $metadata.
      if (range && response.$metadata?.httpStatusCode === 200) {
        throw new StorageUnavailableError(
          'El almacenamiento ignoró la cabecera Range y devolvió el objeto completo',
        );
      }
      const body = response.Body;
      if (!body) throw new StorageUnavailableError('GET devolvió un cuerpo vacío');
      const bytes = await collectStream(body);
      return bytes;
    } catch (cause) {
      if (cause instanceof StorageUnavailableError) throw cause;
      throw new StorageUnavailableError(`GET falló: ${describeError(cause)}`);
    }
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
      return { ok: false, code: 'storage_unavailable', detail: describeError(cause), stat: null };
    }
    return evaluateConfirm(input, stat);
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.assertKey(key) }),
      );
    } catch (cause) {
      // Un 404 significa que ya no estaba, que es el estado deseado.
      if (isNotFound(cause)) return;
      throw new StorageUnavailableError(`DELETE falló: ${describeError(cause)}`);
    }
  }

  /**
   * Una página de `ListObjectsV2`. El cursor es el `NextContinuationToken` tal
   * cual: opaco, se devuelve sin interpretarlo.
   *
   * El prefijo NO se valida contra la forma de las claves de Reuniones: este
   * módulo no sabe nada de reuniones. Lo único que se exige es que no esté
   * vacío, porque un prefijo vacío lista el bucket entero y quien lo pidió
   * casi seguro no quería eso.
   */
  async listPrefix(prefix: string, cursor?: string): Promise<PrefixPage> {
    if (prefix.length === 0) throw new Error('listPrefix: el prefijo no puede estar vacío');
    try {
      const out = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          MaxKeys: DELETE_BATCH_MAX,
          ...(cursor ? { ContinuationToken: cursor } : {}),
        }),
      );
      return {
        keys: (out.Contents ?? []).map((o) => o.Key).filter((k): k is string => typeof k === 'string'),
        // `IsTruncated` false sin token es el final; el token sin truncado no
        // debería pasar, pero si pasa se sigue paginando, que es lo seguro.
        cursor: out.NextContinuationToken ?? null,
      };
    } catch (cause) {
      throw new StorageUnavailableError(`LIST falló: ${describeError(cause)}`);
    }
  }

  async deleteMany(keys: readonly string[]): Promise<DeleteManyResult> {
    if (keys.length === 0) return { deleted: 0, failed: [] };
    if (keys.length > DELETE_BATCH_MAX) {
      throw new Error(`deleteMany: máximo ${DELETE_BATCH_MAX} claves por lote`);
    }
    try {
      const out = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: { Objects: keys.map((k) => ({ Key: this.assertKey(k) })), Quiet: true },
        }),
      );
      // Con `Quiet: true` sólo vuelven los errores. Una clave que no existía no
      // es un error: el estado deseado ya se cumplía.
      const failed = (out.Errors ?? [])
        .map((e) => e.Key)
        .filter((k): k is string => typeof k === 'string');
      return { deleted: keys.length - failed.length, failed };
    } catch (cause) {
      throw new StorageUnavailableError(`DELETE por lotes falló: ${describeError(cause)}`);
    }
  }
}

/** El SDK modela «no existe» de varias formas según la operación. */
function isNotFound(cause: unknown): boolean {
  const error = cause as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    error?.$metadata?.httpStatusCode === 404 ||
    error?.name === 'NotFound' ||
    error?.name === 'NoSuchKey'
  );
}

function describeError(cause: unknown): string {
  const error = cause as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = error?.$metadata?.httpStatusCode;
  return `${error?.name ?? 'Error'}${status ? ` (HTTP ${status})` : ''}: ${error?.message ?? String(cause)}`;
}

/** Junta el cuerpo del SDK, que puede ser varias cosas según el runtime. */
async function collectStream(body: unknown): Promise<Buffer> {
  const candidate = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  };
  if (typeof candidate.transformToByteArray === 'function') {
    return Buffer.from(await candidate.transformToByteArray());
  }
  if (typeof candidate[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  if (Buffer.isBuffer(body)) return body;
  throw new StorageUnavailableError('el cuerpo de la respuesta no se pudo leer');
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
