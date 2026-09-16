import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `meeting_analyses` — el resumen de una reunión, atado a la versión EXACTA de
 * transcripción con la que se produjo.
 *
 * MEET-1 dejó preparados `meetings.analysis_state` y `meetings.active_analysis_id`,
 * y `meeting_result_uploads.kind` ya admite `'analysis'`. Esta migración pone la
 * tabla que faltaba y ata la FK que aquel comentario aplazaba.
 *
 * ── Por qué la clave es `transcript_id` y no `meeting_id` ──────────────────
 *
 * Un resumen NO es de una reunión: es de un TEXTO concreto. Si la reunión se
 * reprocesa y cambia la transcripción, el resumen anterior no queda «un poco
 * viejo», queda hablando de otro documento — con otros segmentos, otros tiempos y
 * otras referencias. Atarlo a la versión hace que eso sea detectable comparando
 * dos uuid, en vez de una marca de tiempo que hay que interpretar:
 *
 *     análisis desactualizado  ⇔  analysis.transcript_id <> meetings.active_transcript_id
 *
 * ── Y por qué es UNIQUE ────────────────────────────────────────────────────
 *
 * `UNIQUE (transcript_id)` es lo que evita gastar dos veces. Un doble clic, una
 * recarga o un reintento convergen en la misma fila en vez de hacer dos llamadas
 * de pago: la segunda choca con la restricción y devuelve la existente. La
 * garantía es de la base, no de una comprobación en el código que dos peticiones
 * simultáneas puedan burlar — el mismo patrón que `runs_one_active_per_meeting_idx`.
 *
 * Rehacer un resumen sobre el MISMO texto es, por tanto, un borrado explícito
 * seguido de una generación. Deliberado: que cueste dinero debe costar una
 * decisión.
 *
 * ── Pero UNIQUE por sí solo NO evita pagar dos veces ───────────────────────
 *
 * Dos peticiones simultáneas pueden consultar las dos, no encontrar nada, llamar
 * las dos al proveedor —y pagar las dos— y sólo entonces chocar al insertar. El
 * UNIQUE impide la segunda FILA, no el segundo COBRO.
 *
 * Por eso la fila se crea ANTES de llamar, en estado `pending`: la reserva es el
 * propio INSERT, y `ON CONFLICT DO NOTHING` hace que exactamente una petición
 * salga con ella. La que no la consigue no llama a nadie: devuelve el análisis
 * terminado si lo hay, o «generando».
 *
 * `reserved_at` existe para lo que pasa cuando el proceso que reservó se muere:
 * sin eso la reunión quedaría bloqueada para siempre en `pending`. Pasado un
 * plazo, otra petición puede APROPIARSE de la reserva con un UPDATE condicional,
 * que también es atómico.
 *
 * ── Lo que NO se guarda ────────────────────────────────────────────────────
 *
 * Ni el prompt, ni la respuesta cruda, ni el texto enviado. Se guarda el
 * RESULTADO estructurado —que es lo que la pantalla lee— y el CONSUMO en tokens.
 * El contenido privado ya vive en `meeting_segments`; duplicarlo aquí sería
 * ampliar la superficie sin ganar nada.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE meeting_analyses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      client_id uuid NOT NULL,
      meeting_id uuid NOT NULL,
      -- La versión de transcripción que se resumió. NOT NULL: un resumen sin
      -- texto de origen no es verificable, y todo esto existe para que lo sea.
      transcript_id uuid NOT NULL,

      provider text NOT NULL,
      model text NOT NULL,
      -- Cambiar el prompt cambia el resultado. Sin esto, dos resúmenes iguales en
      -- apariencia podrían venir de instrucciones distintas y nada lo diría.
      prompt_version integer NOT NULL,

      -- 'pending' = reservado, llamada en curso. La fila nace así, ANTES de
      -- llamar al proveedor, y ésa es la reserva.
      status text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','ready','failed')),
      -- Cuándo se reservó y quién. Lo segundo es un identificador efímero de la
      -- petición, no una persona: sirve para saber si la reserva es nuestra.
      reserved_at timestamptz NOT NULL DEFAULT now(),
      reserved_by text,

      -- El MeetingSummary que la pantalla pinta, ya validado contra el transcript.
      -- NULL mientras está reservado: todavía no hay nada que pintar.
      payload jsonb,

      -- Consumo, para poder sumar el gasto. NUNCA contenido.
      input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
      output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
      -- NULL = no se sabe, y se dirá «no disponible». Un 0 se lee como gratis, y
      -- un modelo cuyo precio no conocemos no es gratis: es desconocido.
      cost_usd numeric(10,6) CHECK (cost_usd IS NULL OR cost_usd >= 0),
      -- El modelo que el proveedor dice haber usado, que puede no ser el pedido
      -- (un alias se resuelve a una versión concreta). Se guardan los dos.
      model_returned text,
      duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),

      created_at timestamptz NOT NULL DEFAULT now(),
      created_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,

      CONSTRAINT analyses_meeting_fkey FOREIGN KEY (meeting_id, tenant_id, client_id)
        REFERENCES meetings (id, tenant_id, client_id) ON DELETE CASCADE,
      -- La FK compuesta incluye tenant y cliente: un análisis no puede colgar de
      -- la transcripción de otro cliente ni por un error de código.
      CONSTRAINT analyses_transcript_fkey FOREIGN KEY (transcript_id, tenant_id, client_id)
        REFERENCES meeting_transcript_versions (id, tenant_id, client_id) ON DELETE CASCADE,
      -- UN análisis por versión de transcripción. Es la defensa contra el gasto
      -- duplicado, y está en la base a propósito.
      CONSTRAINT analyses_transcript_key UNIQUE (transcript_id),
      CONSTRAINT analyses_scope_key UNIQUE (id, tenant_id, client_id),
      CONSTRAINT analyses_meeting_scope_key UNIQUE (id, meeting_id, tenant_id, client_id),
      CONSTRAINT analyses_payload_object
        CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
      -- Un análisis 'ready' sin contenido sería una pantalla vacía que dice estar
      -- lista. La base lo impide en vez de confiar en que el código no lo escriba.
      CONSTRAINT analyses_ready_has_payload
        CHECK (status <> 'ready' OR payload IS NOT NULL)
    );

    CREATE INDEX analyses_meeting_idx ON meeting_analyses (meeting_id, created_at DESC);
    -- Para encontrar reservas abandonadas sin recorrer la tabla.
    CREATE INDEX analyses_pending_idx ON meeting_analyses (reserved_at) WHERE status = 'pending';

    COMMENT ON COLUMN meeting_analyses.transcript_id IS
      'La versión de transcripción resumida. Si difiere de meetings.active_transcript_id, el resumen está desactualizado.';
    COMMENT ON COLUMN meeting_analyses.payload IS
      'MeetingSummary validado: referencias comprobadas contra los segmentos de esa versión. NULL mientras status=pending.';
    COMMENT ON COLUMN meeting_analyses.status IS
      'pending = reserva viva, llamada en curso. La fila se crea ANTES de llamar al proveedor: es lo que evita pagar dos veces.';
    COMMENT ON COLUMN meeting_analyses.cost_usd IS
      'Estimación a partir de una tabla de precios local. NULL cuando el modelo no está en ella: no disponible, no gratis.';

    -- La FK que MEET-1 dejó anotada como pendiente «cuando exista meeting_analyses».
    ALTER TABLE meetings
      ADD CONSTRAINT meetings_active_analysis_fkey
      FOREIGN KEY (active_analysis_id, tenant_id, client_id)
      REFERENCES meeting_analyses (id, tenant_id, client_id) ON DELETE SET NULL (active_analysis_id);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_active_analysis_fkey;
    UPDATE meetings SET active_analysis_id = NULL WHERE active_analysis_id IS NOT NULL;
    DROP TABLE IF EXISTS meeting_analyses;
  `);
}
