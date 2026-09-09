import { withTransaction } from '../db/client.js';
import type { Queryable } from '../db/repositories/meetings/types.js';
import type { ArtifactKind, JobStage } from '../db/repositories/meetings/types.js';
import type { WorkerIdentity } from '../db/repositories/meetings/credentials.js';
import * as meetingsRepo from '../db/repositories/meetings/meetings.js';
import * as jobsRepo from '../db/repositories/meetings/jobs.js';
import * as artifactsRepo from '../db/repositories/meetings/artifacts.js';
import * as transcriptsRepo from '../db/repositories/meetings/transcripts.js';
import { MeetingsApiError, invalidRequest, notFound } from './errors.js';
import { mintLeaseToken, verifyLeaseToken } from './leaseToken.js';
import { meetingsRateLimiter, type RateLimiter } from './rateLimit.js';
import {
  ROLE_CONTENT_ENCODING,
  ROLE_CONTENT_TYPE,
  artifactKey,
  keyBelongsToMeeting,
  originalMediaKey,
} from './storageKeys.js';
import { checkMedia, type MediaLimits } from './mediaLimits.js';
import {
  ArtifactError,
  alignSegments,
  parseDiarizationArtifact,
  parseTranscriptArtifact,
  type ParsedDiarization,
  type ParsedTranscript,
} from './artifacts.js';
import type { PrivateObjectStore } from '../storage/privateObjectStore.js';

/**
 * Las operaciones de `/api/meetings/v1`. Las rutas de Next son adaptadores
 * finos sobre esto.
 *
 * ── Por qué la lógica no vive en las rutas ──────────────────────────────────
 *
 * Lo que hay que probar aquí no es el HTTP: es que el claim sea atómico, que un
 * `complete` reenviado no ingiera dos veces, que un intento viejo no gane sobre
 * el actual y que el siguiente job se cree en la misma transacción que cierra el
 * anterior. Todo eso se prueba contra una base desechable llamando funciones;
 * envolverlo en un servidor sólo añadiría una capa que también habría que
 * levantar en cada prueba.
 *
 * ── El invariante de identidad ──────────────────────────────────────────────
 *
 * `tenant_id` y `client_id` **nunca** vienen de la petición del worker. Salen
 * del job, y el job se filtra por el alcance de la credencial. Un pool
 * `single_tenant` sólo puede reclamar jobs de su tenant (el `WHERE` del claim);
 * un pool `internal` puede reclamar cualquiera, y por eso su creación exige
 * autorización auditada. Después del claim, toda operación sobre el job
 * comprueba que la credencial que la pide es la que sostiene el lease.
 */

export interface MeetingsServiceDeps {
  readonly store: PrivateObjectStore;
  readonly limits: MediaLimits;
  /** Duración del lease. La decide el SERVIDOR, nunca el worker. */
  readonly leaseSeconds: number;
  readonly rateLimiter?: RateLimiter;
  readonly now?: () => Date;
}

/** Un lease de 5 minutos con latido cada ~20 s: tres latidos perdidos y expira. */
export const DEFAULT_LEASE_SECONDS = 300;

function deps(partial: MeetingsServiceDeps): Required<Omit<MeetingsServiceDeps, 'rateLimiter'>> & {
  rateLimiter: RateLimiter;
} {
  return {
    store: partial.store,
    limits: partial.limits,
    leaseSeconds: partial.leaseSeconds,
    rateLimiter: partial.rateLimiter ?? meetingsRateLimiter,
    now: partial.now ?? (() => new Date()),
  };
}

