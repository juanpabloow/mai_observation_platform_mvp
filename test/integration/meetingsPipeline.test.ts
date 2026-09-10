import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { query, withTransaction } from '../../src/db/client.js';
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
import * as transcriptsRepo from '../../src/db/repositories/meetings/transcripts.js';
import {
  alignSegments,
  parseDiarizationArtifact,
  parseTranscriptArtifact,
} from '../../src/meetings/artifacts.js';
import * as artifactsRepo from '../../src/db/repositories/meetings/artifacts.js';
import * as meetingsRepo from '../../src/db/repositories/meetings/meetings.js';
import {
  NORMALIZED_AUDIO,
  type MediaProbe,
} from '../../src/meetings/normalizedAudio.js';
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
  /** Credencial CON `meetings.maintenance`, para el barrido global. */
  maintenanceIdentity: WorkerIdentity;
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
  // Un pool SÓLO de mantenimiento: sin capacidades reclamables, así que su
  // 'concurrency' no lleva límites — que es lo que la coherencia permite ahora
  // que 'meetings.maintenance' no es reclamable.
  //
  // Y su scope es 'internal', no 'single_tenant': la base ya no admite lo
  // segundo (`pools_scope_allows_capabilities`). Ser interno obliga además a
  // dejar rastro de quién lo autorizó y a no tener tenant, que es justo lo que
  // hace de este pool algo distinto de una credencial de trabajo.
  const maintenancePool = await query<{ id: string }>(
    `INSERT INTO worker_pools
       (slug, environment, scope, capabilities, concurrency,
        internal_authorized_actor_label, internal_authorized_at)
     VALUES ($1, 'development', 'internal',
             '{meetings.maintenance}',
             '{"schema_version":1,"limits":{}}'::jsonb,
             'suite <suite@example.test>', now())
     RETURNING id`,
    [`maint-${tenantId.slice(0, 8)}`],
  );

  const credential = await mkCredential(poolId, 'lan-gpu');
  const foreignCredential = await mkCredential(foreignPoolId, 'ajeno');
  const maintenanceCredential = await mkCredential(maintenancePool.rows[0].id, 'mantenimiento');

  const identity = await authenticateWorkerToken(credential.token);
  const foreignIdentity = await authenticateWorkerToken(foreignCredential.token);
  const maintenanceIdentity = await authenticateWorkerToken(maintenanceCredential.token);
  assert.ok(
    identity && foreignIdentity && maintenanceIdentity,
    'las credenciales sembradas deben autenticar',
  );

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
    maintenanceIdentity,
  };
}

/** El sondeo que el formato pactado exige. Cualquier otro se rechaza. */
const VALID_PROBE: MediaProbe = {
  durationSeconds: 12.5,
  sampleRate: NORMALIZED_AUDIO.sampleRate,
  channels: NORMALIZED_AUDIO.channels,
  codec: NORMALIZED_AUDIO.codec,
};

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
  probe?: MediaProbe,
): Promise<Awaited<ReturnType<typeof resultComplete>>> {
  const checksum = sha(artifact);
  // El sondeo lo decide la ETAPA, no quien llama: `normalize` lo exige y las
  // otras dos lo prohíben. Antes este helper lo dejaba pasar tal cual, y por
  // eso todas las pruebas que cerraban `normalize` sin sondeo funcionaban — el
  // helper reproducía el hueco del servicio.
  const effectiveProbe = claimed.stage === 'normalize' ? (probe ?? VALID_PROBE) : undefined;
  assert.ok(
    claimed.stage === 'normalize' || probe === undefined,
    `runStage: la etapa '${claimed.stage}' no admite sondeo`,
  );
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
      ...(effectiveProbe ? { probe: effectiveProbe } : {}),
    },
    world.deps,
  );
}

/** Crea la reunión y sube el audio original: los pasos 1–3 del plan. */
async function seedMeetingWithMedia(
  world: World,
  options: { speakerCount?: number | null } = {},
): Promise<{ meetingId: string; runId: string; jobId: string }> {
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
    {
      bytes: AUDIO.length,
      checksumSha256: sha(AUDIO),
      ...(options.speakerCount === undefined ? {} : { speakerCount: options.speakerCount }),
    },
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
  const sweep = await requeueExpiredLeases(world.maintenanceIdentity);
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
  const sweep = await requeueExpiredLeases(world.maintenanceIdentity);
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
  await requeueExpiredLeases(world.maintenanceIdentity);
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
          probe: VALID_PROBE,
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
        { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED), probe: VALID_PROBE },
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
        { ...proof, bytes: NORMALIZED.length + 10, checksumSha256: sha(NORMALIZED), probe: VALID_PROBE },
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
        { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED), probe: VALID_PROBE },
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

// ══════════════════════════════════════════════════════════════════════════
// Mantenimiento global: aislado por capacidad
// ══════════════════════════════════════════════════════════════════════════

