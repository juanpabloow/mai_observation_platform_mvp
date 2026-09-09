import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb } from './fixtures.js';
import {
  authenticateWorkerToken,
  mintWorkerToken,
} from '../../src/db/repositories/meetings/credentials.js';
import * as jobsRepo from '../../src/db/repositories/meetings/jobs.js';
import * as meetingsRepo from '../../src/db/repositories/meetings/meetings.js';
import { FakePrivateStore } from '../../src/storage/fakePrivateStore.js';
import {
  createMeeting,
  uploadComplete,
  uploadInit,
  type MeetingsServiceDeps,
} from '../../src/meetings/service.js';
import { meetingsRateLimiter } from '../../src/meetings/rateLimit.js';

/**
 * Los ROUTE HANDLERS REALES de Next, invocados con `Request` y `params`.
 *
 * ── Qué añade esto sobre las pruebas de servicio ────────────────────────────
 *
 * `meetingsPipeline.test.ts` prueba el servicio llamando funciones. Esto prueba
 * la capa que estaba sin cubrir: el módulo de ruta tal cual lo importa Next, con
 * su autenticación por cabecera, su parseo del cuerpo, su lectura de `params` y
 * su traducción de errores a estado HTTP y código estable. Un adaptador que
 * leyera mal un parámetro de ruta, que se olvidara de validar, o que devolviera
 * un 500 donde toca un 400, pasaba desapercibido antes.
 *
 * ── Lo que NO cubre, y por qué ──────────────────────────────────────────────
 *
 * Se importan los handlers, no se arranca `next start`. Eso deja fuera el
 * enrutado de Next (que una URL llegue a este fichero), sus middlewares y la
 * caché de rutas. Arrancar el servidor exigiría además una sesión real de Better
 * Auth para las rutas de UI, y esa parte se cubre distinto: las cinco rutas con
 * sesión se ejercitan aquí SIN sesión —comprobando que la validación corre
 * primero y que el fallo es el 404 coherente— y su lógica de ámbito ya está
 * probada en el servicio.
 *
 * Las seis rutas de worker sí se atraviesan completas, incluida la secuencia
 * claim → heartbeat → result/init → PUT → result/complete.
 */

const tenants: string[] = [];
after(async () => {
  for (const tenant of tenants) await cleanupTenant(tenant);
  await closeDb();
});

const NORMALIZED = Buffer.from('RIFF....WAVE normalizado por la prueba de rutas');
const AUDIO = Buffer.from('RIFF....WAVE original de la prueba de rutas');
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Un NDJSON de transcripción bien formado, para llegar a cerrar `transcribe`. */
function transcriptArtifact(segments = 2): Buffer {
  const lines = [
    JSON.stringify({
      schema: 'meetings.transcript',
      schema_version: 1,
      duration_seconds: 30,
      model: 'medium',
      segment_count: segments,
    }),
  ];
  for (let i = 0; i < segments; i += 1) {
    lines.push(JSON.stringify({ i, start: i * 10, end: i * 10 + 9, text: `S${i}`, confidence: 0.9 }));
  }
  return gzipSync(Buffer.from(`${lines.join('\n')}\n`));
}

/**
 * Los handlers resuelven sus dependencias por su cuenta, leyendo el entorno.
 * Aquí se configura el driver `fake`, que es un SINGLETON del proceso — así el
 * `PUT` de una petición y el `complete` de la siguiente ven los mismos objetos,
 * que es exactamente para lo que ese modo existe.
 *
 * No se parchea nada del módulo de rutas: los handlers se ejecutan tal cual. La
 * única diferencia con producción es el driver, y eso es configuración.
 */
process.env.MEETINGS_STORAGE_DRIVER = 'fake';

let store: FakePrivateStore;
let deps: MeetingsServiceDeps;

async function installDeps(): Promise<void> {
  if (deps) return;
  const api = await import('../../web/lib/meetingsApi.js');
  // Se resuelve una vez para materializar el singleton; la prueba usa EL MISMO
  // store que verán los handlers.
  deps = api.meetingsDeps();
  store = deps.store as FakePrivateStore;
  // Los límites de tasa por defecto frenarían la secuencia de una prueba, que
  // hace varias llamadas seguidas a propósito. Se sustituye el limitador
  // COMPARTIDO, no el de una copia de las deps: es el que los handlers usan.
  meetingsRateLimiter.reset();
  const generous = { burst: 5000, refillPerSecond: 5000 };
  for (const operation of ['claim', 'heartbeat', 'result'] as const) {
    (meetingsRateLimiter as unknown as { rules: Record<string, unknown> }).rules[operation] =
      generous;
  }
}

interface Ctx {
  tenantId: string;
  clientId: string;
  token: string;
  maintenanceToken: string;
  foreignToken: string;
}

