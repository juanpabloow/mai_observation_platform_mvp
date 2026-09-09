import { q, type Queryable } from './types.js';
import type { ArtifactKind, UploadState } from './types.js';

/**
 * `meeting_result_uploads`: el registro de cada artefacto que un worker sube.
 *
 * ── Dónde vive la idempotencia ──────────────────────────────────────────────
 *
 * En `ru_attempt_key UNIQUE (job_id, attempt, kind)`, no en el código. Cada
 * función de aquí se apoya en esa constraint con `ON CONFLICT` en vez de hacer
 * `SELECT` y luego decidir: entre la lectura y la escritura otra petición del
 * mismo worker reintentando podría insertar, y el `SELECT` previo habría dicho
 * que no existía.
 */

export interface ResultUploadRow {
  id: string;
  tenant_id: string;
  client_id: string;
  meeting_id: string;
  job_id: string;
  attempt: number;
  kind: ArtifactKind;
  schema_version: number;
  storage_key: string;
  content_type: string;
  content_encoding: string | null;
  declared_bytes: string | null;
  declared_checksum_sha256: string | null;
  declared_item_count: number | null;
  observed_bytes: string | null;
  observed_checksum_sha256: string | null;
  state: UploadState;
  reject_code: string | null;
  reject_detail: string | null;
  rejected_at: Date | null;
  put_expires_at: Date | null;
  uploaded_at: Date | null;
  verified_at: Date | null;
  ingested_at: Date | null;
  created_at: Date;
}

export interface InitUploadInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly meetingId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly kind: ArtifactKind;
  readonly schemaVersion: number;
  readonly storageKey: string;
  readonly contentType: string;
  readonly contentEncoding: string | null;
  readonly putExpiresAt: Date;
}

/**
 * Registra la intención de subir, o devuelve la fila que ya había para este
 * (job, intento, kind).
 *
 * `DO UPDATE` sólo de `put_expires_at`: repetir `result/init` renueva la
 * vigencia de la URL —que es justo para lo que se repite— y no toca nada más. Si
 * actualizara la clave o el kind, un `init` repetido podría reapuntar un
 * artefacto ya subido a otro objeto.
 *
 * Y no revive un artefacto ya verificado o ingerido: en esos estados el
 * `WHERE` de la cláusula lo deja intacto y se devuelve tal cual, porque volver a
 * `awaiting_upload` algo que ya se ingirió borraría el hecho de que se ingirió.
 */
export async function initResultUpload(
  input: InitUploadInput,
  executor?: Queryable,
): Promise<{ upload: ResultUploadRow; created: boolean }> {
  const result = await q(executor).query<ResultUploadRow>(
    `INSERT INTO meeting_result_uploads
       (tenant_id, client_id, meeting_id, job_id, attempt, kind, schema_version,
        storage_key, content_type, content_encoding, put_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (job_id, attempt, kind) DO UPDATE
       SET put_expires_at = EXCLUDED.put_expires_at
       WHERE meeting_result_uploads.state IN ('awaiting_upload', 'uploaded', 'rejected')
     RETURNING *, (xmax = 0) AS inserted`,
    [
      input.tenantId,
      input.clientId,
      input.meetingId,
      input.jobId,
      input.attempt,
      input.kind,
      input.schemaVersion,
      input.storageKey,
      input.contentType,
      input.contentEncoding,
      input.putExpiresAt,
    ],
  );
  if (result.rows.length === 1) {
    const row = result.rows[0] as ResultUploadRow & { inserted?: boolean };
    return { upload: row, created: row.inserted === true };
  }
  // El WHERE del DO UPDATE lo excluyó: ya está verificado o ingerido.
  const existing = await findUpload(input.jobId, input.attempt, input.kind, executor);
  if (!existing) throw new Error('initResultUpload: conflicto sin fila');
  return { upload: existing, created: false };
}

export async function findUpload(
  jobId: string,
  attempt: number,
  kind: ArtifactKind,
  executor?: Queryable,
): Promise<ResultUploadRow | null> {
  const result = await q(executor).query<ResultUploadRow>(
    `SELECT * FROM meeting_result_uploads
      WHERE job_id = $1 AND attempt = $2 AND kind = $3`,
    [jobId, attempt, kind],
  );
  return result.rows[0] ?? null;
}

