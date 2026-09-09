import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb } from './fixtures.js';
import { FakePrivateStore } from '../../src/storage/fakePrivateStore.js';
import { DEFAULT_MEDIA_LIMITS } from '../../src/meetings/mediaLimits.js';
import { RateLimiter } from '../../src/meetings/rateLimit.js';
import { MeetingsApiError } from '../../src/meetings/errors.js';
import {
  authenticateWorkerToken,
  mintWorkerToken,
  revokeCredential,
  type WorkerIdentity,
} from '../../src/db/repositories/meetings/credentials.js';
import * as jobsRepo from '../../src/db/repositories/meetings/jobs.js';
import * as artifactsRepo from '../../src/db/repositories/meetings/artifacts.js';
import {
  cancelMeeting,
  claim,
  createMeeting,
  fail,
  getMeetingState,
  heartbeat,
  requeueExpiredLeases,
  resultComplete,
  resultInit,
  uploadComplete,
  uploadInit,
  type ClaimedJob,
  type MeetingsServiceDeps,
} from '../../src/meetings/service.js';

/**
 * T-3 · el pipeline completo contra PostgreSQL DESECHABLE.
 *
 * Se prueba el servicio, no el HTTP. Lo que hay que demostrar es que el claim
 * es atómico, que un `complete` reenviado no ingiere dos veces, que un intento
 * viejo no gana sobre el actual y que el siguiente job nace en la misma
 * transacción que cierra el anterior. Nada de eso se ve mejor a través de un
 * servidor; sí se ve peor, porque habría que levantarlo en cada prueba.
 *
 * El almacenamiento es el fake, que hace cumplir caducidad, tamaño, checksum y
 * content-type igual que S3, y comparte con el adaptador real la función que
 * decide `confirm()`.
 */

const tenants: string[] = [];
after(async () => {
  for (const tenant of tenants) await cleanupTenant(tenant);
  await closeDb();
});

interface World {
  tenantId: string;
  clientId: string;
  otherClientId: string;
  otherTenantId: string;
  userId: string;
  store: FakePrivateStore;
  deps: MeetingsServiceDeps;
  identity: WorkerIdentity;
  token: string;
  credentialId: string;
  /** Credencial de un pool atado a OTRO tenant. */
  foreignIdentity: WorkerIdentity;
}