async function seed(): Promise<Ctx> {
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  tenants.push(tenantId, foreignTenantId);
  await query(`INSERT INTO tenants (id, name) VALUES ($1, 'R'), ($2, 'RX')`, [
    tenantId,
    foreignTenantId,
  ]);
  const client = await query<{ id: string }>(
    `INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, 'C', false) RETURNING id`,
    [tenantId],
  );
  const mkPool = async (tenant: string, caps: string, limits: string): Promise<string> => {
    const row = await query<{ id: string }>(
      `INSERT INTO worker_pools (slug, environment, scope, tenant_id, capabilities, concurrency)
       VALUES ($1, 'development', 'single_tenant', $2, $3, $4::jsonb) RETURNING id`,
      [`r-${randomUUID().slice(0, 8)}`, tenant, caps, limits],
    );
    return row.rows[0].id;
  };
  const mkToken = async (poolId: string): Promise<string> => {
    const minted = mintWorkerToken();
    await query(
      `INSERT INTO worker_credentials (pool_id, label, token_hash, token_prefix)
       VALUES ($1, 'r', $2, $3)`,
      [poolId, minted.tokenHash, minted.tokenPrefix],
    );
    return minted.token;
  };

  const workPool = await mkPool(
    tenantId,
    '{meetings.transcribe}',
    '{"schema_version":1,"limits":{"meetings.transcribe":1}}',
  );
  // El pool de mantenimiento es INTERNO, no de tenant: la base ya no admite
  // 'meetings.maintenance' en un pool 'single_tenant'
  // (`pools_scope_allows_capabilities`). Ser interno implica además no tener
  // tenant y dejar rastro de quién lo autorizó.
  const maintPool = await query<{ id: string }>(
    `INSERT INTO worker_pools
       (slug, environment, scope, capabilities, concurrency,
        internal_authorized_actor_label, internal_authorized_at)
     VALUES ($1, 'development', 'internal', '{meetings.maintenance}',
             '{"schema_version":1,"limits":{}}'::jsonb, 'suite <suite@example.test>', now())
     RETURNING id`,
    [`r-int-${randomUUID().slice(0, 8)}`],
  ).then((row) => row.rows[0].id);
  const foreignPool = await mkPool(
    foreignTenantId,
    '{meetings.transcribe}',
    '{"schema_version":1,"limits":{"meetings.transcribe":1}}',
  );

  return {
    tenantId,
    clientId: client.rows[0].id,
    token: await mkToken(workPool),
    maintenanceToken: await mkToken(maintPool),
    foreignToken: await mkToken(foreignPool),
  };
}

/** Una petición como la que Next entrega al handler. */
function post(path: string, body: unknown, token?: string): Request {
  return new Request(`https://mai.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function params<T extends Record<string, string>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  if (response.status === 204) return {};
  return (await response.json()) as Record<string, unknown>;
}

/** Deja una reunión con su audio y su job `normalize` en cola. */
async function seedMeeting(ctx: Ctx): Promise<{ meetingId: string; jobId: string }> {
  const scope = { tenantId: ctx.tenantId, clientId: ctx.clientId };
  const created = await createMeeting(scope, {
    title: 'Rutas',
    idempotencyKey: `r-${randomUUID()}`,
  });
  const init = await uploadInit(
    scope,
    created.meetingId,
    { filename: 'a.wav', contentType: 'audio/wav', bytes: AUDIO.length, checksumSha256: sha(AUDIO) },
    deps,
  );
  assert.ok(store.put(init.url, AUDIO, init.requiredHeaders).ok);
  const done = await uploadComplete(
    scope,
    created.meetingId,
    { bytes: AUDIO.length, checksumSha256: sha(AUDIO) },
    deps,
  );
  return { meetingId: created.meetingId, jobId: done.firstJob.id };
}

// ══════════════════════════════════════════════════════════════════════════
// Autenticación, a través del handler real
// ══════════════════════════════════════════════════════════════════════════

test('sin cabecera Authorization el handler de claim responde 401 unauthorized', async () => {
  await installDeps();
  const { POST } = await import('../../web/app/api/meetings/v1/jobs/claim/route.js');
  const response = await POST(post('/api/meetings/v1/jobs/claim', {}));
  assert.equal(response.status, 401);
  assert.deepEqual(await readBody(response), {
    error: { code: 'unauthorized', message: 'Credencial de worker inválida.' },
  });
});

test('un Bearer malformado, un token inventado y uno revocado dan el MISMO 401', async () => {
  await installDeps();
  const ctx = await seed();
  const { POST } = await import('../../web/app/api/meetings/v1/jobs/claim/route.js');

  const revoked = mintWorkerToken();
  const pool = await query<{ id: string }>(
    `SELECT id FROM worker_pools WHERE tenant_id = $1 LIMIT 1`,
    [ctx.tenantId],
  );
  await query(
    `INSERT INTO worker_credentials
       (pool_id, label, token_hash, token_prefix, revoked_at, revoked_actor,
        revoked_actor_label, revoked_reason)
     VALUES ($1, 'rev', $2, $3, now(), 'system', 'test', 'prueba')`,
    [pool.rows[0].id, revoked.tokenHash, revoked.tokenPrefix],
  );

  const bodies: unknown[] = [];
  for (const header of ['Basic abc', 'Bearer', 'Bearer mtk_inventado_pero_largo', `Bearer ${revoked.token}`]) {
    const request = new Request('https://mai.test/api/meetings/v1/jobs/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: header },
      body: '{}',
    });
    const response = await POST(request);
    assert.equal(response.status, 401, header);
    bodies.push(await readBody(response));
  }
  // Los cuatro cuerpos IDÉNTICOS: distinguirlos le diría a quien prueba tokens
  // cuál de sus intentos se acercó.
  assert.equal(new Set(bodies.map((body) => JSON.stringify(body))).size, 1);
});

// ══════════════════════════════════════════════════════════════════════════
// Parseo y validación, a través del handler real
// ══════════════════════════════════════════════════════════════════════════

test('un cuerpo que no es JSON es 400 invalid_request, no 500', async () => {
  await installDeps();
  const ctx = await seed();
  const { POST } = await import('../../web/app/api/meetings/v1/jobs/claim/route.js');
  const request = new Request('https://mai.test/api/meetings/v1/jobs/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.token}` },
    body: '{esto no es json',
  });
  const response = await POST(request);
  assert.equal(response.status, 400);
  const body = await readBody(response);
  assert.equal((body.error as { code: string }).code, 'invalid_request');
});

