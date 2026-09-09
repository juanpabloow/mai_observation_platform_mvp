import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closePool, query } from '../../src/db/client.js';
import { DEFAULT_MEDIA_LIMITS } from '../../src/meetings/mediaLimits.js';
import { RateLimiter } from '../../src/meetings/rateLimit.js';
import { mintWorkerToken } from '../../src/db/repositories/meetings/credentials.js';
import {
  createMeeting,
  getMeetingState,
  uploadComplete,
  uploadInit,
} from '../../src/meetings/service.js';
import { HttpObjectStore } from './httpObjectStore.js';
import { MaiTestServer } from './maiServer.js';

/**
 * Validación cruzada: mai en Node y el worker pull en Python, hablando por HTTP
 * de verdad.
 *
 *   node --import tsx --import ./test/integration/env.ts test/e2e/runCrossProcess.ts <python>
 *
 * Es la única prueba que ejercita el CONTRATO entre los dos procesos: el JSON
 * que el worker manda, la cabecera del token, los códigos de error, los campos
 * de la respuesta y las cabeceras firmadas de la subida. Las suites de cada lado
 * prueban su mitad con un doble del otro; esto prueba que los dos dobles
 * coincidían con la realidad.
 *
 * Las etapas del worker se sustituyen por versiones instantáneas mediante una
 * variable de entorno que el script de Python lee: cargar whisper convertiría
 * esto en una prueba de GPU y el contrato seguiría sin probarse.
 */

const pythonExecutable = process.argv[2];
if (!pythonExecutable) {
  console.error('uso: runCrossProcess.ts <ruta-al-python-con-el-worker>');
  process.exit(2);
}

