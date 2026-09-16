import { q, type Queryable } from './types.js';

/**
 * El estado de la eliminación de una reunión, en la base y no en memoria.
 *
 * Todo lo que hace falta para terminar una eliminación a medias vive en
 * columnas: qué reunión, desde cuándo, a partir de qué instante es seguro
 * borrar la fila, cuántos intentos van y por qué falló el último. Un proceso
 * que arranque de cero puede retomar cualquiera sin saber nada de lo anterior.
 *
 * Esa es la diferencia con un `setTimeout`: la espera hasta
 * `deletion_not_before` dura minutos, y en minutos caben un despliegue, un
 * reinicio y un contenedor reciclado. Una promesa en memoria se los come en
 * silencio y deja el audio en R2 con la fila ya borrada, que es la única
 * combinación de la que no se vuelve.
 */

export type DeletionState = 'live' | 'deleting' | 'delete_failed';

export interface DeletionRow {
  id: string;
  tenant_id: string;
  client_id: string;
  title: string;
  deletion_state: DeletionState;
  deletion_requested_at: Date | null;
  deletion_not_before: Date | null;
  deletion_attempts: number;
  deletion_failure_code: string | null;
  deletion_last_attempt_at: Date | null;
}

/** Cualificadas con `m.`: en el UPDATE con FROM, `id` es ambiguo. */
const COLUMNAS_M = `m.id, m.tenant_id, m.client_id, m.title, m.deletion_state,
                    m.deletion_requested_at, m.deletion_not_before, m.deletion_attempts,
                    m.deletion_failure_code, m.deletion_last_attempt_at`;

const COLUMNAS = `id, tenant_id, client_id, title, deletion_state, deletion_requested_at,
                  deletion_not_before, deletion_attempts, deletion_failure_code,
                  deletion_last_attempt_at`;

export interface ReserveDeletionInput {
  readonly meetingId: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly byUserId: string | null;
  readonly byLabel: string;
  /**
   * TTL de subida del store. **Sólo** se usa para las filas anteriores a
   * `original_put_expires_at`, donde el vencimiento real no se registró. Es la
   * duración que usa el propio código para firmar, no una estimación nuestra.
   */
  readonly fallbackPutTtlSeconds: number;
}

export type ReserveDeletionResult =
  | { readonly outcome: 'reserved'; readonly row: DeletionRow }
  /** Ya estaba en curso. La respuesta al usuario es la misma: 202. */
  | { readonly outcome: 'already'; readonly row: DeletionRow }
  | { readonly outcome: 'not_found' };

/**
 * Marca la reunión `deleting` y fija `deletion_not_before`.
 *
 * ── Por qué el plazo se calcula AQUÍ y en un solo statement ────────────────
 *
 * A partir del momento en que la fila queda `deleting`, el servicio deja de
 * emitir URLs de escritura. Así que el conjunto de URLs que pueden seguir vivas
 * queda cerrado justo en este UPDATE, y su vencimiento máximo se puede calcular
 * de una vez y no volver a tocarse. Hacerlo en dos viajes dejaría una ventana
 * en la que `upload-init` todavía firma y el máximo ya se calculó.
 *
 * Los sumandos son vencimientos REALES devueltos por `signPut`:
 *
 *   · `original_put_expires_at` (subida del audio original);
 *   · `max(meeting_result_uploads.put_expires_at)` (subidas del worker).
 *
 * El único caso sin dato es una reunión que quedó en `uploading` antes de que
 * existiera la columna: ahí se usa `now() + fallbackPutTtlSeconds`, que
 * sobreestima a propósito. Sobreestimar retrasa una limpieza; subestimar deja
 * audio huérfano en el bucket.
 *
 * `delete_failed` también se puede volver a reservar: es un reintento, y el
 * plazo ya venció hace rato, así que recalcularlo no lo alarga.
 */