/** Un mundo aislado por prueba: tenant propio, pool propio, store propio. */
async function makeWorld(options?: { leaseSeconds?: number }): Promise<World> {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  tenants.push(tenantId, otherTenantId);
  await query(`INSERT INTO tenants (id, name) VALUES ($1, $2), ($3, $4)`, [
    tenantId,
    `T ${tenantId.slice(0, 8)}`,
    otherTenantId,
    `T ${otherTenantId.slice(0, 8)}`,
  ]);

  const mkClient = async (tenant: string, name: string): Promise<string> => {
    const result = await query<{ id: string }>(
      `INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, $2, false) RETURNING id`,
      [tenant, name],
    );
    return result.rows[0].id;
  };
  const clientId = await mkClient(tenantId, 'Cliente A');
  const otherClientId = await mkClient(tenantId, 'Cliente B');
  const foreignClientId = await mkClient(otherTenantId, 'Cliente ajeno');

  const userId = `u-${tenantId.slice(0, 8)}`;
  await query(
    `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Test', $2, true)`,
    [userId, `${userId}@example.test`],
  );

  const mkPool = async (tenant: string, slug: string): Promise<string> => {
    const result = await query<{ id: string }>(
      `INSERT INTO worker_pools
         (slug, environment, scope, tenant_id, capabilities, concurrency)
       VALUES ($1, 'development', 'single_tenant', $2,
               '{meetings.transcribe}',
               '{"schema_version":1,"limits":{"meetings.transcribe":1}}'::jsonb)
       RETURNING id`,
      [slug, tenant],
    );
    return result.rows[0].id;
  };
  const poolId = await mkPool(tenantId, `pool-${tenantId.slice(0, 8)}`);
  const foreignPoolId = await mkPool(otherTenantId, `pool-${otherTenantId.slice(0, 8)}`);

  const mkCredential = async (pool: string, label: string): Promise<{ token: string; id: string }> => {
    const minted = mintWorkerToken();
    const result = await query<{ id: string }>(
      `INSERT INTO worker_credentials (pool_id, label, token_hash, token_prefix)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [pool, label, minted.tokenHash, minted.tokenPrefix],
    );
    return { token: minted.token, id: result.rows[0].id };
  };
  const credential = await mkCredential(poolId, 'lan-gpu');
  const foreignCredential = await mkCredential(foreignPoolId, 'ajeno');

  const identity = await authenticateWorkerToken(credential.token);
  const foreignIdentity = await authenticateWorkerToken(foreignCredential.token);
  assert.ok(identity && foreignIdentity, 'las credenciales sembradas deben autenticar');

  const store = new FakePrivateStore();
  void foreignClientId;
  return {
    tenantId,
    clientId,
    otherClientId,
    otherTenantId,
    userId,
    store,
    deps: {
      store,
      limits: DEFAULT_MEDIA_LIMITS,
      leaseSeconds: options?.leaseSeconds ?? 300,
      // Un limitador POR MUNDO: el singleton del proceso haría que una prueba
      // agotara el cubo de la siguiente y los fallos serían por orden de
      // ejecución, no por lo que cada prueba afirma.
      rateLimiter: new RateLimiter({
        rules: {
          claim: { burst: 1000, refillPerSecond: 1000 },
          heartbeat: { burst: 1000, refillPerSecond: 1000 },
          result: { burst: 1000, refillPerSecond: 1000 },
        },
      }),
    },
    identity,
    token: credential.token,
    credentialId: credential.id,
    foreignIdentity,
  };
}

const AUDIO = Buffer.from('RIFF....WAVEfmt fake audio bytes para la prueba');
const NORMALIZED = Buffer.from('RIFF....WAVE 16k mono normalizado');

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function transcriptArtifact(segments = 3): Buffer {
  const lines = [
    JSON.stringify({
      schema: 'meetings.transcript',
      schema_version: 1,
      language: 'es',
      duration_seconds: 30,
      model: 'medium',
      device: 'cuda',
      compute_type: 'float16',
      segment_count: segments,
    }),
  ];
  for (let i = 0; i < segments; i += 1) {
    lines.push(
      JSON.stringify({
        i,
        start: i * 10,
        end: i * 10 + 9,
        text: `Segmento ${i}`,
        confidence: 0.9,
      }),
    );
  }
  return gzipSync(Buffer.from(`${lines.join('\n')}\n`));
}

function diarizationArtifact(): Buffer {
  const turns = [
    { start: 0, end: 9.5, speaker: 'SPEAKER_00' },
    { start: 9.5, end: 19.5, speaker: 'SPEAKER_01' },
    { start: 19.5, end: 30, speaker: 'SPEAKER_00' },
  ];
  const lines = [
    JSON.stringify({
      schema: 'meetings.diarization',
      schema_version: 1,
      backend: 'wespeaker',
      speaker_count: 2,
      turn_count: turns.length,
    }),
    ...turns.map((turn) => JSON.stringify(turn)),
  ];
  return gzipSync(Buffer.from(`${lines.join('\n')}\n`));
}

/** Sube por la URL firmada como lo hará el worker, y confirma. */
async function runStage(
  world: World,
  claimed: ClaimedJob,
  artifact: Buffer,
  probe?: { durationSeconds: number; sampleRate: number; channels: number; codec: string },
): Promise<Awaited<ReturnType<typeof resultComplete>>> {
  const checksum = sha(artifact);
  const signed = await resultInit(
    world.identity,
    {
      jobId: claimed.jobId,
      attempt: claimed.attempt,
      leaseToken: claimed.leaseToken,
      bytes: artifact.length,
      checksumSha256: checksum,
    },
    world.deps,
  );
  const put = world.store.put(signed.url, artifact, signed.requiredHeaders);
  assert.ok(put.ok, `la subida debía funcionar: ${JSON.stringify(put)}`);
  return resultComplete(
    world.identity,
    {
      jobId: claimed.jobId,
      attempt: claimed.attempt,
      leaseToken: claimed.leaseToken,
      bytes: artifact.length,
      checksumSha256: checksum,
      ...(probe ? { probe } : {}),
    },
    world.deps,
  );
}

/** Crea la reunión y sube el audio original: los pasos 1–3 del plan. */
async function seedMeetingWithMedia(world: World): Promise<{ meetingId: string; runId: string; jobId: string }> {
  const scope = { tenantId: world.tenantId, clientId: world.clientId, userId: world.userId };
  const created = await createMeeting(scope, {
    title: 'Kickoff',
    idempotencyKey: `k-${randomUUID()}`,
  });
  const init = await uploadInit(
    scope,
    created.meetingId,
    {
      filename: 'kickoff.wav',
      contentType: 'audio/wav',
      bytes: AUDIO.length,
      checksumSha256: sha(AUDIO),
    },
    world.deps,
  );
  const put = world.store.put(init.url, AUDIO, init.requiredHeaders);
  assert.ok(put.ok, JSON.stringify(put));
  const complete = await uploadComplete(
    scope,
    created.meetingId,
    { bytes: AUDIO.length, checksumSha256: sha(AUDIO) },
    world.deps,
  );
  return { meetingId: created.meetingId, runId: complete.runId, jobId: complete.firstJob.id };
}

async function expectApiError(
  fn: () => Promise<unknown>,
  code: string,
  label: string,
): Promise<MeetingsApiError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof MeetingsApiError, `${label}: se esperaba MeetingsApiError, vino ${error}`);
    assert.equal((error as MeetingsApiError).code, code, label);
    return error as MeetingsApiError;
  }
  throw new Error(`${label}: no lanzó (se esperaba ${code})`);
}

// ══════════════════════════════════════════════════════════════════════════
// 1–9 · El camino completo
// ══════════════════════════════════════════════════════════════════════════

test('el pipeline completo: crear, subir, normalize, transcribe, diarize, ingerir', async () => {
  const world = await makeWorld();
  const scope = { tenantId: world.tenantId, clientId: world.clientId, userId: world.userId };

  // 1–3 · reunión + subida + confirmación
  const { meetingId, runId, jobId } = await seedMeetingWithMedia(world);
  const afterUpload = await getMeetingState(scope, meetingId);
  assert.equal(afterUpload.mediaState, 'ready');

  // 4 · el primer job existe y es normalize, y NO están los otros tres
  const jobsAfterUpload = await jobsRepo.listJobsForMeeting(meetingId);
  assert.deepEqual(
    jobsAfterUpload.map((job) => `${job.stage}:${job.status}`),
    ['normalize:queued'],
    'la creación es SECUENCIAL: sólo normalize está en cola',
  );

  // 5 · el worker reclama y procesa normalize
  const normalizeJob = await claim(world.identity, { workerLabel: 'gpu-01' }, world.deps);
  assert.ok(normalizeJob);
  assert.equal(normalizeJob.jobId, jobId);
  assert.equal(normalizeJob.stage, 'normalize');
  assert.equal(normalizeJob.attempt, 1);
  assert.equal(normalizeJob.inputs.length, 1);
  assert.equal(normalizeJob.inputs[0].role, 'original');
  assert.equal(normalizeJob.inputs[0].checksumSha256, sha(AUDIO));
  assert.ok(normalizeJob.inputs[0].supportsRange);

  // El insumo se puede descargar por la URL firmada, con Range incluido.
  const download = world.store.get(normalizeJob.inputs[0].url);
  assert.ok(download.ok && download.bytes.equals(AUDIO));
  const partial = world.store.get(normalizeJob.inputs[0].url, { start: 0, end: 3 });
  assert.ok(partial.ok && partial.status === 206 && partial.bytes.toString() === 'RIFF');

  const normalizeDone = await runStage(world, normalizeJob, NORMALIZED, {
    durationSeconds: 30,
    sampleRate: 16000,
    channels: 1,
    codec: 'pcm_s16le',
  });

  // 6 · transcribe se creó al cerrar normalize, y sólo transcribe
  assert.deepEqual(normalizeDone.nextJob?.stage, 'transcribe');
  const jobsAfterNormalize = await jobsRepo.listJobsForMeeting(meetingId);
  assert.deepEqual(
    jobsAfterNormalize.map((job) => `${job.stage}:${job.status}`).sort(),
    ['normalize:succeeded', 'transcribe:queued'],
    'diarize NO existe todavía: su insumo aún no está',
  );

  const transcribeJob = await claim(world.identity, {}, world.deps);
  assert.ok(transcribeJob);
  assert.equal(transcribeJob.stage, 'transcribe');
  // Su insumo es el audio NORMALIZADO, no el original.
  assert.deepEqual(transcribeJob.inputs.map((input) => input.role), ['normalized']);
  const normalizedDownload = world.store.get(transcribeJob.inputs[0].url);
  assert.ok(normalizedDownload.ok && normalizedDownload.bytes.equals(NORMALIZED));

  const transcript = transcriptArtifact(3);
  const transcribeDone = await runStage(world, transcribeJob, transcript);
  assert.equal(transcribeDone.nextJob?.stage, 'diarize');
  assert.equal(transcribeDone.ingested, false, 'todavía NO se ingiere: la versión se escribe una vez');

  const stateMidway = await getMeetingState(scope, meetingId);
  assert.equal(stateMidway.transcriptState, 'running');
  assert.equal(stateMidway.activeTranscript, null);

  // 7 · diarize recibe DOS insumos: el audio normalizado y el transcript
  const diarizeJob = await claim(world.identity, {}, world.deps);
  assert.ok(diarizeJob);
  assert.equal(diarizeJob.stage, 'diarize');
  assert.deepEqual(diarizeJob.inputs.map((input) => input.role).sort(), ['normalized', 'transcript']);

  // 8 · al cerrar diarize se verifica todo y se ingiere
  const diarizeDone = await runStage(world, diarizeJob, diarizationArtifact());
  assert.equal(diarizeDone.ingested, true);
  assert.ok(diarizeDone.transcriptId);

  const final = await getMeetingState(scope, meetingId);
  assert.equal(final.transcriptState, 'ready');
  assert.equal(final.diarizationState, 'ready');
  assert.ok(final.activeTranscript);
  assert.equal(final.activeTranscript?.segmentCount, 3);
  assert.equal(final.activeTranscript?.whisperModel, 'medium');
  assert.equal(final.activeTranscript?.diarizationBackend, 'wespeaker');
  assert.equal(final.activeTranscript?.language, 'es');

  // Los hablantes se alinearon por mayor solape.
  const labels = final.activeTranscript?.speakers.map((speaker) => speaker.label).sort();
  assert.deepEqual(labels, ['SPEAKER_00', 'SPEAKER_01']);
  const segments = await query<{ segment_index: number; speaker_label: string | null }>(
    `SELECT segment_index, speaker_label FROM meeting_segments
      WHERE transcript_id = $1 ORDER BY segment_index`,
    [diarizeDone.transcriptId],
  );
  assert.deepEqual(
    segments.rows.map((row) => row.speaker_label),
    ['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00'],
  );

  // 9 · la versión activa pertenece a ESTA reunión y a ESTE run
  const version = await query<{ meeting_id: string; run_id: string }>(
    `SELECT meeting_id, run_id FROM meeting_transcript_versions WHERE id = $1`,
    [diarizeDone.transcriptId],
  );
  assert.equal(version.rows[0].meeting_id, meetingId);
  assert.equal(version.rows[0].run_id, runId);

  // El run cerró con éxito y todos los artefactos quedaron ingeridos.
  const run = await query<{ outcome: string }>(
    `SELECT outcome FROM meeting_processing_runs WHERE id = $1`,
    [runId],
  );
  assert.equal(run.rows[0].outcome, 'succeeded');
  const uploads = await artifactsRepo.findVerifiedForRun(runId);
  assert.equal(uploads.length, 3);
  assert.ok(uploads.every((upload) => upload.state === 'ingested'));
  assert.deepEqual(
    uploads.map((upload) => upload.kind).sort(),
    ['diarization', 'normalized_media', 'transcript'],
  );
});

// ══════════════════════════════════════════════════════════════════════════
// 10 · Worker muerto y recuperación del lease
// ══════════════════════════════════════════════════════════════════════════

test('un worker muerto pierde el lease y el job vuelve a la cola', async () => {
  const world = await makeWorld({ leaseSeconds: 1 });
  const { meetingId } = await seedMeetingWithMedia(world);

  const first = await claim(world.identity, { workerLabel: 'el-que-muere' }, world.deps);
  assert.ok(first);
  assert.equal(first.attempt, 1);

  // Mientras el lease vive, nadie más puede reclamarlo.
  assert.equal(await claim(world.identity, {}, world.deps), null, 'el job está tomado');

  // El worker muere: no hay más latidos. Se fuerza la caducidad en vez de
  // esperar, para que la prueba no dependa del reloj.
  await query(
    `UPDATE meeting_processing_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [first.jobId],
  );
  // Se afirma sobre ESTE job, no sobre el recuento global: el barrido es global
  // y otras pruebas de este fichero dejan leases de 1 segundo que también caen
  // en la misma llamada. Una aserción sobre el total depende del orden de
  // ejecución, que es exactamente lo que no debe medir una prueba.
  const sweep = await requeueExpiredLeases();
  const swept = sweep.jobs.find((entry) => entry.id === first.jobId);
  assert.ok(swept, 'el job caducado entró en el barrido');
  assert.equal(swept?.status, 'queued');

  // Y ahora otro (o el mismo) worker lo recoge, con el intento SIGUIENTE.
  const second = await claim(world.identity, { workerLabel: 'el-que-recoge' }, world.deps);
  assert.ok(second);
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.attempt, 2, 'el intento avanza: no es el mismo trabajo');
  assert.notEqual(second.leaseToken, first.leaseToken);

  // El token del muerto ya no vale para nada.
  await expectApiError(
    () =>
      heartbeat(
        world.identity,
        { jobId: first.jobId, attempt: first.attempt, leaseToken: first.leaseToken },
        world.deps,
      ),
    'attempt_stale',
    'el latido del worker muerto',
  );
  void meetingId;
});

