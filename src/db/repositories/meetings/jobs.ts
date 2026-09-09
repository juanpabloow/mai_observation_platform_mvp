import { q, type Queryable } from './types.js';
import type { JobStage, JobStatus } from './types.js';

/**
 * Runs, jobs y el log de eventos.
 *
 * ── El claim ────────────────────────────────────────────────────────────────
 *
 * `claimNextJob` es la única operación de todo T-3 donde dos procesos compiten
 * por la misma fila, así que es la única que necesita explicación.
 *
 * `FOR UPDATE SKIP LOCKED` sobre un `SELECT ... LIMIT 1` dentro de un CTE, y el
 * `UPDATE` en el mismo statement. Tres propiedades salen de ahí:
 *
 *   · **SKIP LOCKED** hace que dos workers concurrentes no se bloqueen entre sí:
 *     el segundo salta la fila que el primero tiene tomada y coge la siguiente.
 *     Con `FOR UPDATE` a secas, el segundo esperaría al primero y el claim se
 *     serializaría; con `SELECT` sin bloqueo, los dos se llevarían el mismo job.
 *   · **Un solo statement** significa que no hay ventana entre elegir y marcar.
 *     Un SELECT y luego un UPDATE en dos viajes, aun en la misma transacción,
 *     deja el `WHERE status = 'queued'` a merced de lo que pase en medio.
 *   · **El WHERE del UPDATE repite `status = 'queued'`**. Es cinturón y
 *     tirantes: si el CTE devolviera una fila que ya cambió de estado, el UPDATE
 *     no afecta nada y el claim devuelve vacío en vez de pisar un lease ajeno.
 *
 * El filtro de capacidad es `requires <@ $1::text[]`: el job exige un conjunto
 * de capacidades y el pool tiene que contenerlo. No `&&` (intersecta), que
 * dejaría reclamar un job cuyas capacidades el pool sólo cubre en parte.
 */

// ── Runs ───────────────────────────────────────────────────────────────────

export interface RunRow {
  id: string;
  tenant_id: string;
  client_id: string;
  meeting_id: string;
  run_number: number;
  trigger: string;
  requested_options: Record<string, unknown>;
  started_at: Date | null;
  finished_at: Date | null;
  outcome: string | null;
  created_at: Date;
}

export async function createRun(
  input: {
    tenantId: string;
    clientId: string;
    meetingId: string;
    trigger: 'initial' | 'reprocess' | 'import' | 'backfill';
    requestedOptions?: Record<string, unknown>;
    requestedByUserId?: string | null;
  },
  executor?: Queryable,
): Promise<RunRow> {
  // El número de run se calcula en el propio INSERT: leerlo antes y sumarle uno
  // en JS dejaría una ventana en la que dos reprocesamientos eligen el mismo, y
  // `runs_number_key UNIQUE (meeting_id, run_number)` los rechazaría a los dos.
  const result = await q(executor).query<RunRow>(
    `INSERT INTO meeting_processing_runs
       (tenant_id, client_id, meeting_id, run_number, trigger, requested_options,
        requested_by_user_id, started_at)
     SELECT $1, $2, $3,
            COALESCE(MAX(run_number), 0) + 1,
            $4, $5::jsonb, $6, now()
       FROM meeting_processing_runs WHERE meeting_id = $3
     RETURNING *`,
    [
      input.tenantId,
      input.clientId,
      input.meetingId,
      input.trigger,
      JSON.stringify(input.requestedOptions ?? {}),
      input.requestedByUserId ?? null,
    ],
  );
  return result.rows[0];
}

export async function getActiveRun(
  meetingId: string,
  executor?: Queryable,
): Promise<RunRow | null> {
  const result = await q(executor).query<RunRow>(
    `SELECT * FROM meeting_processing_runs
      WHERE meeting_id = $1 AND finished_at IS NULL`,
    [meetingId],
  );
  return result.rows[0] ?? null;
}

export async function finishRun(
  runId: string,
  outcome: 'succeeded' | 'partial' | 'failed' | 'cancelled',
  executor?: Queryable,
): Promise<void> {
  await q(executor).query(
    `UPDATE meeting_processing_runs
        SET finished_at = now(), outcome = $2
      WHERE id = $1 AND finished_at IS NULL`,
    [runId, outcome],
  );
}

// ── Jobs ───────────────────────────────────────────────────────────────────

