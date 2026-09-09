import { createHash, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { evaluateConfirm } from '../../src/storage/s3PrivateStore.js';
import type {
  ByteRange,
  ConfirmInput,
  ConfirmResult,
  ObjectStat,
  PrivateObjectStore,
  SignGetInput,
  SignPutInput,
  SignedUrl,
  StoreCapabilities,
} from '../../src/storage/privateObjectStore.js';

/**
 * Un almacenamiento privado que habla HTTP DE VERDAD. Para la validación
 * cruzada: el worker en Python tiene que hacer PUT y GET reales contra URLs
 * reales, y `FakePrivateStore` sólo existe dentro del proceso de Node.
 *
 * ── Qué hace cumplir, y por eso sirve ───────────────────────────────────────
 *
 * Lo mismo que S3 rechaza cuando la firma no cuadra:
 *
 *   · **la caducidad** de la URL (403 después);
 *   · **el content-length firmado** contra los bytes REALES del cuerpo;
 *   · **el content-type firmado**;
 *   · **el SHA-256 firmado** contra los bytes recibidos;
 *   · **`Range`**, con 206 y recorte por el final.
 *
 * Sin eso, un worker que mandara otro tamaño o otro checksum pasaría la
 * validación cruzada y fallaría contra R2 — que es justo lo que esta prueba
 * existe para descartar.
 *
 * No es un emulador de S3: no firma SigV4. Emite un token opaco, que es
 * suficiente porque lo que se valida aquí es el CONTRATO entre mai y el worker
 * (qué cabeceras se mandan, qué se verifica, qué códigos salen), no la
 * criptografía de AWS — ésa la cubre el vector canónico en las pruebas de T-2.
 */
export class HttpObjectStore implements PrivateObjectStore {
  readonly driver = 'http-test';
  readonly capabilities: StoreCapabilities = { range: true, checksumOnHead: true };

  private readonly objects = new Map<
    string,
    { bytes: Buffer; contentType: string; contentEncoding: string | null; checksum: string }
  >();
  private readonly grants = new Map<
    string,
    { method: 'PUT' | 'GET'; key: string; expiresAt: number; headers: Record<string, string> }
  >();
  private server: Server | null = null;
  private origin = '';
  private counter = 0;

  constructor(private readonly ttlSeconds = 300) {}

  async listen(): Promise<string> {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const token = url.searchParams.get('token') ?? '';
      const grant = this.grants.get(token);

      if (!grant) {
        response.writeHead(403).end('url_unknown');
        return;
      }
      if (Date.now() > grant.expiresAt) {
        response.writeHead(403).end('url_expired');
        return;
      }
      if (request.method === 'PUT' && grant.method === 'PUT') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const body = Buffer.concat(chunks);
          const problem = this.enforce(grant.headers, body, request.headers as Record<string, string>);
          if (problem) {
            response.writeHead(403).end(problem);
            return;
          }
          this.objects.set(grant.key, {
            bytes: body,
            contentType: grant.headers['content-type'] ?? 'application/octet-stream',
            contentEncoding: grant.headers['content-encoding'] ?? null,
            checksum: createHash('sha256').update(body).digest('hex'),
          });
          response.writeHead(204).end();
        });
        return;
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && grant.method === 'GET') {
        const object = this.objects.get(grant.key);
        if (!object) {
          response.writeHead(404).end();
          return;
        }
        const rangeHeader = request.headers.range;
        if (typeof rangeHeader === 'string') {
          const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
          if (match) {
            const start = Number(match[1]);
            const end = match[2] === '' ? object.bytes.length - 1 : Math.min(Number(match[2]), object.bytes.length - 1);
            if (start > end) {
              response.writeHead(416).end();
              return;
            }
            const slice = object.bytes.subarray(start, end + 1);
            response.writeHead(206, {
              'content-length': String(slice.length),
              'content-range': `bytes ${start}-${end}/${object.bytes.length}`,
              'content-type': object.contentType,
            });
            response.end(request.method === 'HEAD' ? undefined : slice);
            return;
          }
        }
        response.writeHead(200, {
          'content-length': String(object.bytes.length),
          'content-type': object.contentType,
        });
        response.end(request.method === 'HEAD' ? undefined : object.bytes);
        return;
      }
      response.writeHead(405).end();
    });

    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server!.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${address.port}`;
    return this.origin;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /** Lo que S3 rechazaría con un 403 por firma que no cuadra. */
  private enforce(
    signed: Record<string, string>,
    body: Buffer,
    sent: Record<string, string>,
  ): string | null {
    for (const [name, expected] of Object.entries(signed)) {
      if (name === 'content-length') {
        // Contra los BYTES REALES, no contra la cabecera declarada.
        if (body.length !== Number(expected)) return `size_mismatch:${body.length}!=${expected}`;
        continue;
      }
      if (name === 'x-amz-checksum-sha256') {
        const actual = createHash('sha256').update(body).digest('base64');
        if (actual !== expected) return 'checksum_mismatch';
        continue;
      }
      const value = (sent[name] ?? '').split(';')[0].trim().toLowerCase();
      if (value !== expected.split(';')[0].trim().toLowerCase()) return `header_mismatch:${name}`;
    }
    return null;
  }

  private grant(
    method: 'PUT' | 'GET',
    key: string,
    headers: Record<string, string>,
    expiresInSeconds?: number,
  ): SignedUrl {
    this.counter += 1;
    const token = createHmac('sha256', 'http-object-store')
      .update(`${method}:${key}:${this.counter}`)
      .digest('hex')
      .slice(0, 32);
    const ttl = expiresInSeconds ?? this.ttlSeconds;
    const expiresAt = Date.now() + ttl * 1000;
    this.grants.set(token, { method, key, expiresAt, headers });
    return {
      url: `${this.origin}/${encodeURIComponent(key)}?token=${token}`,
      requiredHeaders: headers,
      expiresAt: new Date(expiresAt),
    };
  }

  signPut(input: SignPutInput): SignedUrl {
    const headers: Record<string, string> = {
      'content-type': input.contentType,
      'content-length': String(input.contentLength),
    };
    if (input.contentEncoding) headers['content-encoding'] = input.contentEncoding;
    if (input.checksumSha256Hex) {
      headers['x-amz-checksum-sha256'] = Buffer.from(input.checksumSha256Hex, 'hex').toString('base64');
    }
    return this.grant('PUT', input.key, headers, input.expiresInSeconds);
  }

  signGet(input: SignGetInput): SignedUrl {
    return this.grant('GET', input.key, {}, input.expiresInSeconds);
  }

  async head(key: string): Promise<ObjectStat | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      bytes: object.bytes.length,
      contentType: object.contentType,
      contentEncoding: object.contentEncoding,
      checksumSha256Hex: object.checksum,
      lastModified: new Date(),
    };
  }

  async getBytes(key: string, range?: ByteRange): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`no existe el objeto ${key}`);
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

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }
}
