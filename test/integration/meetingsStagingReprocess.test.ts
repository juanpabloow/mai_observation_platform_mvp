import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isUniqueViolation, query, withTransaction } from '../../src/db/client.js';
import * as jobsRepo from '../../src/db/repositories/meetings/jobs.js';
import type { Queryable } from '../../src/db/repositories/meetings/types.js';
import {
  ReprocessRefused,
  applyReprocess,
  hasWarningForRun,
  planReprocess,
} from '../../src/scripts/meetingsStagingReprocess.js';
import { cleanupTenant, closeDb } from './fixtures.js';

/**
 * El reproceso de una reunión fallida, contra la base desechable.
 *
 * Lo que estas pruebas persiguen no es el camino feliz —que también— sino las
 * dos invariantes que el runbook exige y que sólo se pueden observar con datos
 * delante y dos transacciones a la vez:
 *
 *   · nunca dos runs activos por reunión;
 *   · nunca dos jobs `normalize` en el mismo run;
 *
 * y la promesa que hace todo esto útil: **el audio original no se vuelve a
 * subir**. El original tiene `run_id NULL` y sigue siendo el mismo objeto de
 * R2, con los mismos bytes y el mismo checksum, después del reproceso.
 */

const tenants: string[] = [];
after(async () => {
  for (const tenant of tenants) await cleanupTenant(tenant);
  await closeDb();
});

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const parsed = DB_URL === '' ? null : new URL(DB_URL);
const SCRIPT = 'src/scripts/meetingsStagingReprocess.ts';