test('agotados los intentos, el lease caducado deja el job en abandoned y no en failed', async () => {
  const world = await makeWorld({ leaseSeconds: 1 });
  const { meetingId } = await seedMeetingWithMedia(world);
  // Acotado a ESTA reunión: un UPDATE global tocaría jobs de otras pruebas del
  // mismo fichero, cuyos `attempts` ya pueden superar 1, y violaría
  // `jobs_attempts_bounded`.
  await query(`UPDATE meeting_processing_jobs SET max_attempts = 1 WHERE meeting_id = $1`, [meetingId]);

  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  await query(
    `UPDATE meeting_processing_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [claimed.jobId],
  );
  const sweep = await requeueExpiredLeases();
  assert.ok(
    sweep.jobs.some((entry) => entry.id === claimed.jobId && entry.status === 'abandoned'),
    'este job concreto quedó abandoned',
  );
  const job = await jobsRepo.getJobById(claimed.jobId);
  // 'abandoned' y no 'failed': "nadie volvió a decir nada" es un problema
  // distinto de "se intentó y no salió", y distinguirlos permite alertar sobre
  // workers que se caen.
  assert.equal(job?.status, 'abandoned');
  assert.equal(job?.failure_code, 'lease_expired');
});

// ══════════════════════════════════════════════════════════════════════════
// 11 · Credencial revocada
// ══════════════════════════════════════════════════════════════════════════

test('una credencial revocada no autentica, y por tanto no reclama ni completa', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);

  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);

  assert.ok(await revokeCredential(
    world.credentialId,
    { kind: 'system', process: 'leak-response' },
    'secreto filtrado',
  ));

  // La autenticación deja de funcionar: ni claim, ni heartbeat, ni complete,
  // porque ninguno llega a ejecutarse sin identidad.
  assert.equal(await authenticateWorkerToken(world.token), null);

  // Y el job que sostenía sigue en pie con su atribución: revocar no borra.
  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.equal(job?.status, 'leased');
  assert.equal(job?.leased_credential_id, world.credentialId);
  assert.ok(job?.leased_credential_label);

  // La credencial no se puede BORRAR mientras el job la referencie (RESTRICT).
  await assert.rejects(
    () => query(`DELETE FROM worker_credentials WHERE id = $1`, [world.credentialId]),
    /jobs_credential_fkey/,
  );
});

test('revocar y requeuear devuelve el job a la cola limpio', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);

  await query('BEGIN');
  await query(
    `UPDATE worker_credentials SET revoked_at = now(), revoked_actor = 'system',
            revoked_actor_label = 'lease-sweep', revoked_reason = 'requeue'
      WHERE id = $1`,
    [world.credentialId],
  );
  await query(
    `UPDATE meeting_processing_jobs
        SET status = 'queued', lease_token_hash = NULL, lease_expires_at = NULL,
            leased_credential_id = NULL, leased_credential_label = NULL,
            next_attempt_at = now()
      WHERE leased_credential_id = $1 AND status IN ('leased','uploading_result')`,
    [world.credentialId],
  );
  await query('COMMIT');

  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.equal(job?.status, 'queued');
  assert.equal(job?.lease_token_hash, null);
  assert.equal(job?.leased_credential_id, null);
  assert.equal(job?.leased_credential_label, null);
  // `attempts` NO se incrementa en el requeue: lo cuenta el claim. Sumarlo aquí
  // gastaría dos intentos por una sola caída de worker.
  assert.equal(job?.attempts, 1, 'el intento lo contó el claim, no el requeue');

  // El JOB ya no la referencia, pero el LOG DE AUDITORÍA sí: el evento
  // 'claimed' guarda su credential_id y esa FK también es RESTRICT. Así que el
  // borrado físico sigue bloqueado, y eso es el diseño y no un residuo:
  // "las credenciales utilizadas por jobs o eventos no deben borrarse durante la
  // operación normal". Purgarlas de verdad es una operación de retención sobre
  // la auditoría, no un paso del requeue.
  await assert.rejects(
    () => query(`DELETE FROM worker_credentials WHERE id = $1`, [world.credentialId]),
    /job_events_credential_fkey/,
  );
  const events = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM meeting_job_events WHERE credential_id = $1`,
    [world.credentialId],
  );
  assert.ok(Number(events.rows[0].n) > 0, 'la atribución del intento vive en los eventos');
});

