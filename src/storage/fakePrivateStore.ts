import { createHash, createHmac } from 'node:crypto';
import { evaluateConfirm } from './s3PrivateStore.js';
import {
  type ByteRange,
  type ConfirmInput,
  type ConfirmResult,
  type DeleteManyResult,
  type ObjectStat,
  type PrefixPage,
  type PrivateObjectStore,
  type SignGetInput,
  type SignPutInput,
  type SignedUrl,
  type StoreCapabilities,
  DELETE_BATCH_MAX,
} from './privateObjectStore.js';

/**
 * Almacenamiento privado en memoria. Para pruebas y para la validación local
 * end-to-end sin bucket real.
 *
 * ── Qué lo hace útil y no un decorado ───────────────────────────────────────
 *
 * Un fake que acepta todo no prueba nada: el código que lo use pasará las
 * pruebas y fallará contra R2. Así que este imita los comportamientos que de
 * verdad rompen cosas:
 *
 *   · Las URLs **caducan**. `put()` con una URL vencida falla con
 *     'url_expired', igual que un 403 de S3.
 *   · Las cabeceras firmadas se **hacen cumplir**. Subir con otro content-type,
 *     otro tamaño o otro checksum del que se firmó falla, porque eso es lo que
 *     hace S3 cuando la firma no cuadra. Es la propiedad de la que depende que
 *     los límites no sean opcionales.
 *   · Los rangos se sirven **de verdad**, con recorte por el final del objeto.
 *   · La decisión de `confirm()` la toma `evaluateConfirm`, **la misma función**
 *     que usa el adaptador real. Si cada uno decidiera por su cuenta, aprobar
 *     contra el fake no diría nada sobre producción.
 *
 *   · **Los listados se pueden truncar**. `listPrefix` pagina de verdad, con
 *     cursor, para que el bucle de borrado se ejercite con más objetos de los
 *     que caben en una página en vez de dar siempre una sola vuelta.
 *
 * Lo que NO imita: multipart ni versionado. Tampoco consistencia eventual —y
 * eso no es una simplificación: R2 es fuertemente consistente en escritura,
 * borrado y listado, así que una lista vacía justo después de borrar refleja el
 * estado real, no una ventana de gracia.
 */

interface StoredObject {
  bytes: Buffer;
  contentType: string;
  contentEncoding: string | null;
  checksumSha256Hex: string;
  lastModified: Date;
}

interface SignedGrant {
  method: 'PUT' | 'GET' | 'HEAD' | 'DELETE';
  key: string;
  expiresAt: Date;
  requiredHeaders: Record<string, string>;
}

export type PutOutcome =
  | { ok: true }
  | { ok: false; code: 'url_expired' | 'url_unknown' | 'signature_mismatch'; detail: string };

export class FakePrivateStore implements PrivateObjectStore {
  readonly driver = 'fake';
  readonly capabilities: StoreCapabilities = { range: true, checksumOnHead: true };

  private readonly objects = new Map<string, StoredObject>();
  private readonly grants = new Map<string, SignedGrant>();
  readonly putTtlSeconds: number;
  private readonly getTtlSeconds: number;
  private now: () => Date;
  private counter = 0;
  private pageSize = DELETE_BATCH_MAX;
  private failDeleteOf = new Set<string>();

  constructor(options?: { putTtlSeconds?: number; getTtlSeconds?: number; clock?: () => Date }) {
    this.putTtlSeconds = options?.putTtlSeconds ?? 900;
    this.getTtlSeconds = options?.getTtlSeconds ?? 3600;
    this.now = options?.clock ?? (() => new Date());
  }

  /** Permite a una prueba mover el reloj para que una URL caduque. */
  setClock(clock: () => Date): void {
    this.now = clock;
  }

