import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * MEET-1 · Núcleo del módulo Reuniones: el registro, sus medios, y el sistema
 * de trabajos.
 *
 * Aditiva: cinco tablas nuevas y nada más. No altera ninguna tabla existente.
 *
 * ── Cuatro decisiones que conviene leer antes del SQL ──────────────────────
 *
 * 1. EL DOMINIO NO CONTIENE LA COLA. `meetings` no tiene `lease_owner`,
 * `attempts` ni `claimed_at`. Eso vive en `meeting_processing_jobs`. Una
 * reunión es un hecho del negocio; un job es un intento de procesarla, y
 * mezclarlos obliga a tocar el dominio cada vez que cambia la mecánica de
 * reintentos.
 *
 * 2. CUATRO MÁQUINAS DE ESTADO INDEPENDIENTES. `media_state`,
 * `transcript_state`, `diarization_state` y `analysis_state` avanzan por
 * separado, porque un fallo de diarización no invalida un transcript
 * utilizable. El chip que ve el usuario ("Completada con avisos") se DERIVA
 * de las cuatro; no hay una quinta columna que pueda contradecirlas.
 *
 * 3. SCOPING POR FK COMPUESTA, NO POR DISCIPLINA. Cada tabla hija referencia
 * `meetings (id, tenant_id, client_id)`. Una fila hija no puede pertenecer a
 * una reunión de otro cliente ni por un error de código, porque la base lo
 * rechaza. Eso exige el UNIQUE `meetings_scope_key`, que existe para ser
 * referenciado y no para deduplicar.
 *
 * 4. TIMESTAMPS EN UTC. Todo `timestamptz`, que en PostgreSQL almacena un
 * instante absoluto en UTC. Ninguna columna `timestamp` sin zona.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- ═══════════════════════════════════════════════════════════════════════
    -- 0. Vocabulario de capacidades y su mapeo a etapas
    -- ═══════════════════════════════════════════════════════════════════════
    -- MAPEO EXPLÍCITO. Hay cuatro etapas y dos capacidades:
    --
    --   normalize ─┐
    --   transcribe ─┼─→ meetings.transcribe (trabajo de medios y GPU)
    --   diarize ─┘
    --   analyze ──→ meetings.analyze (LLM, I/O)
    --
    -- QUÉ SIGNIFICA ESTA AGRUPACIÓN, Y QUÉ NO.
    --
    -- Es una AUTORIZACIÓN DE POOL: un pool con 'meetings.transcribe' puede
    -- reclamar jobs de esas tres etapas. Nada más. La revisión anterior escribió
    -- aquí que las tres "comparten el fichero de audio descargado y el modelo
    -- cargado", y eso es FALSO como garantía: dos pools distintos con la misma
    -- capacidad, o dos procesos del mismo pool, pueden reclamar 'normalize' y
    -- 'transcribe' de la misma reunión y no comparten ni disco ni memoria. La
    -- capacidad no expresa afinidad de ejecución. Si en el futuro se quisiera
    -- garantizar que las tres caen en el mismo proceso, haría falta un mecanismo
    -- explícito (afinidad por run, o un job compuesto), y sería otra cosa que
    -- esta columna.
    --
    -- La razón real de agrupar es de PERFIL DE RECURSO: las tres necesitan un
    -- runtime con GPU y códecs; el análisis sólo necesita salida a un LLM. Por
    -- eso admiten concurrencias distintas y pueden vivir en runtimes distintos.
    -- Que además a menudo caigan en el mismo proceso —y entonces reaprovechen la
    -- descarga y el modelo— es una optimización oportunista, no un invariante.
    CREATE FUNCTION meetings_stage_capability(stage text)
    RETURNS text AS $$
      SELECT CASE stage
               WHEN 'normalize' THEN 'meetings.transcribe'
               WHEN 'transcribe' THEN 'meetings.transcribe'
               WHEN 'diarize' THEN 'meetings.transcribe'
               WHEN 'analyze' THEN 'meetings.analyze'
             END;
    $$ LANGUAGE sql IMMUTABLE STRICT;

    CREATE FUNCTION meetings_known_capability(cap text)
    RETURNS boolean AS $$
      SELECT cap IN ('meetings.transcribe', 'meetings.analyze');
    $$ LANGUAGE sql IMMUTABLE STRICT;

    -- Un CHECK no admite subconsultas; encapsularlas en una función IMMUTABLE
    -- sí, y es el mecanismo estándar para esto.
    CREATE FUNCTION meetings_known_capabilities(caps text[])
    RETURNS boolean AS $$
      SELECT caps IS NULL
          OR NOT EXISTS (
               SELECT 1 FROM unnest(caps) AS c WHERE NOT meetings_known_capability(c)
             );
    $$ LANGUAGE sql IMMUTABLE;

    -- ═══════════════════════════════════════════════════════════════════════
    -- 1. meetings — el registro del negocio
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE meetings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,

      title text NOT NULL,
      source_kind text NOT NULL
                             CHECK (source_kind IN ('file','meet','inbox','room','api')),
      started_at timestamptz,
      language_hint text,

      -- Punteros a la versión ACTIVA. Sin FK todavía: las tablas de versiones
      -- llegan en MEET-2, y una FK aquí obligaría a un orden de migración
      -- circular. MEET-2 las añade.
      active_transcript_id uuid,
      active_analysis_id uuid,

      -- Las cuatro máquinas de estado (decisión 2).
      media_state text NOT NULL DEFAULT 'pending'
                             CHECK (media_state IN ('pending','uploading','ready','invalid')),
      transcript_state text NOT NULL DEFAULT 'pending'
                             CHECK (transcript_state IN ('pending','running','ready','failed','skipped')),
      diarization_state text NOT NULL DEFAULT 'pending'
                             CHECK (diarization_state IN ('pending','running','ready','partial','failed','skipped')),
      analysis_state text NOT NULL DEFAULT 'pending'
                             CHECK (analysis_state IN ('pending','running','ready','partial','failed','skipped')),

      -- Avisos derivados de las etapas secundarias, para "Completada con
      -- avisos". Array de objetos { stage, state, failure_code, detail }.
      warnings jsonb NOT NULL DEFAULT '[]'::jsonb,

      idempotency_key text NOT NULL,
      retention_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
      import_batch_id uuid,

      created_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      cancelled_at timestamptz,
      -- SNAPSHOT + PUNTERO, la regla general de este esquema (ver decisión 7).
      -- La cancelación es un hecho histórico: quién la hizo se copia. El
      -- puntero sirve para enlazar a la ficha mientras exista.
      cancelled_by_label text,
      cancelled_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT meetings_client_fkey FOREIGN KEY (client_id, tenant_id)
        REFERENCES clients (id, tenant_id) ON DELETE CASCADE,
      -- Reintentar una subida devuelve la misma reunión en vez de duplicarla.
      CONSTRAINT meetings_idem_key UNIQUE (tenant_id, client_id, idempotency_key),
      -- Existe para que las hijas puedan referenciarlo (decisión 3).
      CONSTRAINT meetings_scope_key UNIQUE (id, tenant_id, client_id),
      CONSTRAINT meetings_warnings_array CHECK (jsonb_typeof(warnings) = 'array'),
      CONSTRAINT meetings_retention_object CHECK (jsonb_typeof(retention_policy) = 'object'),
      -- Cancelar es un hecho con autor y momento, o no ocurrió.
      -- Atado al SNAPSHOT, no a la FK. Antes ataba 'cancelled_at' a
      -- 'cancelled_by_user_id', que es ON DELETE SET NULL: borrar al usuario
      -- que canceló una reunión anulaba esa columna y violaba este CHECK, así
      -- que el DELETE fallaba. Lo destapó el barrido que borra de verdad cada
      -- padre de una FK SET NULL.
      CONSTRAINT meetings_cancel_coherent CHECK (
        (cancelled_at IS NULL) = (cancelled_by_label IS NULL)
      )
    );

    -- El listado del módulo: por cliente, más recientes primero.
    CREATE INDEX meetings_list_idx
      ON meetings (tenant_id, client_id, started_at DESC NULLS LAST, created_at DESC);
    -- La faceta "requieren atención" y los filtros por estado.
    CREATE INDEX meetings_state_idx
      ON meetings (tenant_id, client_id, transcript_state, analysis_state);
    -- Sólo las que están en marcha; parcial para no escanear el histórico.
    CREATE INDEX meetings_in_flight_idx
      ON meetings (tenant_id, client_id, updated_at DESC)
      WHERE media_state <> 'ready' OR transcript_state IN ('pending','running');

    -- ═══════════════════════════════════════════════════════════════════════
    -- 2. meeting_media — los ficheros
    -- ═══════════════════════════════════════════════════════════════════════
    -- Separado de meetings porque la retención actúa sobre MEDIOS y porque un
    -- reproceso añade derivados nuevos con su propio reloj sin tocar el original.
    CREATE TABLE meeting_media (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      client_id uuid NOT NULL,
      meeting_id uuid NOT NULL,

      role text NOT NULL CHECK (role IN ('original','normalized','raw_result')),
      storage_key text NOT NULL,
      bytes bigint NOT NULL CHECK (bytes >= 0),
      -- NOT NULL: el worker verifica lo que descarga y mai lo que se subió.
      -- Un byte cambiado se detecta en vez de convertirse en un transcript raro.
      checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
      content_type text NOT NULL,

      -- Sondeo REAL de ffprobe, no lo que declaró el cliente.
      duration_seconds numeric(12,3) CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
      sample_rate integer CHECK (sample_rate IS NULL OR sample_rate > 0),
      channels smallint CHECK (channels IS NULL OR channels > 0),
      codec text,
      probe_ok boolean,
      probe_error text,

      -- Retención (D-2/D-12). NULL = conservar. El interruptor maestro está en
      -- client_modules.settings y por ahora está apagado, así que nada calcula
      -- este valor todavía.
      delete_after timestamptz,
      deleted_at timestamptz,

      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT meeting_media_meeting_fkey FOREIGN KEY (meeting_id, tenant_id, client_id)
        REFERENCES meetings (id, tenant_id, client_id) ON DELETE CASCADE,
      CONSTRAINT meeting_media_key_unique UNIQUE (storage_key),
      CONSTRAINT meeting_media_scope_key UNIQUE (id, tenant_id, client_id),
      -- Un probe que falló tiene que explicar por qué.
      CONSTRAINT meeting_media_probe_coherent CHECK (
        probe_ok IS NULL OR probe_ok = true OR probe_error IS NOT NULL
      )
    );

    -- Un solo 'original' VIVO por reunión; los derivados pueden ser varios y
    -- pueden repetirse entre runs.
    CREATE UNIQUE INDEX meeting_media_one_live_original_idx
      ON meeting_media (meeting_id)
      WHERE role = 'original' AND deleted_at IS NULL;
    CREATE INDEX meeting_media_meeting_idx ON meeting_media (meeting_id, role);
    -- El barrido de retención: sólo lo que tiene fecha y no está borrado.
    CREATE INDEX meeting_media_sweep_idx ON meeting_media (delete_after)
      WHERE delete_after IS NOT NULL AND deleted_at IS NULL;

    -- ═══════════════════════════════════════════════════════════════════════
    -- 3. meeting_processing_runs — un intento de procesar, inmutable
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE meeting_processing_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      client_id uuid NOT NULL,
      meeting_id uuid NOT NULL,

      run_number integer NOT NULL CHECK (run_number >= 1),
      trigger text NOT NULL
                             CHECK (trigger IN ('initial','reprocess','import','backfill')),
      requested_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      requested_options jsonb NOT NULL DEFAULT '{}'::jsonb,

      started_at timestamptz,
      finished_at timestamptz,
      outcome text CHECK (outcome IN ('succeeded','partial','failed','cancelled')),

      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT runs_meeting_fkey FOREIGN KEY (meeting_id, tenant_id, client_id)
        REFERENCES meetings (id, tenant_id, client_id) ON DELETE CASCADE,
      CONSTRAINT runs_number_key UNIQUE (meeting_id, run_number),
      CONSTRAINT runs_scope_key UNIQUE (id, tenant_id, client_id),
      -- Clave que INCLUYE meeting_id: es la que referencian jobs y
      -- transcript_versions, de modo que un run no puede pertenecer a una
      -- reunión y ser usado por otra.
      CONSTRAINT runs_meeting_scope_key UNIQUE (id, meeting_id, tenant_id, client_id),
      CONSTRAINT runs_options_object CHECK (jsonb_typeof(requested_options) = 'object'),
      -- Un run terminado tiene desenlace; uno en marcha no lo tiene todavía.
      CONSTRAINT runs_finish_coherent CHECK ((finished_at IS NULL) = (outcome IS NULL)),
      CONSTRAINT runs_time_order CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
    );

    -- D-3: MÁXIMO UN REPROCESO ACTIVO POR REUNIÓN, garantizado por la base.
    -- Un índice único parcial, no una comprobación en código que dos peticiones
    -- simultáneas puedan burlar.
    CREATE UNIQUE INDEX runs_one_active_per_meeting_idx
      ON meeting_processing_runs (meeting_id)
      WHERE finished_at IS NULL;

    CREATE INDEX runs_meeting_idx ON meeting_processing_runs (meeting_id, run_number DESC);

    -- ═══════════════════════════════════════════════════════════════════════
    -- 4. meeting_processing_jobs — LA COLA
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE meeting_processing_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      client_id uuid NOT NULL,
      meeting_id uuid NOT NULL,
      run_id uuid NOT NULL,

      stage text NOT NULL
                             CHECK (stage IN ('normalize','transcribe','diarize','analyze')),
      status text NOT NULL DEFAULT 'queued'
                             CHECK (status IN ('queued','leased','uploading_result',
                                               'succeeded','failed','cancelled','abandoned')),

      priority smallint NOT NULL DEFAULT 100,
      attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      max_attempts smallint NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
      -- Backoff exponencial con jitter: el barrido lo fija al requeuear.
      next_attempt_at timestamptz NOT NULL DEFAULT now(),

      -- Lease. El token se guarda SOLO como hash (requisito de T-1): el claro
      -- se devuelve una vez en la respuesta de claim y no se persiste nunca.
      lease_token_hash text CHECK (lease_token_hash IS NULL OR lease_token_hash ~ '^[0-9a-f]{64}$'),
      lease_expires_at timestamptz,
      -- La CREDENCIAL que sostiene el lease. Dos columnas y las dos exigidas
      -- mientras el lease está vivo.
      --
      -- La FK se añade en MEET-3 con ON DELETE RESTRICT. La revisión anterior
      -- la puso SET NULL con la idea de que borrar una credencial "liberaba" el
      -- job, y montó la invariante sobre la etiqueta para que el borrado no
      -- fallara. Eso estaba mal por el otro extremo: usar un DELETE como
      -- mecanismo de liberación destruye la atribución del trabajo en curso y
      -- convierte un descuido administrativo en pérdida de auditoría. Liberar
      -- un job es REVOCAR la credencial y REQUEUEAR en la misma transacción; el
      -- borrado físico no participa. Con RESTRICT la base impide el descuido en
      -- vez de absorberlo.
      --
      -- Y siendo así, 'leased_credential_label' ya no es "lo que sobrevive al
      -- borrado" — nada se borra. Su papel es otro: es el registro legible de
      -- QUÉ credencial sostuvo el lease (slug del pool + prefijo del token),
      -- escrito por mai a partir de la credencial ya verificada. Sobrevive a la
      -- rotación, que sí ocurre, y no obliga a un JOIN para responder "quién
      -- procesó esto". Es AUTORITATIVO.
      --
      -- 'leased_worker_label' es distinto: es lo que el worker dice llamarse.
      -- Telemetría, no identidad. Dos preguntas, dos columnas.
      leased_credential_label text,
      leased_credential_id uuid,
      leased_worker_label text,

      -- Heartbeat: se ACTUALIZA aquí, no se acumula como historia. 480 filas
      -- por reunión de 4 h no responden ninguna pregunta.
      last_heartbeat_at timestamptz,
      progress_pct smallint CHECK (progress_pct IS NULL OR progress_pct BETWEEN 0 AND 100),
      last_progress_at timestamptz,

      failure_code text,
      failure_detail text,
      -- COLUMNA GENERADA. El claim compara esto con las capacidades del pool.
      -- Al derivarse de 'stage' mediante una función IMMUTABLE, el mapeo no se
      -- puede contradecir: no hay forma de escribir un job que exija una
      -- capacidad que su etapa no necesita, ni una desconocida.
      requires text[] NOT NULL
                             GENERATED ALWAYS AS (ARRAY[meetings_stage_capability(stage)]) STORED,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT jobs_meeting_fkey FOREIGN KEY (meeting_id, tenant_id, client_id)
        REFERENCES meetings (id, tenant_id, client_id) ON DELETE CASCADE,
      -- El run tiene que ser de ESTA reunión.
      CONSTRAINT jobs_run_fkey FOREIGN KEY (run_id, meeting_id, tenant_id, client_id)
        REFERENCES meeting_processing_runs (id, meeting_id, tenant_id, client_id) ON DELETE CASCADE,
      -- Una etapa por run: reintentar incrementa 'attempts', no crea otra fila.
      CONSTRAINT jobs_stage_key UNIQUE (run_id, stage),
      CONSTRAINT jobs_scope_key UNIQUE (id, tenant_id, client_id),
      -- Referenciada por result_uploads y job_events.
      CONSTRAINT jobs_meeting_scope_key UNIQUE (id, meeting_id, tenant_id, client_id),
      -- INVARIANTES COMPLETAS POR ESTADO.
      --
      -- La primera versión sólo exigía lease en los estados activos y dejaba
      -- pasar token y expiración residuales en 'queued' y en los terminales. Un
      -- job en cola con token residual es a la vez reclamable y "ya reclamado".
      -- La segunda exigía la etiqueta pero no el uuid, para que borrar la
      -- credencial no rompiera el CHECK — un objetivo equivocado (ver arriba).
      --
      --   queued → NADA de lease: token, expiración, uuid y etiqueta
      --                       los cuatro NULL. Un requeue tiene que limpiarlos
      --                       todos, y por eso la atribución del intento que
      --                       acaba de soltarse NO vive aquí: vive en
      --                       'meeting_job_events', que es la tabla que
      --                       conserva la historia. Esta columna guarda el
      --                       lease ACTUAL, no los pasados.
      --
      --   leased → los CUATRO obligatorios. Sin uuid no hay a quién
      --   uploading_result revocar; sin etiqueta no se puede responder quién
      --                       procesa esto sin un JOIN; y un job activo que
      --                       tuviera sólo la etiqueta apuntaría a una
      --                       credencial que la base no puede verificar.
      --
      --   terminales → token y expiración a NULL (el lease terminó), y
      --                       uuid y etiqueta SE CONSERVAN como auditoría. No se
      --                       EXIGEN: un job cancelado desde la cola nunca tuvo
      --                       credencial, y obligarle a inventar una sería
      --                       falsear el registro.
      CONSTRAINT jobs_lease_invariants CHECK (
        CASE status
          WHEN 'queued' THEN
            lease_token_hash IS NULL AND lease_expires_at IS NULL
            AND leased_credential_id IS NULL AND leased_credential_label IS NULL
          WHEN 'leased' THEN
            lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL
            AND leased_credential_id IS NOT NULL AND leased_credential_label IS NOT NULL
          WHEN 'uploading_result' THEN
            lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL
            AND leased_credential_id IS NOT NULL AND leased_credential_label IS NOT NULL
          ELSE
            -- succeeded | failed | cancelled | abandoned
            lease_token_hash IS NULL AND lease_expires_at IS NULL
        END
      ),
      -- El uuid y la etiqueta describen LA MISMA credencial: o están los dos o
      -- no está ninguno, en cualquier estado. Sin esto, un terminal podría
      -- quedarse con una etiqueta huérfana que nadie puede verificar, y la
      -- auditoría diría un nombre que la base no respalda.
      CONSTRAINT jobs_credential_pair CHECK (
        (leased_credential_id IS NULL) = (leased_credential_label IS NULL)
      ),
      -- Un fallo explica por qué.
      CONSTRAINT jobs_failure_coherent CHECK (
        status <> 'failed' OR failure_code IS NOT NULL
      ),
      CONSTRAINT jobs_attempts_bounded CHECK (attempts <= max_attempts)
    );

    -- EL ÍNDICE DEL CLAIM ATÓMICO. La consulta es
    --   SELECT id FROM meeting_processing_jobs
    --    WHERE status='queued' AND next_attempt_at <= now()
    --    ORDER BY priority, next_attempt_at
    --    FOR UPDATE SKIP LOCKED LIMIT 1
    -- Parcial sobre 'queued': el histórico de jobs terminados no se escanea.
    CREATE INDEX jobs_claimable_idx
      ON meeting_processing_jobs (priority, next_attempt_at, created_at)
      WHERE status = 'queued';

    -- El barrido de leases caídos.
    CREATE INDEX jobs_lease_sweep_idx
      ON meeting_processing_jobs (lease_expires_at)
      WHERE status IN ('leased','uploading_result');

    -- Consultas por reunión (la UI) y por credencial (auditoría).
    CREATE INDEX jobs_meeting_idx ON meeting_processing_jobs (meeting_id, stage);
    CREATE INDEX jobs_tenant_status_idx
      ON meeting_processing_jobs (tenant_id, client_id, status, updated_at DESC);
    CREATE INDEX jobs_credential_idx
      ON meeting_processing_jobs (leased_credential_id)
      WHERE leased_credential_id IS NOT NULL;

    -- ═══════════════════════════════════════════════════════════════════════
    -- 5. meeting_job_events — auditoría, append-only
    -- ═══════════════════════════════════════════════════════════════════════
    -- HECHOS, no latidos. El heartbeat actualiza el job (arriba); aquí sólo
    -- entran claims, transiciones, reintentos, cancelaciones, errores y
    -- progreso MUESTREADO.
    CREATE TABLE meeting_job_events (
      id bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL,
      client_id uuid NOT NULL,
      meeting_id uuid NOT NULL,
      job_id uuid,
      attempt smallint NOT NULL DEFAULT 0,

      at timestamptz NOT NULL DEFAULT now(),
      kind text NOT NULL
                      CHECK (kind IN ('claimed','state_changed','progress','retried',
                                      'lease_expired','cancelled','failed','result_ingested')),
      stage text CHECK (stage IS NULL OR stage IN ('normalize','transcribe','diarize','analyze')),
      progress_pct smallint CHECK (progress_pct IS NULL OR progress_pct BETWEEN 0 AND 100),
      credential_id uuid,
      worker_label text,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,

      CONSTRAINT job_events_meeting_fkey FOREIGN KEY (meeting_id, tenant_id, client_id)
        REFERENCES meetings (id, tenant_id, client_id) ON DELETE CASCADE,
      -- DECISIÓN EXPLÍCITA: FK mientras el job exista, y al desaparecer se
      -- anula SÓLO job_id. La auditoría sobrevive con su meeting_id, tenant y
      -- cliente intactos — que es el punto de una tabla de auditoría — y a la
      -- vez la base garantiza que, mientras el puntero no sea NULL, apunta a un
      -- job real de ESTA reunión. La alternativa (sin FK) dejaba un uuid que
      -- podía no corresponder a nada y aun así parecer una relación.
      CONSTRAINT job_events_job_fkey FOREIGN KEY (job_id, meeting_id, tenant_id, client_id)
        REFERENCES meeting_processing_jobs (id, meeting_id, tenant_id, client_id)
        ON DELETE SET NULL (job_id),
      CONSTRAINT job_events_detail_object CHECK (jsonb_typeof(detail) = 'object')
    );

    CREATE INDEX job_events_meeting_idx ON meeting_job_events (meeting_id, at DESC);
    CREATE INDEX job_events_job_idx ON meeting_job_events (job_id, at DESC) WHERE job_id IS NOT NULL;
    CREATE INDEX job_events_credential_idx
      ON meeting_job_events (credential_id, at DESC) WHERE credential_id IS NOT NULL;
  `);
}

/**
 * down rehúsa ejecutarse si hay reuniones. Borrar el trabajo de un cliente para
 * deshacer un despliegue es peor que un error explícito — el mismo criterio que
 * MOD-3.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    DECLARE n bigint;
    BEGIN
      SELECT count(*) INTO n FROM meetings;
      IF n > 0 THEN
        RAISE EXCEPTION
          'MEET-1 down abortado: existen % reunion(es). Bórralas explícitamente antes de revertir (evita pérdida silenciosa).', n;
      END IF;
    END $$;

    DROP TABLE IF EXISTS meeting_job_events;
    DROP TABLE IF EXISTS meeting_processing_jobs;
    DROP TABLE IF EXISTS meeting_processing_runs;
    DROP TABLE IF EXISTS meeting_media;
    DROP TABLE IF EXISTS meetings;

    DROP FUNCTION IF EXISTS meetings_known_capabilities(text[]);
    DROP FUNCTION IF EXISTS meetings_known_capability(text);
    DROP FUNCTION IF EXISTS meetings_stage_capability(text);
  `);
}