// ══════════════════════════════════════════════════════════════════════════
// 12 · Idempotencia
// ══════════════════════════════════════════════════════════════════════════

test('reenviar result/complete es idempotente y no ingiere dos veces', async () => {
  const world = await makeWorld();
  const { meetingId, runId } = await seedMeetingWithMedia(world);

  const normalizeJob = await claim(world.identity, {}, world.deps);
  assert.ok(normalizeJob);
  await runStage(world, normalizeJob, NORMALIZED);
  const transcribeJob = await claim(world.identity, {}, world.deps);
  assert.ok(transcribeJob);
  await runStage(world, transcribeJob, transcriptArtifact(2));
  const diarizeJob = await claim(world.identity, {}, world.deps);
  assert.ok(diarizeJob);

  const artifact = diarizationArtifact();
  const first = await runStage(world, diarizeJob, artifact);
  assert.equal(first.ingested, true);

  // El mismo complete otra vez, con los mismos valores.
  const again = await resultComplete(
    world.identity,
    {
      jobId: diarizeJob.jobId,
      attempt: diarizeJob.attempt,
      leaseToken: diarizeJob.leaseToken,
      bytes: artifact.length,
      checksumSha256: sha(artifact),
    },
    world.deps,
  );
  assert.equal(again.status, 'succeeded');
  assert.equal(again.transcriptId, first.transcriptId, 'la misma versión, no otra');

  // Y en la base sigue habiendo UNA versión y UN juego de segmentos.
  const versions = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM meeting_transcript_versions WHERE run_id = $1`,
    [runId],
  );
  assert.equal(versions.rows[0].n, '1');
  const segments = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM meeting_segments WHERE transcript_id = $1`,
    [first.transcriptId],
  );
  assert.equal(segments.rows[0].n, '2');
  void meetingId;
});