test('un campo desconocido en el cuerpo se rechaza y se NOMBRA', async () => {
  await installDeps();
  const ctx = await seed();
  const { POST } = await import('../../web/app/api/meetings/v1/jobs/claim/route.js');
  // `tenantId` es exactamente el campo que nunca debe leerse de la petición:
  // que aparezca avisa de que alguien intenta inyectar ámbito.
  const response = await POST(
    post('/api/meetings/v1/jobs/claim', { tenantId: randomUUID() }, ctx.token),
  );
  assert.equal(response.status, 400);
  const message = ((await readBody(response)).error as { message: string }).message;
  assert.match(message, /no reconocido/);
  assert.match(message, /tenantId/);
});

test('un enum inválido es 400 y NO llega a la base como violación de CHECK', async () => {
  await installDeps();
  const { POST } = await import('../../web/app/api/meetings/v1/meetings/route.js');
  const ctx = await seed();
  const response = await POST(
    post('/api/meetings/v1/meetings', {
      clientId: ctx.clientId,
      title: 'X',
      idempotencyKey: 'k',
      sourceKind: 'loquesea',
    }),
  );
  // Antes había un `as never` aquí y el valor llegaba al INSERT: la violación
  // de CHECK salía como 500.
  assert.equal(response.status, 400);
  const message = ((await readBody(response)).error as { message: string }).message;
  assert.match(message, /sourceKind/);
});

test('los tipos NO se coercen: "3" no es 3 ni "true" es true', async () => {
  await installDeps();
  const ctx = await seed();
  const { POST } = await import('../../web/app/api/meetings/v1/jobs/[jobId]/heartbeat/route.js');
  const response = await POST(
    post(
      '/api/meetings/v1/jobs/x/heartbeat',
      { attempt: '1', leaseToken: 'mlt_algo_bastante_largo' },
      ctx.token,
    ),
    params({ jobId: randomUUID() }),
  );
  assert.equal(response.status, 400);
  assert.match(((await readBody(response)).error as { message: string }).message, /attempt/);
});

test('un parámetro de ruta que no es uuid es 400, no un error de tipo de PostgreSQL', async () => {
  await installDeps();
  const ctx = await seed();
  const { POST } = await import('../../web/app/api/meetings/v1/jobs/[jobId]/heartbeat/route.js');
  const response = await POST(
    post('/api/meetings/v1/jobs/no-es-uuid/heartbeat', { attempt: 1, leaseToken: 'x'.repeat(20) }, ctx.token),
    params({ jobId: 'no-es-uuid' }),
  );
  assert.equal(response.status, 400);
  assert.match(((await readBody(response)).error as { message: string }).message, /jobId/);
});

test('un ISO datetime sin offset se rechaza', async () => {
  await installDeps();
  const ctx = await seed();
  const { POST } = await import('../../web/app/api/meetings/v1/meetings/route.js');
  const response = await POST(
    post('/api/meetings/v1/meetings', {
      clientId: ctx.clientId,
      title: 'X',
      idempotencyKey: 'k2',
      startedAt: '2026-09-08 12:00:00',
    }),
  );
  assert.equal(response.status, 400);
  assert.match(((await readBody(response)).error as { message: string }).message, /startedAt/);
});

test('un checksum que no es sha256 hex se rechaza en el borde', async () => {
  await installDeps();
  const ctx = await seed();
  const { POST } = await import('../../web/app/api/meetings/v1/jobs/[jobId]/result/init/route.js');
  const response = await POST(
    post(
      '/api/meetings/v1/jobs/x/result/init',
      { attempt: 1, leaseToken: 'x'.repeat(20), bytes: 10, checksumSha256: 'corto' },
      ctx.token,
    ),
    params({ jobId: randomUUID() }),
  );
  assert.equal(response.status, 400);
  assert.match(((await readBody(response)).error as { message: string }).message, /checksumSha256/);
});

test('un array de capacidades con un valor desconocido se rechaza', async () => {
  await installDeps();
  const ctx = await seed();
  const { POST } = await import('../../web/app/api/meetings/v1/jobs/claim/route.js');
  const response = await POST(
    post('/api/meetings/v1/jobs/claim', { capabilities: ['meetings.inventada'] }, ctx.token),
  );
  assert.equal(response.status, 400);
  assert.match(((await readBody(response)).error as { message: string }).message, /capabilities/);
});

test('un failureCode que no es lower_snake_case se rechaza', async () => {
  await installDeps();
  const ctx = await seed();
  const { POST } = await import('../../web/app/api/meetings/v1/jobs/[jobId]/fail/route.js');
  const response = await POST(
    post(
      '/api/meetings/v1/jobs/x/fail',
      { attempt: 1, leaseToken: 'x'.repeat(20), failureCode: 'Algo Con Espacios' },
      ctx.token,
    ),
    params({ jobId: randomUUID() }),
  );
  assert.equal(response.status, 400);
  assert.match(((await readBody(response)).error as { message: string }).message, /failureCode/);
});

