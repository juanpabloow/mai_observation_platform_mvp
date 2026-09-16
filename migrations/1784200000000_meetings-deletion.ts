import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Eliminación definitiva de una reunión: audio original, artefactos y filas.
 *
 * ── Por qué un eje de estado NUEVO y no `cancelled_at` ─────────────────────
 *
 * Cancelar detiene el trabajo y deja la reunión ahí; eliminar la hace
 * desaparecer. Una reunión cancelada se puede eliminar después, así que si
 * compartieran columna no habría forma de expresar «cancelada y además en
 * eliminación». Son dos hechos distintos sobre la misma fila.
 *
 * ── El problema real: una URL PUT firmada sobrevive a la decisión ──────────
 *
 * Marcar `deleting` impide EMITIR nuevas URLs de escritura, pero no revoca las
 * ya emitidas. Una URL de subida firmada hace cinco minutos sigue siendo válida
 * hasta su vencimiento, y S3/R2 la honra sin preguntarle nada a mai. Si se
 * vacía el prefijo y se borra la fila mientras esa URL vive, el cliente puede
 * subir DESPUÉS y dejar un objeto bajo un prefijo que ya no tiene fila que lo
 * mencione: basura invisible con audio de una reunión que el usuario cree
 * eliminada.
 *
 * De ahí `deletion_not_before`: el instante a partir del cual ya no puede
 * existir ninguna URL de escritura vigente para esta reunión. Se calcula al
 * reservar, como el máximo de los vencimientos REALES que el código ya
 * registra:
 *
 *   · `meetings.original_put_expires_at` — que esta migración añade, porque
 *     `uploadInit` firmaba el PUT y no guardaba su vencimiento en ningún sitio;
 *   · `max(meeting_result_uploads.put_expires_at)` — que ya existía y ya se
 *     escribe en `result/init`.
 *
 * No hay una duración inventada en ninguna parte: son los `expiresAt` que
 * devolvió el propio `signPut`.
 *
 * ── Y por qué la limpieza es una tarea, no una promesa ─────────────────────
 *
 * Entre reservar y poder limpiar pasan minutos. Un `setTimeout` no sobrevive a
 * un despliegue, a un reinicio ni a que el proceso se recicle, y la reunión se
 * quedaría a medio eliminar sin que nadie lo supiera. Todo el estado necesario
 * para terminar vive en estas columnas, así que cualquier proceso que corra
 * después puede retomarla. `purge_lease_until` es lo que evita que dos barridos
 * simultáneos trabajen sobre la misma reunión.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE meetings
      -- Vencimiento REAL de la URL PUT del medio original, tal y como lo
      -- devolvió signPut. NULL = nunca se firmó una (o se firmó antes de que
      -- existiera esta columna).
      ADD COLUMN original_put_expires_at timestamptz,

      ADD COLUMN deletion_state text NOT NULL DEFAULT 'live'
        CHECK (deletion_state IN ('live','deleting','delete_failed')),
      ADD COLUMN deletion_requested_at timestamptz,
      -- A partir de aquí ya no puede quedar viva ninguna URL de escritura.
      ADD COLUMN deletion_not_before timestamptz,
      -- SNAPSHOT + puntero, la regla de este esquema: quién lo pidió es un
      -- hecho histórico y no debe evaporarse al borrar al usuario.
      ADD COLUMN deletion_by_label text,
      ADD COLUMN deletion_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      ADD COLUMN deletion_attempts integer NOT NULL DEFAULT 0
        CHECK (deletion_attempts >= 0),
      ADD COLUMN deletion_last_attempt_at timestamptz,
      -- CÓDIGO, nunca detalle: un mensaje de error puede arrastrar una clave de
      -- objeto, y una clave lleva dentro tenant, cliente y reunión.
      ADD COLUMN deletion_failure_code text,
      ADD COLUMN purge_lease_until timestamptz;

    COMMENT ON COLUMN meetings.deletion_not_before IS
      'Instante tras el cual ninguna URL PUT firmada para esta reunión puede seguir viva. Calculado al reservar como el máximo de los vencimientos reales ya registrados. La fila NO se borra antes de este instante.';

    COMMENT ON COLUMN meetings.original_put_expires_at IS
      'Vencimiento de la URL PUT del medio original, tal como lo devolvió signPut. NULL en filas anteriores a esta columna: para ésas se usa now() + el TTL de subida que configura el propio store, que es la duración que usa el código.';

    -- Pedir la eliminación es un hecho con autor, momento y plazo, o no ocurrió.
    ALTER TABLE meetings
      ADD CONSTRAINT meetings_deletion_coherent CHECK (
        (deletion_state = 'live'
           AND deletion_requested_at IS NULL
           AND deletion_not_before IS NULL
           AND deletion_by_label IS NULL)
        OR (deletion_state <> 'live'
           AND deletion_requested_at IS NOT NULL
           AND deletion_not_before IS NOT NULL
           AND deletion_by_label IS NOT NULL)
      );

    -- Un fallo tiene código; un estado que no ha fallado, no.
    ALTER TABLE meetings
      ADD CONSTRAINT meetings_deletion_failure_coherent CHECK (
        deletion_state = 'delete_failed' OR deletion_failure_code IS NULL
      );

    -- El barrido sólo mira las que NO están vivas, que son poquísimas.
    CREATE INDEX meetings_pending_purge_idx
      ON meetings (deletion_not_before)
      WHERE deletion_state <> 'live';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS meetings_pending_purge_idx;
    ALTER TABLE meetings
      DROP CONSTRAINT IF EXISTS meetings_deletion_failure_coherent,
      DROP CONSTRAINT IF EXISTS meetings_deletion_coherent,
      DROP COLUMN IF EXISTS purge_lease_until,
      DROP COLUMN IF EXISTS deletion_failure_code,
      DROP COLUMN IF EXISTS deletion_last_attempt_at,
      DROP COLUMN IF EXISTS deletion_attempts,
      DROP COLUMN IF EXISTS deletion_by_user_id,
      DROP COLUMN IF EXISTS deletion_by_label,
      DROP COLUMN IF EXISTS deletion_not_before,
      DROP COLUMN IF EXISTS deletion_requested_at,
      DROP COLUMN IF EXISTS deletion_state,
      DROP COLUMN IF EXISTS original_put_expires_at;
  `);
}