test('reenviar result/init devuelve la MISMA clave con una URL nueva', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);

  const proof = { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken };
  const payload = { bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED) };
  const first = await resultInit(world.identity, { ...proof, ...payload }, world.deps);
  const second = await resultInit(world.identity, { ...proof, ...payload }, world.deps);

  assert.equal(second.storageKey, first.storageKey, 'la clave es determinista');
  assert.notEqual(second.url, first.url, 'la URL se renueva');
  // Y sigue habiendo UNA fila de artefacto.
  const uploads = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM meeting_result_uploads WHERE job_id = $1`,
    [claimed.jobId],
  );
  assert.equal(uploads.rows[0].n, '1');
});

test('crear la reunión con la misma clave de idempotencia no crea otra', async () => {
  const world = await makeWorld();
  const scope = { tenantId: world.tenantId, clientId: world.clientId, userId: world.userId };
  const key = `k-${randomUUID()}`;
  const first = await createMeeting(scope, { title: 'A', idempotencyKey: key });
  const second = await createMeeting(scope, { title: 'Otro título', idempotencyKey: key });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.meetingId, first.meetingId);
  // El título NO se sobrescribe: la reunión es de quien la creó primero.
  const state = await getMeetingState(scope, first.meetingId);
  assert.equal(state.title, 'A');
});

test('reenviar fail es idempotente', async () => {
  const world = await makeWorld();
  const { meetingId } = await seedMeetingWithMedia(world);
  await query(`UPDATE meeting_processing_jobs SET max_attempts = 1 WHERE meeting_id = $1`, [meetingId]);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);

  const proof = { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken };
  const first = await fail(world.identity, { ...proof, failureCode: 'ffmpeg_crash' }, world.deps);
  assert.equal(first.requeued, false);
  assert.equal(first.status, 'failed');
  const again = await fail(world.identity, { ...proof, failureCode: 'ffmpeg_crash' }, world.deps);
  assert.equal(again.status, 'failed');
  assert.equal(again.requeued, false);
});

// ══════════════════════════════════════════════════════════════════════════
// 13 · Lease, intento y checksum incorrectos
// ══════════════════════════════════════════════════════════════════════════

test('un token de lease inventado no sirve', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  await expectApiError(
    () =>
      heartbeat(
        world.identity,
        { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: 'mlt_inventado' },
        world.deps,
      ),
    'lease_invalid',
    'token inventado',
  );
});

test('el token de un job NO sirve para otro job', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  const first = await claim(world.identity, {}, world.deps);
  assert.ok(first);
  await runStage(world, first, NORMALIZED);
  const second = await claim(world.identity, {}, world.deps);
  assert.ok(second);

  // El token del segundo job, presentado para el primero: el binding incluye el
  // jobId, así que no verifica.
  await expectApiError(
    () =>
      heartbeat(
        world.identity,
        { jobId: first.jobId, attempt: first.attempt, leaseToken: second.leaseToken },
        world.deps,
      ),
    'invalid_transition',
    'token cruzado sobre un job ya cerrado',
  );
});

test('un intento anterior no puede ganar sobre el actual', async () => {
  const world = await makeWorld({ leaseSeconds: 1 });
  await seedMeetingWithMedia(world);

  const stale = await claim(world.identity, {}, world.deps);
  assert.ok(stale);
  // El artefacto del intento 1 se sube de verdad: el escenario es un worker
  // colgado que revive DESPUÉS de que otro tomara el relevo.
  const staleInit = await resultInit(
    world.identity,
    {
      jobId: stale.jobId,
      attempt: stale.attempt,
      leaseToken: stale.leaseToken,
      bytes: NORMALIZED.length,
      checksumSha256: sha(NORMALIZED),
    },
    world.deps,
  );
  assert.ok(world.store.put(staleInit.url, NORMALIZED, staleInit.requiredHeaders).ok);

  await query(
    `UPDATE meeting_processing_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [stale.jobId],
  );
  await requeueExpiredLeases();
  const current = await claim(world.identity, {}, world.deps);
  assert.ok(current);
  assert.equal(current.attempt, stale.attempt + 1);

  // El muerto revive y manda su complete. Rechazado por intento obsoleto.
  await expectApiError(
    () =>
      resultComplete(
        world.identity,
        {
          jobId: stale.jobId,
          attempt: stale.attempt,
          leaseToken: stale.leaseToken,
          bytes: NORMALIZED.length,
          checksumSha256: sha(NORMALIZED),
        },
        world.deps,
      ),
    'attempt_stale',
    'complete de un intento viejo',
  );

  // Y su artefacto no se ingirió: la clave del intento 1 es OTRA, así que ni
  // siquiera pisó la del intento en curso.
  assert.notEqual(
    staleInit.storageKey,
    (
      await resultInit(
        world.identity,
        {
          jobId: current.jobId,
          attempt: current.attempt,
          leaseToken: current.leaseToken,
          bytes: NORMALIZED.length,
          checksumSha256: sha(NORMALIZED),
        },
        world.deps,
      )
    ).storageKey,
  );
});