test('un detalle de fallo demasiado largo se rechaza en vez de recortarse en silencio', async () => {
  await installDeps();
  const ctx = await seed();
  const { POST } = await import('../../web/app/api/meetings/v1/jobs/[jobId]/fail/route.js');
  const response = await POST(
    post(
      '/api/meetings/v1/jobs/x/fail',
      { attempt: 1, leaseToken: 'x'.repeat(20), failureCode: 'ok', failureDetail: 'y'.repeat(3000) },
      ctx.token,
    ),
    params({ jobId: randomUUID() }),
  );
  assert.equal(response.status, 400);
  assert.match(((await readBody(response)).error as { message: string }).message, /failureDetail/);
});

// ══════════════════════════════════════════════════════════════════════════
// La secuencia completa, a través de los handlers
// ══════════════════════════════════════════════════════════════════════════

test('claim → heartbeat → result/init → PUT → result/complete por los handlers reales', async () => {
  await installDeps();
  const ctx = await seed();
  const { meetingId, jobId } = await seedMeeting(ctx);

  const claimRoute = await import('../../web/app/api/meetings/v1/jobs/claim/route.js');
  const heartbeatRoute = await import('../../web/app/api/meetings/v1/jobs/[jobId]/heartbeat/route.js');
  const initRoute = await import('../../web/app/api/meetings/v1/jobs/[jobId]/result/init/route.js');
  const completeRoute = await import('../../web/app/api/meetings/v1/jobs/[jobId]/result/complete/route.js');

  // claim
  const claimResponse = await claimRoute.POST(
    post('/api/meetings/v1/jobs/claim', { workerLabel: 'ruta-01' }, ctx.token),
  );
  assert.equal(claimResponse.status, 200);
  const job = await readBody(claimResponse);
  assert.equal(job.jobId, jobId);
  assert.equal(job.stage, 'normalize');
  assert.equal(job.attempt, 1);
  assert.ok(typeof job.leaseToken === 'string' && (job.leaseToken as string).startsWith('mlt_'));
  const inputs = job.inputs as Array<{ role: string; url: string }>;
  assert.deepEqual(inputs.map((input) => input.role), ['original']);

  const proof = { attempt: job.attempt, leaseToken: job.leaseToken };

  // heartbeat
  const beat = await heartbeatRoute.POST(
    post(`/api/meetings/v1/jobs/${jobId}/heartbeat`, { ...proof, progressPct: 40 }, ctx.token),
    params({ jobId: jobId as string }),
  );
  assert.equal(beat.status, 200);
  const beatBody = await readBody(beat);
  assert.equal(beatBody.cancelled, false);
  assert.ok(typeof beatBody.leaseExpiresAt === 'string');

  // result/init
  const initResponse = await initRoute.POST(
    post(
      `/api/meetings/v1/jobs/${jobId}/result/init`,
      { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED) },
      ctx.token,
    ),
    params({ jobId: jobId as string }),
  );
  assert.equal(initResponse.status, 200);
  const signed = await readBody(initResponse);
  assert.equal(signed.method, 'PUT');
  assert.ok(typeof signed.storageKey === 'string');

  // El PUT de verdad contra el store, con las cabeceras que la ruta devolvió.
  const put = store.put(
    signed.url as string,
    NORMALIZED,
    signed.requiredHeaders as Record<string, string>,
  );
  assert.ok(put.ok, JSON.stringify(put));

  // result/complete
  const completeResponse = await completeRoute.POST(
    post(
      `/api/meetings/v1/jobs/${jobId}/result/complete`,
      {
        ...proof,
        bytes: NORMALIZED.length,
        checksumSha256: sha(NORMALIZED),
        probe: { durationSeconds: 30, sampleRate: 16000, channels: 1, codec: 'pcm_s16le' },
      },
      ctx.token,
    ),
    params({ jobId: jobId as string }),
  );
  assert.equal(completeResponse.status, 200);
  const completed = await readBody(completeResponse);
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual((completed.nextJob as { stage: string }).stage, 'transcribe');

  // Y el siguiente job existe de verdad, con su procedencia relacional.
  const jobs = await jobsRepo.listJobsForMeeting(meetingId);
  assert.deepEqual(
    jobs.map((row) => `${row.stage}:${row.status}`).sort(),
    ['normalize:succeeded', 'transcribe:queued'],
  );
  const media = await query<{ run_id: string | null }>(
    `SELECT run_id FROM meeting_media WHERE meeting_id = $1 AND role = 'normalized'`,
    [meetingId],
  );
  assert.ok(media.rows[0].run_id, 'el derivado guarda su run');
});

test('la cola vacía responde 204 sin cuerpo por el handler', async () => {
  await installDeps();
  const ctx = await seed();
  const { POST } = await import('../../web/app/api/meetings/v1/jobs/claim/route.js');
  const response = await POST(post('/api/meetings/v1/jobs/claim', {}, ctx.token));
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
});

// ══════════════════════════════════════════════════════════════════════════
// Traducción de errores e idempotencia, por los handlers
// ══════════════════════════════════════════════════════════════════════════