const AUDIO = Buffer.from('RIFF....WAVE audio original de la validación cruzada');
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface Step {
  readonly n: number;
  readonly label: string;
  ok: boolean;
  detail?: string;
}
const steps: Step[] = [];
function check(n: number, label: string, ok: boolean, detail?: string): void {
  steps.push({ n, label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${String(n).padStart(2)} · ${label}${ok || !detail ? '' : ` — ${detail}`}`);
}

function runWorker(
  python: string,
  maiOrigin: string,
  token: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(python, ['-m', 'tests.e2e_pull_driver', '3'], {
      cwd: process.env.WORKER_DIR,
      env: {
        ...process.env,
        MEETINGS_PULL_ENABLED: '1',
        MAI_BASE_URL: maiOrigin,
        MAI_WORKER_TOKEN: token,
        MEETINGS_PULL_IDLE_SECONDS: '0.05',
        MEETINGS_PULL_HEARTBEAT_SECONDS: '0.5',
        MEETINGS_E2E_FAKE_STAGES: '1',
        PYTHONPATH: process.env.WORKER_DIR ?? '',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** Igual que runWorker pero para un comando cualquiera: también asíncrono, por
 *  la misma razón — el servidor de mai vive en este proceso. */
function runPython(
  python: string,
  args: string[],
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(python, args, { cwd: process.env.WORKER_DIR, env: process.env });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function main(): Promise<number> {
  const store = new HttpObjectStore();
  const storeOrigin = await store.listen();
  const deps = {
    store,
    limits: DEFAULT_MEDIA_LIMITS,
    leaseSeconds: 60,
    rateLimiter: new RateLimiter({
      rules: {
        claim: { burst: 500, refillPerSecond: 500 },
        heartbeat: { burst: 500, refillPerSecond: 500 },
        result: { burst: 500, refillPerSecond: 500 },
      },
    }),
  };
  const mai = new MaiTestServer(deps);
  const maiOrigin = await mai.listen();

  // ── Semilla ──────────────────────────────────────────────────────────────
  const tenantId = randomUUID();
  await query(`INSERT INTO tenants (id, name) VALUES ($1, 'E2E')`, [tenantId]);
  const client = await query<{ id: string }>(
    `INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, 'Cliente E2E', false) RETURNING id`,
    [tenantId],
  );
  const clientId = client.rows[0].id;
  const pool = await query<{ id: string }>(
    `INSERT INTO worker_pools (slug, environment, scope, tenant_id, capabilities, concurrency)
     VALUES ($1, 'development', 'single_tenant', $2, '{meetings.transcribe}',
             '{"schema_version":1,"limits":{"meetings.transcribe":1}}'::jsonb)
     RETURNING id`,
    [`e2e-${tenantId.slice(0, 8)}`, tenantId],
  );
  const minted = mintWorkerToken();
  await query(
    `INSERT INTO worker_credentials (pool_id, label, token_hash, token_prefix)
     VALUES ($1, 'e2e', $2, $3)`,
    [pool.rows[0].id, minted.tokenHash, minted.tokenPrefix],
  );
  const scope = { tenantId, clientId };

  console.log(`\nmai:   ${maiOrigin}\nstore: ${storeOrigin}\n`);

  try {
    // 1 · crear la reunión
    const created = await createMeeting(scope, { title: 'E2E', idempotencyKey: `e2e-${randomUUID()}` });
    check(1, 'crear reunión', created.created && Boolean(created.meetingId));

    // 2 · signed PUT y subida del audio, con un PUT HTTP REAL
    const init = await uploadInit(
      scope,
      created.meetingId,
      { filename: 'e2e.wav', contentType: 'audio/wav', bytes: AUDIO.length, checksumSha256: sha(AUDIO) },
      deps,
    );
    const putResponse = await fetch(init.url, {
      method: 'PUT',
      headers: init.requiredHeaders as Record<string, string>,
      body: AUDIO,
    });
    check(2, 'signed PUT y subida del audio', putResponse.status === 204, `HTTP ${putResponse.status}`);

    // 3 · confirmar la subida
    const confirmed = await uploadComplete(
      scope,
      created.meetingId,
      { bytes: AUDIO.length, checksumSha256: sha(AUDIO) },
      deps,
    );
    check(3, 'confirmar upload', confirmed.mediaState === 'ready');

    // 4 · normalize existe y es el ÚNICO en cola
    const initialJobs = await query<{ stage: string; status: string }>(
      `SELECT stage, status FROM meeting_processing_jobs WHERE meeting_id = $1`,
      [created.meetingId],
    );
    check(
      4,
      'sólo normalize en cola (creación secuencial)',
      initialJobs.rows.length === 1 && initialJobs.rows[0].stage === 'normalize',
      JSON.stringify(initialJobs.rows),
    );

    // 5–7 · el WORKER en Python reclama y procesa las tres etapas.
    //
    // `spawn` y no `spawnSync`: el servidor de mai vive en ESTE proceso, así que
    // bloquear el event loop esperando al hijo dejaría al worker hablando con un
    // servidor que no puede contestar — y el síntoma sería un timeout que parece
    // un problema de red.
    const workerResult = await runWorker(pythonExecutable, maiOrigin, minted.token);
    if (workerResult.code !== 0) {
      console.log(
        workerResult.output.split('\n').slice(-25).map((line) => `      ${line}`).join('\n'),
      );
    }
    check(
      5,
      'el worker Python reclamó y procesó las tres etapas',
      workerResult.code === 0,
      `exit ${workerResult.code}`,
    );

    const jobs = await query<{ stage: string; status: string }>(
      `SELECT stage, status FROM meeting_processing_jobs WHERE meeting_id = $1 ORDER BY created_at`,
      [created.meetingId],
    );
    const shape = jobs.rows.map((row) => `${row.stage}:${row.status}`);
    check(
      6,
      'transcribe y diarize se crearon secuencialmente',
      shape.join(',') === 'normalize:succeeded,transcribe:succeeded,diarize:succeeded',
      shape.join(','),
    );

    const uploads = await query<{ kind: string; state: string }>(
      `SELECT kind, state FROM meeting_result_uploads WHERE meeting_id = $1 ORDER BY created_at`,
      [created.meetingId],
    );
    check(
      7,
      'los tres artefactos se subieron por signed PUT',
      uploads.rows.length === 3 && uploads.rows.every((row) => row.state === 'ingested'),
      JSON.stringify(uploads.rows),
    );

    // 8 · checksums verificados e ingestión
    const verified = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM meeting_result_uploads
        WHERE meeting_id = $1 AND observed_checksum_sha256 = declared_checksum_sha256`,
      [created.meetingId],
    );
    const state = await getMeetingState(scope, created.meetingId);
    check(
      8,
      'checksums verificados y transcript ingerido',
      verified.rows[0].n === '3' && state.transcriptState === 'ready' && state.activeTranscript !== null,
      `verificados=${verified.rows[0].n} transcript=${state.transcriptState}`,
    );

    // 9 · la versión activa es de ESTA reunión
    const version = await query<{ meeting_id: string; run_id: string }>(
      `SELECT meeting_id, run_id FROM meeting_transcript_versions WHERE id = $1`,
      [state.activeTranscript?.id ?? null],
    );
    check(
      9,
      'la versión activa pertenece a la reunión correcta',
      version.rows[0]?.meeting_id === created.meetingId && version.rows[0]?.run_id === confirmed.runId,
    );

    // ── El contrato de ERROR sobre HTTP real. Las pruebas de servicio de T-3
    //    cubren la lógica; esto cubre que el código y el estado lleguen por el
    //    cable con la forma que el worker compara.
    const post = async (path: string, token: string, payload: unknown) =>
      fetch(`${maiOrigin}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

    // 11 · credencial revocada
    const revoked = mintWorkerToken();
    const revokedRow = await query<{ id: string }>(
      `INSERT INTO worker_credentials
         (pool_id, label, token_hash, token_prefix, revoked_at, revoked_actor,
          revoked_actor_label, revoked_reason)
       VALUES ($1, 'revocada', $2, $3, now(), 'system', 'e2e', 'prueba')
       RETURNING id`,
      [pool.rows[0].id, revoked.tokenHash, revoked.tokenPrefix],
    );
    const revokedClaim = await post('/api/meetings/v1/jobs/claim', revoked.token, {});
    const revokedBody = (await revokedClaim.json()) as { error?: { code?: string } };
    check(
      11,
      'una credencial revocada recibe 401 unauthorized',
      revokedClaim.status === 401 && revokedBody.error?.code === 'unauthorized',
      `HTTP ${revokedClaim.status} ${JSON.stringify(revokedBody)}`,
    );
    void revokedRow;

    // 13 · lease token equivocado sobre un job real
    const someJob = jobs.rows.length > 0
      ? (await query<{ id: string; attempts: number }>(
          `SELECT id, attempts FROM meeting_processing_jobs
            WHERE meeting_id = $1 AND stage = 'diarize'`,
          [created.meetingId],
        )).rows[0]
      : null;
    if (someJob) {
      const badLease = await post(`/api/meetings/v1/jobs/${someJob.id}/heartbeat`, minted.token, {
        attempt: someJob.attempts,
        leaseToken: 'mlt_inventado',
      });
      const badBody = (await badLease.json()) as { error?: { code?: string } };
      check(
        13,
        'un lease token inventado recibe 409 con código estable',
        badLease.status === 409 && typeof badBody.error?.code === 'string',
        `HTTP ${badLease.status} ${JSON.stringify(badBody)}`,
      );
    }

    // 14 · un pool de OTRO tenant no ve este trabajo
    const foreignTenant = randomUUID();
    await query(`INSERT INTO tenants (id, name) VALUES ($1, 'E2E ajeno')`, [foreignTenant]);
    const foreignPool = await query<{ id: string }>(
      `INSERT INTO worker_pools (slug, environment, scope, tenant_id, capabilities, concurrency)
       VALUES ($1, 'development', 'single_tenant', $2, '{meetings.transcribe}',
               '{"schema_version":1,"limits":{"meetings.transcribe":1}}'::jsonb)
       RETURNING id`,
      [`e2e-x-${foreignTenant.slice(0, 8)}`, foreignTenant],
    );
    const foreignToken = mintWorkerToken();
    await query(
      `INSERT INTO worker_credentials (pool_id, label, token_hash, token_prefix)
       VALUES ($1, 'ajena', $2, $3)`,
      [foreignPool.rows[0].id, foreignToken.tokenHash, foreignToken.tokenPrefix],
    );
    // Se encola trabajo nuevo del tenant propio para que "no hay nada" no sea
    // trivialmente cierto.
    const second = await createMeeting(scope, { title: 'E2E 2', idempotencyKey: `e2e-${randomUUID()}` });
    const secondInit = await uploadInit(
      scope,
      second.meetingId,
      { filename: 'x.wav', contentType: 'audio/wav', bytes: AUDIO.length, checksumSha256: sha(AUDIO) },
      deps,
    );
    await fetch(secondInit.url, {
      method: 'PUT',
      headers: secondInit.requiredHeaders as Record<string, string>,
      body: AUDIO,
    });
    await uploadComplete(scope, second.meetingId, { bytes: AUDIO.length, checksumSha256: sha(AUDIO) }, deps);

    const foreignClaim = await post('/api/meetings/v1/jobs/claim', foreignToken.token, {});
    const ownClaim = await post('/api/meetings/v1/jobs/claim', minted.token, {});
    check(
      14,
      'sin acceso cruzado: el pool ajeno recibe 204 y el propio sí trabajo',
      foreignClaim.status === 204 && ownClaim.status === 200,
      `ajeno=${foreignClaim.status} propio=${ownClaim.status}`,
    );
    await query(`DELETE FROM tenants WHERE id = $1`, [foreignTenant]);

    // 15 · las rutas HTTP históricas del worker siguen funcionando
    const legacy = await runPython(pythonExecutable, [
      '-c',
      'import sys; sys.path.insert(0,"."); import app.main as m; print(sorted({r.path for r in m.app.routes if hasattr(r,"path")}))',
    ]);
    const legacyOk =
      legacy.code === 0 &&
      ['/health', '/gpu', '/transcribe'].every((route) => legacy.output.includes(route));
    check(15, 'las rutas HTTP históricas siguen registradas', legacyOk, legacy.output.trim());

    await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  } finally {
    await mai.close();
    await store.close();
    await closePool();
  }

  const failed = steps.filter((step) => !step.ok);
  console.log(
    `\n${failed.length === 0 ? 'CRUZADO VERDE' : 'CRUZADO CON FALLOS'} — ${steps.length - failed.length}/${steps.length}\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