  private grant(
    method: SignedGrant['method'],
    key: string,
    ttlSeconds: number,
    requiredHeaders: Record<string, string> = {},
  ): SignedUrl {
    // El token no es criptográfico: sólo tiene que ser único y opaco para que
    // una prueba no pueda "adivinar" una URL que no se emitió.
    this.counter += 1;
    const token = createHmac('sha256', 'fake-store')
      .update(`${method}:${key}:${this.counter}`)
      .digest('hex')
      .slice(0, 32);
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000);
    this.grants.set(token, { method, key, expiresAt, requiredHeaders });
    return {
      url: `https://fake-private.local/${encodeURIComponent(key)}?token=${token}`,
      requiredHeaders,
      expiresAt,
    };
  }

  private resolve(url: string): { grant: SignedGrant | null; expired: boolean } {
    const token = new URL(url).searchParams.get('token');
    const grant = token ? this.grants.get(token) ?? null : null;
    if (!grant) return { grant: null, expired: false };
    return { grant, expired: this.now().getTime() > grant.expiresAt.getTime() };
  }

  async signPut(input: SignPutInput): Promise<SignedUrl> {
    const headers: Record<string, string> = {
      'content-type': input.contentType,
      'content-length': String(input.contentLength),
    };
    if (input.contentEncoding) headers['content-encoding'] = input.contentEncoding;
    if (input.checksumSha256Hex) headers['x-amz-checksum-sha256'] = input.checksumSha256Hex;
    return this.grant('PUT', input.key, input.expiresInSeconds ?? this.putTtlSeconds, headers);
  }

  async signGet(input: SignGetInput): Promise<SignedUrl> {
    return this.grant('GET', input.key, input.expiresInSeconds ?? this.getTtlSeconds);
  }

  /**
   * Sube usando una URL firmada. Es el método que un test o el emulador local
   * usan en lugar de un PUT HTTP real, y hace cumplir lo mismo que S3.
   */
  put(url: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): PutOutcome {
    const { grant, expired } = this.resolve(url);
    if (!grant) return { ok: false, code: 'url_unknown', detail: 'URL no emitida por este store.' };
    if (grant.method !== 'PUT') {
      return { ok: false, code: 'signature_mismatch', detail: 'La URL no es de subida.' };
    }
    if (expired) return { ok: false, code: 'url_expired', detail: 'La URL de subida ha caducado.' };

    const sent = new Map<string, string>();
    for (const [name, value] of Object.entries(headers)) sent.set(name.toLowerCase(), String(value));

    // El tamaño se comprueba contra los BYTES REALES, no contra lo que diga la
    // cabecera: un cliente que declara 10 y manda 20 es el caso que importa.
    for (const [name, expectedValue] of Object.entries(grant.requiredHeaders)) {
      if (name === 'content-length') {
        if (body.length !== Number(expectedValue)) {
          return {
            ok: false,
            code: 'signature_mismatch',
            detail: `Se firmaron ${expectedValue} bytes y se enviaron ${body.length}.`,
          };
        }
        continue;
      }
      if (name === 'x-amz-checksum-sha256') {
        const actual = createHash('sha256').update(body).digest('hex');
        if (actual !== expectedValue.toLowerCase()) {
          return {
            ok: false,
            code: 'signature_mismatch',
            detail: 'El SHA-256 del cuerpo no coincide con el firmado.',
          };
        }
        continue;
      }
      if ((sent.get(name) ?? '').toLowerCase() !== expectedValue.toLowerCase()) {
        return {
          ok: false,
          code: 'signature_mismatch',
          detail: `La cabecera ${name} no coincide con la firmada.`,
        };
      }
    }

    this.objects.set(grant.key, {
      bytes: Buffer.from(body),
      contentType: grant.requiredHeaders['content-type'] ?? 'application/octet-stream',
      contentEncoding: grant.requiredHeaders['content-encoding'] ?? null,
      checksumSha256Hex: createHash('sha256').update(body).digest('hex'),
      lastModified: this.now(),
    });
    return { ok: true };
  }

  /** Descarga por URL firmada, con Range. Lo que hará el worker. */
  get(url: string, range?: ByteRange): { ok: true; bytes: Buffer; status: 200 | 206 } | { ok: false; code: string } {
    const { grant, expired } = this.resolve(url);
    if (!grant || grant.method !== 'GET') return { ok: false, code: 'url_unknown' };
    if (expired) return { ok: false, code: 'url_expired' };
    const object = this.objects.get(grant.key);
    if (!object) return { ok: false, code: 'object_missing' };
    if (!range) return { ok: true, bytes: Buffer.from(object.bytes), status: 200 };
    // El final se recorta al objeto, como hace HTTP: pedir más allá del final
    // devuelve lo que hay, no un error.
    const end = Math.min(range.end ?? object.bytes.length - 1, object.bytes.length - 1);
    if (range.start > end) return { ok: false, code: 'range_not_satisfiable' };
    return { ok: true, bytes: Buffer.from(object.bytes.subarray(range.start, end + 1)), status: 206 };
  }

  async head(key: string): Promise<ObjectStat | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      bytes: object.bytes.length,
      contentType: object.contentType,
      contentEncoding: object.contentEncoding,
      checksumSha256Hex: object.checksumSha256Hex,
      lastModified: object.lastModified,
    };
  }

  async getBytes(key: string, range?: ByteRange): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`fake store: el objeto ${key} no existe`);
    if (!range) return Buffer.from(object.bytes);
    const end = Math.min(range.end ?? object.bytes.length - 1, object.bytes.length - 1);
    return Buffer.from(object.bytes.subarray(range.start, end + 1));
  }

  async confirm(input: ConfirmInput): Promise<ConfirmResult> {
    return evaluateConfirm(input, await this.head(input.key));
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /**
   * Pagina como el real. El tamaño de página se puede bajar en las pruebas
   * (`pageSize`) para forzar varias vueltas sin sembrar mil objetos.
   */
  async listPrefix(prefix: string, cursor?: string): Promise<PrefixPage> {
    if (prefix.length === 0) throw new Error('listPrefix: el prefijo no puede estar vacío');
    const todas = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const desde = cursor ? todas.findIndex((k) => k > cursor) : 0;
    if (desde < 0) return { keys: [], cursor: null };
    const pagina = todas.slice(desde, desde + this.pageSize);
    const hayMas = desde + pagina.length < todas.length;
    return { keys: pagina, cursor: hayMas ? pagina[pagina.length - 1] : null };
  }

  async deleteMany(keys: readonly string[]): Promise<DeleteManyResult> {
    if (keys.length > DELETE_BATCH_MAX) {
      throw new Error(`deleteMany: máximo ${DELETE_BATCH_MAX} claves por lote`);
    }
    let deleted = 0;
    const failed: string[] = [];
    for (const k of keys) {
      if (this.failDeleteOf.has(k)) { failed.push(k); continue; }
      this.objects.delete(k);
      deleted += 1;
    }
    return { deleted, failed };
  }

  /** Para probar el camino de fallo: estas claves se resisten a morir. */
  failDeletesFor(keys: readonly string[]): void {
    this.failDeleteOf = new Set(keys);
  }

  /** Tamaño de página del listado, para ejercitar la paginación. */
  setPageSize(n: number): void {
    if (!Number.isInteger(n) || n < 1) throw new Error('pageSize debe ser un entero >= 1');
    this.pageSize = n;
  }

  // ── Ayudas para pruebas ───────────────────────────────────────────────────

  /** Escribe un objeto sin pasar por una URL firmada: para preparar un estado. */
  seed(key: string, bytes: Buffer, contentType = 'application/octet-stream'): void {
    this.objects.set(key, {
      bytes: Buffer.from(bytes),
      contentType,
      contentEncoding: null,
      checksumSha256Hex: createHash('sha256').update(bytes).digest('hex'),
      lastModified: this.now(),
    });
  }

  /** Corrompe un objeto conservando el tamaño: el caso que sólo el checksum
   *  detecta, y por tanto el que prueba que el checksum sirve para algo. */
  corrupt(key: string): boolean {
    const object = this.objects.get(key);
    if (!object || object.bytes.length === 0) return false;
    const bytes = Buffer.from(object.bytes);
    bytes[0] = bytes[0] ^ 0xff;
    object.bytes = bytes;
    object.checksumSha256Hex = createHash('sha256').update(bytes).digest('hex');
    return true;
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  size(): number {
    return this.objects.size;
  }
}