test('un checksum que no cuadra rechaza el artefacto y no cierra la etapa', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);

  const proof = { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken };
  const signed = await resultInit(
    world.identity,
    { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED) },
    world.deps,
  );
  assert.ok(world.store.put(signed.url, NORMALIZED, signed.requiredHeaders).ok);

  // El objeto se corrompe conservando el tamaño: sólo el checksum lo detecta.
  assert.ok(world.store.corrupt(signed.storageKey));
  await expectApiError(
    () =>
      resultComplete(
        world.identity,
        { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED) },
        world.deps,
      ),
    'checksum_mismatch',
    'objeto corrupto',
  );

  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.notEqual(job?.status, 'succeeded', 'la etapa NO se cierra con un artefacto corrupto');
  const upload = await artifactsRepo.findUpload(claimed.jobId, claimed.attempt, 'normalized_media');
  assert.equal(upload?.state, 'rejected');
  assert.equal(upload?.reject_code, 'checksum_mismatch');
  assert.ok(upload?.rejected_at);
});

test('un tamaño que no cuadra se rechaza como size_mismatch', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  const proof = { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken };
  const signed = await resultInit(
    world.identity,
    { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED) },
    world.deps,
  );
  assert.ok(world.store.put(signed.url, NORMALIZED, signed.requiredHeaders).ok);
  // Se declara otro tamaño en el complete.
  await expectApiError(
    () =>
      resultComplete(
        world.identity,
        { ...proof, bytes: NORMALIZED.length + 10, checksumSha256: sha(NORMALIZED) },
        world.deps,
      ),
    'size_mismatch',
    'tamaño declarado distinto',
  );
});

test('un complete sin objeto subido se rechaza como object_missing', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  const proof = { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken };
  await resultInit(
    world.identity,
    { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED) },
    world.deps,
  );
  // Nunca se sube nada.
  await expectApiError(
    () =>
      resultComplete(
        world.identity,
        { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED) },
        world.deps,
      ),
    'object_missing',
    'sin objeto',
  );
});

test('un artefacto malformado o con schema_version desconocida se rechaza', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  const normalizeJob = await claim(world.identity, {}, world.deps);
  assert.ok(normalizeJob);
  await runStage(world, normalizeJob, NORMALIZED);
  const transcribeJob = await claim(world.identity, {}, world.deps);
  assert.ok(transcribeJob);

  // La cabecera declara 5 segmentos y hay 2: es el caso del NDJSON truncado
  // cuyo checksum sí cuadra porque se subió ya truncado.
  const lines = [
    JSON.stringify({
      schema: 'meetings.transcript',
      schema_version: 1,
      duration_seconds: 30,
      model: 'medium',
      segment_count: 5,
    }),
    JSON.stringify({ i: 0, start: 0, end: 1, text: 'a' }),
    JSON.stringify({ i: 1, start: 1, end: 2, text: 'b' }),
  ];
  const truncated = gzipSync(Buffer.from(`${lines.join('\n')}\n`));
  await expectApiError(
    () => runStage(world, transcribeJob, truncated),
    'artifact_malformed',
    'transcript truncado',
  );

  // Y una versión de esquema que mai no sabe leer.
  const future = gzipSync(
    Buffer.from(
      `${JSON.stringify({
        schema: 'meetings.transcript',
        schema_version: 99,
        duration_seconds: 1,
        model: 'm',
        segment_count: 0,
      })}\n`,
    ),
  );
  await expectApiError(
    () => runStage(world, transcribeJob, future),
    'unsupported_schema_version',
    'schema_version futura',
  );
});

// ══════════════════════════════════════════════════════════════════════════
// 14 · Aislamiento entre tenants y clientes
// ══════════════════════════════════════════════════════════════════════════

test('un pool de otro tenant no puede reclamar trabajo ajeno', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  // El pool ajeno está atado a otro tenant: el WHERE del claim lo excluye.
  assert.equal(await claim(world.foreignIdentity, {}, world.deps), null);
  // Y el propio sí lo ve, así que la ausencia no es "no hay trabajo".
  assert.ok(await claim(world.identity, {}, world.deps));
});

test('una credencial que no sostiene el lease recibe 404, no 403', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  // Decir "existe pero no es tuyo" le confirmaría a otro tenant que el uuid es
  // real. El 404 es indistinguible de un job inexistente.
  await expectApiError(
    () =>
      heartbeat(
        world.foreignIdentity,
        { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken },
        world.deps,
      ),
    'not_found',
    'credencial ajena sobre un job real',
  );
  await expectApiError(
    () => heartbeat(world.identity, { jobId: randomUUID(), attempt: 1, leaseToken: 'x' }, world.deps),
    'not_found',
    'job inexistente',
  );
});

