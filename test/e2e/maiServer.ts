import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authenticateWorkerToken } from '../../src/db/repositories/meetings/credentials.js';
import { MeetingsApiError } from '../../src/meetings/errors.js';
import {
  claim,
  fail,
  heartbeat,
  requeueExpiredLeases,
  resultComplete,
  resultInit,
  type MeetingsServiceDeps,
} from '../../src/meetings/service.js';

/**
 * Un servidor HTTP mínimo que monta las MISMAS operaciones del servicio que
 * montan las rutas de Next, con las mismas rutas y el mismo formato de error.
 *
 * ── Por qué esto y no `next start` ──────────────────────────────────────────
 *
 * Lo que la validación cruzada tiene que demostrar es el CONTRATO entre los dos
 * procesos: qué JSON manda el worker, qué cabecera lleva el token, qué códigos
 * salen, qué campos espera de vuelta. Ese contrato lo define el servicio, y las
 * rutas de Next son adaptadores de veinte líneas sobre él.
 *
 * Levantar Next para probarlo añadiría un servidor de producción, su
 * compilación y su gestión de procesos a una prueba cuyo objeto es otro — y a
 * cambio no probaría nada que estos handlers no prueben, porque son el mismo
 * cuerpo. Que las rutas de Next existan y compilen lo verifica `npm run
 * build:web`; que sus adaptadores traduzcan bien lo verifica que sean tres
 * líneas cada uno.
 *
 * Lo que este servidor NO simula, y hay que decirlo: el enrutado de Next, sus
 * middlewares y la resolución de `params`. Si un adaptador leyera mal un
 * parámetro de ruta, esta prueba no lo vería.
 */
export class MaiTestServer {
  private server: Server | null = null;
  private origin = '';

  constructor(private readonly deps: MeetingsServiceDeps) {}

  async listen(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
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

  private async handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    const send = (status: number, payload?: unknown): void => {
      if (payload === undefined) {
        response.writeHead(status).end();
        return;
      }
      const body = JSON.stringify(payload);
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
      response.end(body);
    };

    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};

      // Idéntico a `authenticateWorker`: sólo la cabecera Authorization.
      const header = String(request.headers.authorization ?? '').trim();
      const match = /^Bearer\s+(.+)$/i.exec(header);
      const identity = match?.[1] ? await authenticateWorkerToken(match[1].trim()) : null;
      if (!identity) {
        send(401, { error: { code: 'unauthorized', message: 'Credencial de worker inválida.' } });
        return;
      }

      const path = url.pathname;
      const jobMatch = /^\/api\/meetings\/v1\/jobs\/([^/]+)\/(heartbeat|fail|result\/init|result\/complete)$/.exec(path);

      if (path === '/api/meetings/v1/jobs/claim') {
        const job = await claim(
          identity,
          {
            workerLabel: typeof body.workerLabel === 'string' ? body.workerLabel : null,
            capabilities: Array.isArray(body.capabilities) ? (body.capabilities as string[]) : undefined,
          },
          this.deps,
        );
        send(job ? 200 : 204, job ?? undefined);
        return;
      }

      if (path === '/api/meetings/v1/maintenance/requeue-expired') {
        const result = await requeueExpiredLeases();
        send(200, { requeued: result.requeued, abandoned: result.abandoned });
        return;
      }

      if (jobMatch) {
        const jobId = jobMatch[1];
        const proof = {
          jobId,
          attempt: Number(body.attempt),
          leaseToken: String(body.leaseToken ?? ''),
        };
        switch (jobMatch[2]) {
          case 'heartbeat':
            send(200, await heartbeat(identity, {
              ...proof,
              progressPct: typeof body.progressPct === 'number' ? body.progressPct : null,
            }, this.deps));
            return;
          case 'fail':
            send(200, await fail(identity, {
              ...proof,
              failureCode: String(body.failureCode ?? ''),
              failureDetail: typeof body.failureDetail === 'string' ? body.failureDetail : null,
            }, this.deps));
            return;
          case 'result/init':
            send(200, await resultInit(identity, {
              ...proof,
              bytes: Number(body.bytes),
              checksumSha256: String(body.checksumSha256 ?? ''),
              itemCount: typeof body.itemCount === 'number' ? body.itemCount : null,
              schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : 1,
            }, this.deps));
            return;
          case 'result/complete': {
            const probe = (body.probe ?? null) as Record<string, unknown> | null;
            send(200, await resultComplete(identity, {
              ...proof,
              bytes: Number(body.bytes),
              checksumSha256: String(body.checksumSha256 ?? ''),
              ...(probe
                ? {
                    probe: {
                      durationSeconds: typeof probe.durationSeconds === 'number' ? probe.durationSeconds : null,
                      sampleRate: typeof probe.sampleRate === 'number' ? probe.sampleRate : null,
                      channels: typeof probe.channels === 'number' ? probe.channels : null,
                      codec: typeof probe.codec === 'string' ? probe.codec : null,
                    },
                  }
                : {}),
            }, this.deps));
            return;
          }
        }
      }

      send(404, { error: { code: 'not_found', message: 'No encontrado.' } });
    } catch (error) {
      if (error instanceof MeetingsApiError) {
        response.writeHead(error.status, {
          'content-type': 'application/json',
          ...error.headers,
        });
        response.end(JSON.stringify(error.body()));
        return;
      }
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { code: 'internal', message: (error as Error).message } }),
      );
    }
  }
}