test('un lease inventado sale como 409 con código estable', async () => {
  await installDeps();
  const ctx = await seed();
  const { jobId } = await seedMeeting(ctx);
  const claimRoute = await import('../../web/app/api/meetings/v1/jobs/claim/route.js');
  await claimRoute.POST(post('/api/meetings/v1/jobs/claim', {}, ctx.token));

  const { POST } = await import('../../web/app/api/meetings/v1/jobs/[jobId]/heartbeat/route.js');
  const response = await POST(
    post(`/api/meetings/v1/jobs/${jobId}/heartbeat`, { attempt: 1, leaseToken: 'mlt_inventado_largo' }, ctx.token),
    params({ jobId }),
  );
  assert.equal(response.status, 409);
  assert.equal(((await readBody(response)).error as { code: string }).code, 'lease_invalid');
});

test('un job de otro tenant sale como 404, no 403', async () => {
  await installDeps();
  const ctx = await seed();
  const { jobId } = await seedMeeting(ctx);
  const claimRoute = await import('../../web/app/api/meetings/v1/jobs/claim/route.js');
  const claimed = await readBody(await claimRoute.POST(post('/api/meetings/v1/jobs/claim', {}, ctx.token)));

  const { POST } = await import('../../web/app/api/meetings/v1/jobs/[jobId]/heartbeat/route.js');
  const response = await POST(
    post(
      `/api/meetings/v1/jobs/${jobId}/heartbeat`,
      { attempt: claimed.attempt, leaseToken: claimed.leaseToken },
      ctx.foreignToken,
    ),
    params({ jobId }),
  );
  assert.equal(response.status, 404);
  assert.equal(((await readBody(response)).error as { code: string }).code, 'not_found');
});

/** El sondeo que el formato pactado exige al cerrar `normalize`. */
const PROBE = { durationSeconds: 30, sampleRate: 16000, channels: 1, codec: 'pcm_s16le' } as const;

test('reenviar result/complete por el handler es idempotente; con otro checksum es 409', async () => {
  await installDeps();
  const ctx = await seed();
  const { jobId } = await seedMeeting(ctx);
  const claimRoute = await import('../../web/app/api/meetings/v1/jobs/claim/route.js');
  const initRoute = await import('../../web/app/api/meetings/v1/jobs/[jobId]/result/init/route.js');
  const completeRoute = await import('../../web/app/api/meetings/v1/jobs/[jobId]/result/complete/route.js');

  const claimed = await readBody(await claimRoute.POST(post('/api/meetings/v1/jobs/claim', {}, ctx.token)));
  const proof = { attempt: claimed.attempt, leaseToken: claimed.leaseToken };
  const initPayload = { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED) };
  // `init` no lleva sondeo y `complete` de `normalize` lo exige: son dos
  // cuerpos distintos, y compartir el objeto era lo que dejaba pasar el cierre
  // sin sondeo.
  const payload = { ...initPayload, probe: PROBE };

  const signed = await readBody(
    await initRoute.POST(
      post(`/api/meetings/v1/jobs/${jobId}/result/init`, initPayload, ctx.token),
      params({ jobId }),
    ),
  );
  assert.ok(store.put(signed.url as string, NORMALIZED, signed.requiredHeaders as Record<string, string>).ok);

  const first = await completeRoute.POST(
    post(`/api/meetings/v1/jobs/${jobId}/result/complete`, payload, ctx.token),
    params({ jobId }),
  );
  assert.equal(first.status, 200);

  // Mismo payload: 200 con el mismo resultado.
  const again = await completeRoute.POST(
    post(`/api/meetings/v1/jobs/${jobId}/result/complete`, payload, ctx.token),
    params({ jobId }),
  );
  assert.equal(again.status, 200);
  assert.equal((await readBody(again)).status, 'succeeded');

  // Payload en conflicto: 409 terminal_conflict.
  const conflicting = await completeRoute.POST(
    post(
      `/api/meetings/v1/jobs/${jobId}/result/complete`,
      { ...proof, bytes: NORMALIZED.length, checksumSha256: 'e'.repeat(64), probe: PROBE },
      ctx.token,
    ),
    params({ jobId }),
  );
  assert.equal(conflicting.status, 409);
  assert.equal(((await readBody(conflicting)).error as { code: string }).code, 'terminal_conflict');
});

// ══════════════════════════════════════════════════════════════════════════
// El contrato del sondeo de `normalize`, por los handlers reales
// ══════════════════════════════════════════════════════════════════════════

/**
 * Deja un `normalize` reclamado y su artefacto ya subido, listo para el
 * `result/complete` que cada prueba quiera probar.
 */
async function normalizeReadyToComplete(ctx: Ctx): Promise<{
  jobId: string;
  proof: { attempt: number; leaseToken: string };
  complete: (body: unknown) => Promise<Response>;
}> {
  const { jobId } = await seedMeeting(ctx);
  const claimRoute = await import('../../web/app/api/meetings/v1/jobs/claim/route.js');
  const initRoute = await import('../../web/app/api/meetings/v1/jobs/[jobId]/result/init/route.js');
  const completeRoute = await import(
    '../../web/app/api/meetings/v1/jobs/[jobId]/result/complete/route.js'
  );
  const claimed = await readBody(await claimRoute.POST(post('/api/meetings/v1/jobs/claim', {}, ctx.token)));
  assert.equal(claimed.stage, 'normalize');
  const proof = { attempt: claimed.attempt as number, leaseToken: claimed.leaseToken as string };
  const signed = await readBody(
    await initRoute.POST(
      post(
        `/api/meetings/v1/jobs/${jobId}/result/init`,
        { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED) },
        ctx.token,
      ),
      params({ jobId }),
    ),
  );
  assert.ok(store.put(signed.url as string, NORMALIZED, signed.requiredHeaders as Record<string, string>).ok);
  return {
    jobId,
    proof,
    complete: (body: unknown) =>
      completeRoute.POST(
        post(`/api/meetings/v1/jobs/${jobId}/result/complete`, body, ctx.token),
        params({ jobId }),
      ),
  };
}