function guardEnv(overrides: Record<string, string> = {}): Record<string, string> {
  assert.ok(parsed, 'hace falta TEST_DATABASE_URL');
  return {
    PATH: process.env.PATH ?? '',
    MEETINGS_ENV_KIND: 'staging',
    DATABASE_URL: DB_URL,
    MEETINGS_EXPECTED_DB_HOST: parsed.hostname,
    MEETINGS_EXPECTED_DB_NAME: parsed.pathname.replace(/^\//, ''),
    ...overrides,
  };
}

function run(
  args: readonly string[],
  env: Record<string, string> = guardEnv(),
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
    cwd: new URL('../../', import.meta.url).pathname,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

interface Scenario {
  readonly tenantId: string;
  readonly clientId: string;
  readonly meetingId: string;
  readonly runId: string;
  readonly jobId: string;
  readonly storageKey: string;
  readonly checksum: string;
}

/**
 * El estado en el que W-3 se quedó: original vivo, run 1 cerrado con
 * `outcome='failed'`, job `normalize` agotado con `worker_error`, y el aviso
 * histórico en la reunión.
 */
async function seedFailedMeeting(
  overrides: {
    readonly mediaState?: string;
    readonly cancelled?: boolean;
    readonly deleteOriginal?: boolean;
    readonly leaveRunOpen?: boolean;
    readonly warnings?: unknown[];
  } = {},
): Promise<Scenario> {
  const tenantId = randomUUID();
  const clientId = randomUUID();
  const meetingId = randomUUID();
  const runId = randomUUID();
  const jobId = randomUUID();
  const checksum = randomUUID().replace(/-/g, '').padEnd(64, 'a').slice(0, 64);
  const storageKey = `t/${tenantId}/c/${clientId}/m/${meetingId}/original/source`;

  tenants.push(tenantId);
  await query(`INSERT INTO tenants (id, name) VALUES ($1, 'W3 reproceso')`, [tenantId]);
  await query(
    `INSERT INTO clients (id, tenant_id, name, is_default) VALUES ($1, $2, 'Cliente', false)`,
    [clientId, tenantId],
  );
  await query(
    `INSERT INTO client_modules (tenant_id, client_id, module_key, enabled)
     VALUES ($1, $2, 'meetings', true)`,
    [tenantId, clientId],
  );
  await query(
    `INSERT INTO meetings (id, tenant_id, client_id, title, source_kind, idempotency_key,
                           media_state, transcript_state, warnings, cancelled_at, cancelled_by_label)
     VALUES ($1, $2, $3, 'La que falló', 'file', $4, $5, 'failed', $6::jsonb, $7, $8)`,
    [
      meetingId,
      tenantId,
      clientId,
      `repro-${meetingId.slice(0, 8)}`,
      overrides.mediaState ?? 'ready',
      JSON.stringify(
        overrides.warnings ?? [
          { at: '2026-09-10T00:48:23.085Z', code: 'normalize_failed', failure_code: 'worker_error' },
        ],
      ),
      overrides.cancelled === true ? new Date() : null,
      overrides.cancelled === true ? 'prueba' : null,
    ],
  );
  await query(
    `INSERT INTO meeting_media (tenant_id, client_id, meeting_id, role, storage_key, bytes,
                                checksum_sha256, content_type, deleted_at)
     VALUES ($1, $2, $3, 'original', $4, 1026007, $5, 'audio/wav', $6)`,
    [tenantId, clientId, meetingId, storageKey, checksum, overrides.deleteOriginal === true ? new Date() : null],
  );
  await query(
    `INSERT INTO meeting_processing_runs (id, tenant_id, client_id, meeting_id, run_number,
                                          trigger, started_at, finished_at, outcome)
     VALUES ($1, $2, $3, $4, 1, 'initial', now() - interval '10 min', $5, $6)`,
    [
      runId,
      tenantId,
      clientId,
      meetingId,
      overrides.leaveRunOpen === true ? null : new Date(),
      overrides.leaveRunOpen === true ? null : 'failed',
    ],
  );
  // El run abierto lleva su job en cola, no arrendado: 'leased' exige los
  // cuatro campos de lease en la MISMA fila (jobs_lease_invariants) y el uuid
  // de credencial tiene FK con RESTRICT, así que fingirlo obligaría a sembrar
  // un pool y una credencial que esta prueba no necesita. Un run abierto con
  // trabajo en cola es un estado igual de real.
  const inFlight = overrides.leaveRunOpen === true;
  await query(
    `INSERT INTO meeting_processing_jobs (id, tenant_id, client_id, meeting_id, run_id, stage,
                                          status, attempts, max_attempts, failure_code, failure_detail)
     VALUES ($1, $2, $3, $4, $5, 'normalize', $6, $7, 3, $8, $9)`,
    [
      jobId,
      tenantId,
      clientId,
      meetingId,
      runId,
      inFlight ? 'queued' : 'failed',
      inFlight ? 0 : 3,
      inFlight ? null : 'worker_error',
      inFlight ? null : "'dict' object has no attribute 'duration_seconds'",
    ],
  );
  return { tenantId, clientId, meetingId, runId, jobId, storageKey, checksum };
}

const idArgs = (s: Scenario): string[] => [
  '--tenant-id', s.tenantId,
  '--client-id', s.clientId,
  '--meeting-id', s.meetingId,
];

async function stateOf(s: Scenario): Promise<{
  activeRuns: number;
  runs: number;
  normalizeJobs: number;
  queuedJobs: number;
  transcriptState: string;
  warnings: unknown[];
  originals: number;
  originalBytes: string | null;
  originalChecksum: string | null;
  oldJobStatus: string;
  oldJobAttempts: number;
  oldJobFailure: string | null;
}> {
  const row = (
    await query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM meeting_processing_runs WHERE meeting_id=$1 AND finished_at IS NULL)::text AS active_runs,
         (SELECT count(*) FROM meeting_processing_runs WHERE meeting_id=$1)::text AS runs,
         (SELECT count(*) FROM meeting_processing_jobs WHERE meeting_id=$1 AND stage='normalize')::text AS normalize_jobs,
         (SELECT count(*) FROM meeting_processing_jobs WHERE meeting_id=$1 AND status='queued')::text AS queued_jobs,
         (SELECT transcript_state FROM meetings WHERE id=$1) AS transcript_state,
         (SELECT warnings FROM meetings WHERE id=$1)::text AS warnings,
         (SELECT count(*) FROM meeting_media WHERE meeting_id=$1 AND role='original' AND deleted_at IS NULL)::text AS originals,
         (SELECT bytes FROM meeting_media WHERE meeting_id=$1 AND role='original')::text AS original_bytes,
         (SELECT checksum_sha256 FROM meeting_media WHERE meeting_id=$1 AND role='original') AS original_checksum,
         (SELECT status FROM meeting_processing_jobs WHERE id=$2) AS old_status,
         (SELECT attempts FROM meeting_processing_jobs WHERE id=$2)::text AS old_attempts,
         (SELECT failure_code FROM meeting_processing_jobs WHERE id=$2) AS old_failure`,
      [s.meetingId, s.jobId],
    )
  ).rows[0];
  return {
    activeRuns: Number(row.active_runs),
    runs: Number(row.runs),
    normalizeJobs: Number(row.normalize_jobs),
    queuedJobs: Number(row.queued_jobs),
    transcriptState: row.transcript_state,
    warnings: JSON.parse(row.warnings) as unknown[],
    originals: Number(row.originals),
    originalBytes: row.original_bytes,
    originalChecksum: row.original_checksum,
    oldJobStatus: row.old_status,
    oldJobAttempts: Number(row.old_attempts),
    oldJobFailure: row.old_failure,
  };
}

// ── El camino feliz, y qué NO cambia ────────────────────────────────────────

test('el reproceso crea run 2 y un normalize nuevo sin tocar el job fallido', async () => {
  const s = await seedFailedMeeting();
  const before = await stateOf(s);

  const result = run([...idArgs(s), '--execute']);
  assert.equal(result.status, 0, result.stderr);

  const after_ = await stateOf(s);
  assert.equal(after_.runs, 2, 'hay dos runs');
  assert.equal(after_.activeRuns, 1, 'y sólo uno activo');
  assert.equal(after_.normalizeJobs, 2, 'un normalize por run');
  assert.equal(after_.queuedJobs, 1, 'sólo el nuevo está en cola');
  assert.equal(after_.transcriptState, 'pending', 'failed → pending');

  // El job fallido, intacto hasta el último campo.
  assert.equal(after_.oldJobStatus, 'failed');
  assert.equal(after_.oldJobAttempts, before.oldJobAttempts);
  assert.equal(after_.oldJobFailure, 'worker_error');

  const run2 = (
    await query<{ id: string; run_number: number; trigger: string; requested_by_user_id: string | null }>(
      `SELECT id, run_number, trigger, requested_by_user_id FROM meeting_processing_runs
        WHERE meeting_id=$1 AND finished_at IS NULL`,
      [s.meetingId],
    )
  ).rows[0];
  assert.equal(run2.run_number, 2);
  assert.equal(run2.trigger, 'reprocess');
  assert.equal(run2.requested_by_user_id, null, 'no se inventa un autor');

  const job2 = (
    await query<{ id: string; status: string; attempts: number; requires: string[]; run_id: string }>(
      `SELECT id, status, attempts, requires, run_id FROM meeting_processing_jobs
        WHERE meeting_id=$1 AND status='queued'`,
      [s.meetingId],
    )
  ).rows[0];
  assert.equal(job2.run_id, run2.id, 'el job cuelga del run nuevo');
  assert.equal(job2.attempts, 0);
  assert.deepEqual(job2.requires, ['meetings.transcribe'], 'requires es GENERATED desde stage');
});

test('el audio original se reutiliza: mismos bytes, mismo checksum, misma clave', async () => {
  const s = await seedFailedMeeting();
  const before = await stateOf(s);
  assert.equal(run([...idArgs(s), '--execute']).status, 0);
  const after_ = await stateOf(s);

  assert.equal(after_.originals, 1, 'sigue habiendo UN original vivo');
  assert.equal(after_.originalBytes, before.originalBytes);
  assert.equal(after_.originalChecksum, before.originalChecksum);

  // Y la clave es la misma fila: `run_id` sigue NULL, así que pertenece a la
  // reunión y el claim de normalize del run nuevo la encuentra por meeting_id.
  const media = (
    await query<{ storage_key: string; run_id: string | null }>(
      `SELECT storage_key, run_id FROM meeting_media WHERE meeting_id=$1 AND role='original'`,
      [s.meetingId],
    )
  ).rows;
  assert.equal(media.length, 1, 'no se duplicó el original');
  assert.equal(media[0].storage_key, s.storageKey);
  assert.equal(media[0].run_id, null);

  // Cero medios derivados: el run nuevo aún no ha producido nada.
  const derived = await query(
    `SELECT 1 FROM meeting_media WHERE meeting_id=$1 AND role <> 'original'`,
    [s.meetingId],
  );
  assert.equal(derived.rowCount, 0);
});

test('el aviso histórico se conserva y el nuevo no se duplica', async () => {
  const s = await seedFailedMeeting();
  assert.equal(run([...idArgs(s), '--execute']).status, 0);
  const after_ = await stateOf(s);

  assert.equal(after_.warnings.length, 2, 'el histórico sigue y se añadió uno');
  const codes = after_.warnings.map((w) => (w as Record<string, unknown>).code);
  assert.deepEqual(codes, ['normalize_failed', 'reprocess_requested']);
  const nuevo = after_.warnings[1] as Record<string, unknown>;
  assert.equal(nuevo.run_number, 2);
  assert.equal(nuevo.previous_failure_code, 'worker_error', 'dice por qué se reprocesa');
  assert.equal(
    after_.warnings.filter((w) => (w as Record<string, unknown>).code === 'reprocess_requested').length,
    1,
  );
});

test('si el aviso de ese run ya existe, no se añade otro', async () => {
  // Alguien reprocesó, el run se cerró, y el aviso del run 2 ya está puesto.
  const s = await seedFailedMeeting({
    warnings: [
      { at: '2026-09-10T00:48:23.085Z', code: 'normalize_failed', failure_code: 'worker_error' },
      { at: '2026-09-10T01:00:00.000Z', code: 'reprocess_requested', run_number: 2 },
    ],
  });
  assert.equal(run([...idArgs(s), '--execute']).status, 0);
  const after_ = await stateOf(s);
  assert.equal(after_.warnings.length, 2, 'ni uno más');
  assert.equal(after_.transcriptState, 'pending', 'el estado sí avanza igual');
});

test('hasWarningForRun distingue por run_number y por código', () => {
  const warnings = [
    { code: 'normalize_failed', failure_code: 'worker_error' },
    { code: 'reprocess_requested', run_number: 2 },
    null,
    'basura',
  ];
  assert.equal(hasWarningForRun(warnings, 2), true);
  assert.equal(hasWarningForRun(warnings, 3), false, 'otro run es otro aviso');
  assert.equal(hasWarningForRun([], 2), false);
  assert.equal(hasWarningForRun([{ code: 'otra_cosa', run_number: 2 }], 2), false);
});

// ── El dry-run ──────────────────────────────────────────────────────────────

test('sin --execute no se escribe absolutamente nada', async () => {
  const s = await seedFailedMeeting();
  const before = await stateOf(s);

  const result = run(idArgs(s));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY-RUN/);
  assert.match(result.stdout, /run nuevo\s+nº2/);
  assert.match(result.stdout, /trigger='reprocess'/);
  assert.match(result.stdout, /failed → pending/);
  assert.ok(result.stdout.includes(s.storageKey), 'dice qué objeto reutiliza');

  assert.deepEqual(await stateOf(s), before, 'la base está exactamente igual');
});

test('--dry-run y --execute juntos no se ejecutan', async () => {
  const s = await seedFailedMeeting();
  const result = run([...idArgs(s), '--dry-run', '--execute']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /incompatibles/);
  assert.equal((await stateOf(s)).runs, 1);
});

// ── Las cinco negativas ─────────────────────────────────────────────────────

test('rechaza una reunión cancelada', async () => {
  const s = await seedFailedMeeting({ cancelled: true });
  const result = run([...idArgs(s), '--execute']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[meeting_cancelled\]/);
  assert.equal((await stateOf(s)).runs, 1, 'no se creó ningún run');
});

test('rechaza medios que no están listos', async () => {
  for (const mediaState of ['pending', 'uploading', 'invalid']) {
    const s = await seedFailedMeeting({ mediaState });
    const result = run([...idArgs(s), '--execute']);
    assert.equal(result.status, 2, `media_state=${mediaState}`);
    assert.match(result.stderr, /\[media_not_ready\]/);
    assert.equal((await stateOf(s)).runs, 1);
  }
});

test('rechaza si el original está borrado, en vez de pedir que se resuba', async () => {
  const s = await seedFailedMeeting({ deleteOriginal: true });
  const result = run([...idArgs(s), '--execute']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[original_missing\]/);
  assert.equal((await stateOf(s)).runs, 1);
});

test('rechaza si ya hay un run activo, y no lo cierra por su cuenta', async () => {
  const s = await seedFailedMeeting({ leaveRunOpen: true });
  const result = run([...idArgs(s), '--execute']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[run_active\]/);

  const after_ = await stateOf(s);
  assert.equal(after_.runs, 1, 'no se creó otro');
  assert.equal(after_.activeRuns, 1, 'y el que había sigue abierto');
  const outcome = await query<{ outcome: string | null }>(
    `SELECT outcome FROM meeting_processing_runs WHERE id=$1`,
    [s.runId],
  );
  assert.equal(outcome.rows[0].outcome, null, 'nadie le puso desenlace');
});

test('las guardas de identidad: tenant, cliente y reunión tienen que cuadrar los tres', async () => {
  const s = await seedFailedMeeting();
  const otro = randomUUID();

  for (const args of [
    ['--tenant-id', otro, '--client-id', s.clientId, '--meeting-id', s.meetingId],
    ['--tenant-id', s.tenantId, '--client-id', otro, '--meeting-id', s.meetingId],
    ['--tenant-id', s.tenantId, '--client-id', s.clientId, '--meeting-id', otro],
  ]) {
    const result = run([...args, '--execute']);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /\[meeting_not_found\]/);
  }
  assert.equal((await stateOf(s)).runs, 1);
});

test('sin los tres uuids, y sin la puerta de staging, no arranca', async () => {
  const s = await seedFailedMeeting();
  assert.equal(run(['--tenant-id', s.tenantId, '--execute']).status, 2);
  assert.equal(run(['--tenant-id', s.tenantId, '--client-id', s.clientId, '--execute']).status, 2);
  assert.match(run([...idArgs(s), '--execute'], guardEnv({ MEETINGS_ENV_KIND: 'production' })).stderr, /no es 'staging'/);
  assert.match(
    run([...idArgs(s), '--execute'], guardEnv({ MEETINGS_EXPECTED_DB_NAME: 'otra_base' })).stderr,
    /no es el declarado/,
  );
  assert.equal((await stateOf(s)).runs, 1, 'ninguna de esas pasadas escribió');
});

// ── Doble ejecución y concurrencia ──────────────────────────────────────────

test('ejecutarlo dos veces seguidas no crea dos runs activos', async () => {
  const s = await seedFailedMeeting();

  const first = run([...idArgs(s), '--execute']);
  assert.equal(first.status, 0, first.stderr);
  const second = run([...idArgs(s), '--execute']);

  // La segunda pasada ve el run que la primera dejó abierto y se niega. No es
  // un error del script: es la definición de «un reproceso a la vez».
  assert.equal(second.status, 2);
  assert.match(second.stderr, /\[run_active\]/);

  const after_ = await stateOf(s);
  assert.equal(after_.activeRuns, 1);
  assert.equal(after_.runs, 2);
  assert.equal(after_.normalizeJobs, 2);
  assert.equal(after_.queuedJobs, 1);
});

test('dos reprocesos SIMULTÁNEOS: uno gana, y nunca hay dos runs activos', async () => {
  const s = await seedFailedMeeting();
  const target = { tenantId: s.tenantId, clientId: s.clientId, meetingId: s.meetingId };

  // Dos transacciones de verdad, en paralelo, cada una con su cliente del pool.
  // El `FOR UPDATE` de `planReprocess` serializa: la segunda espera a que la
  // primera confirme, vuelve a leer y encuentra el run activo.
  const results = await Promise.allSettled([
    withTransaction((client) => applyReprocess(target, client as unknown as Queryable)),
    withTransaction((client) => applyReprocess(target, client as unknown as Queryable)),
  ]);

  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'exactamente una gana');
  assert.equal(failed.length, 1, 'y exactamente una pierde');

  const reason = (failed[0] as PromiseRejectedResult).reason as Error;
  assert.ok(
    reason instanceof ReprocessRefused || isUniqueViolation(reason),
    `la perdedora falla por la causa correcta, no por otra: ${reason.message}`,
  );

  const after_ = await stateOf(s);
  assert.equal(after_.activeRuns, 1, 'NUNCA dos runs activos');
  assert.equal(after_.runs, 2, 'la perdedora no dejó un run huérfano');
  assert.equal(after_.normalizeJobs, 2, 'ni un job de más');
  assert.equal(after_.queuedJobs, 1);
});

test('cinco reprocesos simultáneos: sigue habiendo uno', async () => {
  const s = await seedFailedMeeting();
  const target = { tenantId: s.tenantId, clientId: s.clientId, meetingId: s.meetingId };

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      withTransaction((client) => applyReprocess(target, client as unknown as Queryable)),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);

  const after_ = await stateOf(s);
  assert.equal(after_.activeRuns, 1);
  assert.equal(after_.runs, 2);
  assert.equal(after_.normalizeJobs, 2);
});

test('el índice único es la garantía real, no la comprobación de código', async () => {
  // Se salta `planReprocess` a propósito: dos INSERT de run directos y
  // simultáneos, sin lectura previa ni lock. Es el escenario que una
  // comprobación en código no puede cubrir, y el que el índice parcial
  // `runs_one_active_per_meeting_idx` existe para hacer imposible.
  const s = await seedFailedMeeting();
  const insertRun = (client: unknown): Promise<unknown> =>
    jobsRepo.createRun(
      {
        tenantId: s.tenantId,
        clientId: s.clientId,
        meetingId: s.meetingId,
        trigger: 'reprocess',
        requestedByUserId: null,
      },
      client as Queryable,
    );

  const results = await Promise.allSettled([
    withTransaction((client) => insertRun(client)),
    withTransaction((client) => insertRun(client)),
  ]);

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const reason = (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
  assert.ok(isUniqueViolation(reason), 'la base lo rechaza por violación de unicidad');

  const after_ = await stateOf(s);
  assert.equal(after_.activeRuns, 1);
});

// ── El plan y la escritura no pueden divergir ───────────────────────────────

test('planReprocess no escribe, y aplica las mismas condiciones que applyReprocess', async () => {
  const cancelada = await seedFailedMeeting({ cancelled: true });
  await assert.rejects(
    () => planReprocess(cancelada, { query } as unknown as Queryable),
    (error: Error) => error instanceof ReprocessRefused && error.code === 'meeting_cancelled',
  );

  const buena = await seedFailedMeeting();
  const before = await stateOf(buena);
  const plan = await planReprocess(buena, { query } as unknown as Queryable);
  assert.equal(plan.nextRunNumber, 2);
  assert.equal(plan.original.storage_key, buena.storageKey);
  assert.equal(plan.untouchedJobs.length, 1);
  assert.equal(plan.untouchedJobs[0].failureCode, 'worker_error');
  assert.deepEqual(await stateOf(buena), before, 'planificar no escribe');
});

test('importar el módulo no ejecuta el script', async () => {
  // `applyReprocess` se importa arriba. Si el módulo corriera `main()` al
  // importarse, esta suite habría intentado reprocesar con los argumentos del
  // corredor de pruebas y habría cerrado el pool a mitad.
  const alive = await query<{ ok: number }>(`SELECT 1 AS ok`);
  assert.equal(alive.rows[0].ok, 1, 'el pool sigue abierto');
});