test('la reunión de un cliente no se ve desde otro cliente del mismo tenant', async () => {
  const world = await makeWorld();
  const { meetingId } = await seedMeetingWithMedia(world);
  await expectApiError(
    () =>
      getMeetingState(
        { tenantId: world.tenantId, clientId: world.otherClientId, userId: world.userId },
        meetingId,
      ),
    'not_found',
    'lectura desde otro cliente',
  );
  // Y tampoco se puede subir a ella desde el otro cliente.
  await expectApiError(
    () =>
      uploadInit(
        { tenantId: world.tenantId, clientId: world.otherClientId },
        meetingId,
        { filename: 'x.wav', contentType: 'audio/wav', bytes: 10 },
        world.deps,
      ),
    'not_found',
    'upload-init desde otro cliente',
  );
});

test('las claves de almacenamiento están separadas por tenant y cliente', async () => {
  const world = await makeWorld();
  const { meetingId } = await seedMeetingWithMedia(world);
  const keys = world.store.keys();
  assert.equal(keys.length, 1);
  assert.ok(keys[0].startsWith(`t/${world.tenantId}/c/${world.clientId}/m/${meetingId}/`), keys[0]);
});

// ══════════════════════════════════════════════════════════════════════════
// Límites, validación y fallo parcial
// ══════════════════════════════════════════════════════════════════════════

test('los límites de medios se aplican en upload-init con códigos estables', async () => {
  const world = await makeWorld();
  const scope = { tenantId: world.tenantId, clientId: world.clientId, userId: world.userId };
  const created = await createMeeting(scope, { title: 'X', idempotencyKey: `k-${randomUUID()}` });

  for (const [candidate, label] of [
    [{ filename: 'x.exe', contentType: 'audio/wav', bytes: 10 }, 'extensión'],
    [{ filename: 'x.wav', contentType: 'text/html', bytes: 10 }, 'MIME'],
    [{ filename: 'x.wav', contentType: 'audio/wav', bytes: 0 }, 'vacío'],
    [
      { filename: 'x.wav', contentType: 'audio/wav', bytes: DEFAULT_MEDIA_LIMITS.maxBytes + 1 },
      'demasiado grande',
    ],
  ] as const) {
    await expectApiError(
      () => uploadInit(scope, created.meetingId, candidate, world.deps),
      'media_rejected',
      label,
    );
  }
});

test('el navegador no puede elegir la clave: no hay forma de pasarla', async () => {
  const world = await makeWorld();
  const scope = { tenantId: world.tenantId, clientId: world.clientId, userId: world.userId };
  const created = await createMeeting(scope, { title: 'X', idempotencyKey: `k-${randomUUID()}` });
  // Un nombre con traversal: se usa sólo para leer la extensión.
  const init = await uploadInit(
    scope,
    created.meetingId,
    { filename: '../../../etc/passwd.wav', contentType: 'audio/wav', bytes: 10 },
    world.deps,
  );
  assert.equal(
    init.storageKey,
    `t/${world.tenantId}/c/${world.clientId}/m/${created.meetingId}/original/source`,
  );
  assert.ok(!init.storageKey.includes('..'));
  assert.ok(!init.storageKey.includes('passwd'));
});

test('diarize fallido ingiere el transcript y deja la reunión con avisos', async () => {
  const world = await makeWorld();
  const scope = { tenantId: world.tenantId, clientId: world.clientId, userId: world.userId };
  const { meetingId, runId } = await seedMeetingWithMedia(world);

  const normalizeJob = await claim(world.identity, {}, world.deps);
  assert.ok(normalizeJob);
  await runStage(world, normalizeJob, NORMALIZED);
  const transcribeJob = await claim(world.identity, {}, world.deps);
  assert.ok(transcribeJob);
  await runStage(world, transcribeJob, transcriptArtifact(3));

  await query(
    `UPDATE meeting_processing_jobs SET max_attempts = 1 WHERE meeting_id = $1 AND stage = 'diarize'`,
    [meetingId],
  );
  const diarizeJob = await claim(world.identity, {}, world.deps);
  assert.ok(diarizeJob);
  const outcome = await fail(
    world.identity,
    {
      jobId: diarizeJob.jobId,
      attempt: diarizeJob.attempt,
      leaseToken: diarizeJob.leaseToken,
      failureCode: 'pyannote_oom',
    },
    world.deps,
  );
  assert.equal(outcome.requeued, false);

  const state = await getMeetingState(scope, meetingId);
  assert.equal(state.transcriptState, 'ready', 'el texto se ingiere igual');
  assert.equal(state.diarizationState, 'failed');
  assert.ok(state.activeTranscript, 'hay versión activa');
  assert.equal(state.activeTranscript?.diarizationBackend, null);
  assert.equal(state.activeTranscript?.speakers.length, 0, 'sin participantes identificados');
  assert.equal(state.warnings.length, 1);
  assert.equal((state.warnings[0] as { code: string }).code, 'diarization_failed');

  const run = await query<{ outcome: string }>(
    `SELECT outcome FROM meeting_processing_runs WHERE id = $1`,
    [runId],
  );
  assert.equal(run.rows[0].outcome, 'partial');

  // Los segmentos existen y no tienen etiqueta: es "sin identificar", no vacío.
  const segments = await query<{ speaker_label: string | null }>(
    `SELECT speaker_label FROM meeting_segments WHERE transcript_id = $1`,
    [state.activeTranscript?.id],
  );
  assert.equal(segments.rows.length, 3);
  assert.ok(segments.rows.every((row) => row.speaker_label === null));
});