export interface JobRow {
  id: string;
  tenant_id: string;
  client_id: string;
  meeting_id: string;
  run_id: string;
  stage: JobStage;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  lease_expires_at: Date | null;
  lease_token_hash: string | null;
  leased_credential_id: string | null;
  leased_credential_label: string | null;
  leased_worker_label: string | null;
  last_heartbeat_at: Date | null;
  progress_pct: number | null;
  failure_code: string | null;
  failure_detail: string | null;
  requires: string[];
  created_at: Date;
  updated_at: Date;
}

/**
 * Crea el job de una etapa. Si el run ya tiene esa etapa devuelve la existente
 * (`jobs_stage_key UNIQUE (run_id, stage)`), que es lo que hace idempotente
 * «crear el siguiente job» cuando un `result/complete` se reenvía.
 */
export async function createJob(
  input: {
    tenantId: string;
    clientId: string;
    meetingId: string;
    runId: string;
    stage: JobStage;
    priority?: number;
    maxAttempts?: number;
  },
  executor?: Queryable,
): Promise<{ job: JobRow; created: boolean }> {
  const inserted = await q(executor).query<JobRow>(
    `INSERT INTO meeting_processing_jobs
       (tenant_id, client_id, meeting_id, run_id, stage, priority, max_attempts)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 100), COALESCE($7, 3))
     ON CONFLICT (run_id, stage) DO NOTHING
     RETURNING *`,
    [
      input.tenantId,
      input.clientId,
      input.meetingId,
      input.runId,
      input.stage,
      input.priority ?? null,
      input.maxAttempts ?? null,
    ],
  );
  if (inserted.rows.length === 1) return { job: inserted.rows[0], created: true };
  const existing = await q(executor).query<JobRow>(
    `SELECT * FROM meeting_processing_jobs WHERE run_id = $1 AND stage = $2`,
    [input.runId, input.stage],
  );
  return { job: existing.rows[0], created: false };
}

