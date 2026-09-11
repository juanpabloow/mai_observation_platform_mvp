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

      -- El MeetingSummary que la pantalla pinta, ya validado contra el transcript.
      payload jsonb NOT NULL,

      -- Consumo, para poder sumar el gasto. NUNCA contenido.
      input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
      output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
      cost_usd numeric(10,6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
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
      CONSTRAINT analyses_payload_object CHECK (jsonb_typeof(payload) = 'object')
    );

    CREATE INDEX analyses_meeting_idx ON meeting_analyses (meeting_id, created_at DESC);

    COMMENT ON COLUMN meeting_analyses.transcript_id IS
      'La versión de transcripción resumida. Si difiere de meetings.active_transcript_id, el resumen está desactualizado.';
    COMMENT ON COLUMN meeting_analyses.payload IS
      'MeetingSummary validado: referencias comprobadas contra los segmentos de esa versión.';

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
