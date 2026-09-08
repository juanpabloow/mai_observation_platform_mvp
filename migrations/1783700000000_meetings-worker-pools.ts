import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * MEET-3 · Pools y credenciales de worker (D-7).
 *
 * Aditiva: dos tablas y una función IMMUTABLE de validación.
 *
 * ── Por qué NO se reutiliza `handoff_tokens` ───────────────────────────────
 *
 * Está atado a `n8n_connection_id NOT NULL` y su cadena de verificación exige
 * `X-Workflow-Ref` (web/lib/crmApi.ts). Un worker de GPU no es una conexión de
 * n8n; forzarlo a fingir que lo es dejaría un `n8n_connections` fantasma por
 * worker, y el header fue descartado explícitamente.
 *
 * ── Qué garantiza la base y qué NO ─────────────────────────────────────────
 *
 * GARANTÍA REAL, corregida. La revisión anterior afirmaba que el CHECK
 * de formato hex "impide guardar el token en claro". Es falso: el CHECK sólo
 * acepta 64 caracteres de [0-9a-f]. Un secreto que casualmente tenga esa forma
 * —y generar tokens en hexadecimal de 32 bytes es justo lo natural— pasaría el
 * CHECK sin objeción. Lo que el CHECK da de verdad es más modesto y sigue
 * valiendo la pena:
 *
 * · rechaza cualquier valor que NO tenga la forma de un sha256, lo que atrapa
 * el error grosero de escribir ahí un secreto con prefijo, guiones, base64
 * o longitud distinta;
 * · fija la forma de la columna, de modo que la comparación en el claim es
 * siempre entre dos digests del mismo tipo.
 *
 * La garantía de que el valor almacenado es un HASH y no el secreto vive en el
 * servicio que emite la credencial: genera entropía, deriva el sha256, persiste
 * el digest y devuelve el claro UNA vez sin escribirlo en ninguna parte. Es una
 * garantía de código, y así hay que documentarla; la base no puede distinguir
 * un digest de un secreto que se le parezca.
 * · Un pool `internal` (que ve trabajo de cualquier tenant) NO PUEDE EXISTIR
 * sin constancia de quién lo autorizó y cuándo. Es un CHECK, no una
 * convención.
 * · `concurrency` es jsonb VALIDADO: estructura, schema_version, capacidades
 * conocidas y enteros positivos acotados. No es un jsonb arbitrario.
 *
 * ── Por qué `concurrency` es jsonb y no una columna ────────────────────────
 *
 * D-10: el mismo runtime reclama `meetings.transcribe` y `meetings.analyze`. La
 * GPU admite un job a la vez; el análisis es I/O contra un LLM y admite varios.
 * Con un solo número, o se desaprovecha el LLM o se satura la GPU. La forma es
 *
 * { "schema_version": 1, "limits": { "meetings.transcribe": 1, "meetings.analyze": 4 } }
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- ═══════════════════════════════════════════════════════════════════════
    -- 0. Validadores de 'concurrency' y de coherencia del pool
    -- ═══════════════════════════════════════════════════════════════════════
    -- 'meetings_known_capability' y 'meetings_known_capabilities' YA NO SE
    -- CREAN AQUÍ: viven en MEET-1, donde también se define el mapeo
    -- etapa→capacidad que gobierna 'meeting_processing_jobs.requires'. Tener el
    -- vocabulario en dos migraciones permitía que MEET-1 y MEET-3 discreparan
    -- sobre qué capacidades existen, que es exactamente el desacuerdo que hace
    -- un job inreclamable para siempre.

    -- Valida la ESTRUCTURA de concurrency. Rechaza:
    --   · lo que no sea objeto
    --   · schema_version ausente o distinto de 1
    --   · claves de primer nivel desconocidas
    --   · 'limits' ausente o no objeto
    --   · capacidades desconocidas dentro de limits
    --   · valores no enteros, <= 0, o > 64
    -- Un CHECK no admite subconsultas; encapsularlas en una función IMMUTABLE
    -- sí está permitido y es el mecanismo estándar para esto.
    CREATE FUNCTION meetings_valid_concurrency(cfg jsonb)
    RETURNS boolean AS $$
      SELECT
        jsonb_typeof(cfg) = 'object'
        -- schema_version obligatorio y conocido
        AND cfg ? 'schema_version'
        AND jsonb_typeof(cfg->'schema_version') = 'number'
        AND (cfg->>'schema_version')::numeric = 1
        -- sin claves desconocidas de primer nivel
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_object_keys(cfg) k
           WHERE k NOT IN ('schema_version', 'limits')
        )
        -- limits obligatorio y objeto
        AND cfg ? 'limits'
        AND jsonb_typeof(cfg->'limits') = 'object'
        -- al menos un límite: un pool sin límites no puede reclamar nada
        AND EXISTS (SELECT 1 FROM jsonb_object_keys(cfg->'limits') k)
        -- toda clave es una capacidad conocida
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_object_keys(cfg->'limits') k
           WHERE NOT meetings_known_capability(k)
        )
        -- todo valor es entero positivo y acotado
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_each(cfg->'limits') AS e(k, v)
           WHERE jsonb_typeof(v) <> 'number'
              OR (v::text)::numeric <> trunc((v::text)::numeric)
              OR (v::text)::numeric < 1
              OR (v::text)::numeric > 64
        );
    $$ LANGUAGE sql IMMUTABLE STRICT;

    -- COHERENCIA ENTRE 'capabilities' Y 'concurrency'.
    --
    -- Antes se validaban por separado: cada una era internamente correcta y
    -- entre las dos podían decir cosas incompatibles. Los dos fallos que eso
    -- permitía son silenciosos y de distinto signo:
    --
    --   capabilities = {meetings.transcribe, meetings.analyze}
    --   limits = {meetings.transcribe: 1}
    --     → el pool ANUNCIA que analiza, el planificador le asigna análisis, y
    --       el worker no tiene límite para esa capacidad. Según cómo lo lea el
    --       claim: o no reclama nunca (trabajo parado sin error) o reclama sin
    --       tope (satura el runtime).
    --
    --   capabilities = {meetings.transcribe}
    --   limits = {meetings.transcribe: 1, meetings.analyze: 4}
    --     → hay un presupuesto de concurrencia reservado para una capacidad que
    --       el pool no declara. Capacidad muerta que parece configurada.
    --
    -- Así que la base exige la BIYECCIÓN: toda clave de limits está declarada, y
    -- toda capacidad declarada tiene límite. Y exige al menos una: un pool sin
    -- capacidades efectivas no puede reclamar nada, y un pool que no puede
    -- reclamar nada es un registro que engaña a quien lo lee.
    CREATE FUNCTION meetings_pool_coherent(caps text[], cfg jsonb)
    RETURNS boolean AS $$
      SELECT caps IS NOT NULL
         AND cfg IS NOT NULL
         AND cardinality(caps) >= 1
         -- toda clave de limits está declarada en capabilities
         AND NOT EXISTS (
               SELECT 1 FROM jsonb_object_keys(cfg->'limits') AS k
                WHERE NOT (k = ANY (caps))
             )
         -- toda capacidad declarada tiene un límite
         AND NOT EXISTS (
               SELECT 1 FROM unnest(caps) AS c
                WHERE NOT (cfg->'limits' ? c)
             );
    $$ LANGUAGE sql IMMUTABLE;

    -- ═══════════════════════════════════════════════════════════════════════
    -- 1. worker_pools
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE worker_pools (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
      environment text NOT NULL
                     CHECK (environment IN ('production','staging','development')),

      -- 'internal' → ve trabajo de cualquier tenant. Requiere autorización
      --                   explícita y auditada (CHECK de abajo).
      -- 'single_tenant' → un tenant fijo.
      --
      -- 'allowlist' NO EXISTE TODAVÍA. La revisión anterior lo admitía —y
      -- peor, era el DEFAULT— apuntando a 'worker_pool_tenants', una tabla que
      -- MEET-11 creará y que está fuera del MVP. Un pool con scope 'allowlist'
      -- y sin tabla de allowlist no tiene lista: o el claim no le da nada (y el
      -- trabajo se queda parado sin explicación) o alguien "arregla" el claim
      -- tratándolo como internal, que es la falla de aislamiento entre tenants.
      -- Un valor de enum cuyo mecanismo no existe es una trampa; se añade
      -- cuando se añada la tabla, en la misma migración.
      --
      -- El DEFAULT es ahora el scope MÁS RESTRICTIVO que sigue siendo usable:
      -- 'single_tenant'. Crear un pool sin decidir su alcance ya no produce el
      -- caso ambiguo, produce uno que exige nombrar el tenant.
      scope text NOT NULL DEFAULT 'single_tenant'
                     CHECK (scope IN ('internal','single_tenant')),
      tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,

      -- LA AUTORIZACIÓN ES UN SNAPSHOT, NO UNA FK.
      --
      -- Antes 'internal_authorized_by_user_id' era una FK con ON DELETE SET
      -- NULL y a la vez 'pools_internal_authorized' prohibía que fuese NULL.
      -- Las dos reglas se contradicen: borrar al usuario que autorizó el pool
      -- habría intentado poner NULL en una columna que un CHECK exige no nula,
      -- y la eliminación habría fallado con un error incomprensible. Peor: la
      -- combinación implicaba que la constancia de la autorización podía
      -- desaparecer por un borrado ajeno.
      --
      -- Ni SET NULL ni RESTRICT son buenos aquí. RESTRICT convierte un pool
      -- interno en un motivo para no poder dar de baja a una persona, para
      -- siempre. Lo que se necesita es un registro que ya no dependa de que la
      -- fila del usuario siga existiendo: la autorización es un HECHO HISTÓRICO
      -- y los hechos históricos se copian, no se referencian.
      --
      -- Así que hay dos columnas con papeles distintos:
      --   · el snapshot ('..._actor_label'), obligatorio si el pool es interno,
      --     sin FK, inmune a borrados;
      --   · el puntero ('..._user_id'), útil mientras el usuario exista para
      --     enlazar a su ficha, con SET NULL y SIN ninguna constraint que lo
      --     obligue a estar presente.
      internal_authorized_actor_label text,
      internal_authorized_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      internal_authorized_at timestamptz,
      internal_authorization_note text,

      -- El default declara la capacidad que el default de 'concurrency' limita:
      -- si no, la fila por defecto sería incoherente.
      capabilities text[] NOT NULL DEFAULT '{meetings.transcribe}',
      concurrency jsonb NOT NULL
                     DEFAULT '{"schema_version":1,"limits":{"meetings.transcribe":1}}'::jsonb,
      max_bytes bigint CHECK (max_bytes IS NULL OR max_bytes > 0),

      enabled boolean NOT NULL DEFAULT true,
      created_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT pools_slug_env_key UNIQUE (slug, environment),
      CONSTRAINT pools_scope_coherent CHECK (
        (scope = 'single_tenant' AND tenant_id IS NOT NULL) OR
        (scope <> 'single_tenant' AND tenant_id IS NULL)
      ),
      -- Un pool interno global SIN autorización explícita no puede existir. Se
      -- exige el SNAPSHOT, no la FK: es lo que sobrevive al borrado del usuario.
      CONSTRAINT pools_internal_authorized CHECK (
        scope <> 'internal' OR
        (internal_authorized_actor_label IS NOT NULL AND internal_authorized_at IS NOT NULL)
      ),
      -- Un pool no interno no lleva rastro de una autorización que no necesita.
      CONSTRAINT pools_authorization_scoped CHECK (
        scope = 'internal' OR
        (internal_authorized_actor_label IS NULL
         AND internal_authorized_at IS NULL
         AND internal_authorized_by_user_id IS NULL)
      ),
      -- Toda capacidad declarada tiene que ser conocida (vocabulario de MEET-1).
      CONSTRAINT pools_capabilities_known CHECK (meetings_known_capabilities(capabilities)),
      CONSTRAINT pools_concurrency_valid CHECK (meetings_valid_concurrency(concurrency)),
      -- Y las dos tienen que decir lo mismo.
      CONSTRAINT pools_coherent CHECK (meetings_pool_coherent(capabilities, concurrency))
    );

    CREATE INDEX pools_caps_idx ON worker_pools USING gin (capabilities);
    CREATE INDEX pools_enabled_idx ON worker_pools (environment, scope) WHERE enabled;

    -- ═══════════════════════════════════════════════════════════════════════
    -- 2. worker_credentials — sólo hash
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE worker_credentials (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      pool_id uuid NOT NULL REFERENCES worker_pools (id) ON DELETE CASCADE,
      label text NOT NULL,

      -- sha256 en hex, 64 caracteres. El CHECK fija la FORMA de la columna y
      -- atrapa el error grosero de escribir aquí algo que no es un digest; NO
      -- puede garantizar que lo que hay sea un hash y no un secreto parecido
      --. Esa garantía la da el servicio emisor. Ver el docstring.
      token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      -- Prefijo para identificarlo en la UI. Corto a propósito: 8 caracteres no
      -- permiten reconstruir el secreto.
      token_prefix text NOT NULL CHECK (char_length(token_prefix) BETWEEN 4 AND 12),

      -- Rotación sin ventana de caída: la vieja y la nueva conviven hasta que
      -- la vieja expira.
      rotated_from_id uuid REFERENCES worker_credentials (id) ON DELETE SET NULL,
      expires_at timestamptz,

      -- REVOCACIÓN CON AUTOR SIEMPRE IDENTIFICABLE.
      --
      -- La constraint anterior era
      --   (revoked_at IS NULL) = (by_user IS NULL AND reason IS NULL)
      --      OR revoked_at IS NOT NULL
      -- y la segunda rama vaciaba la primera: en cuanto revoked_at no es NULL,
      -- la disyunción es cierta pase lo que pase con autor y motivo. Es decir,
      -- se podía revocar una credencial sin dejar constancia de quién ni por
      -- qué — precisamente el registro que existe para responder eso.
      --
      -- La causa de fondo era que no había forma de expresar una revocación
      -- AUTOMÁTICA: el barrido de credenciales caducadas, o la respuesta a un
      -- secreto filtrado, no tienen un usuario detrás, así que la única salida
      -- era dejar el hueco. Se resuelve nombrando al actor en vez de suponerlo
      -- humano:
      --
      --   'user' → la revocó una persona.
      --   'system' → la revocó un proceso ('expiry-sweep', 'leak-response'…).
      --
      -- Y quién fue se guarda en un SNAPSHOT, no en una FK, por la misma razón
      -- que en worker_pools: la revocación es un hecho histórico. El
      -- primer intento aquí exigía 'revoked_by_user_id IS NOT NULL' cuando el
      -- actor era 'user', teniendo esa columna ON DELETE SET NULL — la misma
      -- contradicción que #6 denunciaba, reintroducida una tabla más abajo. La
      -- prueba que borra de verdad al usuario que revocó la destapó: el DELETE
      -- fallaba con una violación de CHECK y dar de baja a una persona quedaba
      -- bloqueado por una credencial que ella misma había revocado.
      --
      -- Así que 'revoked_actor_label' es el registro (correo de la persona o
      -- nombre del proceso) y 'revoked_by_user_id' es sólo un puntero cómodo
      -- mientras la fila exista. Ninguna constraint lo exige.
      revoked_at timestamptz,
      revoked_actor text CHECK (revoked_actor IS NULL
                                      OR revoked_actor IN ('user','system')),
      revoked_actor_label text,
      revoked_reason text,
      revoked_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,

      -- Telemetría DECLARADA por el worker, guardada aquí. Nunca se lee del
      -- cuerpo de una petición para autorizar nada.
      declared_backends text[] NOT NULL DEFAULT '{}',
      declared_models text[] NOT NULL DEFAULT '{}',
      worker_version text,
      gpu_name text,

      last_used_at timestamptz,
      last_seen_ip inet,
      created_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT credentials_hash_key UNIQUE (token_hash),
      -- Sin revocar: ni un solo campo de revocación relleno.
      CONSTRAINT credentials_not_revoked_clean CHECK (
        revoked_at IS NOT NULL OR (
          revoked_actor IS NULL AND revoked_actor_label IS NULL
          AND revoked_reason IS NULL AND revoked_by_user_id IS NULL
        )
      ),
      -- Revocada: actor, quién y por qué, los tres obligatorios. Y un proceso
      -- no puede presentarse con el usuario de nadie.
      CONSTRAINT credentials_revoked_attributed CHECK (
        revoked_at IS NULL OR (
          revoked_actor IS NOT NULL
          AND revoked_actor_label IS NOT NULL
          AND revoked_reason IS NOT NULL
          AND (revoked_actor <> 'system' OR revoked_by_user_id IS NULL)
        )
      ),
      -- No se rota una credencial hacia sí misma.
      CONSTRAINT credentials_no_self_rotation CHECK (rotated_from_id IS NULL OR rotated_from_id <> id)
    );

    CREATE INDEX credentials_pool_idx ON worker_credentials (pool_id);
    -- El lookup del claim: sólo credenciales vivas.
    CREATE INDEX credentials_live_idx ON worker_credentials (token_hash)
      WHERE revoked_at IS NULL;
    CREATE INDEX credentials_prefix_idx ON worker_credentials (token_prefix);

    -- ═══════════════════════════════════════════════════════════════════════
    -- 3. La FK del lease sobre la credencial
    -- ═══════════════════════════════════════════════════════════════════════
    -- MEET-1 declaró 'leased_credential_id' y 'meeting_job_events.credential_id'
    -- sin FK porque la tabla no existía.
    --
    -- ON DELETE RESTRICT, no SET NULL ni CASCADE.
    --
    -- La revisión anterior usó SET NULL razonando que "borrar una credencial no
    -- debe borrar el job que estaba procesando; el barrido de leases lo devuelve
    -- a la cola". La conclusión era correcta y la premisa no: el problema no es
    -- qué pasa cuando se borra una credencial referenciada, es que eso NO DEBE
    -- PASAR. Una credencial que un job o un evento menciona es la respuesta a
    -- "quién procesó esto"; borrarla no libera trabajo, borra la atribución.
    -- Y usar el DELETE como mecanismo de liberación es peor todavía, porque
    -- convierte una limpieza administrativa descuidada en pérdida silenciosa de
    -- auditoría sobre trabajo en curso.
    --
    -- El mecanismo correcto para liberar un job es REVOCAR (revoked_at) y
    -- REQUEUEAR en la misma transacción: el job vuelve a 'queued' con token,
    -- expiración, uuid y etiqueta a NULL, la credencial queda inutilizable para
    -- futuros claims, y la historia del intento anterior está en
    -- 'meeting_job_events'. El borrado físico no participa en la operación
    -- normal; si algún día hace falta, primero hay que comprobar que nadie la
    -- referencia — y RESTRICT es exactamente esa comprobación, hecha por la base
    -- en vez de por quien recuerde hacerla.
    ALTER TABLE meeting_processing_jobs
      ADD CONSTRAINT jobs_credential_fkey
      FOREIGN KEY (leased_credential_id)
      REFERENCES worker_credentials (id) ON DELETE RESTRICT;

    ALTER TABLE meeting_job_events
      ADD CONSTRAINT job_events_credential_fkey
      FOREIGN KEY (credential_id)
      REFERENCES worker_credentials (id) ON DELETE RESTRICT;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    DECLARE n bigint;
    BEGIN
      SELECT count(*) INTO n FROM worker_credentials;
      IF n > 0 THEN
        RAISE EXCEPTION
          'MEET-3 down abortado: existen % credencial(es) de worker. Revócalas, comprueba que ningún job ni evento las referencie, y bórralas explícitamente antes de revertir.', n;
      END IF;
    END $$;

    ALTER TABLE meeting_job_events DROP CONSTRAINT IF EXISTS job_events_credential_fkey;
    ALTER TABLE meeting_processing_jobs DROP CONSTRAINT IF EXISTS jobs_credential_fkey;

    DROP TABLE IF EXISTS worker_credentials;
    DROP TABLE IF EXISTS worker_pools;

    -- El vocabulario de capacidades es de MEET-1 y su 'down' lo borra: aquí
    -- sólo se retira lo que aquí se creó.
    DROP FUNCTION IF EXISTS meetings_pool_coherent(text[], jsonb);
    DROP FUNCTION IF EXISTS meetings_valid_concurrency(jsonb);
  `);
}