/** Todos los artefactos verificados de un run, para la ingestión. */
export async function findVerifiedForRun(
  runId: string,
  executor?: Queryable,
): Promise<ResultUploadRow[]> {
  const result = await q(executor).query<ResultUploadRow>(
    `SELECT ru.*
       FROM meeting_result_uploads ru
       JOIN meeting_processing_jobs j ON j.id = ru.job_id
      WHERE j.run_id = $1 AND ru.state IN ('verified', 'ingested')
      ORDER BY ru.created_at ASC`,
    [runId],
  );
  return result.rows;
}

/**
 * Registra lo que el worker DECLARA que va a subir, y con ello reinicia la fila.
 *
 * Acepta también el estado `rejected`, y ésa es la parte importante. Un
 * artefacto rechazado —checksum que no cuadra, NDJSON truncado— tiene que poder
 * reintentarse DENTRO del mismo intento: el fallo es del fichero que el worker
 * generó, no del intento, y gastar un reintento del job por un artefacto mal
 * serializado agotaría `max_attempts` por un problema que se corrige
 * regenerando el objeto.
 *
 * Para que eso funcione hay que limpiar TODO lo que la pasada anterior dejó: el
 * rechazo (`reject_*`, `rejected_at`) y las mediciones (`observed_*`,
 * `verified_at`). Sin limpiarlas, `ru_state_invariants` rechazaría la fila —el
 * estado `uploaded` exige que esas columnas estén vacías— y, peor, la
 * declaración vieja seguiría ahí: `result/complete` compararía el checksum nuevo
 * con el viejo y respondería `checksum_mismatch` para siempre. Un worker que
 * corrige su artefacto quedaría atascado sin forma de salir.
 */
export async function markUploaded(
  uploadId: string,
  declared: { bytes: number; checksumSha256: string; itemCount: number | null },
  executor?: Queryable,
): Promise<void> {
  await q(executor).query(
    `UPDATE meeting_result_uploads
        SET state = 'uploaded',
            uploaded_at = now(),
            declared_bytes = $2,
            declared_checksum_sha256 = $3,
            declared_item_count = $4,
            reject_code = NULL,
            reject_detail = NULL,
            rejected_at = NULL,
            observed_bytes = NULL,
            observed_checksum_sha256 = NULL,
            verified_at = NULL
      WHERE id = $1 AND state IN ('awaiting_upload', 'uploaded', 'rejected')`,
    [uploadId, declared.bytes, declared.checksumSha256, declared.itemCount],
  );
}

export async function markVerified(
  uploadId: string,
  observed: { bytes: number; checksumSha256: string },
  executor?: Queryable,
): Promise<boolean> {
  const result = await q(executor).query(
    `UPDATE meeting_result_uploads
        SET state = 'verified', verified_at = COALESCE(verified_at, now()),
            uploaded_at = COALESCE(uploaded_at, now()),
            observed_bytes = $2, observed_checksum_sha256 = $3
      WHERE id = $1 AND state IN ('uploaded', 'verified')`,
    [uploadId, observed.bytes, observed.checksumSha256],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markIngested(uploadIds: readonly string[], executor?: Queryable): Promise<void> {
  if (uploadIds.length === 0) return;
  await q(executor).query(
    `UPDATE meeting_result_uploads
        SET state = 'ingested', ingested_at = COALESCE(ingested_at, now())
      WHERE id = ANY($1::uuid[]) AND state = 'verified'`,
    [uploadIds],
  );
}

export async function markRejected(
  uploadId: string,
  code: string,
  detail: string | null,
  executor?: Queryable,
): Promise<void> {
  await q(executor).query(
    `UPDATE meeting_result_uploads
        SET state = 'rejected', rejected_at = now(), reject_code = $2, reject_detail = $3
      WHERE id = $1 AND state <> 'ingested'`,
    [uploadId, code, detail],
  );
}