test('normalize fallido hunde el run: sin audio no hay nada que transcribir', async () => {
  const world = await makeWorld();
  const scope = { tenantId: world.tenantId, clientId: world.clientId, userId: world.userId };
  const { meetingId, runId } = await seedMeetingWithMedia(world);
  await query(`UPDATE meeting_processing_jobs SET max_attempts = 1 WHERE meeting_id = $1`, [meetingId]);

  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  await fail(
    world.identity,
    {
      jobId: claimed.jobId,
      attempt: claimed.attempt,
      leaseToken: claimed.leaseToken,
      failureCode: 'audio_unreadable',
    },
    world.deps,
  );

  const state = await getMeetingState(scope, meetingId);
  assert.equal(state.transcriptState, 'failed');
  assert.equal(state.activeTranscript, null);
  const run = await query<{ outcome: string }>(
    `SELECT outcome FROM meeting_processing_runs WHERE id = $1`,
    [runId],
  );
  assert.equal(run.rows[0].outcome, 'failed');
  // Y no se creó transcribe: su insumo no existe.
  const jobs = await jobsRepo.listJobsForMeeting(meetingId);
  assert.deepEqual(jobs.map((job) => job.stage), ['normalize']);
});

test('un fallo con intentos restantes vuelve a la cola con backoff', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  const outcome = await fail(
    world.identity,
    {
      jobId: claimed.jobId,
      attempt: claimed.attempt,
      leaseToken: claimed.leaseToken,
      failureCode: 'transient',
    },
    world.deps,
  );
  assert.equal(outcome.requeued, true);
  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.equal(job?.status, 'queued');
  assert.ok(job && job.next_attempt_at.getTime() > Date.now(), 'el backoff aplaza el reintento');
  // Y por tanto no es reclamable ahora mismo.
  assert.equal(await claim(world.identity, {}, world.deps), null);
});

// ══════════════════════════════════════════════════════════════════════════
// Cancelación, concurrencia y límites de tasa
// ══════════════════════════════════════════════════════════════════════════

test('cancelar marca los jobs y el worker se entera en el siguiente latido', async () => {
  const world = await makeWorld();
  const scope = { tenantId: world.tenantId, clientId: world.clientId, userId: world.userId };
  const { meetingId } = await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);

  const beat = await heartbeat(
    world.identity,
    { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken },
    world.deps,
  );
  assert.equal(beat.cancelled, false);

  const cancellation = await cancelMeeting(scope, meetingId);
  assert.equal(cancellation.cancelled, true);
  assert.equal(cancellation.jobsCancelled, 1);

  // La señal viaja en la respuesta del latido: es lo único que el worker
  // consulta durante un trabajo largo.
  await expectApiError(
    () =>
      heartbeat(
        world.identity,
        { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken },
        world.deps,
      ),
    'invalid_transition',
    'latido sobre un job cancelado',
  );
  const state = await getMeetingState(scope, meetingId);
  assert.ok(state.cancelledAt);
});

test('dos claims concurrentes no se llevan el mismo job', async () => {
  const world = await makeWorld();
  // Tres reuniones, tres jobs normalize en cola.
  await seedMeetingWithMedia(world);
  await seedMeetingWithMedia(world);
  await seedMeetingWithMedia(world);

  const claims = await Promise.all([
    claim(world.identity, { workerLabel: 'a' }, world.deps),
    claim(world.identity, { workerLabel: 'b' }, world.deps),
    claim(world.identity, { workerLabel: 'c' }, world.deps),
  ]);
  const ids = claims.filter((job): job is ClaimedJob => job !== null).map((job) => job.jobId);
  assert.equal(ids.length, 3, 'los tres consiguieron trabajo');
  assert.equal(new Set(ids).size, 3, 'y ninguno el mismo: SKIP LOCKED');
  // Un cuarto no encuentra nada.
  assert.equal(await claim(world.identity, {}, world.deps), null);
});

test('el límite de tasa frena un bucle de claim y dice cuándo reintentar', async () => {
  const world = await makeWorld();
  const limited: MeetingsServiceDeps = {
    ...world.deps,
    rateLimiter: new RateLimiter({ rules: { claim: { burst: 2, refillPerSecond: 0.1 } } }),
  };
  await seedMeetingWithMedia(world);
  await claim(world.identity, {}, limited);
  await claim(world.identity, {}, limited);
  const error = await expectApiError(() => claim(world.identity, {}, limited), 'rate_limited', 'tercer claim');
  assert.ok(Number(error.headers['retry-after']) >= 1, 'Retry-After nunca invita a reintentar ya');
});

test('el worker puede pedir MENOS capacidades de las que tiene, nunca más', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  // Pide sólo analyze, que su credencial no tiene: no obtiene nada.
  assert.equal(await claim(world.identity, { capabilities: ['meetings.analyze'] }, world.deps), null);
  // Pide transcribe, que sí tiene.
  assert.ok(await claim(world.identity, { capabilities: ['meetings.transcribe'] }, world.deps));
});

test('el estado de la UI describe el pipeline sin exponer nada del almacenamiento', async () => {
  const world = await makeWorld();
  const scope = { tenantId: world.tenantId, clientId: world.clientId, userId: world.userId };
  const { meetingId } = await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  await runStage(world, claimed, NORMALIZED);

  const state = await getMeetingState(scope, meetingId);
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes('X-Amz'), 'ninguna URL firmada');
  assert.ok(!serialized.includes('fake-private.local'), 'ninguna URL de almacenamiento');
  assert.ok(!serialized.includes('mlt_'), 'ningún token de lease');
  assert.ok(!serialized.includes(world.token), 'ningún token de worker');
  assert.deepEqual(
    state.jobs.map((job) => `${job.stage}:${job.status}`).sort(),
    ['normalize:succeeded', 'transcribe:queued'],
  );
  assert.ok(state.events.length > 0, 'la auditoría se puede leer');
});