test('normalize sin sondeo: el handler responde 400 y no cierra la etapa', async () => {
  await installDeps();
  const ctx = await seed();
  const { jobId, proof, complete } = await normalizeReadyToComplete(ctx);

  const response = await complete({
    ...proof,
    bytes: NORMALIZED.length,
    checksumSha256: sha(NORMALIZED),
  });
  assert.equal(response.status, 400);
  const body = await readBody(response);
  assert.equal((body.error as { code: string }).code, 'invalid_request');
  assert.match((body.error as { message: string }).message, /probe/);

  const job = await jobsRepo.getJobById(jobId);
  assert.notEqual(job?.status, 'succeeded');
  const jobs = await jobsRepo.listJobsForMeeting(job!.meeting_id);
  assert.equal(jobs.filter((entry) => entry.stage === 'transcribe').length, 0);
});

test('normalize con sondeo PARCIAL: 400 del esquema, con el campo nombrado', async () => {
  await installDeps();
  const ctx = await seed();
  const { jobId, proof, complete } = await normalizeReadyToComplete(ctx);

  // Cada campo del formato, ausente por turnos. El esquema del cuerpo es la
  // primera puerta y nombra el campo — un mensaje que dice 'sampleRate' es lo
  // que permite al worker corregir sin adivinar.
  for (const [missing, partial] of [
    ['sampleRate', { channels: 1, codec: 'pcm_s16le' }],
    ['channels', { sampleRate: 16000, codec: 'pcm_s16le' }],
    ['codec', { sampleRate: 16000, channels: 1 }],
  ] as Array<[string, Record<string, unknown>]>) {
    const response = await complete({
      ...proof,
      bytes: NORMALIZED.length,
      checksumSha256: sha(NORMALIZED),
      probe: partial,
    });
    assert.equal(response.status, 400, `falta ${missing}`);
    const body = await readBody(response);
    assert.equal((body.error as { code: string }).code, 'invalid_request');
    assert.match((body.error as { message: string }).message, new RegExp(missing));
  }

  // 'durationSeconds' es la única concesión: ffprobe no siempre la informa.
  const withoutDuration = await complete({
    ...proof,
    bytes: NORMALIZED.length,
    checksumSha256: sha(NORMALIZED),
    probe: { sampleRate: 16000, channels: 1, codec: 'pcm_s16le' },
  });
  assert.equal(withoutDuration.status, 200);
  const job = await jobsRepo.getJobById(jobId);
  assert.equal(job?.status, 'succeeded');
  const media = await meetingsRepo.findLiveDerived(job!.run_id, 'normalized');
  assert.equal(media?.duration_seconds, null, 'la duración se guarda nula, no inventada');
  assert.equal(media?.probe_ok, true);
});

test('normalize con el formato equivocado: 422 media_rejected y nada escrito', async () => {
  await installDeps();
  const ctx = await seed();
  const { jobId, proof, complete } = await normalizeReadyToComplete(ctx);

  for (const probe of [
    { ...PROBE, sampleRate: 44100 },
    { ...PROBE, channels: 2 },
    { ...PROBE, codec: 'aac' },
  ]) {
    const response = await complete({
      ...proof,
      bytes: NORMALIZED.length,
      checksumSha256: sha(NORMALIZED),
      probe,
    });
    assert.equal(response.status, 422, JSON.stringify(probe));
    assert.equal(((await readBody(response)).error as { code: string }).code, 'media_rejected');
  }

  const job = await jobsRepo.getJobById(jobId);
  assert.notEqual(job?.status, 'succeeded');
  assert.equal(await meetingsRepo.findLiveDerived(job!.run_id, 'normalized'), null);
  const jobs = await jobsRepo.listJobsForMeeting(job!.meeting_id);
  assert.equal(jobs.filter((entry) => entry.stage === 'transcribe').length, 0);
});

test('normalize válido: 200, medio con probe_ok y transcribe encolado', async () => {
  await installDeps();
  const ctx = await seed();
  const { jobId, proof, complete } = await normalizeReadyToComplete(ctx);

  const body = {
    ...proof,
    bytes: NORMALIZED.length,
    checksumSha256: sha(NORMALIZED),
    probe: PROBE,
  };
  const response = await complete(body);
  assert.equal(response.status, 200);
  const completed = await readBody(response);
  assert.equal(completed.status, 'succeeded');
  assert.equal((completed.nextJob as { stage: string }).stage, 'transcribe');

  const job = await jobsRepo.getJobById(jobId);
  const media = await meetingsRepo.findLiveDerived(job!.run_id, 'normalized');
  assert.equal(media?.probe_ok, true);
  assert.equal(Number(media?.duration_seconds), PROBE.durationSeconds);
  assert.equal(media?.sample_rate, PROBE.sampleRate);
  assert.equal(media?.channels, PROBE.channels);
  assert.equal(media?.codec, PROBE.codec);

  // Reenvío IDÉNTICO: 200 con el resultado previo, y sin un segundo transcribe.
  const again = await complete(body);
  assert.equal(again.status, 200);
  assert.equal((await readBody(again)).status, 'succeeded');
  const jobs = await jobsRepo.listJobsForMeeting(job!.meeting_id);
  assert.equal(jobs.filter((entry) => entry.stage === 'transcribe').length, 1);

  // Reenvío con otra DURACIÓN: 409. Es el único campo del sondeo que llega a la
  // comparación terminal; los otros tres los detiene antes el formato pactado.
  const conflicting = await complete({ ...body, probe: { ...PROBE, durationSeconds: 31 } });
  assert.equal(conflicting.status, 409);
  assert.equal(((await readBody(conflicting)).error as { code: string }).code, 'terminal_conflict');

  // Y el estado terminal siguió intacto.
  const after = await meetingsRepo.findLiveDerived(job!.run_id, 'normalized');
  assert.equal(Number(after?.duration_seconds), PROBE.durationSeconds);
});