function enforceRate(
  limiter: RateLimiter,
  credentialId: string,
  operation: 'claim' | 'heartbeat' | 'result',
): void {
  const decision = limiter.check(credentialId, operation);
  if (!decision.allowed) {
    throw new MeetingsApiError('rate_limited', 'Demasiadas peticiones para esta credencial.', {
      'retry-after': String(decision.retryAfterSeconds),
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Lado UI/aplicación: crear reunión y subir el medio original
// ══════════════════════════════════════════════════════════════════════════

export interface AppScope {
  readonly tenantId: string;
  readonly clientId: string;
  readonly userId?: string | null;
  readonly userLabel?: string | null;
}

export interface CreateMeetingRequest {
  readonly title: string;
  readonly sourceKind?: 'file' | 'meet' | 'inbox' | 'room' | 'api';
  readonly idempotencyKey: string;
  readonly startedAt?: string | null;
  readonly languageHint?: string | null;
  /** `{ diarize: false }` omite la etapa de diarización en este run. */
  readonly options?: Record<string, unknown>;
}

export async function createMeeting(
  scope: AppScope,
  request: CreateMeetingRequest,
): Promise<{ meetingId: string; created: boolean; mediaState: string }> {
  const title = (request.title ?? '').trim();
  if (title.length === 0) throw invalidRequest('El título es obligatorio.');
  if (title.length > 500) throw invalidRequest('El título es demasiado largo.');
  const idempotencyKey = (request.idempotencyKey ?? '').trim();
  if (idempotencyKey.length === 0) throw invalidRequest('idempotencyKey es obligatoria.');
  if (idempotencyKey.length > 200) throw invalidRequest('idempotencyKey es demasiado larga.');

  let startedAt: Date | null = null;
  if (request.startedAt) {
    startedAt = new Date(request.startedAt);
    if (Number.isNaN(startedAt.getTime())) throw invalidRequest('startedAt no es una fecha válida.');
  }

  const { meeting, created } = await meetingsRepo.createMeeting({
    tenantId: scope.tenantId,
    clientId: scope.clientId,
    title,
    sourceKind: request.sourceKind ?? 'file',
    idempotencyKey,
    startedAt,
    languageHint: request.languageHint ?? null,
    createdByUserId: scope.userId ?? null,
  });

  return { meetingId: meeting.id, created, mediaState: meeting.media_state };
}

export interface UploadInitRequest {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: number;
  /** SHA-256 en hex. Si se da, va DENTRO de la firma del PUT. */
  readonly checksumSha256?: string;
}

export interface SignedUploadResponse {
  readonly url: string;
  readonly method: 'PUT';
  readonly requiredHeaders: Readonly<Record<string, string>>;
  readonly expiresAt: string;
  /** Se devuelve para que el cliente pueda confirmarlo, NO para que lo elija. */
  readonly storageKey: string;
}

/**
 * Firma la subida del medio original. El navegador manda nombre, tipo y tamaño;
 * **no manda la clave**, que se deriva de la reunión.
 */
export async function uploadInit(
  scope: AppScope,
  meetingId: string,
  request: UploadInitRequest,
  d: MeetingsServiceDeps,
): Promise<SignedUploadResponse> {
  const { store, limits } = deps(d);
  const meeting = await meetingsRepo.getMeetingScoped(meetingId, scope.tenantId, scope.clientId);
  if (!meeting) throw notFound();
  if (meeting.cancelled_at !== null) {
    throw new MeetingsApiError('invalid_transition', 'La reunión está cancelada.');
  }
  if (meeting.media_state === 'ready') {
    throw new MeetingsApiError('invalid_transition', 'Esta reunión ya tiene su medio original.');
  }

  const check = checkMedia(
    { filename: request.filename, contentType: request.contentType, bytes: request.bytes },
    limits,
  );
  if (!check.ok) {
    throw new MeetingsApiError('media_rejected', check.detail);
  }
  if (request.checksumSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(request.checksumSha256)) {
    throw invalidRequest('checksumSha256 debe ser un SHA-256 en hexadecimal.');
  }

  const key = originalMediaKey({
    tenantId: scope.tenantId,
    clientId: scope.clientId,
    meetingId: meeting.id,
  });
  const signed = store.signPut({
    key,
    contentType: check.contentType,
    contentLength: request.bytes,
    ...(request.checksumSha256 ? { checksumSha256Hex: request.checksumSha256.toLowerCase() } : {}),
  });

  await meetingsRepo.setMediaState(meeting.id, 'uploading');

  return {
    url: signed.url,
    method: 'PUT',
    requiredHeaders: signed.requiredHeaders,
    expiresAt: signed.expiresAt.toISOString(),
    storageKey: key,
  };
}

export interface UploadCompleteRequest {
  readonly bytes: number;
  readonly checksumSha256: string;
}

export interface UploadCompleteResponse {
  readonly mediaState: string;
  readonly runId: string;
  readonly firstJob: { readonly id: string; readonly stage: JobStage };
}

/**
 * Confirma el objeto y arranca el pipeline. En UNA transacción: insertar el
 * medio, poner `media_state='ready'`, crear el run y crear el job `normalize`.
 *
 * Si se hiciera en pasos separados, un fallo entre el medio y el run dejaría una
 * reunión con audio y sin nada que lo procese — y nada en los datos diría que
 * está a medias, porque `media_state='ready'` es exactamente el estado normal.
 */
export async function uploadComplete(
  scope: AppScope,
  meetingId: string,
  request: UploadCompleteRequest,
  d: MeetingsServiceDeps,
): Promise<UploadCompleteResponse> {
  const { store } = deps(d);
  const meeting = await meetingsRepo.getMeetingScoped(meetingId, scope.tenantId, scope.clientId);
  if (!meeting) throw notFound();
  if (meeting.cancelled_at !== null) {
    throw new MeetingsApiError('invalid_transition', 'La reunión está cancelada.');
  }
  if (!/^[0-9a-f]{64}$/i.test(request.checksumSha256)) {
    throw invalidRequest('checksumSha256 debe ser un SHA-256 en hexadecimal.');
  }

  const key = originalMediaKey({
    tenantId: scope.tenantId,
    clientId: scope.clientId,
    meetingId: meeting.id,
  });

  // Reenvío del mismo complete: ya está todo hecho.
  const already = await meetingsRepo.findMediaByKey(key);
  if (already && meeting.media_state === 'ready') {
    const run = await jobsRepo.getActiveRun(meeting.id);
    if (run) {
      const jobs = await jobsRepo.listJobsForMeeting(meeting.id);
      const normalize = jobs.find((job) => job.run_id === run.id && job.stage === 'normalize');
      if (normalize) {
        return {
          mediaState: 'ready',
          runId: run.id,
          firstJob: { id: normalize.id, stage: 'normalize' },
        };
      }
    }
  }

  const confirmation = await store.confirm({
    key,
    expectedBytes: request.bytes,
    expectedChecksumSha256Hex: request.checksumSha256.toLowerCase(),
  });
  if (!confirmation.ok) {
    // El objeto no está o no es el prometido: la reunión vuelve a 'pending' para
    // que el usuario pueda reintentar, no queda atascada en 'uploading'.
    await meetingsRepo.setMediaState(meeting.id, confirmation.code === 'object_missing' ? 'pending' : 'invalid');
    throw new MeetingsApiError(confirmation.code, confirmation.detail);
  }

  return withTransaction(async (client) => {
    const executor = client as unknown as Queryable;
    await meetingsRepo.insertMedia(
      {
        tenantId: scope.tenantId,
        clientId: scope.clientId,
        meetingId: meeting.id,
        role: 'original',
        storageKey: key,
        bytes: confirmation.stat.bytes,
        checksumSha256: request.checksumSha256.toLowerCase(),
        contentType: confirmation.stat.contentType ?? 'application/octet-stream',
      },
      executor,
    );
    await meetingsRepo.setMediaState(meeting.id, 'ready', executor);

    const run =
      (await jobsRepo.getActiveRun(meeting.id, executor)) ??
      (await jobsRepo.createRun(
        {
          tenantId: scope.tenantId,
          clientId: scope.clientId,
          meetingId: meeting.id,
          trigger: 'initial',
          requestedByUserId: scope.userId ?? null,
        },
        executor,
      ));

    const { job } = await jobsRepo.createJob(
      {
        tenantId: scope.tenantId,
        clientId: scope.clientId,
        meetingId: meeting.id,
        runId: run.id,
        stage: 'normalize',
      },
      executor,
    );
    await jobsRepo.appendJobEvent(
      {
        tenantId: scope.tenantId,
        clientId: scope.clientId,
        meetingId: meeting.id,
        jobId: job.id,
        attempt: 0,
        kind: 'state_changed',
        stage: 'normalize',
        detail: { to: 'queued', reason: 'media_ready' },
      },
      executor,
    );

    return { mediaState: 'ready', runId: run.id, firstJob: { id: job.id, stage: 'normalize' } };
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Lado worker
// ══════════════════════════════════════════════════════════════════════════

export interface ClaimRequest {
  /** Telemetría declarada. Nunca se usa para autorizar nada. */
  readonly workerLabel?: string | null;
  readonly capabilities?: readonly string[];
}

export interface ClaimedInput {
  readonly role: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly bytes: number | null;
  readonly checksumSha256: string | null;
  readonly supportsRange: boolean;
}

export interface ClaimedJob {
  readonly jobId: string;
  readonly meetingId: string;
  readonly runId: string;
  readonly stage: JobStage;
  readonly attempt: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly inputs: readonly ClaimedInput[];
  readonly options: Record<string, unknown>;
  readonly languageHint: string | null;
}

/**
 * Reclama trabajo. Devuelve null cuando no hay nada reclamable, que la ruta
 * traduce a 204 y no a un error: «no hay trabajo» es el estado normal de una
 * cola vacía, no un fallo.
 *
 * Las capacidades que se usan para filtrar son las de la CREDENCIAL. Si el
 * worker manda `capabilities` en el cuerpo se INTERSECAN con las suyas —puede
 * pedir menos de lo que tiene, nunca más—, lo que permite a un proceso
 * declararse temporalmente sólo para una etapa sin necesidad de otra credencial.
 */
export async function claim(
  identity: WorkerIdentity,
  request: ClaimRequest,
  d: MeetingsServiceDeps,
): Promise<ClaimedJob | null> {
  const { store, leaseSeconds, rateLimiter } = deps(d);
  enforceRate(rateLimiter, identity.credentialId, 'claim');

  let capabilities = [...identity.capabilities];
  if (request.capabilities && request.capabilities.length > 0) {
    const asked = new Set(request.capabilities);
    capabilities = capabilities.filter((capability) => asked.has(capability));
  }
  if (capabilities.length === 0) return null;

  const workerLabel = normalizeLabel(request.workerLabel);

  const claimed = await withTransaction(async (client) => {
    const executor = client as unknown as Queryable;
    let minted: { token: string; hash: string } | null = null;

    const job = await jobsRepo.claimNextJob(
      {
        capabilities,
        leaseSeconds,
        credentialId: identity.credentialId,
        credentialLabel: identity.attributionLabel,
        workerLabel,
        tenantId: identity.scope === 'internal' ? null : identity.tenantId,
        leaseTokenHashFor: ({ id, attempt }) => {
          const result = mintLeaseToken({
            jobId: id,
            attempt,
            credentialId: identity.credentialId,
          });
          minted = { token: result.token, hash: result.tokenHash };
          return result.tokenHash;
        },
      },
      executor,
    );
    if (!job || !minted) return null;

    await jobsRepo.appendJobEvent(
      {
        tenantId: job.tenant_id,
        clientId: job.client_id,
        meetingId: job.meeting_id,
        jobId: job.id,
        attempt: job.attempts,
        kind: 'claimed',
        stage: job.stage,
        credentialId: identity.credentialId,
        workerLabel,
        detail: { pool: identity.poolSlug, environment: identity.environment },
      },
      executor,
    );

    // Los estados de la reunión pasan a 'running' en la misma transacción que
    // el claim: no existe el instante en que un job esté reclamado y la reunión
    // siga diciendo 'pending'.
    if (job.stage === 'transcribe') {
      await meetingsRepo.updatePipelineState(job.meeting_id, { transcriptState: 'running' }, executor);
    } else if (job.stage === 'diarize') {
      await meetingsRepo.updatePipelineState(job.meeting_id, { diarizationState: 'running' }, executor);
    }

    return { job, token: (minted as { token: string; hash: string }).token };
  });

  if (!claimed) return null;
  const { job, token } = claimed;

  const meeting = await meetingsRepo.getMeetingById(job.meeting_id);
  const run = await jobsRepo.getActiveRun(job.meeting_id);
  const inputs = await buildInputs(job, store);

  return {
    jobId: job.id,
    meetingId: job.meeting_id,
    runId: job.run_id,
    stage: job.stage,
    attempt: job.attempts,
    leaseToken: token,
    leaseExpiresAt: (job.lease_expires_at as Date).toISOString(),
    inputs,
    options: run?.requested_options ?? {},
    languageHint: meeting?.language_hint ?? null,
  };
}

/**
 * Los insumos de cada etapa, con su URL firmada. Las claves se DERIVAN, no se
 * leen de la petición ni se buscan por texto: derivarlas es lo que garantiza que
 * el insumo es el de este run y no el de otro (ver los contratos de etapa §7).
 */
async function buildInputs(
  job: jobsRepo.JobRow,
  store: PrivateObjectStore,
): Promise<ClaimedInput[]> {
  const scope = { tenantId: job.tenant_id, clientId: job.client_id, meetingId: job.meeting_id };
  const inputs: ClaimedInput[] = [];

  const addMedia = async (key: string, role: string): Promise<void> => {
    const media = await meetingsRepo.findMediaByKey(key);
    if (!media) return;
    const signed = store.signGet({ key, forRangeReads: true });
    inputs.push({
      role,
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      bytes: Number(media.bytes),
      checksumSha256: media.checksum_sha256,
      supportsRange: store.capabilities.range,
    });
  };

  if (job.stage === 'normalize') {
    await addMedia(originalMediaKey(scope), 'original');
    return inputs;
  }

  // transcribe y diarize consumen el audio normalizado de ESTE run. El intento
  // que lo produjo no es necesariamente el mismo que el del job actual, así que
  // se busca la fila de meeting_media cuya clave está bajo el prefijo del run.
  const normalizedJob = (await jobsRepo.listJobsForMeeting(job.meeting_id)).find(
    (candidate) => candidate.run_id === job.run_id && candidate.stage === 'normalize',
  );
  if (normalizedJob) {
    for (let attempt = normalizedJob.attempts; attempt >= 1; attempt -= 1) {
      const key = artifactKey({ ...scope, runId: job.run_id, attempt, role: 'normalized' });
      const media = await meetingsRepo.findMediaByKey(key);
      if (media) {
        await addMedia(key, 'normalized');
        break;
      }
    }
  }

  if (job.stage === 'diarize') {
    const transcribeJob = (await jobsRepo.listJobsForMeeting(job.meeting_id)).find(
      (candidate) => candidate.run_id === job.run_id && candidate.stage === 'transcribe',
    );
    if (transcribeJob) {
      const upload = await artifactsRepo.findUpload(
        transcribeJob.id,
        transcribeJob.attempts,
        'transcript',
      );
      if (upload && (upload.state === 'verified' || upload.state === 'ingested')) {
        const signed = store.signGet({ key: upload.storage_key, forRangeReads: true });
        inputs.push({
          role: 'transcript',
          url: signed.url,
          expiresAt: signed.expiresAt.toISOString(),
          bytes: upload.observed_bytes === null ? null : Number(upload.observed_bytes),
          checksumSha256: upload.observed_checksum_sha256,
          supportsRange: store.capabilities.range,
        });
      }
    }
  }

  return inputs;
}

function normalizeLabel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 120);
  return trimmed.length > 0 ? trimmed : null;
}

export interface LeaseProof {
  readonly jobId: string;
  readonly attempt: number;
  readonly leaseToken: string;
}

interface AuthorizedJob {
  readonly job: jobsRepo.JobRow;
}

/**
 * La comprobación que gobierna TODA operación sobre un job reclamado.
 *
 * El orden de los rechazos importa y es deliberado:
 *
 *   1. El job no existe → `not_found`. Lo mismo que si es de otro tenant, así
 *      que un uuid adivinado no distingue los dos casos.
 *   2. La credencial que pide no es la que sostiene el lease → `not_found`
 *      también. No `lease_invalid`: decir «este job existe pero no es tuyo» le
 *      confirma a otro tenant que el uuid es real.
 *   3. El intento que declara no es el actual → `attempt_stale`. Éste SÍ se
 *      distingue, porque es el worker legítimo llegando tarde y necesita saber
 *      que su trabajo ya no vale para no reintentarlo.
 *   4. El job no está en un estado con lease → `invalid_transition`.
 *   5. El token no verifica → `lease_invalid`.
 *   6. El lease caducó → `lease_expired`.
 */
async function authorizeLease(
  identity: WorkerIdentity,
  proof: LeaseProof,
  executor?: Queryable,
  options?: { allowTerminalIdempotent?: boolean },
): Promise<AuthorizedJob> {
  const job = await jobsRepo.getJobById(proof.jobId, executor);
  if (!job) throw notFound();
  if (identity.scope === 'single_tenant' && job.tenant_id !== identity.tenantId) throw notFound();
  if (job.leased_credential_id !== identity.credentialId) throw notFound();

  if (job.attempts !== proof.attempt) {
    throw new MeetingsApiError(
      'attempt_stale',
      `El intento ${proof.attempt} ya no está en curso (el actual es ${job.attempts}).`,
    );
  }

  const terminal = job.status === 'succeeded' || job.status === 'failed';
  if (terminal && options?.allowTerminalIdempotent) {
    // Reenvío de un complete/fail que ya se aplicó. No se verifica el token
    // porque ya se limpió al cerrar el job; la credencial y el intento, que
    // sí se conservan, son la prueba suficiente de que es el mismo worker.
    return { job };
  }
  if (job.status !== 'leased' && job.status !== 'uploading_result') {
    throw new MeetingsApiError('invalid_transition', `El job está en estado '${job.status}'.`);
  }
  if (
    !verifyLeaseToken(proof.leaseToken, job.lease_token_hash, {
      jobId: job.id,
      attempt: job.attempts,
      credentialId: identity.credentialId,
    })
  ) {
    throw new MeetingsApiError('lease_invalid', 'El token de lease no es válido para este job.');
  }
  if (job.lease_expires_at !== null && job.lease_expires_at.getTime() <= Date.now()) {
    throw new MeetingsApiError('lease_expired', 'El lease ha caducado; el job volverá a la cola.');
  }
  return { job };
}

export interface HeartbeatRequest extends LeaseProof {
  readonly progressPct?: number | null;
}

export async function heartbeat(
  identity: WorkerIdentity,
  request: HeartbeatRequest,
  d: MeetingsServiceDeps,
): Promise<{ leaseExpiresAt: string; cancelled: boolean }> {
  const { leaseSeconds, rateLimiter } = deps(d);
  enforceRate(rateLimiter, identity.credentialId, 'heartbeat');

  const { job } = await authorizeLease(identity, request);

  let progress: number | null = null;
  if (request.progressPct !== undefined && request.progressPct !== null) {
    if (!Number.isInteger(request.progressPct) || request.progressPct < 0 || request.progressPct > 100) {
      throw invalidRequest('progressPct debe ser un entero entre 0 y 100.');
    }
    progress = request.progressPct;
  }

  const expiresAt = await jobsRepo.renewLease(job.id, leaseSeconds, progress);
  if (!expiresAt) throw new MeetingsApiError('invalid_transition', 'El job ya no admite renovación.');

  // La cancelación es COOPERATIVA: mai no puede matar un proceso ajeno, así que
  // la señal viaja en la respuesta del latido, que es lo único que el worker
  // consulta durante un trabajo largo.
  const meeting = await meetingsRepo.getMeetingById(job.meeting_id);
  return { leaseExpiresAt: expiresAt.toISOString(), cancelled: meeting?.cancelled_at !== null };
}

export interface FailRequest extends LeaseProof {
  readonly failureCode: string;
  readonly failureDetail?: string | null;
}

export async function fail(
  identity: WorkerIdentity,
  request: FailRequest,
  d: MeetingsServiceDeps,
): Promise<{ status: string; requeued: boolean; attempts: number }> {
  const { rateLimiter, store } = deps(d);
  enforceRate(rateLimiter, identity.credentialId, 'result');

  const code = (request.failureCode ?? '').trim();
  if (code.length === 0 || code.length > 80) {
    throw invalidRequest('failureCode es obligatorio y debe tener 80 caracteres o menos.');
  }

  return withTransaction(async (client) => {
    const executor = client as unknown as Queryable;
    const { job } = await authorizeLease(identity, request, executor, {
      allowTerminalIdempotent: true,
    });

    // Reenvío de un fail ya aplicado: se responde el mismo resultado.
    if (job.status === 'failed' || job.status === 'succeeded') {
      return { status: job.status, requeued: false, attempts: job.attempts };
    }

    const outcome = await jobsRepo.markFailed(
      job.id,
      code,
      typeof request.failureDetail === 'string' ? request.failureDetail.slice(0, 2000) : null,
      executor,
    );
    if (!outcome) throw new MeetingsApiError('invalid_transition', 'El job ya no admite fallo.');

    await jobsRepo.appendJobEvent(
      {
        tenantId: job.tenant_id,
        clientId: job.client_id,
        meetingId: job.meeting_id,
        jobId: job.id,
        attempt: job.attempts,
        kind: outcome.requeued ? 'retried' : 'failed',
        stage: job.stage,
        credentialId: identity.credentialId,
        detail: { failure_code: code },
      },
      executor,
    );

    if (!outcome.requeued) {
      await resolveTerminalFailure(job, code, store, executor);
    }

    return { status: outcome.job.status, requeued: outcome.requeued, attempts: outcome.job.attempts };
  });
}

/**
 * Un fallo definitivo. `diarize` es el único caso con fallo PARCIAL: el
 * transcript se ingiere igual y la reunión queda «completada con avisos». Las
 * otras dos etapas hunden el run, porque sin su salida no hay nada que ingerir.
 */
async function resolveTerminalFailure(
  job: jobsRepo.JobRow,
  failureCode: string,
  store: PrivateObjectStore,
  executor: Queryable,
): Promise<void> {
  if (job.stage === 'diarize') {
    // El transcript verificado se relee del almacenamiento: es el objeto cuyo
    // checksum ya se comprobó, y arrastrarlo entre dos peticiones separadas por
    // minutos no aportaría nada salvo memoria.
    await ingestAfterDiarizationFailure(job, failureCode, store, executor);
    return;
  }
  await meetingsRepo.updatePipelineState(
    job.meeting_id,
    {
      transcriptState: 'failed',
      appendWarnings: [{ code: `${job.stage}_failed`, failure_code: failureCode, at: new Date().toISOString() }],
    },
    executor,
  );
  await jobsRepo.finishRun(job.run_id, 'failed', executor);
}

// ── Artefactos ─────────────────────────────────────────────────────────────

/** La etapa determina el `kind`: el worker no lo elige. */
const STAGE_ARTIFACT: Record<JobStage, ArtifactKind> = {
  normalize: 'normalized_media',
  transcribe: 'transcript',
  diarize: 'diarization',
  analyze: 'analysis',
};

const ARTIFACT_ROLE = {
  normalized_media: 'normalized',
  transcript: 'transcript',
  diarization: 'diarization',
} as const;

export interface ResultInitRequest extends LeaseProof {
  readonly bytes: number;
  readonly checksumSha256: string;
  readonly itemCount?: number | null;
  readonly schemaVersion?: number;
}

export async function resultInit(
  identity: WorkerIdentity,
  request: ResultInitRequest,
  d: MeetingsServiceDeps,
): Promise<SignedUploadResponse> {
  const { store, rateLimiter } = deps(d);
  enforceRate(rateLimiter, identity.credentialId, 'result');

  const { job } = await authorizeLease(identity, request);
  const kind = STAGE_ARTIFACT[job.stage];
  if (kind === 'analysis') {
    throw new MeetingsApiError('invalid_transition', 'La etapa analyze no está habilitada todavía.');
  }
  if (!Number.isInteger(request.bytes) || request.bytes <= 0) {
    throw invalidRequest('bytes debe ser un entero positivo.');
  }
  if (identity.maxBytes !== null && request.bytes > identity.maxBytes) {
    throw new MeetingsApiError('media_rejected', 'El artefacto supera el máximo del pool.');
  }
  if (!/^[0-9a-f]{64}$/i.test(request.checksumSha256)) {
    throw invalidRequest('checksumSha256 debe ser un SHA-256 en hexadecimal.');
  }

  const role = ARTIFACT_ROLE[kind as keyof typeof ARTIFACT_ROLE];
  const key = artifactKey({
    tenantId: job.tenant_id,
    clientId: job.client_id,
    meetingId: job.meeting_id,
    runId: job.run_id,
    attempt: job.attempts,
    role,
  });
  const contentType = ROLE_CONTENT_TYPE[role];
  const contentEncoding = ROLE_CONTENT_ENCODING[role];

  const signed = store.signPut({
    key,
    contentType,
    contentLength: request.bytes,
    checksumSha256Hex: request.checksumSha256.toLowerCase(),
    ...(contentEncoding ? { contentEncoding } : {}),
  });

  const { upload } = await artifactsRepo.initResultUpload({
    tenantId: job.tenant_id,
    clientId: job.client_id,
    meetingId: job.meeting_id,
    jobId: job.id,
    attempt: job.attempts,
    kind,
    schemaVersion: request.schemaVersion ?? 1,
    storageKey: key,
    contentType,
    contentEncoding,
    putExpiresAt: signed.expiresAt,
  });
  await artifactsRepo.markUploaded(
    upload.id,
    {
      bytes: request.bytes,
      checksumSha256: request.checksumSha256.toLowerCase(),
      itemCount: request.itemCount ?? null,
    },
    undefined,
  );
  await jobsRepo.markUploadingResult(job.id);

  return {
    url: signed.url,
    method: 'PUT',
    requiredHeaders: signed.requiredHeaders,
    expiresAt: signed.expiresAt.toISOString(),
    storageKey: key,
  };
}

export interface ResultCompleteRequest extends LeaseProof {
  readonly bytes: number;
  readonly checksumSha256: string;
  /** Sólo para `normalize`: lo que ffprobe midió del audio normalizado. */
  readonly probe?: {
    readonly durationSeconds?: number | null;
    readonly sampleRate?: number | null;
    readonly channels?: number | null;
    readonly codec?: string | null;
  };
}

export interface ResultCompleteResponse {
  readonly status: 'succeeded';
  readonly nextJob: { readonly id: string; readonly stage: JobStage } | null;
  readonly ingested: boolean;
  readonly transcriptId: string | null;
}

/**
 * Verifica el artefacto y cierra la etapa. Todo dentro de una transacción, con
 * la creación del siguiente job incluida — que es el requisito explícito de
 * T-3: si el job siguiente se creara después de confirmar, un fallo en medio
 * dejaría una etapa cerrada y ninguna otra en cola, y la reunión se quedaría
 * quieta sin que nada dijera por qué.
 */
export async function resultComplete(
  identity: WorkerIdentity,
  request: ResultCompleteRequest,
  d: MeetingsServiceDeps,
): Promise<ResultCompleteResponse> {
  const { store, rateLimiter } = deps(d);
  enforceRate(rateLimiter, identity.credentialId, 'result');

  const preflight = await authorizeLease(identity, request, undefined, {
    allowTerminalIdempotent: true,
  });
  const job = preflight.job;
  const kind = STAGE_ARTIFACT[job.stage];
  if (!/^[0-9a-f]{64}$/i.test(request.checksumSha256)) {
    throw invalidRequest('checksumSha256 debe ser un SHA-256 en hexadecimal.');
  }

  const upload = await artifactsRepo.findUpload(job.id, job.attempts, kind);
  if (!upload) {
    throw new MeetingsApiError('invalid_transition', 'No hay una subida iniciada para este intento.');
  }
  if (!keyBelongsToMeeting(upload.storage_key, {
    tenantId: job.tenant_id,
    clientId: job.client_id,
    meetingId: job.meeting_id,
  })) {
    // Imposible salvo corrupción: la clave la derivó mai. Se comprueba antes de
    // firmar cualquier lectura, no después.
    throw new MeetingsApiError('internal', 'La clave del artefacto no pertenece a la reunión.');
  }

  // Reenvío después de haber cerrado: se responde lo mismo sin volver a verificar.
  if (job.status === 'succeeded') {
    const meeting = await meetingsRepo.getMeetingById(job.meeting_id);
    return {
      status: 'succeeded',
      nextJob: await findNextJob(job),
      ingested: upload.state === 'ingested',
      transcriptId: meeting?.active_transcript_id ?? null,
    };
  }

  if (upload.state !== 'ingested' && upload.state !== 'verified') {
    const confirmation = await store.confirm({
      key: upload.storage_key,
      expectedBytes: request.bytes,
      expectedChecksumSha256Hex: request.checksumSha256.toLowerCase(),
      expectedContentType: upload.content_type,
    });
    if (!confirmation.ok) {
      await artifactsRepo.markRejected(upload.id, confirmation.code, confirmation.detail);
      throw new MeetingsApiError(confirmation.code, confirmation.detail);
    }
    // El checksum declarado en `init` y el declarado ahora tienen que coincidir:
    // si no, el worker cambió de opinión sobre lo que subió.
    if (
      upload.declared_checksum_sha256 !== null &&
      upload.declared_checksum_sha256.toLowerCase() !== request.checksumSha256.toLowerCase()
    ) {
      await artifactsRepo.markRejected(upload.id, 'checksum_mismatch', 'El checksum difiere del declarado en init.');
      throw new MeetingsApiError('checksum_mismatch', 'El checksum difiere del declarado en init.');
    }
    await artifactsRepo.markVerified(upload.id, {
      bytes: confirmation.stat.bytes,
      checksumSha256: request.checksumSha256.toLowerCase(),
    });
  }

  // Los artefactos NDJSON se parsean ANTES de abrir la transacción: descargar y
  // validar dentro mantendría abierta una transacción durante una petición de
  // red, con la fila del job bloqueada.
  let transcript: ParsedTranscript | null = null;
  let diarization: ParsedDiarization | null = null;
  let transcriptForRun: ParsedTranscript | null = null;
  try {
    if (kind === 'transcript') {
      transcript = parseTranscriptArtifact(await store.getBytes(upload.storage_key));
      transcriptForRun = transcript;
    } else if (kind === 'diarization') {
      diarization = parseDiarizationArtifact(await store.getBytes(upload.storage_key));
      // La ingestión necesita AMBOS artefactos. El de transcripción se relee de
      // su objeto verificado: es lo que garantiza que se ingiere exactamente el
      // contenido cuyo checksum se comprobó, y no una copia en memoria que
      // habría que arrastrar entre dos peticiones separadas por minutos.
      const verified = await artifactsRepo.findVerifiedForRun(job.run_id);
      const transcriptUpload = verified.find((item) => item.kind === 'transcript');
      if (!transcriptUpload) {
        throw new MeetingsApiError(
          'invalid_transition',
          'No hay transcript verificado en este run; diarize no puede cerrarse.',
        );
      }
      transcriptForRun = parseTranscriptArtifact(await store.getBytes(transcriptUpload.storage_key));
    }
  } catch (cause) {
    if (cause instanceof MeetingsApiError) throw cause;
    if (cause instanceof ArtifactError) {
      await artifactsRepo.markRejected(upload.id, cause.code, cause.message);
      throw new MeetingsApiError(cause.code, cause.message);
    }
    throw new MeetingsApiError('storage_unavailable', (cause as Error).message);
  }

  return withTransaction(async (client) => {
    const executor = client as unknown as Queryable;
    // Se re-autoriza DENTRO de la transacción: entre el preflight y aquí el
    // lease pudo caducar y el job volver a la cola con otro intento.
    const { job: locked } = await authorizeLease(identity, request, executor, {
      allowTerminalIdempotent: true,
    });
    if (locked.status === 'succeeded') {
      const meeting = await meetingsRepo.getMeetingById(locked.meeting_id, executor);
      return {
        status: 'succeeded' as const,
        nextJob: await findNextJob(locked, executor),
        ingested: true,
        transcriptId: meeting?.active_transcript_id ?? null,
      };
    }

    await jobsRepo.markSucceeded(locked.id, executor);
    await jobsRepo.appendJobEvent(
      {
        tenantId: locked.tenant_id,
        clientId: locked.client_id,
        meetingId: locked.meeting_id,
        jobId: locked.id,
        attempt: locked.attempts,
        kind: 'state_changed',
        stage: locked.stage,
        credentialId: identity.credentialId,
        detail: { to: 'succeeded', kind },
      },
      executor,
    );

    let nextJob: { id: string; stage: JobStage } | null = null;
    let ingested = false;
    let transcriptId: string | null = null;

    if (kind === 'normalized_media') {
      await meetingsRepo.insertMedia(
        {
          tenantId: locked.tenant_id,
          clientId: locked.client_id,
          meetingId: locked.meeting_id,
          role: 'normalized',
          storageKey: upload.storage_key,
          bytes: request.bytes,
          checksumSha256: request.checksumSha256.toLowerCase(),
          contentType: upload.content_type,
          durationSeconds: request.probe?.durationSeconds ?? null,
          sampleRate: request.probe?.sampleRate ?? null,
          channels: request.probe?.channels ?? null,
          codec: request.probe?.codec ?? null,
          probeOk: true,
        },
        executor,
      );
      await artifactsRepo.markIngested([upload.id], executor);
      const created = await jobsRepo.createJob(
        {
          tenantId: locked.tenant_id,
          clientId: locked.client_id,
          meetingId: locked.meeting_id,
          runId: locked.run_id,
          stage: 'transcribe',
        },
        executor,
      );
      nextJob = { id: created.job.id, stage: 'transcribe' };
    } else if (kind === 'transcript') {
      const run = await jobsRepo.getActiveRun(locked.meeting_id, executor);
      const wantsDiarization = run?.requested_options?.diarize !== false;
      if (wantsDiarization) {
        const created = await jobsRepo.createJob(
          {
            tenantId: locked.tenant_id,
            clientId: locked.client_id,
            meetingId: locked.meeting_id,
            runId: locked.run_id,
            stage: 'diarize',
          },
          executor,
        );
        nextJob = { id: created.job.id, stage: 'diarize' };
      } else {
        const result = await ingestRun(locked, { diarizationOutcome: 'skipped' }, executor, transcript);
        ingested = result.ingested;
        transcriptId = result.transcriptId;
      }
    } else if (kind === 'diarization') {
      const result = await ingestRun(
        locked,
        { diarizationOutcome: 'ready', diarization },
        executor,
        transcriptForRun,
      );
      ingested = result.ingested;
      transcriptId = result.transcriptId;
    }

    if (nextJob) {
      await jobsRepo.appendJobEvent(
        {
          tenantId: locked.tenant_id,
          clientId: locked.client_id,
          meetingId: locked.meeting_id,
          jobId: nextJob.id,
          attempt: 0,
          kind: 'state_changed',
          stage: nextJob.stage,
          detail: { to: 'queued', reason: `${locked.stage}_succeeded` },
        },
        executor,
      );
    }

    return { status: 'succeeded' as const, nextJob, ingested, transcriptId };
  });
}

async function findNextJob(
  job: jobsRepo.JobRow,
  executor?: Queryable,
): Promise<{ id: string; stage: JobStage } | null> {
  const order: JobStage[] = ['normalize', 'transcribe', 'diarize', 'analyze'];
  const jobs = await jobsRepo.listJobsForMeeting(job.meeting_id, executor);
  const next = order[order.indexOf(job.stage) + 1];
  const found = jobs.find((candidate) => candidate.run_id === job.run_id && candidate.stage === next);
  return found ? { id: found.id, stage: found.stage } : null;
}

interface IngestOptions {
  readonly diarizationOutcome: 'ready' | 'failed' | 'skipped';
  readonly diarization?: ParsedDiarization | null;
  readonly failureCode?: string;
}

/**
 * La ingestión: escribe la versión de transcript UNA vez, con o sin hablantes.
 *
 * Cuando llega desde `diarize`, el artefacto de transcripción se relee de
 * `meeting_result_uploads` — se verificó en su momento y sigue en el
 * almacenamiento. Releerlo es más barato que arrastrarlo entre dos peticiones
 * HTTP separadas por minutos, y garantiza que lo que se ingiere es el objeto
 * cuyo checksum se comprobó.
 */
async function ingestRun(
  job: jobsRepo.JobRow,
  options: IngestOptions,
  executor: Queryable,
  parsedTranscript?: ParsedTranscript | null,
): Promise<{ ingested: boolean; transcriptId: string | null }> {
  const uploads = await artifactsRepo.findVerifiedForRun(job.run_id, executor);
  const transcriptUpload = uploads.find((upload) => upload.kind === 'transcript');
  if (!transcriptUpload) {
    // Sin transcript no hay nada que ingerir: el run muere.
    await meetingsRepo.updatePipelineState(
      job.meeting_id,
      {
        transcriptState: 'failed',
        appendWarnings: [{ code: 'transcript_missing', at: new Date().toISOString() }],
      },
      executor,
    );
    await jobsRepo.finishRun(job.run_id, 'failed', executor);
    return { ingested: false, transcriptId: null };
  }

  let transcript = parsedTranscript ?? null;
  if (!transcript) {
    // La lectura del artefacto no puede hacerse aquí sin pasar el store; el
    // llamador la hace y la inyecta. Si llegamos sin ella es un fallo de
    // programación, no un estado del sistema.
    throw new Error('ingestRun: falta el transcript parseado');
  }

  const diarization = options.diarizationOutcome === 'ready' ? options.diarization ?? null : null;
  const alignment = alignSegments(transcript.segments, diarization?.turns ?? null);

  const { version, created } = await transcriptsRepo.ingestTranscriptVersion(
    {
      tenantId: job.tenant_id,
      clientId: job.client_id,
      meetingId: job.meeting_id,
      runId: job.run_id,
      whisperModel: transcript.header.model,
      diarizationBackend: diarization?.header.backend ?? null,
      language: transcript.header.language,
      durationSeconds: transcript.header.durationSeconds,
      schemaVersion: transcript.header.schemaVersion,
      metrics: {
        device: transcript.header.device,
        compute_type: transcript.header.computeType,
        ...(diarization ? { speaker_count: diarization.header.speakerCount } : {}),
      },
      segments: alignment.segments,
      talkSharePct: alignment.talkSharePct,
    },
    executor,
  );

  const ingestedIds = uploads.filter((upload) => upload.state === 'verified').map((upload) => upload.id);
  await artifactsRepo.markIngested(ingestedIds, executor);

  const diarizationState =
    options.diarizationOutcome === 'ready'
      ? 'ready'
      : options.diarizationOutcome === 'skipped'
        ? 'skipped'
        : 'failed';
  const warnings =
    options.diarizationOutcome === 'failed'
      ? [
          {
            code: 'diarization_failed',
            failure_code: options.failureCode ?? 'unknown',
            at: new Date().toISOString(),
          },
        ]
      : [];

  await meetingsRepo.updatePipelineState(
    job.meeting_id,
    {
      transcriptState: 'ready',
      diarizationState,
      activeTranscriptId: version.id,
      ...(warnings.length > 0 ? { appendWarnings: warnings } : {}),
    },
    executor,
  );
  await jobsRepo.finishRun(
    job.run_id,
    options.diarizationOutcome === 'failed' ? 'partial' : 'succeeded',
    executor,
  );
  await jobsRepo.appendJobEvent(
    {
      tenantId: job.tenant_id,
      clientId: job.client_id,
      meetingId: job.meeting_id,
      jobId: job.id,
      attempt: job.attempts,
      kind: 'result_ingested',
      stage: job.stage,
      detail: {
        transcript_id: version.id,
        segments: alignment.segments.length,
        diarization: diarizationState,
      },
    },
    executor,
  );

  return { ingested: created, transcriptId: version.id };
}

/**
 * Ingestión que viene de un `diarize` FALLIDO: hay que releer el transcript
 * verificado del almacenamiento, porque el que llegó en esta petición era el de
 * diarización (o no llegó ninguno).
 */
export async function ingestAfterDiarizationFailure(
  job: jobsRepo.JobRow,
  failureCode: string,
  store: PrivateObjectStore,
  executor: Queryable,
): Promise<void> {
  const uploads = await artifactsRepo.findVerifiedForRun(job.run_id, executor);
  const transcriptUpload = uploads.find((upload) => upload.kind === 'transcript');
  if (!transcriptUpload) {
    // Diarize falló y tampoco hay transcript: no hay nada que salvar.
    await meetingsRepo.updatePipelineState(
      job.meeting_id,
      {
        transcriptState: 'failed',
        diarizationState: 'failed',
        appendWarnings: [{ code: 'transcript_missing', at: new Date().toISOString() }],
      },
      executor,
    );
    await jobsRepo.finishRun(job.run_id, 'failed', executor);
    return;
  }
  const parsed = parseTranscriptArtifact(await store.getBytes(transcriptUpload.storage_key));
  await ingestRun(job, { diarizationOutcome: 'failed', failureCode }, executor, parsed);
}

// ── Barrido y cancelación ──────────────────────────────────────────────────

export async function requeueExpiredLeases(): Promise<{
  requeued: number;
  abandoned: number;
  jobs: readonly jobsRepo.RequeuedJob[];
}> {
  const jobs = await jobsRepo.requeueExpiredLeases();
  for (const job of jobs) {
    const full = await jobsRepo.getJobById(job.id);
    if (!full) continue;
    await jobsRepo.appendJobEvent({
      tenantId: full.tenant_id,
      clientId: full.client_id,
      meetingId: full.meeting_id,
      jobId: full.id,
      attempt: full.attempts,
      kind: 'lease_expired',
      stage: full.stage,
      detail: { to: full.status },
    });
  }
  return {
    requeued: jobs.filter((job) => job.status === 'queued').length,
    abandoned: jobs.filter((job) => job.status === 'abandoned').length,
    jobs,
  };
}

export async function cancelMeeting(
  scope: AppScope,
  meetingId: string,
): Promise<{ cancelled: boolean; jobsCancelled: number }> {
  const meeting = await meetingsRepo.getMeetingScoped(meetingId, scope.tenantId, scope.clientId);
  if (!meeting) throw notFound();

  return withTransaction(async (client) => {
    const executor = client as unknown as Queryable;
    const cancelled = await meetingsRepo.cancelMeeting(
      meetingId,
      scope.tenantId,
      scope.clientId,
      scope.userLabel ?? scope.userId ?? 'system',
      scope.userId ?? null,
      executor,
    );
    // Los jobs en vuelo se marcan cancelados; el worker se enterará en su
    // siguiente latido. Lo que NO se hace es esperar a que responda: una
    // cancelación que depende de que un proceso remoto conteste no es una
    // cancelación.
    const jobsCancelled = await jobsRepo.cancelJobsForMeeting(meetingId, executor);
    const run = await jobsRepo.getActiveRun(meetingId, executor);
    if (run) await jobsRepo.finishRun(run.id, 'cancelled', executor);
    if (cancelled) {
      await jobsRepo.appendJobEvent(
        {
          tenantId: scope.tenantId,
          clientId: scope.clientId,
          meetingId,
          jobId: null,
          attempt: 0,
          kind: 'cancelled',
          detail: { jobs_cancelled: jobsCancelled },
        },
        executor,
      );
    }
    return { cancelled, jobsCancelled };
  });
}

// ── Lectura para la UI ─────────────────────────────────────────────────────

export interface MeetingStateResponse {
  readonly id: string;
  readonly title: string;
  readonly mediaState: string;
  readonly transcriptState: string;
  readonly diarizationState: string;
  readonly analysisState: string;
  readonly cancelledAt: string | null;
  readonly warnings: readonly unknown[];
  readonly activeTranscript: {
    readonly id: string;
    readonly language: string | null;
    readonly durationSeconds: number;
    readonly segmentCount: number;
    readonly whisperModel: string;
    readonly diarizationBackend: string | null;
    readonly speakers: readonly {
      readonly label: string;
      readonly displayName: string | null;
      readonly talkSharePct: number | null;
    }[];
  } | null;
  readonly jobs: readonly {
    readonly id: string;
    readonly stage: string;
    readonly status: string;
    readonly attempts: number;
    readonly progressPct: number | null;
    readonly failureCode: string | null;
  }[];
  readonly events: readonly { readonly kind: string; readonly stage: string | null; readonly at: string }[];
}

export async function getMeetingState(
  scope: AppScope,
  meetingId: string,
): Promise<MeetingStateResponse> {
  const meeting = await meetingsRepo.getMeetingScoped(meetingId, scope.tenantId, scope.clientId);
  if (!meeting) throw notFound();

  const [jobs, events, transcript] = await Promise.all([
    jobsRepo.listJobsForMeeting(meetingId),
    jobsRepo.listEventsForMeeting(meetingId, 50),
    transcriptsRepo.getActiveTranscript(meetingId),
  ]);

  const speakers = transcript ? await transcriptsRepo.listTranscriptSpeakers(transcript.id) : [];

  return {
    id: meeting.id,
    title: meeting.title,
    mediaState: meeting.media_state,
    transcriptState: meeting.transcript_state,
    diarizationState: meeting.diarization_state,
    analysisState: meeting.analysis_state,
    cancelledAt: meeting.cancelled_at?.toISOString() ?? null,
    warnings: meeting.warnings,
    activeTranscript: transcript
      ? {
          id: transcript.id,
          language: transcript.language,
          durationSeconds: Number(transcript.duration_seconds),
          segmentCount: transcript.segment_count,
          whisperModel: transcript.whisper_model,
          diarizationBackend: transcript.diarization_backend,
          speakers: speakers.map((speaker) => ({
            label: speaker.speaker_label,
            displayName: speaker.display_name,
            talkSharePct: speaker.talk_share_pct === null ? null : Number(speaker.talk_share_pct),
          })),
        }
      : null,
    jobs: jobs.map((job) => ({
      id: job.id,
      stage: job.stage,
      status: job.status,
      attempts: job.attempts,
      progressPct: job.progress_pct,
      failureCode: job.failure_code,
    })),
    events: events.map((event) => ({
      kind: event.kind,
      stage: event.stage,
      at: event.at.toISOString(),
    })),
  };
}
