import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * MEET-4 · Artefactos de resultado.
 *
 * Aditiva: una tabla.
 *
 * ── Una fila por ARTEFACTO, no por parte ───────────────────────────────────
 *
 * La revisión 4 del diseño proponía troceado en partes, justificado con una
 * cifra que resultó ser falsa (se afirmó 5–15 MB por transcript). La medición
 * sobre los artefactos históricos de Transcript-Project dio otra cosa:
 *
 * reunión mayor disponible 30 min 03 s · 205 segmentos · 10 KB NDJSON
 * segmentos/min p50 8,1 · p95 10,7 · máx 13,6
 * extrapolado a 4 h ~3.274 segmentos · ~158 KB · ~53 KB con gzip
 *
 * 53 KB caben en un solo objeto, así que el troceado sobraba. Lo que se
 * conserva es el CAMINO ÚNICO por artefacto, y su justificación ya no es el
 * tamaño:
 *
 * 1. Un solo camino de persistencia y una sola historia de idempotencia. Un
 * umbral significaría dos rutas y dos sitios donde equivocarse.
 * 2. Integridad verificable independientemente del HTTP: si un proxy trunca
 * un body, mai no puede distinguir "faltó" de "nunca existió"; con un
 * objeto y su checksum, sí.
 * 3. Reintento barato: si `complete` falla, el artefacto ya está subido.
 * 4. El artefacto ES el `raw_result` auditable que el diseño ya necesitaba.
 * 5. El worker no necesita conocer el límite de body ni el timeout del proxy.
 *
 * ── Idempotencia ───────────────────────────────────────────────────────────
 *
 * `UNIQUE (job_id, attempt, kind)`: un `result/init` repetido para el mismo
 * intento devuelve la MISMA fila y la misma URL firmada, en vez de crear otra.
 * Es el requisito explícito de T-1.
 *
 * ── Estados ────────────────────────────────────────────────────────────────
 *
 * awaiting_upload → uploaded → verified → ingested
 * ↘ ↘
 * rejected ←┘
 *
 * Las invariantes de cada estado son CONSTRAINTS, no reglas del servicio: ver
 * `ru_state_invariants`, que explica por qué. La transición en sí (qué estado
 * puede suceder a cuál) la impone el servicio de ingesta; lo que la base
 * garantiza es que ninguna fila pueda estar en un estado cuyos datos no
 * respalden — que es lo que hace que un estado signifique algo.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE meeting_result_uploads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      client_id uuid NOT NULL,
      meeting_id uuid NOT NULL,
      job_id uuid NOT NULL,
      -- El intento del job al que pertenece este artefacto. Dos intentos
      -- producen dos artefactos, y ambos quedan para diagnóstico.
      attempt smallint NOT NULL CHECK (attempt >= 0),

      kind text NOT NULL CHECK (kind IN ('transcript','analysis','raw')),
      schema_version smallint NOT NULL CHECK (schema_version >= 1),

      storage_key text NOT NULL,
      content_type text NOT NULL DEFAULT 'application/x-ndjson',
      content_encoding text CHECK (content_encoding IS NULL OR content_encoding IN ('gzip','identity')),

      -- Declarados en 'init', verificados en 'complete'. NULL hasta que el
      -- worker los reporte.
      declared_bytes bigint CHECK (declared_bytes IS NULL OR declared_bytes >= 0),
      declared_checksum_sha256 text CHECK (declared_checksum_sha256 IS NULL
                                           OR declared_checksum_sha256 ~ '^[0-9a-f]{64}$'),
      declared_item_count integer CHECK (declared_item_count IS NULL OR declared_item_count >= 0),

      -- Medidos por mai al descargar el objeto. La divergencia con lo declarado
      -- es lo que produce 'rejected'.
      observed_bytes bigint CHECK (observed_bytes IS NULL OR observed_bytes >= 0),
      observed_checksum_sha256 text CHECK (observed_checksum_sha256 IS NULL
                                           OR observed_checksum_sha256 ~ '^[0-9a-f]{64}$'),

      state text NOT NULL DEFAULT 'awaiting_upload'
                        CHECK (state IN ('awaiting_upload','uploaded','verified','ingested','rejected')),
      reject_code text,
      reject_detail text,
      -- CUÁNDO se rechazó. Faltaba: 'rejected' tenía código pero no instante,
      -- así que la única forma de fechar un rechazo era el created_at de la
      -- fila, que es cuando empezó la subida, no cuando se rechazó.
      rejected_at timestamptz,

      -- Vigencia de la URL firmada de PUT. No se guarda la URL: se regenera.
      put_expires_at timestamptz,
      uploaded_at timestamptz,
      verified_at timestamptz,
      ingested_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT ru_meeting_fkey FOREIGN KEY (meeting_id, tenant_id, client_id)
        REFERENCES meetings (id, tenant_id, client_id) ON DELETE CASCADE,
      -- El job tiene que ser de ESTA reunión. Con la clave anterior
      -- (id, tenant_id, client_id) se podía registrar un artefacto con
      -- meeting_id de la reunión A y job_id de un job de la reunión B del mismo
      -- cliente, y el resultado de una reunión habría quedado colgado de otra.
      CONSTRAINT ru_job_fkey FOREIGN KEY (job_id, meeting_id, tenant_id, client_id)
        REFERENCES meeting_processing_jobs (id, meeting_id, tenant_id, client_id) ON DELETE CASCADE,

      -- LA IDEMPOTENCIA (requisito de T-1).
      CONSTRAINT ru_attempt_key UNIQUE (job_id, attempt, kind),
      CONSTRAINT ru_storage_key_unique UNIQUE (storage_key),

      -- ─────────────────────────────────────────────────────────────────────
      -- INVARIANTES DE ESTADO, EN LA BASE Y NO EN EL SERVICIO
      -- ─────────────────────────────────────────────────────────────────────
      -- Las tres constraints anteriores (ru_reject_coherent,
      -- ru_verified_coherent, ru_ingest_after_verify) cubrían trozos: exigían
      -- código en el rechazo, mediciones en verified/ingested, y verify antes
      -- de ingest. Lo que no cubrían era el resto de la tabla de verdad, y los
      -- huecos no eran teóricos:
      --
      --   · 'uploaded' sin uploaded_at — el estado dice que el objeto está y
      --     no hay instante en que llegara;
      --   · 'ingested' con verified_at pero sin uploaded_at — verificado algo
      --     que nunca se subió;
      --   · 'awaiting_upload' con ingested_at relleno — el barrido de subidas
      --     abandonadas lo trataría como pendiente cuando ya se ingirió;
      --   · 'rejected' sin instante de rechazo.
      --
      -- Podrían vivir en el servicio de ingesta. No lo hacen por dos razones.
      -- La primera es que este esquema ya decidió lo contrario en todas las
      -- demás decisiones difíciles —las claves compuestas con meeting_id, las
      -- invariantes del lease, la coherencia de capabilities— y una tabla que
      -- confía en el código mientras sus vecinas no lo hacen es la que se
      -- corrompe. La segunda es específica: estas filas las escriben DOS
      -- actores en momentos distintos (el worker al subir, mai al verificar e
      -- ingerir) y las tocan barridos de limpieza y reintentos. Un invariante
      -- que depende de que TODOS los caminos de escritura lo recuerden no es un
      -- invariante.
      --
      -- Una sola CASE por estado, para que la tabla se lea como la tabla de
      -- verdad que es:
      CONSTRAINT ru_state_invariants CHECK (
        CASE state
          WHEN 'awaiting_upload' THEN
            -- Nada ha pasado todavía.
            uploaded_at IS NULL AND verified_at IS NULL
            AND ingested_at IS NULL AND rejected_at IS NULL
          WHEN 'uploaded' THEN
            -- El objeto está; nadie lo ha medido.
            uploaded_at IS NOT NULL AND verified_at IS NULL
            AND ingested_at IS NULL AND rejected_at IS NULL
          WHEN 'verified' THEN
            -- Subido Y medido. Las mediciones son lo que distingue
            -- 'verified' de 'uploaded': sin ellas no se verificó nada.
            uploaded_at IS NOT NULL AND verified_at IS NOT NULL
            AND observed_bytes IS NOT NULL AND observed_checksum_sha256 IS NOT NULL
            AND ingested_at IS NULL AND rejected_at IS NULL
          WHEN 'ingested' THEN
            -- Los tres instantes y las mediciones. No se ingiere lo que no se
            -- verificó, y no se verifica lo que no se subió.
            uploaded_at IS NOT NULL AND verified_at IS NOT NULL
            AND ingested_at IS NOT NULL
            AND observed_bytes IS NOT NULL AND observed_checksum_sha256 IS NOT NULL
            AND rejected_at IS NULL
          WHEN 'rejected' THEN
            -- Cuándo y por qué. Un rechazo sin motivo no es diagnosticable, y
            -- este es el estado que alguien va a mirar cuando algo falle.
            rejected_at IS NOT NULL AND reject_code IS NOT NULL
            AND ingested_at IS NULL
        END
      ),
      -- El orden temporal. La CASE de arriba dice qué instantes existen en cada
      -- estado; esto dice que no pueden estar del revés.
      CONSTRAINT ru_time_order CHECK (
        (verified_at IS NULL OR uploaded_at IS NULL OR verified_at >= uploaded_at)
        AND (ingested_at IS NULL OR verified_at IS NULL OR ingested_at >= verified_at)
      ),
      -- Las dos mediciones describen el mismo objeto: van juntas.
      CONSTRAINT ru_observed_pair CHECK (
        (observed_bytes IS NULL) = (observed_checksum_sha256 IS NULL)
      ),
      -- Y un detalle de rechazo sin código sería un texto sin clasificar.
      CONSTRAINT ru_reject_detail_needs_code CHECK (
        reject_detail IS NULL OR reject_code IS NOT NULL
      )
    );

    -- El flujo del worker: buscar el artefacto de este job e intento.
    CREATE INDEX ru_job_idx ON meeting_result_uploads (job_id, attempt);
    -- La ingesta pendiente, que es lo que el worker de mai barre.
    CREATE INDEX ru_pending_idx ON meeting_result_uploads (state, created_at)
      WHERE state IN ('uploaded','verified');
    -- Limpieza de subidas abandonadas (URL caducada sin objeto).
    CREATE INDEX ru_abandoned_idx ON meeting_result_uploads (put_expires_at)
      WHERE state = 'awaiting_upload';
    CREATE INDEX ru_meeting_idx ON meeting_result_uploads (meeting_id, kind, created_at DESC);
    -- Los rechazos recientes, que es lo que se mira cuando algo va mal.
    CREATE INDEX ru_rejected_idx ON meeting_result_uploads (rejected_at DESC)
      WHERE state = 'rejected';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    DECLARE n bigint;
    BEGIN
      SELECT count(*) INTO n FROM meeting_result_uploads;
      IF n > 0 THEN
        RAISE EXCEPTION
          'MEET-4 down abortado: existen % artefacto(s) de resultado. Bórralos explícitamente antes de revertir.', n;
      END IF;
    END $$;

    DROP TABLE IF EXISTS meeting_result_uploads;
  `);
}