test('el sondeo en transcribe: 400 por el handler, no se ignora', async () => {
  await installDeps();
  const ctx = await seed();
  const { jobId, proof, complete } = await normalizeReadyToComplete(ctx);
  assert.equal(
    (
      await complete({
        ...proof,
        bytes: NORMALIZED.length,
        checksumSha256: sha(NORMALIZED),
        probe: PROBE,
      })
    ).status,
    200,
  );

  const claimRoute = await import('../../web/app/api/meetings/v1/jobs/claim/route.js');
  const initRoute = await import('../../web/app/api/meetings/v1/jobs/[jobId]/result/init/route.js');
  const completeRoute = await import(
    '../../web/app/api/meetings/v1/jobs/[jobId]/result/complete/route.js'
  );
  const transcribe = await readBody(
    await claimRoute.POST(post('/api/meetings/v1/jobs/claim', {}, ctx.token)),
  );
  assert.equal(transcribe.stage, 'transcribe');
  const transcribeId = transcribe.jobId as string;
  const artifact = transcriptArtifact();
  const tProof = { attempt: transcribe.attempt, leaseToken: transcribe.leaseToken };
  const signed = await readBody(
    await initRoute.POST(
      post(
        `/api/meetings/v1/jobs/${transcribeId}/result/init`,
        { ...tProof, bytes: artifact.length, checksumSha256: sha(artifact) },
        ctx.token,
      ),
      params({ jobId: transcribeId }),
    ),
  );
  assert.ok(store.put(signed.url as string, artifact, signed.requiredHeaders as Record<string, string>).ok);

  const withProbe = await completeRoute.POST(
    post(
      `/api/meetings/v1/jobs/${transcribeId}/result/complete`,
      { ...tProof, bytes: artifact.length, checksumSha256: sha(artifact), probe: PROBE },
      ctx.token,
    ),
    params({ jobId: transcribeId }),
  );
  assert.equal(withProbe.status, 400);
  const body = await readBody(withProbe);
  assert.equal((body.error as { code: string }).code, 'invalid_request');
  assert.match((body.error as { message: string }).message, /probe/);
  assert.notEqual((await jobsRepo.getJobById(transcribeId))?.status, 'succeeded');

  // Sin el sondeo, la misma etapa cierra por el mismo handler.
  const withoutProbe = await completeRoute.POST(
    post(
      `/api/meetings/v1/jobs/${transcribeId}/result/complete`,
      { ...tProof, bytes: artifact.length, checksumSha256: sha(artifact) },
      ctx.token,
    ),
    params({ jobId: transcribeId }),
  );
  assert.equal(withoutProbe.status, 200);
  void jobId;
});

test('el barrido global exige ámbito interno Y capacidad, también por el handler', async () => {
  await installDeps();
  const ctx = await seed();
  const { POST } = await import('../../web/app/api/meetings/v1/maintenance/requeue-expired/route.js');

  // Una credencial NORMAL de worker —ámbito de tenant, sólo transcribe— recibe
  // el MISMO 404 que un recurso inexistente.
  const denied = await POST(post('/api/meetings/v1/maintenance/requeue-expired', {}, ctx.token));
  assert.equal(denied.status, 404);
  assert.equal(((await readBody(denied)).error as { code: string }).code, 'not_found');

  // Una de otro tenant, igual.
  const foreign = await POST(
    post('/api/meetings/v1/maintenance/requeue-expired', {}, ctx.foreignToken),
  );
  assert.equal(foreign.status, 404);
  assert.equal(((await readBody(foreign)).error as { code: string }).code, 'not_found');

  // La credencial de mantenimiento es INTERNA: se comprueba antes de afirmar
  // que el éxito viene de ahí, porque el ámbito es la mitad del requisito y una
  // credencial de tenant con la capacidad ya no se puede ni emitir.
  const identity = await authenticateWorkerToken(ctx.maintenanceToken);
  assert.ok(identity);
  assert.equal(identity.scope, 'internal');
  assert.deepEqual(identity.capabilities, ['meetings.maintenance']);
  assert.equal(identity.tenantId, null, 'un pool interno no está atado a ningún tenant');

  // Y sólo ella ve los recuentos globales.
  const allowed = await POST(
    post('/api/meetings/v1/maintenance/requeue-expired', {}, ctx.maintenanceToken),
  );
  assert.equal(allowed.status, 200);
  const body = await readBody(allowed);
  assert.equal(typeof body.requeued, 'number');
  assert.equal(typeof body.abandoned, 'number');

  // Un cuerpo con campos de más se rechaza en el borde, no se ignora: el
  // barrido no toma parámetros, y aceptar 'tenantId' en silencio dejaría a
  // alguien creyendo que acotó el alcance.
  const withBody = await POST(
    post('/api/meetings/v1/maintenance/requeue-expired', { tenantId: ctx.tenantId }, ctx.maintenanceToken),
  );
  assert.equal(withBody.status, 400);
  assert.equal(((await readBody(withBody)).error as { code: string }).code, 'invalid_request');
});

