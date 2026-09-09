/**
 * La interfaz del almacenamiento PRIVADO de Reuniones.
 *
 * Privado significa dos cosas concretas, no una postura: el bucket no tiene
 * acceso público, y **no existe ninguna URL permanente**. Todo acceso es una URL
 * firmada que caduca. El bucket de logos (`web/lib/r2.ts`) es el contrario
 * exacto —público, inmutable, cacheado un año— y por eso son dos buckets y dos
 * módulos, no uno con una bandera.
 *
 * ── Lo que esta interfaz impone al llamador ─────────────────────────────────
 *
 *   · Las claves las genera `src/meetings/storageKeys.ts`. Nada de aquí
 *     construye una clave a partir de entrada de cliente.
 *   · Nada devuelve una URL que se pueda guardar. `expiresAt` viaja con la URL
 *     precisamente para que el llamador tenga que decidir qué hacer cuando
 *     caduque, en vez de descubrirlo con un 403.
 *   · `confirm()` es el único camino por el que un objeto pasa a considerarse
 *     disponible. Firmar un PUT no significa que el objeto exista; el cliente
 *     puede no subir nunca, subir a medias o subir otra cosa.
 *
 * ── Sobre el checksum ───────────────────────────────────────────────────────
 *
 * El SHA-256 se puede exigir DENTRO de la firma del PUT
 * (`x-amz-checksum-sha256`). Cuando se exige, el almacenamiento rechaza la
 * subida si los bytes no cuadran: la integridad la hace cumplir el propio
 * almacenamiento y mai sólo la lee de vuelta. Es preferible a que mai descargue
 * y rehashee, y para audio de cientos de megas es la diferencia entre confirmar
 * en una petición y transferirlo todo dos veces.
 *
 * Cuando el store no puede reportar el checksum, `confirm()` lo dice
 * (`checksumVerified: false`) en vez de fingir que lo comprobó. Un llamador que
 * necesite certeza puede entonces descargar y hashear; uno que no, decide con
 * el tamaño. Lo que no puede pasar es que crea que verificó algo que no.
 */

/** Rangos HTTP para lecturas parciales (`Range: bytes=start-end`, inclusivo). */
export interface ByteRange {
  readonly start: number;
  /** Inclusivo, como en HTTP. Omitido = hasta el final. */
  readonly end?: number;
}

export interface SignedUrl {
  readonly url: string;
  /** Cabeceras que el cliente DEBE enviar tal cual, o la firma no cuadra. */
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface SignPutInput {
  readonly key: string;
  readonly contentType: string;
  /**
   * Tamaño exacto que se va a subir. Va firmado, así que el almacenamiento
   * rechaza un cuerpo de otro tamaño. Es el único límite de tamaño que se
   * cumple de verdad: los de `mediaLimits` son un filtro previo.
   */
  readonly contentLength: number;
  /** SHA-256 en hex (64 chars). Se traduce a base64 para la cabecera de S3. */
  readonly checksumSha256Hex?: string;
  readonly contentEncoding?: string;
  /** Sobrescribe la caducidad por defecto del store. */
  readonly expiresInSeconds?: number;
}

export interface SignGetInput {
  readonly key: string;
  readonly expiresInSeconds?: number;
  /**
   * Declara que el consumidor va a usar Range. No cambia la firma —Range no es
   * una cabecera firmada— pero deja explícito en el sitio de llamada que se
   * espera un almacenamiento que lo soporte, y `capabilities.range` dice si lo
   * hace.
   */
  readonly forRangeReads?: boolean;
}

export interface ObjectStat {
  readonly key: string;
  readonly bytes: number;
  readonly contentType: string | null;
  readonly contentEncoding: string | null;
  /** SHA-256 en hex si el almacenamiento lo reporta; null si no. */
  readonly checksumSha256Hex: string | null;
  readonly lastModified: Date | null;
}

export type ConfirmResult =
  | {
      readonly ok: true;
      readonly stat: ObjectStat;
      /** false = el objeto existe y el tamaño cuadra, pero el checksum no se
       *  pudo comprobar contra el almacenamiento. No es un fallo; es una
       *  garantía más débil, dicha en voz alta. */
      readonly checksumVerified: boolean;
    }
  | {
      readonly ok: false;
      readonly code: ConfirmFailureCode;
      readonly detail: string;
      readonly stat: ObjectStat | null;
    };

export type ConfirmFailureCode =
  | 'object_missing'
  | 'size_mismatch'
  | 'checksum_mismatch'
  | 'content_type_mismatch'
  | 'storage_unavailable';

export interface ConfirmInput {
  readonly key: string;
  readonly expectedBytes: number;
  readonly expectedChecksumSha256Hex: string;
  /** Si se da, se compara; si no, no se mira. */
  readonly expectedContentType?: string;
}

export interface StoreCapabilities {
  /** El almacenamiento sirve `Range` en los GET firmados. */
  readonly range: boolean;
  /** Puede reportar el SHA-256 de un objeto sin descargarlo. */
  readonly checksumOnHead: boolean;
}

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

export interface PrivateObjectStore {
  /** 's3' | 'fake'. Sólo para logs y diagnóstico; nunca para decidir lógica. */
  readonly driver: string;
  readonly capabilities: StoreCapabilities;

  signPut(input: SignPutInput): SignedUrl;
  signGet(input: SignGetInput): SignedUrl;

  head(key: string): Promise<ObjectStat | null>;
  /**
   * Descarga completa. Para artefactos NDJSON (medidos: ~50 KB con gzip para 4
   * horas) es lo correcto. Para audio NO se debe usar: de ahí que la
   * verificación del original vaya por `confirm()`, que sólo hace HEAD.
   */
  getBytes(key: string, range?: ByteRange): Promise<Buffer>;

  /** El único camino por el que un objeto pasa a estar disponible. */
  confirm(input: ConfirmInput): Promise<ConfirmResult>;

  delete(key: string): Promise<void>;
}

/** hex → base64, que es como S3 quiere el checksum en la cabecera. */
export function hexToBase64(hex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('hexToBase64: se esperaba un sha256 en hex de 64 caracteres');
  }
  return Buffer.from(hex, 'hex').toString('base64');
}

export function base64ToHex(value: string): string | null {
  const buf = Buffer.from(value, 'base64');
  return buf.length === 32 ? buf.toString('hex') : null;
}