export async function getJobById(jobId: string, executor?: Queryable): Promise<JobRow | null> {
  const result = await q(executor).query<JobRow>(
    `SELECT * FROM meeting_processing_jobs WHERE id = $1`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

/** Con bloqueo: para las transiciones que leen y escriben en la misma tx. */
export async function getJobForUpdate(
  jobId: string,
  executor: Queryable,
): Promise<JobRow | null> {
  const result = await executor.query<JobRow>(
    `SELECT * FROM meeting_processing_jobs WHERE id = $1 FOR UPDATE`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

export interface ClaimInput {
  readonly capabilities: readonly string[];
  readonly leaseSeconds: number;
  readonly credentialId: string;
  readonly credentialLabel: string;
  readonly workerLabel: string | null;
  /** null = pool interno: cualquier tenant. */
  readonly tenantId: string | null;
  readonly leaseTokenHashFor: (job: { id: string; attempt: number }) => string;
}

/**
 * Reclama el siguiente job reclamable, atómicamente. Devuelve null si no hay.
 *
 * Se hace en dos pasos DENTRO de una transacción, y esa es la parte delicada: el
 * hash del lease depende del `attempt` resultante, que no se conoce hasta haber
 * elegido la fila. Así que primero se BLOQUEA el candidato con SKIP LOCKED sin
 * modificarlo, se calcula el hash con el attempt que va a tener, y se aplica el
 * UPDATE sobre la fila ya bloqueada. Entre los dos pasos nadie más puede tocarla
 * porque el bloqueo del `FOR UPDATE` se mantiene hasta el fin de la transacción.
 */
export async function claimNextJob(
  input: ClaimInput,
  executor: Queryable,
): Promise<JobRow | null> {
  const candidate = await executor.query<{ id: string; attempts: number }>(
    `SELECT id, attempts
       FROM meeting_processing_jobs
      WHERE status = 'queued'
        AND next_attempt_at <= now()
        AND attempts < max_attempts
        AND requires <@ $1::text[]
        AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
      ORDER BY priority ASC, next_attempt_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1`,
    [input.capabilities, input.tenantId],
  );
  if (candidate.rows.length === 0) return null;

  const { id, attempts } = candidate.rows[0];
  const nextAttempt = attempts + 1;
  const tokenHash = input.leaseTokenHashFor({ id, attempt: nextAttempt });

  const updated = await executor.query<JobRow>(
    `UPDATE meeting_processing_jobs
        SET status = 'leased',
            attempts = $2,
            lease_token_hash = $3,
            lease_expires_at = now() + make_interval(secs => $4::double precision),
            leased_credential_id = $5,
            leased_credential_label = $6,
            leased_worker_label = $7,
            last_heartbeat_at = now(),
            updated_at = now()
      WHERE id = $1 AND status = 'queued'
      RETURNING *`,
    [
      id,
      nextAttempt,
      tokenHash,
      input.leaseSeconds,
      input.credentialId,
      input.credentialLabel,
      input.workerLabel,
    ],
  );
  return updated.rows[0] ?? null;
}

/**
 * Renueva el lease. **El servidor decide la duración**, no el worker: si el
 * worker pudiera pedir su propia caducidad, un worker roto pediría una hora y
 * ningún barrido lo recuperaría en ese tiempo.
 */
export async function renewLease(
  jobId: string,
  leaseSeconds: number,
  progressPct: number | null,
  executor?: Queryable,
): Promise<Date | null> {
  const result = await q(executor).query<{ lease_expires_at: Date }>(
    `UPDATE meeting_processing_jobs
        SET lease_expires_at = now() + make_interval(secs => $2::double precision),
            last_heartbeat_at = now(),
            progress_pct = COALESCE($3, progress_pct),
            last_progress_at = CASE WHEN $3 IS NULL THEN last_progress_at ELSE now() END,
            updated_at = now()
      WHERE id = $1 AND status IN ('leased', 'uploading_result')
      RETURNING lease_expires_at`,
    [jobId, leaseSeconds, progressPct],
  );
  return result.rows[0]?.lease_expires_at ?? null;
}

export async function markUploadingResult(jobId: string, executor?: Queryable): Promise<boolean> {
  const result = await q(executor).query(
    `UPDATE meeting_processing_jobs
        SET status = 'uploading_result', updated_at = now()
      WHERE id = $1 AND status IN ('leased', 'uploading_result')`,
    [jobId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Cierra un job con éxito. Libera token y caducidad y CONSERVA la credencial:
 * las invariantes lo exigen así y es la respuesta a «quién procesó esto».
 */
export async function markSucceeded(jobId: string, executor?: Queryable): Promise<boolean> {
  const result = await q(executor).query(
    `UPDATE meeting_processing_jobs
        SET status = 'succeeded', lease_token_hash = NULL, lease_expires_at = NULL,
            progress_pct = 100, updated_at = now()
      WHERE id = $1 AND status IN ('leased', 'uploading_result')`,
    [jobId],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface FailOutcome {
  readonly job: JobRow;
  /** true = queda otro intento y volvió a la cola. */
  readonly requeued: boolean;
}

/**
 * Marca un fallo. Si quedan intentos vuelve a `queued` con backoff exponencial y
 * jitter; si no, queda `failed`.
 *
 * El backoff se calcula en SQL con `attempts` para que no dependa del reloj del
 * cliente. El jitter (±25 %) evita que varios jobs que fallaron por la misma
 * causa —el almacenamiento caído, digamos— reintenten todos en el mismo
 * instante y vuelvan a tumbarlo.
 */
export async function markFailed(
  jobId: string,
  failureCode: string,
  failureDetail: string | null,
  executor?: Queryable,
): Promise<FailOutcome | null> {
  const result = await q(executor).query<JobRow>(
    `UPDATE meeting_processing_jobs
        SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
            failure_code = $2,
            failure_detail = $3,
            lease_token_hash = NULL,
            lease_expires_at = NULL,
            leased_credential_id = CASE WHEN attempts < max_attempts THEN NULL ELSE leased_credential_id END,
            leased_credential_label = CASE WHEN attempts < max_attempts THEN NULL ELSE leased_credential_label END,
            next_attempt_at = now() + make_interval(secs =>
              LEAST(600, POWER(2, LEAST(attempts, 8)) * 5) * (0.75 + random() * 0.5)),
            updated_at = now()
      WHERE id = $1 AND status IN ('leased', 'uploading_result')
      RETURNING *`,
    [jobId, failureCode, failureDetail],
  );
  const job = result.rows[0];
  if (!job) return null;
  return { job, requeued: job.status === 'queued' };
}

export async function cancelJobsForMeeting(
  meetingId: string,
  executor?: Queryable,
): Promise<number> {
  const result = await q(executor).query(
    `UPDATE meeting_processing_jobs
        SET status = 'cancelled', lease_token_hash = NULL, lease_expires_at = NULL,
            updated_at = now()
      WHERE meeting_id = $1 AND status IN ('queued', 'leased', 'uploading_result')`,
    [meetingId],
  );
  return result.rowCount ?? 0;
}

export interface RequeuedJob {
  readonly id: string;
  readonly meeting_id: string;
  readonly stage: JobStage;
  readonly attempts: number;
  readonly status: JobStatus;
}

/**
 * Barrido de leases caducados. Un worker que muere no avisa: lo único que se
 * sabe es que dejó de latir, así que el lease caduca y el trabajo vuelve.
 *
 * Los que agotaron intentos quedan `abandoned` y no `failed` a propósito:
 * `failed` significa «se intentó y no salió», `abandoned` significa «nadie
 * volvió a decir nada». Distinguirlos es lo que permite alertar sobre workers
 * que se caen, que es un problema distinto de un audio corrupto.
 */
export async function requeueExpiredLeases(executor?: Queryable): Promise<RequeuedJob[]> {
  const result = await q(executor).query<RequeuedJob>(
    `UPDATE meeting_processing_jobs
        SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'abandoned' END,
            lease_token_hash = NULL,
            lease_expires_at = NULL,
            leased_credential_id = CASE WHEN attempts < max_attempts THEN NULL ELSE leased_credential_id END,
            leased_credential_label = CASE WHEN attempts < max_attempts THEN NULL ELSE leased_credential_label END,
            failure_code = CASE WHEN attempts < max_attempts THEN failure_code ELSE 'lease_expired' END,
            next_attempt_at = now(),
            updated_at = now()
      WHERE status IN ('leased', 'uploading_result')
        AND lease_expires_at < now()
      RETURNING id, meeting_id, stage, attempts, status`,
  );
  return result.rows;
}

export async function listJobsForMeeting(
  meetingId: string,
  executor?: Queryable,
): Promise<JobRow[]> {
  const result = await q(executor).query<JobRow>(
    `SELECT * FROM meeting_processing_jobs WHERE meeting_id = $1 ORDER BY created_at ASC`,
    [meetingId],
  );
  return result.rows;
}

// ── Eventos ────────────────────────────────────────────────────────────────

export type JobEventKind =
  | 'claimed'
  | 'state_changed'
  | 'progress'
  | 'retried'
  | 'lease_expired'
  | 'cancelled'
  | 'failed'
  | 'result_ingested';

/**
 * Añade un evento de auditoría. Nunca lanza: un fallo al registrar no debe
 * tumbar la operación que registraba. Pero sí se propaga si estamos dentro de
 * una transacción, porque ahí un error abortaría el bloque de todos modos y
 * tragárselo dejaría la transacción en estado inutilizable.
 */
export async function appendJobEvent(
  input: {
    tenantId: string;
    clientId: string;
    meetingId: string;
    jobId: string | null;
    attempt: number;
    kind: JobEventKind;
    stage?: JobStage | null;
    progressPct?: number | null;
    credentialId?: string | null;
    workerLabel?: string | null;
    detail?: Record<string, unknown>;
  },
  executor?: Queryable,
): Promise<void> {
  await q(executor).query(
    `INSERT INTO meeting_job_events
       (tenant_id, client_id, meeting_id, job_id, attempt, kind, stage,
        progress_pct, credential_id, worker_label, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [
      input.tenantId,
      input.clientId,
      input.meetingId,
      input.jobId,
      input.attempt,
      input.kind,
      input.stage ?? null,
      input.progressPct ?? null,
      input.credentialId ?? null,
      input.workerLabel ?? null,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

export async function listEventsForMeeting(
  meetingId: string,
  limit = 100,
  executor?: Queryable,
): Promise<Array<{ kind: string; stage: string | null; at: Date; attempt: number; detail: unknown }>> {
  const result = await q(executor).query<{
    kind: string;
    stage: string | null;
    at: Date;
    attempt: number;
    detail: unknown;
  }>(
    `SELECT kind, stage, at, attempt, detail
       FROM meeting_job_events
      WHERE meeting_id = $1
      ORDER BY at DESC, id DESC
      LIMIT $2`,
    [meetingId, limit],
  );
  return result.rows;
}