test('las rutas con sesión validan ANTES de resolver el ámbito', async () => {
  await installDeps();
  // Sin sesión, `getAccessScope` redirige o lanza. Un cuerpo inválido tiene que
  // fallar antes de llegar ahí: si no, un 400 legítimo se convertiría en el
  // error de la sesión y el cliente no sabría qué corregir.
  const { POST } = await import('../../web/app/api/meetings/v1/meetings/route.js');
  const response = await POST(
    post('/api/meetings/v1/meetings', { title: '', idempotencyKey: '', clientId: 'no-uuid' }),
  );
  assert.equal(response.status, 400);
  const message = ((await readBody(response)).error as { message: string }).message;
  assert.match(message, /clientId/);
});

test('un artefacto con schema_version futura se rechaza por el handler', async () => {
  await installDeps();
  const ctx = await seed();
  const { jobId } = await seedMeeting(ctx);
  const claimRoute = await import('../../web/app/api/meetings/v1/jobs/claim/route.js');
  const initRoute = await import('../../web/app/api/meetings/v1/jobs/[jobId]/result/init/route.js');
  const claimed = await readBody(await claimRoute.POST(post('/api/meetings/v1/jobs/claim', {}, ctx.token)));

  const response = await initRoute.POST(
    post(
      `/api/meetings/v1/jobs/${jobId}/result/init`,
      {
        attempt: claimed.attempt,
        leaseToken: claimed.leaseToken,
        bytes: 10,
        checksumSha256: sha(NORMALIZED),
        schemaVersion: 99,
      },
      ctx.token,
    ),
    params({ jobId }),
  );
  // Se rechaza en el borde, antes de firmar una URL: una versión que mai no sabe
  // leer no debería llegar a subirse.
  assert.equal(response.status, 400);
  assert.match(((await readBody(response)).error as { message: string }).message, /schemaVersion/);
});

test('un artefacto NDJSON malformado sale como 422 artifact_malformed', async () => {
  await installDeps();
  const ctx = await seed();
  const { jobId } = await seedMeeting(ctx);
  const claimRoute = await import('../../web/app/api/meetings/v1/jobs/claim/route.js');
  const initRoute = await import('../../web/app/api/meetings/v1/jobs/[jobId]/result/init/route.js');
  const completeRoute = await import('../../web/app/api/meetings/v1/jobs/[jobId]/result/complete/route.js');

  // normalize primero, para llegar a transcribe.
  const normalize = await readBody(await claimRoute.POST(post('/api/meetings/v1/jobs/claim', {}, ctx.token)));
  const normalizePayload = {
    attempt: normalize.attempt,
    leaseToken: normalize.leaseToken,
    bytes: NORMALIZED.length,
    checksumSha256: sha(NORMALIZED),
  };
  const normalizeSigned = await readBody(
    await initRoute.POST(
      post(`/api/meetings/v1/jobs/${jobId}/result/init`, normalizePayload, ctx.token),
      params({ jobId }),
    ),
  );
  store.put(
    normalizeSigned.url as string,
    NORMALIZED,
    normalizeSigned.requiredHeaders as Record<string, string>,
  );
  const normalizeClosed = await completeRoute.POST(
    post(
      `/api/meetings/v1/jobs/${jobId}/result/complete`,
      { ...normalizePayload, probe: PROBE },
      ctx.token,
    ),
    params({ jobId }),
  );
  assert.equal(normalizeClosed.status, 200, 'normalize tiene que cerrar para llegar a transcribe');

  // transcribe con un NDJSON cuya cabecera declara más segmentos de los que hay.
  const transcribe = await readBody(await claimRoute.POST(post('/api/meetings/v1/jobs/claim', {}, ctx.token)));
  const truncated = gzipSync(
    Buffer.from(
      `${JSON.stringify({
        schema: 'meetings.transcript',
        schema_version: 1,
        duration_seconds: 30,
        model: 'medium',
        segment_count: 9,
      })}\n${JSON.stringify({ i: 0, start: 0, end: 1, text: 'uno' })}\n`,
    ),
  );
  const transcribeId = transcribe.jobId as string;
  const payload = {
    attempt: transcribe.attempt,
    leaseToken: transcribe.leaseToken,
    bytes: truncated.length,
    checksumSha256: sha(truncated),
  };
  const signed = await readBody(
    await initRoute.POST(
      post(`/api/meetings/v1/jobs/${transcribeId}/result/init`, payload, ctx.token),
      params({ jobId: transcribeId }),
    ),
  );
  store.put(signed.url as string, truncated, signed.requiredHeaders as Record<string, string>);

  const response = await completeRoute.POST(
    post(`/api/meetings/v1/jobs/${transcribeId}/result/complete`, payload, ctx.token),
    params({ jobId: transcribeId }),
  );
  assert.equal(response.status, 422);
  assert.equal(((await readBody(response)).error as { code: string }).code, 'artifact_malformed');
});