test('una credencial de proceso NO puede ejecutar el barrido global', async () => {
  const world = await makeWorld({ leaseSeconds: 1 });
  const { meetingId } = await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  await query(
    `UPDATE meeting_processing_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [claimed.jobId],
  );

  // La credencial de trabajo tiene meetings.transcribe y nada más. Reencolar
  // jobs de toda la instalación no es trabajo de reunión.
  await expectApiError(
    () => requeueExpiredLeases(world.identity),
    'not_found',
    'barrido con credencial de proceso',
  );
  // Y el job sigue colgado: no se reencoló por accidente.
  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.equal(job?.status, 'leased');

  // La credencial de mantenimiento sí puede.
  const sweep = await requeueExpiredLeases(world.maintenanceIdentity);
  assert.ok(sweep.jobs.some((entry) => entry.id === claimed.jobId));
  void meetingId;
});

test('una credencial ajena tampoco puede, aunque tenga otro tenant detrás', async () => {
  const world = await makeWorld();
  await expectApiError(
    () => requeueExpiredLeases(world.foreignIdentity),
    'not_found',
    'barrido con credencial de otro tenant',
  );
});

test('la credencial de mantenimiento NO puede reclamar trabajo', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  // Sus capacidades no incluyen ninguna reclamable, así que el claim no le da
  // nada — y eso no es una comprobación en la ruta, es el filtro del claim.
  assert.equal(await claim(world.maintenanceIdentity, {}, world.deps), null);
  // Mientras el pool de proceso sí ve el trabajo, así que la ausencia no es
  // «no hay nada».
  assert.ok(await claim(world.identity, {}, world.deps));
});

test('el barrido exige ÁMBITO interno Y capacidad, las dos cosas', async () => {
  const world = await makeWorld();

  // La garantía tiene dos niveles y aquí se prueba el del SERVICIO. El de la
  // base —que un pool 'single_tenant' no puede declarar la capacidad— vive en
  // 'pools_scope_allows_capabilities' y se prueba justo debajo y en la suite de
  // esquema. Se prueban por separado porque cubren caminos distintos: el CHECK
  // cubre las credenciales emitidas, esto cubre las identidades construidas en
  // memoria, que es lo que hará cualquier llamador interno futuro.
  const withScope = (
    identity: WorkerIdentity,
    scope: 'internal' | 'single_tenant',
    capabilities: readonly WorkerIdentity['capabilities'][number][],
  ): WorkerIdentity => ({ ...identity, scope, capabilities });

  // 1 · Ámbito de tenant CON la capacidad. La base no dejaría emitirla, así que
  //     la identidad se fabrica: es exactamente el caso que el CHECK no puede
  //     ver.
  await expectApiError(
    () =>
      requeueExpiredLeases(
        withScope(world.maintenanceIdentity, 'single_tenant', ['meetings.maintenance']),
      ),
    'not_found',
    'identidad de tenant con la capacidad puesta a mano',
  );

  // 2 · Ámbito interno SIN la capacidad. Ser interno no autoriza nada por sí
  //     solo: el scope dice sobre qué, la capacidad dice qué.
  await expectApiError(
    () =>
      requeueExpiredLeases(withScope(world.identity, 'internal', ['meetings.transcribe'])),
    'not_found',
    'identidad interna sin la capacidad',
  );

  // 3 · Interno y sin ninguna capacidad.
  await expectApiError(
    () => requeueExpiredLeases(withScope(world.identity, 'internal', [])),
    'not_found',
    'identidad interna sin capacidades',
  );

  // 4 · Sólo interno + capacidad ejecuta el barrido. Y es la credencial REAL,
  //     no una construida: el camino completo desde el token.
  assert.equal(world.maintenanceIdentity.scope, 'internal');
  assert.deepEqual(world.maintenanceIdentity.capabilities, ['meetings.maintenance']);
  const sweep = await requeueExpiredLeases(world.maintenanceIdentity);
  assert.ok(Number.isInteger(sweep.requeued) && Number.isInteger(sweep.abandoned));
});

test('la base no admite un pool de tenant con la capacidad de mantenimiento', async () => {
  const world = await makeWorld();

  // El nivel de esquema. Sin esto, el aislamiento dependería de que nadie
  // escribiera esta fila — y esta fila no falla al usarse: la credencial se
  // emite y autentica igual.
  await assert.rejects(
    () =>
      query(
        `INSERT INTO worker_pools (slug, environment, scope, tenant_id, capabilities, concurrency)
         VALUES ($1, 'development', 'single_tenant', $2, '{meetings.maintenance}',
                 '{"schema_version":1,"limits":{}}'::jsonb)`,
        [`maint-tenant-${randomUUID().slice(0, 8)}`, world.tenantId],
      ),
    /pools_scope_allows_capabilities/,
    'un pool single_tenant no puede declarar meetings.maintenance',
  );

  // Tampoco acompañada de una reclamable perfectamente coherente: no es un
  // problema de coherencia con 'concurrency', es de ámbito.
  await assert.rejects(
    () =>
      query(
        `INSERT INTO worker_pools (slug, environment, scope, tenant_id, capabilities, concurrency)
         VALUES ($1, 'development', 'single_tenant', $2,
                 '{meetings.transcribe,meetings.maintenance}',
                 '{"schema_version":1,"limits":{"meetings.transcribe":1}}'::jsonb)`,
        [`maint-mixto-${randomUUID().slice(0, 8)}`, world.tenantId],
      ),
    /pools_scope_allows_capabilities/,
    'ni mezclada con una capacidad reclamable',
  );

  // Ni por UPDATE sobre el pool de trabajo que ya existe.
  await assert.rejects(
    () =>
      query(
        `UPDATE worker_pools SET capabilities = '{meetings.transcribe,meetings.maintenance}'
          WHERE id = (SELECT pool_id FROM worker_credentials WHERE id = $1)`,
        [world.credentialId],
      ),
    /pools_scope_allows_capabilities/,
    'ni adquirirla por UPDATE',
  );
});

test('un pool sólo de mantenimiento es válido con limits vacío', async () => {
  const world = await makeWorld();
  // La coherencia sólo exige límite para las capacidades RECLAMABLES: exigirlo
  // aquí obligaría a inventar un número para algo que no se reclama.
  assert.deepEqual(world.maintenanceIdentity.capabilities, ['meetings.maintenance']);
  assert.deepEqual(world.maintenanceIdentity.concurrency, {});
  // Y un pool que SÍ declara una reclamable no puede dejar limits vacío.
  await assert.rejects(
    () =>
      query(
        `INSERT INTO worker_pools (slug, environment, scope, tenant_id, capabilities, concurrency)
         VALUES ($1, 'development', 'single_tenant', $2, '{meetings.transcribe}',
                 '{"schema_version":1,"limits":{}}'::jsonb)`,
        [`incoherente-${randomUUID().slice(0, 8)}`, world.tenantId],
      ),
    /pools_coherent/,
  );
});

test('un límite para una capacidad NO reclamable se rechaza', async () => {
  const world = await makeWorld();
  await assert.rejects(
    () =>
      query(
        `INSERT INTO worker_pools (slug, environment, scope, tenant_id, capabilities, concurrency)
         VALUES ($1, 'development', 'single_tenant', $2, '{meetings.maintenance}',
                 '{"schema_version":1,"limits":{"meetings.maintenance":1}}'::jsonb)`,
        [`raro-${randomUUID().slice(0, 8)}`, world.tenantId],
      ),
    /concurrency_valid|pools_coherent/,
  );
});

// ══════════════════════════════════════════════════════════════════════════
// Procedencia relacional del medio derivado
// ══════════════════════════════════════════════════════════════════════════

test('el medio derivado guarda su run y el original no', async () => {
  const world = await makeWorld();
  const { meetingId, runId } = await seedMeetingWithMedia(world);
  const original = await query<{ run_id: string | null; role: string }>(
    `SELECT run_id, role FROM meeting_media WHERE meeting_id = $1`,
    [meetingId],
  );
  assert.deepEqual(original.rows, [{ run_id: null, role: 'original' }]);

  const normalizeJob = await claim(world.identity, {}, world.deps);
  assert.ok(normalizeJob);
  await runStage(world, normalizeJob, NORMALIZED);

  const derived = await query<{ run_id: string | null; role: string }>(
    `SELECT run_id, role FROM meeting_media WHERE meeting_id = $1 AND role = 'normalized'`,
    [meetingId],
  );
  assert.deepEqual(derived.rows, [{ run_id: runId, role: 'normalized' }]);
});

test('la invariante se cumple en las DOS direcciones', async () => {
  const world = await makeWorld();
  const { meetingId, runId } = await seedMeetingWithMedia(world);

  // Un derivado SIN run: nadie podría decir de qué reprocesamiento vino.
  await assert.rejects(
    () =>
      query(
        `INSERT INTO meeting_media
           (tenant_id, client_id, meeting_id, role, storage_key, bytes, checksum_sha256, content_type, sample_rate, channels, codec, probe_ok)
         VALUES ($1, $2, $3, 'normalized', $4, 10, $5, 'audio/wav', 16000, 1, 'pcm_s16le', true)`,
        [world.tenantId, world.clientId, meetingId, `k-${randomUUID()}`, 'a'.repeat(64)],
      ),
    /meeting_media_run_scoped/,
  );

  // Un original CON run: afirmaría que una etapa produjo lo que subió alguien.
  await assert.rejects(
    () =>
      query(
        `INSERT INTO meeting_media
           (tenant_id, client_id, meeting_id, run_id, role, storage_key, bytes, checksum_sha256, content_type)
         VALUES ($1, $2, $3, $4, 'original', $5, 10, $6, 'audio/wav')`,
        [world.tenantId, world.clientId, meetingId, runId, `k-${randomUUID()}`, 'a'.repeat(64)],
      ),
    /meeting_media_run_scoped/,
  );
});

test('un derivado cuyo run es de OTRA reunión se rechaza', async () => {
  const world = await makeWorld();
  const first = await seedMeetingWithMedia(world);
  const second = await seedMeetingWithMedia(world);
  await assert.rejects(
    () =>
      query(
        `INSERT INTO meeting_media
           (tenant_id, client_id, meeting_id, run_id, role, storage_key, bytes, checksum_sha256, content_type, sample_rate, channels, codec, probe_ok)
         VALUES ($1, $2, $3, $4, 'normalized', $5, 10, $6, 'audio/wav', 16000, 1, 'pcm_s16le', true)`,
        [
          world.tenantId,
          world.clientId,
          first.meetingId,
          second.runId,
          `k-${randomUUID()}`,
          'a'.repeat(64),
        ],
      ),
    /meeting_media_run_fkey/,
  );
});

test('un solo normalized VIVO por run: el reintento reemplaza, no duplica', async () => {
  const world = await makeWorld();
  const { meetingId, runId } = await seedMeetingWithMedia(world);
  const normalizeJob = await claim(world.identity, {}, world.deps);
  assert.ok(normalizeJob);
  await runStage(world, normalizeJob, NORMALIZED);

  // Se simula el segundo intento del MISMO run subiendo otro objeto: el índice
  // único parcial impide dos vivos, así que el anterior tiene que retirarse.
  const secondKey = `t/${world.tenantId}/c/${world.clientId}/m/${meetingId}/r/${runId}/normalized/a2/audio.wav`;
  await assert.rejects(
    () =>
      query(
        `INSERT INTO meeting_media
           (tenant_id, client_id, meeting_id, run_id, role, storage_key, bytes, checksum_sha256, content_type, sample_rate, channels, codec, probe_ok)
         VALUES ($1, $2, $3, $4, 'normalized', $5, 10, $6, 'audio/wav', 16000, 1, 'pcm_s16le', true)`,
        [world.tenantId, world.clientId, meetingId, runId, secondKey, 'b'.repeat(64)],
      ),
    /meeting_media_one_live_derived_idx/,
    'dos normalized vivos del mismo run no pueden coexistir',
  );

  // Con el anterior retirado, sí cabe — y sigue habiendo exactamente uno vivo.
  await query(
    `UPDATE meeting_media SET deleted_at = now()
      WHERE run_id = $1 AND role = 'normalized' AND deleted_at IS NULL`,
    [runId],
  );
  await query(
    `INSERT INTO meeting_media
       (tenant_id, client_id, meeting_id, run_id, role, storage_key, bytes, checksum_sha256, content_type, sample_rate, channels, codec, probe_ok)
     VALUES ($1, $2, $3, $4, 'normalized', $5, 10, $6, 'audio/wav', 16000, 1, 'pcm_s16le', true)`,
    [world.tenantId, world.clientId, meetingId, runId, secondKey, 'b'.repeat(64)],
  );
  const live = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM meeting_media
      WHERE run_id = $1 AND role = 'normalized' AND deleted_at IS NULL`,
    [runId],
  );
  assert.equal(live.rows[0].n, '1');
  // Y el histórico no se perdió: sigue habiendo dos filas.
  const total = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM meeting_media WHERE run_id = $1 AND role = 'normalized'`,
    [runId],
  );
  assert.equal(total.rows[0].n, '2');
});

test('el insumo de transcribe se localiza por run, no recorriendo intentos', async () => {
  const world = await makeWorld();
  const { runId } = await seedMeetingWithMedia(world);
  const normalizeJob = await claim(world.identity, {}, world.deps);
  assert.ok(normalizeJob);
  await runStage(world, normalizeJob, NORMALIZED);

  const transcribeJob = await claim(world.identity, {}, world.deps);
  assert.ok(transcribeJob);
  assert.deepEqual(transcribeJob.inputs.map((input) => input.role), ['normalized']);

  // Y si el derivado se retira, el claim del insumo devuelve nada — no una
  // versión antigua encontrada por texto de clave.
  await query(`UPDATE meeting_media SET deleted_at = now() WHERE run_id = $1`, [runId]);
  const second = await seedMeetingWithMedia(world);
  const otherNormalize = await claim(world.identity, {}, world.deps);
  assert.ok(otherNormalize);
  await runStage(world, otherNormalize, NORMALIZED);
  const otherTranscribe = await claim(world.identity, {}, world.deps);
  assert.ok(otherTranscribe);
  // El insumo que recibe es el de SU run, no el de la reunión anterior.
  const media = await query<{ run_id: string }>(
    `SELECT run_id FROM meeting_media
      WHERE role = 'normalized' AND deleted_at IS NULL AND meeting_id = $1`,
    [second.meetingId],
  );
  assert.equal(media.rows[0].run_id, second.runId);
});

// ══════════════════════════════════════════════════════════════════════════
// Idempotencia terminal estricta
// ══════════════════════════════════════════════════════════════════════════

test('reenviar complete con el MISMO payload devuelve el resultado previo', async () => {
  const world = await makeWorld();
  const { runId } = await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  const first = await runStage(world, claimed, NORMALIZED);

  const proof = { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken };
  const again = await resultComplete(
    world.identity,
    { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED), probe: VALID_PROBE },
    world.deps,
  );
  assert.equal(again.status, 'succeeded');
  assert.deepEqual(again.nextJob?.stage, first.nextJob?.stage);
  // Y no se creó un segundo job de la etapa siguiente.
  const jobs = await jobsRepo.listJobsForMeeting(claimed.meetingId);
  assert.equal(jobs.filter((job) => job.stage === 'transcribe').length, 1);
  void runId;
});

test('reenviar complete con OTRO checksum se rechaza y no cambia nada', async () => {
  const world = await makeWorld();
  const { meetingId } = await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  await runStage(world, claimed, NORMALIZED);

  const proof = { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken };
  await expectApiError(
    () =>
      resultComplete(
        world.identity,
        { ...proof, bytes: NORMALIZED.length, checksumSha256: 'f'.repeat(64), probe: VALID_PROBE },
        world.deps,
      ),
    'terminal_conflict',
    'complete con otro checksum',
  );
  // El estado terminal NO se modificó.
  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.equal(job?.status, 'succeeded');
  const upload = await artifactsRepo.findUpload(claimed.jobId, claimed.attempt, 'normalized_media');
  assert.equal(upload?.state, 'ingested');
  assert.equal(upload?.observed_checksum_sha256, sha(NORMALIZED));
  void meetingId;
});

test('reenviar complete con OTRO tamaño se rechaza', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  await runStage(world, claimed, NORMALIZED);
  await expectApiError(
    () =>
      resultComplete(
        world.identity,
        {
          jobId: claimed.jobId,
          attempt: claimed.attempt,
          leaseToken: claimed.leaseToken,
          bytes: NORMALIZED.length + 5,
          checksumSha256: sha(NORMALIZED),
          probe: VALID_PROBE,
        },
        world.deps,
      ),
    'terminal_conflict',
    'complete con otro tamaño',
  );
});

test('un fail sobre un job que ya salió BIEN se rechaza', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  await runStage(world, claimed, NORMALIZED);
  await expectApiError(
    () =>
      fail(
        world.identity,
        {
          jobId: claimed.jobId,
          attempt: claimed.attempt,
          leaseToken: claimed.leaseToken,
          failureCode: 'inventado',
        },
        world.deps,
      ),
    'terminal_conflict',
    'fail sobre succeeded',
  );
  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.equal(job?.status, 'succeeded');
  assert.equal(job?.failure_code, null, 'el estado terminal no se tocó');
});

test('reenviar fail con OTRO código se rechaza sin reescribir la causa', async () => {
  const world = await makeWorld();
  const { meetingId } = await seedMeetingWithMedia(world);
  await query(`UPDATE meeting_processing_jobs SET max_attempts = 1 WHERE meeting_id = $1`, [meetingId]);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  const proof = { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken };
  await fail(world.identity, { ...proof, failureCode: 'audio_unreadable' }, world.deps);

  // El mismo código: idempotente.
  const again = await fail(world.identity, { ...proof, failureCode: 'audio_unreadable' }, world.deps);
  assert.equal(again.status, 'failed');

  // Otro código: conflicto. El failure_code es lo que alguien lee para entender
  // qué pasó; pisarlo con el último que llegue destruye esa respuesta.
  await expectApiError(
    () => fail(world.identity, { ...proof, failureCode: 'otra_cosa' }, world.deps),
    'terminal_conflict',
    'fail con otro código',
  );
  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.equal(job?.failure_code, 'audio_unreadable');
});

test('reenviar fail con el MISMO código y detalle es idempotente; otro detalle es conflicto', async () => {
  const world = await makeWorld();
  const { meetingId } = await seedMeetingWithMedia(world);
  await query(`UPDATE meeting_processing_jobs SET max_attempts = 1 WHERE meeting_id = $1`, [meetingId]);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  const proof = { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken };

  await fail(
    world.identity,
    { ...proof, failureCode: 'audio_unreadable', failureDetail: 'ffprobe: moov atom not found' },
    world.deps,
  );

  // Positivo: mismo código Y mismo detalle → el resultado previo.
  const again = await fail(
    world.identity,
    { ...proof, failureCode: 'audio_unreadable', failureDetail: 'ffprobe: moov atom not found' },
    world.deps,
  );
  assert.equal(again.status, 'failed');
  assert.equal(again.requeued, false);

  // Negativo: mismo código, OTRO detalle. El detalle es lo que alguien lee
  // para diagnosticar; aceptar la segunda versión en silencio dejaría un
  // diagnóstico que nadie escribió a propósito.
  await expectApiError(
    () =>
      fail(
        world.identity,
        { ...proof, failureCode: 'audio_unreadable', failureDetail: 'otra causa' },
        world.deps,
      ),
    'terminal_conflict',
    'fail con otro detalle',
  );

  // Negativo: el detalle DESAPARECE. Nulo contra texto también es diferencia.
  await expectApiError(
    () => fail(world.identity, { ...proof, failureCode: 'audio_unreadable' }, world.deps),
    'terminal_conflict',
    'fail sin el detalle que ya constaba',
  );

  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.equal(job?.failure_code, 'audio_unreadable');
  assert.equal(job?.failure_detail, 'ffprobe: moov atom not found', 'el terminal no se reescribió');
});

test('un fail sin detalle sigue siendo idempotente, y añadir uno es conflicto', async () => {
  const world = await makeWorld();
  const { meetingId } = await seedMeetingWithMedia(world);
  await query(`UPDATE meeting_processing_jobs SET max_attempts = 1 WHERE meeting_id = $1`, [meetingId]);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  const proof = { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken };

  await fail(world.identity, { ...proof, failureCode: 'gpu_oom' }, world.deps);
  // La simetría del caso anterior: null contra null coincide.
  const again = await fail(world.identity, { ...proof, failureCode: 'gpu_oom' }, world.deps);
  assert.equal(again.status, 'failed');
  // Y también coincide si el reenvío manda null explícito en vez de omitirlo.
  const withNull = await fail(
    world.identity,
    { ...proof, failureCode: 'gpu_oom', failureDetail: null },
    world.deps,
  );
  assert.equal(withNull.status, 'failed');

  await expectApiError(
    () =>
      fail(world.identity, { ...proof, failureCode: 'gpu_oom', failureDetail: 'algo' }, world.deps),
    'terminal_conflict',
    'fail que añade un detalle a un terminal sin detalle',
  );
  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.equal(job?.failure_detail, null);
});

const PROBE = { durationSeconds: 3600.4567, sampleRate: 16000, channels: 1, codec: 'pcm_s16le' };

test('reenviar complete de normalize con el MISMO sondeo es idempotente', async () => {
  const world = await makeWorld();
  const { runId } = await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  const first = await runStage(world, claimed, NORMALIZED, PROBE);

  const again = await resultComplete(
    world.identity,
    {
      jobId: claimed.jobId,
      attempt: claimed.attempt,
      leaseToken: claimed.leaseToken,
      bytes: NORMALIZED.length,
      checksumSha256: sha(NORMALIZED),
      probe: PROBE,
    },
    world.deps,
  );
  assert.equal(again.status, 'succeeded');
  assert.equal(again.nextJob?.stage, first.nextJob?.stage);
  assert.equal(again.nextJob?.id, first.nextJob?.id, 'no se creó otro job');

  // El sondeo se compara contra lo PERSISTIDO, y 'duration_seconds' es
  // numeric(12,3): 3600.4567 se guardó como 3600.457. Un reenvío que repite el
  // valor original tiene que coincidir igual, o mai estaría inventando un
  // conflicto a partir de su propio redondeo.
  const media = await meetingsRepo.findLiveDerived(runId, 'normalized');
  assert.equal(Number(media?.duration_seconds), 3600.457);
  assert.equal(media?.sample_rate, 16000);
  assert.equal(media?.channels, 1);
  assert.equal(media?.codec, 'pcm_s16le');

  // Y el valor ya cuantizado también coincide: es el mismo número.
  const quantized = await resultComplete(
    world.identity,
    {
      jobId: claimed.jobId,
      attempt: claimed.attempt,
      leaseToken: claimed.leaseToken,
      bytes: NORMALIZED.length,
      checksumSha256: sha(NORMALIZED),
      probe: { ...PROBE, durationSeconds: 3600.457 },
    },
    world.deps,
  );
  assert.equal(quantized.status, 'succeeded');
});

test('el sondeo del formato: sólo durationSeconds llega a terminal_conflict', async () => {
  const world = await makeWorld();
  const { runId } = await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  await runStage(world, claimed, NORMALIZED, PROBE);

  const base = {
    jobId: claimed.jobId,
    attempt: claimed.attempt,
    leaseToken: claimed.leaseToken,
    bytes: NORMALIZED.length,
    checksumSha256: sha(NORMALIZED),
  };

  // 'durationSeconds' es el ÚNICO campo del sondeo que varía legítimamente
  // entre audios, así que es el único que puede llegar a la comparación
  // terminal. Distinto valor sobre un job cerrado: conflicto.
  await expectApiError(
    () => resultComplete(world.identity, { ...base, probe: { ...PROBE, durationSeconds: 3599 } }, world.deps),
    'terminal_conflict',
    'complete con otra duración',
  );
  // Y nulo contra un valor que constaba también es diferencia.
  await expectApiError(
    () =>
      resultComplete(
        world.identity,
        { ...base, probe: { ...PROBE, durationSeconds: null } },
        world.deps,
      ),
    'terminal_conflict',
    'complete que borra la duración que constaba',
  );

  // Los otros tres NO llegan ahí: el formato pactado los detiene antes, con
  // 'media_rejected', que es más específico. Antes esta prueba los esperaba
  // como 'terminal_conflict' y pasaba porque no había puerta de formato.
  for (const [field, probe] of [
    ['sampleRate', { ...PROBE, sampleRate: 48000 }],
    ['channels', { ...PROBE, channels: 2 }],
    ['codec', { ...PROBE, codec: 'aac' }],
  ] as Array<[string, MediaProbe]>) {
    await expectApiError(
      () => resultComplete(world.identity, { ...base, probe }, world.deps),
      'media_rejected',
      `complete con otro ${field}`,
    );
  }

  // La comparación de los tres sigue en el código y no es inalcanzable: si el
  // formato pactado cambiara, un reenvío con los valores NUEVOS pasaría la
  // puerta y chocaría con la fila escrita bajo el pacto viejo. Aquí se
  // comprueba lo que sí se puede provocar hoy.
  const media = await meetingsRepo.findLiveDerived(runId, 'normalized');
  assert.equal(Number(media?.duration_seconds), 3600.457);
  assert.equal(media?.sample_rate, NORMALIZED_AUDIO.sampleRate);
  assert.equal(media?.channels, NORMALIZED_AUDIO.channels);
  assert.equal(media?.codec, NORMALIZED_AUDIO.codec);
  assert.equal(media?.probe_ok, true);
  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.equal(job?.status, 'succeeded');
  const jobs = await jobsRepo.listJobsForMeeting(claimed.meetingId);
  assert.equal(jobs.filter((entry) => entry.stage === 'transcribe').length, 1);
});

// ── El sondeo es OBLIGATORIO para normalize ────────────────────────────────
//
// Aquí vivía 'un complete de normalize SIN sondeo es idempotente consigo
// mismo', que convertía en contrato el hueco: `probe` era opcional, mai
// persistía el medio con `probe_ok = true` sin haber medido nada y encolaba
// `transcribe` sobre él. Lo sustituyen estas pruebas negativas.

test('normalize SIN sondeo no cierra nada', async () => {
  const world = await makeWorld();
  const { runId } = await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  const proof = { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken };
  const signed = await resultInit(
    world.identity,
    { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED) },
    world.deps,
  );
  assert.ok(world.store.put(signed.url, NORMALIZED, signed.requiredHeaders).ok);

  await expectApiError(
    () =>
      resultComplete(
        world.identity,
        { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED) },
        world.deps,
      ),
    'invalid_request',
    'normalize sin sondeo',
  );

  // Las tres cosas que NO deben haber pasado.
  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.notEqual(job?.status, 'succeeded', 'el job no se marca succeeded');
  assert.equal(
    await meetingsRepo.findLiveDerived(runId, 'normalized'),
    null,
    'no se inserta meeting_media',
  );
  const jobs = await jobsRepo.listJobsForMeeting(claimed.meetingId);
  assert.equal(jobs.filter((entry) => entry.stage === 'transcribe').length, 0, 'no se encola transcribe');

  // Y tampoco se escribió nada en la subida: la comprobación va antes de
  // `store.confirm`, así que ni siquiera hay un `verified`.
  const upload = await artifactsRepo.findUpload(claimed.jobId, claimed.attempt, 'normalized_media');
  assert.equal(upload?.state, 'uploaded');
  assert.equal(upload?.verified_at, null);

  // Con el sondeo, el mismo intento cierra: el rechazo no dejó el job en un
  // estado del que no se pueda salir.
  const ok = await resultComplete(
    world.identity,
    { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED), probe: VALID_PROBE },
    world.deps,
  );
  assert.equal(ok.status, 'succeeded');
  assert.equal(ok.nextJob?.stage, 'transcribe');
});

test('normalize con un sondeo PARCIAL no cierra nada', async () => {
  const world = await makeWorld();
  const { runId } = await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  const proof = { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken };
  const signed = await resultInit(
    world.identity,
    { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED) },
    world.deps,
  );
  assert.ok(world.store.put(signed.url, NORMALIZED, signed.requiredHeaders).ok);

  // Un sondeo a medias es una afirmación sobre lo que no se miró. En el borde
  // lo rechaza el esquema del cuerpo; el servicio, que recibe el tipo ya
  // estrecho, lo ve como formato incompleto.
  //
  // El cast es deliberado: se está probando lo que llega por el cable, no lo
  // que el tipo permite. `parseBody` es la primera puerta y se prueba aparte;
  // esto comprueba que el servicio no confía en que alguien la haya cruzado.
  for (const partial of [
    { channels: 1, codec: 'pcm_s16le' },
    { sampleRate: 16000, codec: 'pcm_s16le' },
    { sampleRate: 16000, channels: 1 },
    {},
  ]) {
    await expectApiError(
      () =>
        resultComplete(
          world.identity,
          {
            ...proof,
            bytes: NORMALIZED.length,
            checksumSha256: sha(NORMALIZED),
            probe: partial as unknown as MediaProbe,
          },
          world.deps,
        ),
      'media_rejected',
      `sondeo parcial ${JSON.stringify(partial)}`,
    );
  }

  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.notEqual(job?.status, 'succeeded');
  assert.equal(await meetingsRepo.findLiveDerived(runId, 'normalized'), null);
  const jobs = await jobsRepo.listJobsForMeeting(claimed.meetingId);
  assert.equal(jobs.filter((entry) => entry.stage === 'transcribe').length, 0);
});

test('normalize con el FORMATO equivocado no cierra nada', async () => {
  const world = await makeWorld();
  const { runId } = await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  const proof = { jobId: claimed.jobId, attempt: claimed.attempt, leaseToken: claimed.leaseToken };
  const signed = await resultInit(
    world.identity,
    { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED) },
    world.deps,
  );
  assert.ok(world.store.put(signed.url, NORMALIZED, signed.requiredHeaders).ok);

  // Un ffmpeg mal configurado produce 48 kHz estéreo AAC. Antes el pipeline
  // seguía adelante y el fallo aparecía como una transcripción rara, lejos del
  // sitio donde se podía diagnosticar.
  const wrong: MediaProbe[] = [
    { ...VALID_PROBE, sampleRate: 48_000 },
    { ...VALID_PROBE, channels: 2 },
    { ...VALID_PROBE, codec: 'aac' },
    { durationSeconds: 12.5, sampleRate: 48_000, channels: 2, codec: 'aac' },
  ];
  for (const probe of wrong) {
    await expectApiError(
      () =>
        resultComplete(
          world.identity,
          { ...proof, bytes: NORMALIZED.length, checksumSha256: sha(NORMALIZED), probe },
          world.deps,
        ),
      'media_rejected',
      `formato equivocado ${JSON.stringify(probe)}`,
    );
  }

  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.notEqual(job?.status, 'succeeded');
  assert.equal(await meetingsRepo.findLiveDerived(runId, 'normalized'), null);
  const jobs = await jobsRepo.listJobsForMeeting(claimed.meetingId);
  assert.equal(jobs.filter((entry) => entry.stage === 'transcribe').length, 0);
});

test('el sondeo se RECHAZA en transcribe y en diarize, no se ignora', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  const normalizeJob = await claim(world.identity, {}, world.deps);
  assert.ok(normalizeJob);
  await runStage(world, normalizeJob, NORMALIZED);

  for (const stage of ['transcribe', 'diarize'] as const) {
    const job = await claim(world.identity, {}, world.deps);
    assert.ok(job);
    assert.equal(job.stage, stage);
    const artifact = stage === 'transcribe' ? transcriptArtifact() : diarizationArtifact();
    const proof = { jobId: job.jobId, attempt: job.attempt, leaseToken: job.leaseToken };
    const signed = await resultInit(
      world.identity,
      { ...proof, bytes: artifact.length, checksumSha256: sha(artifact) },
      world.deps,
    );
    assert.ok(world.store.put(signed.url, artifact, signed.requiredHeaders).ok);

    // Aceptar y luego ignorar es lo peor de las dos opciones: el worker cree
    // que mai registró un sondeo y mai no registró nada.
    await expectApiError(
      () =>
        resultComplete(
          world.identity,
          { ...proof, bytes: artifact.length, checksumSha256: sha(artifact), probe: VALID_PROBE },
          world.deps,
        ),
      'invalid_request',
      `sondeo en ${stage}`,
    );
    const stillOpen = await jobsRepo.getJobById(job.jobId);
    assert.notEqual(stillOpen?.status, 'succeeded', `${stage} no se cerró`);

    // Y sin el sondeo, la misma etapa cierra.
    const ok = await resultComplete(
      world.identity,
      { ...proof, bytes: artifact.length, checksumSha256: sha(artifact) },
      world.deps,
    );
    assert.equal(ok.status, 'succeeded');
  }
});

test('el leaseToken NO entra en la comparación de idempotencia', async () => {
  const world = await makeWorld();
  await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  await runStage(world, claimed, NORMALIZED, PROBE);

  const body = {
    jobId: claimed.jobId,
    attempt: claimed.attempt,
    leaseToken: claimed.leaseToken,
    bytes: NORMALIZED.length,
    checksumSha256: sha(NORMALIZED),
    probe: PROBE,
  };
  assert.equal((await resultComplete(world.identity, body, world.deps)).status, 'succeeded');

  // El token es una prueba de POSESIÓN, no un dato del resultado, así que no
  // entra en la comparación: si entrara, un reenvío tras una renovación de
  // lease legítima saldría como conflicto.
  //
  // Y sobre un terminal no hay nada contra lo que compararlo:
  // 'jobs_lease_invariants' exige que 'lease_token_hash' sea NULL en cuanto el
  // job cierra. Así que un token distinto pasa igual — lo que autoriza el
  // reenvío es la CREDENCIAL y el intento, que sí se conservan.
  const job = await jobsRepo.getJobById(claimed.jobId);
  assert.equal(job?.status, 'succeeded');
  assert.equal(job?.lease_token_hash, null, 'el terminal ya no guarda el token');
  const otherToken = await resultComplete(
    world.identity,
    { ...body, leaseToken: 'mlt_otro_token_con_longitud_suficiente' },
    world.deps,
  );
  assert.equal(otherToken.status, 'succeeded');

  // Lo que NO pasa es otra credencial, aunque el payload sea idéntico: el
  // reenvío es del mismo worker o no es un reenvío.
  await expectApiError(
    () => resultComplete(world.foreignIdentity, body, world.deps),
    'not_found',
    'complete de un terminal con una credencial ajena',
  );
  // Ni un intento distinto: eso lo rechaza 'authorizeLease' antes de comparar
  // nada del payload.
  await expectApiError(
    () => resultComplete(world.identity, { ...body, attempt: claimed.attempt + 1 }, world.deps),
    'attempt_stale',
    'complete de un terminal con otro intento',
  );
});

test('un complete sobre un job cancelado se rechaza', async () => {
  const world = await makeWorld();
  const scope = { tenantId: world.tenantId, clientId: world.clientId, userId: world.userId };
  const { meetingId } = await seedMeetingWithMedia(world);
  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  const signed = await resultInit(
    world.identity,
    {
      jobId: claimed.jobId,
      attempt: claimed.attempt,
      leaseToken: claimed.leaseToken,
      bytes: NORMALIZED.length,
      checksumSha256: sha(NORMALIZED),
    },
    world.deps,
  );
  assert.ok(world.store.put(signed.url, NORMALIZED, signed.requiredHeaders).ok);
  await cancelMeeting(scope, meetingId);

  // El job quedó 'cancelled', y el código es `invalid_transition`, no
  // `terminal_conflict`. La distinción importa: `terminal_conflict` significa
  // «esto ya terminó y estás afirmando otra cosa sobre su resultado»;
  // `invalid_transition` significa «esto ya no está en el pipeline». Un worker
  // que recibe el primero tiene un bug; uno que recibe el segundo perdió una
  // carrera con una cancelación, que es normal.
  await expectApiError(
    () =>
      resultComplete(
        world.identity,
        {
          jobId: claimed.jobId,
          attempt: claimed.attempt,
          leaseToken: claimed.leaseToken,
          bytes: NORMALIZED.length,
          checksumSha256: sha(NORMALIZED),
          probe: VALID_PROBE,
        },
        world.deps,
      ),
    'invalid_transition',
    'complete sobre cancelado',
  );
  // Y el artefacto NO se ingirió.
  const upload = await artifactsRepo.findUpload(claimed.jobId, claimed.attempt, 'normalized_media');
  assert.notEqual(upload?.state, 'ingested');
});


// ══════════════════════════════════════════════════════════════════════════
// «¿Cuántas personas hablan?» — que la opción LLEGUE, contra la base de verdad
//
// Lo que se afirma aquí es la mitad de mai de la cadena: que el número elegido al
// subir queda escrito en `requested_options` del run y que el `claim` lo entrega.
// NO se afirma que el worker lo use — eso es código Python en otra máquina y se
// verifica allí, no aquí.
// ══════════════════════════════════════════════════════════════════════════

test('el número de hablantes se persiste en el run y llega en el claim de TODAS las etapas', async () => {
  const world = await makeWorld();
  const { meetingId, runId } = await seedMeetingWithMedia(world, { speakerCount: 2 });

  // 1 · escrito en la base, en el run, y sólo eso.
  const stored = await query<{ requested_options: Record<string, unknown> }>(
    'SELECT requested_options FROM meeting_processing_runs WHERE id = $1',
    [runId],
  );
  assert.deepEqual(stored.rows[0].requested_options, { speakerCount: 2 });

  // 2 · el claim lo entrega. Las opciones son del RUN, así que las tres etapas las
  // ven — y la que importa es diarize, que es la única que las va a usar.
  const normalize = await claim(world.identity, {}, world.deps);
  assert.ok(normalize);
  assert.equal(normalize.options.speakerCount, 2, 'normalize también las ve');

  await runStage(world, normalize, NORMALIZED, {
    durationSeconds: 30,
    sampleRate: 16000,
    channels: 1,
    codec: 'pcm_s16le',
  });
  const transcribe = await claim(world.identity, {}, world.deps);
  assert.ok(transcribe);
  assert.equal(transcribe.stage, 'transcribe');
  assert.equal(transcribe.options.speakerCount, 2);

  await runStage(world, transcribe, transcriptArtifact(3));
  const diarize = await claim(world.identity, {}, world.deps);
  assert.ok(diarize);
  assert.equal(diarize.stage, 'diarize', 'la etapa que lo necesita');
  assert.equal(
    diarize.options.speakerCount,
    2,
    'el número llega al claim de diarize: es lo que el worker tiene que leer',
  );
  assert.equal(diarize.meetingId, meetingId);
});

test('automático no escribe la clave, y el claim la entrega ausente', async () => {
  const world = await makeWorld();
  const { runId } = await seedMeetingWithMedia(world, { speakerCount: null });

  const stored = await query<{ requested_options: Record<string, unknown> }>(
    'SELECT requested_options FROM meeting_processing_runs WHERE id = $1',
    [runId],
  );
  assert.deepEqual(stored.rows[0].requested_options, {}, 'automático no deja rastro');

  const claimed = await claim(world.identity, {}, world.deps);
  assert.ok(claimed);
  assert.equal(
    'speakerCount' in claimed.options,
    false,
    'ausente, no null: es lo que el worker ya interpreta como automático',
  );
});

test('no elegir nada es indistinguible de elegir automático', async () => {
  const world = await makeWorld();
  const sinElegir = await seedMeetingWithMedia(world);
  const automatico = await seedMeetingWithMedia(world, { speakerCount: null });

  const rows = await query<{ id: string; requested_options: Record<string, unknown> }>(
    'SELECT id, requested_options FROM meeting_processing_runs WHERE id = ANY($1)',
    [[sinElegir.runId, automatico.runId]],
  );
  assert.equal(rows.rows.length, 2);
  for (const row of rows.rows) assert.deepEqual(row.requested_options, {});
});

test('un número se conserva intacto tras un requeue: la opción es del run, no del intento', async () => {
  const world = await makeWorld({ leaseSeconds: 1 });
  const { meetingId } = await seedMeetingWithMedia(world, { speakerCount: 5 });

  const first = await claim(world.identity, {}, world.deps);
  assert.ok(first);
  assert.equal(first.options.speakerCount, 5);

  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const sweep = await requeueExpiredLeases(world.maintenanceIdentity);
  assert.ok(sweep.requeued >= 1, 'el lease caducó y el job volvió a la cola');
  const second = await claim(world.identity, {}, world.deps);
  assert.ok(second);
  assert.equal(second.meetingId, meetingId);
  assert.equal(second.attempt, 2, 'es el segundo intento');
  assert.equal(second.options.speakerCount, 5, 'y sigue viendo el número elegido');
});

// ══════════════════════════════════════════════════════════════════════════
// El transcript v2 con tiempos por palabra, ingerido de verdad
//
// La prueba unitaria comprueba `alignSegments`. Esta comprueba que el resultado
// LLEGA A LA BASE: los bloques partidos, sus etiquetas, sus marcas de solape, los
// índices densos y `segment_count` cuadrando con las filas.
// ══════════════════════════════════════════════════════════════════════════

/**
 * Un transcript v2 de dos segmentos. El primero contiene A y B —es el caso de la
 * reunión real, donde whisper mete pregunta y respuesta en el mismo trozo—, y el
 * segundo lleva una palabra suelta de A dentro del turno de B.
 */
function transcriptArtifactV2(): Buffer {
  const lines = [
    JSON.stringify({
      schema: 'meetings.transcript',
      schema_version: 2,
      language: 'es',
      duration_seconds: 30,
      model: 'medium',
      device: 'cuda',
      compute_type: 'float16',
      segment_count: 2,
    }),
    JSON.stringify({
      i: 0,
      start: 0,
      end: 9,
      text: '¿Qué te gustaría almorzar? No sé, podríamos pollo',
      words: [
        { start: 0.0, end: 1.0, word: '¿Qué' },
        { start: 1.0, end: 2.0, word: ' te' },
        { start: 2.0, end: 3.0, word: ' gustaría' },
        { start: 3.0, end: 4.0, word: ' almorzar?' },
        { start: 5.0, end: 6.0, word: ' No' },
        { start: 6.0, end: 7.0, word: ' sé,' },
        { start: 7.0, end: 8.0, word: ' podríamos' },
        { start: 8.0, end: 9.0, word: ' pollo' },
      ],
    }),
    JSON.stringify({
      i: 1,
      start: 10,
      end: 19,
      text: 'Entonces pedimos sushi vale y lo confirmo ahora',
      words: [
        { start: 10.0, end: 11.0, word: 'Entonces' },
        { start: 11.0, end: 12.0, word: ' pedimos' },
        { start: 12.0, end: 13.0, word: ' sushi' },
        { start: 13.0, end: 13.4, word: ' vale' },
        { start: 14.0, end: 15.0, word: ' y' },
        { start: 15.0, end: 16.0, word: ' lo' },
        { start: 16.0, end: 17.0, word: ' confirmo' },
      ],
    }),
  ];
  return gzipSync(Buffer.from(`${lines.join('\n')}\n`));
}

/** Turnos que reparten el segmento 0 en dos voces y meten un «vale» ajeno en el 1. */
function diarizationArtifactForV2(): Buffer {
  const turns = [
    { start: 0, end: 4.5, speaker: 'SPEAKER_00' },
    { start: 4.8, end: 9.5, speaker: 'SPEAKER_01' },
    { start: 9.8, end: 13.0, speaker: 'SPEAKER_01' },
    { start: 13.0, end: 13.5, speaker: 'SPEAKER_00' },
    { start: 13.6, end: 19.5, speaker: 'SPEAKER_01' },
  ];
  const lines = [
    JSON.stringify({
      schema: 'meetings.diarization',
      schema_version: 1,
      backend: 'pyannote_full',
      speaker_count: 2,
      turn_count: turns.length,
    }),
    ...turns.map((turn) => JSON.stringify(turn)),
  ];
  return gzipSync(Buffer.from(`${lines.join('\n')}\n`));
}

test('un transcript v2 se ingiere partido por palabra, con los bloques y las marcas en la base', async () => {
  const world = await makeWorld();
  const scope = { tenantId: world.tenantId, clientId: world.clientId, userId: world.userId };
  const { meetingId, runId } = await seedMeetingWithMedia(world, { speakerCount: 2 });

  const normalize = await claim(world.identity, {}, world.deps);
  assert.ok(normalize);
  await runStage(world, normalize, NORMALIZED, {
    durationSeconds: 30,
    sampleRate: 16000,
    channels: 1,
    codec: 'pcm_s16le',
  });

  const transcribe = await claim(world.identity, {}, world.deps);
  assert.ok(transcribe);
  await runStage(world, transcribe, transcriptArtifactV2());

  const diarize = await claim(world.identity, {}, world.deps);
  assert.ok(diarize);
  const done = await runStage(world, diarize, diarizationArtifactForV2());
  assert.equal(done.ingested, true);

  const segments = await query<{
    segment_index: number;
    start_sec: string;
    end_sec: string;
    speaker_label: string | null;
    text: string;
    overlap: boolean;
    speaker_uncertain: boolean;
  }>(
    `SELECT segment_index, start_sec, end_sec, speaker_label, text, overlap, speaker_uncertain
       FROM meeting_segments WHERE transcript_id = $1 ORDER BY segment_index`,
    [done.transcriptId],
  );

  // El segmento 0 se partió en dos; el 1 absorbió el «vale» y quedó en uno.
  assert.equal(segments.rows.length, 3, 'dos segmentos de whisper dan tres bloques');
  assert.deepEqual(
    segments.rows.map((row) => row.speaker_label),
    ['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_01'],
  );
  assert.deepEqual(
    segments.rows.map((row) => row.text),
    [
      '¿Qué te gustaría almorzar?',
      'No sé, podríamos pollo',
      // El segmento 1 NO se partió: el «vale» se absorbió y quedó un solo tramo, así
      // que se emite el segmento ORIGINAL — con «ahora» incluido, que ni siquiera
      // tenía entrada en `words`. El texto no se reconstruye desde las palabras
      // cuando no hace falta partir, y así no se pierde lo que ellas no cubren.
      'Entonces pedimos sushi vale y lo confirmo ahora',
    ],
  );
  assert.deepEqual(
    segments.rows.map((row) => [Number(row.start_sec), Number(row.end_sec)]),
    [
      [0, 4],
      [5, 9],
      // Los tiempos ORIGINALES del segmento, porque no se partió.
      [10, 19],
    ],
    'partido, los tiempos son los de las palabras; sin partir, los del segmento — nunca interpolados',
  );

  // Solapamiento e incertidumbre son campos DISTINTOS, y aquí se ve por qué.
  assert.deepEqual(
    segments.rows.map((row) => row.overlap),
    [false, false, false],
    'ninguno tiene dos voces simultáneas: el «vale» ajeno es el 5,6 % del bloque',
  );
  assert.deepEqual(
    segments.rows.map((row) => row.speaker_uncertain),
    [false, false, true],
    'el tercero sí es tentativo: hay un cambio de hablante que las palabras no permiten situar',
  );
  assert.ok(segments.rows[2].text.includes('vale'), 'y no perdió la palabra');
  assert.ok(segments.rows[2].text.includes('ahora'), 'ni «ahora», que no tenía entrada en words');

  // Índices densos y `segment_count` cuadrando con lo que hay.
  assert.deepEqual(segments.rows.map((row) => row.segment_index), [0, 1, 2]);
  const state = await getMeetingState(scope, meetingId);
  assert.equal(state.activeTranscript?.segmentCount, 3, 'segment_count sale de las filas reales');
  assert.equal(state.activeTranscript?.diarizationBackend, 'pyannote_full');

  const version = await query<{ schema_version: number }>(
    `SELECT schema_version FROM meeting_transcript_versions WHERE id = $1`,
    [done.transcriptId],
  );
  assert.equal(version.rows[0].schema_version, 2, 'la versión del artefacto queda registrada');

  const run = await query<{ outcome: string }>(
    `SELECT outcome FROM meeting_processing_runs WHERE id = $1`,
    [runId],
  );
  assert.equal(run.rows[0].outcome, 'succeeded');
});

test('reingerir los mismos bloques partidos converge en vez de duplicar', async () => {
  // Partir añade filas y renumera índices, así que la idempotencia hay que volver a
  // demostrarla: el UNIQUE es (transcript_id, segment_index) y una segunda escritura
  // de los MISMOS bloques tiene que dar exactamente las mismas filas.
  const world = await makeWorld();
  const { meetingId, runId } = await seedMeetingWithMedia(world, { speakerCount: 2 });

  const transcript = parseTranscriptArtifact(gunzipSync(transcriptArtifactV2()));
  const diarization = parseDiarizationArtifact(gunzipSync(diarizationArtifactForV2()));
  const alignment = alignSegments(transcript.segments, diarization.turns);
  assert.equal(alignment.segments.length, 3, 'tres bloques de dos segmentos');

  const input = {
    tenantId: world.tenantId,
    clientId: world.clientId,
    meetingId,
    runId,
    whisperModel: transcript.header.model,
    diarizationBackend: diarization.header.backend,
    language: transcript.header.language,
    durationSeconds: transcript.header.durationSeconds,
    schemaVersion: transcript.header.schemaVersion,
    metrics: {},
    segments: alignment.segments,
    talkSharePct: alignment.talkSharePct,
  };

  // Debe ir en transacción: la propia función lo documenta, porque un fallo a mitad
  // dejaría una versión con la mitad de sus segmentos y `segment_count` mintiendo.
  const first = await withTransaction((client) =>
    transcriptsRepo.ingestTranscriptVersion(input, client as unknown as Parameters<typeof transcriptsRepo.ingestTranscriptVersion>[1]),
  );
  assert.equal(first.created, true);

  const snapshot = async (): Promise<string> => {
    const rows = await query<{
      segment_index: number;
      speaker_label: string | null;
      text: string;
      overlap: boolean;
      speaker_uncertain: boolean;
    }>(
      `SELECT segment_index, speaker_label, text, overlap, speaker_uncertain FROM meeting_segments
         WHERE transcript_id = $1 ORDER BY segment_index`,
      [first.version.id],
    );
    return JSON.stringify(rows.rows);
  };
  const before = await snapshot();

  const second = await withTransaction((client) =>
    transcriptsRepo.ingestTranscriptVersion(input, client as unknown as Parameters<typeof transcriptsRepo.ingestTranscriptVersion>[1]),
  );
  assert.equal(second.version.id, first.version.id, 'tv_run_key: una versión por run');
  assert.equal(await snapshot(), before, 'la segunda escritura no duplica ni reordena');

  const count = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM meeting_segments WHERE transcript_id = $1`,
    [first.version.id],
  );
  assert.equal(count.rows[0].n, '3', 'siguen siendo tres filas, no seis');
});