export async function reserveDeletion(
  input: ReserveDeletionInput,
  executor?: Queryable,
): Promise<ReserveDeletionResult> {
  const ex = q(executor);
  const r = await ex.query<DeletionRow>(
    `UPDATE meetings m
        SET deletion_state = 'deleting',
            deletion_requested_at = COALESCE(m.deletion_requested_at, now()),
            deletion_by_user_id = COALESCE(m.deletion_by_user_id, $4),
            deletion_by_label = COALESCE(m.deletion_by_label, $5),
            deletion_failure_code = NULL,
            -- Un reintento humano devuelve el presupuesto de intentos
            -- automáticos. En la primera reserva ya era cero.
            deletion_attempts = 0,
            purge_lease_until = NULL,
            deletion_not_before = GREATEST(
              now(),
              COALESCE(
                m.original_put_expires_at,
                CASE WHEN m.media_state = 'uploading'
                     THEN now() + ($6 || ' seconds')::interval END,
                now()
              ),
              COALESCE(
                (SELECT max(ru.put_expires_at)
                   FROM meeting_result_uploads ru
                  WHERE ru.meeting_id = m.id),
                now()
              )
            ),
            updated_at = now()
      WHERE m.id = $1 AND m.tenant_id = $2 AND m.client_id = $3
        AND m.deletion_state IN ('live', 'delete_failed')
      RETURNING ${COLUMNAS}`,
    [input.meetingId, input.tenantId, input.clientId, input.byUserId, input.byLabel,
     String(input.fallbackPutTtlSeconds)],
  );
  if (r.rows[0]) return { outcome: 'reserved', row: r.rows[0] };

  // No afectó filas: o no existe / no es de este ámbito, o ya estaba `deleting`.
  const existente = await ex.query<DeletionRow>(
    `SELECT ${COLUMNAS} FROM meetings WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [input.meetingId, input.tenantId, input.clientId],
  );
  if (!existente.rows[0]) return { outcome: 'not_found' };
  return { outcome: 'already', row: existente.rows[0] };
}

/** ¿Está esta reunión marcada para eliminación? Una lectura, sin efectos. */
export async function isBeingDeleted(
  meetingId: string,
  executor?: Queryable,
): Promise<boolean> {
  const r = await q(executor).query<{ deletion_state: DeletionState }>(
    `SELECT deletion_state FROM meetings WHERE id = $1`,
    [meetingId],
  );
  return r.rows[0] !== undefined && r.rows[0].deletion_state !== 'live';
}

/** Cuánto puede tardar un barrido antes de que otro lo dé por muerto. */
export const PURGE_LEASE_MS = 5 * 60 * 1000;

/**
 * Cuántas veces reintenta SOLO el barrido antes de rendirse.
 *
 * Rendirse no es olvidar: la fila se queda en `delete_failed`, visible en el
 * listado y con «Reintentar eliminación» en su menú. Lo que se detiene es el
 * bucle automático, porque un fallo que se repite cinco veces no se va a
 * arreglar a la sexta y seguir intentándolo cada cinco minutos convierte un
 * problema en ruido permanente que nadie mira.
 *
 * Un reintento HUMANO pone el contador a cero: si alguien mira el error y
 * pulsa el botón, el presupuesto vuelve a empezar.
 */
export const MAX_PURGE_ATTEMPTS = 5;

/**
 * Toma hasta `limit` reuniones cuyo plazo ya venció y que nadie está limpiando.
 *
 * `FOR UPDATE SKIP LOCKED` más un lease en columna, por la misma razón que en
 * `claimNextJob`: el bloqueo de fila sólo dura la transacción, y esta operación
 * sigue después (listar y borrar en R2 tarda). El lease es lo que impide que un
 * segundo barrido empiece sobre la misma reunión mientras el primero trabaja, y
 * que una caída la deje tomada para siempre.
 */
export async function claimMeetingsToPurge(
  limit: number,
  executor?: Queryable,
): Promise<DeletionRow[]> {
  const r = await q(executor).query<DeletionRow>(
    `WITH candidatas AS (
       SELECT id FROM meetings
        WHERE deletion_state IN ('deleting', 'delete_failed')
          AND deletion_not_before <= now()
          AND deletion_attempts < $3
          AND (purge_lease_until IS NULL OR purge_lease_until < now())
        ORDER BY deletion_requested_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE meetings m
        SET purge_lease_until = now() + ($2 || ' milliseconds')::interval,
            deletion_attempts = m.deletion_attempts + 1,
            deletion_last_attempt_at = now()
       FROM candidatas c
      WHERE m.id = c.id
      RETURNING ${COLUMNAS_M}`,
    [limit, String(PURGE_LEASE_MS), MAX_PURGE_ATTEMPTS],
  );
  return r.rows;
}

/**
 * El DELETE definitivo, con el plazo REPETIDO en el WHERE.
 *
 * Es cinturón y tirantes igual que en `claimNextJob`: entre reservar y llegar
 * aquí pasaron minutos y varias llamadas a R2. Si por cualquier camino la fila
 * dejara de cumplir la condición, el DELETE no afecta nada y el barrido lo
 * trata como un fallo, en vez de borrar una reunión cuyo plazo no ha vencido.
 *
 * Las siete tablas hijas se van por `ON DELETE CASCADE`; los punteros
 * `active_transcript_id` y `active_analysis_id` son diferidos y `SET NULL`, así
 * que no hay que desactivarlos antes.
 */
export async function deleteMeetingRow(
  meetingId: string,
  executor?: Queryable,
): Promise<boolean> {
  const r = await q(executor).query(
    `DELETE FROM meetings
      WHERE id = $1
        AND deletion_state IN ('deleting', 'delete_failed')
        AND deletion_not_before <= now()`,
    [meetingId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Deja constancia de que el intento falló y suelta el lease para reintentar. */
export async function markDeleteFailed(
  meetingId: string,
  failureCode: string,
  executor?: Queryable,
): Promise<void> {
  await q(executor).query(
    `UPDATE meetings
        SET deletion_state = 'delete_failed',
            deletion_failure_code = $2,
            purge_lease_until = NULL,
            updated_at = now()
      WHERE id = $1 AND deletion_state IN ('deleting', 'delete_failed')`,
    [meetingId, failureCode],
  );
}

/** Registra el vencimiento REAL de la URL PUT del medio original. */
export async function setOriginalPutExpiry(
  meetingId: string,
  expiresAt: Date,
  executor?: Queryable,
): Promise<void> {
  // GREATEST: reintentar `upload-init` renueva la URL, y el plazo tiene que
  // reflejar la más tardía, no la última escrita por casualidad.
  await q(executor).query(
    `UPDATE meetings
        SET original_put_expires_at = GREATEST(COALESCE(original_put_expires_at, $2::timestamptz), $2::timestamptz)
      WHERE id = $1`,
    [meetingId, expiresAt],
  );
}
