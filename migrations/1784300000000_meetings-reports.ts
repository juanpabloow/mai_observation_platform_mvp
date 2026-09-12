import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Reportes con plantilla: instrucciones editables, versionadas y auditadas, y
 * varios reportes por versión de transcripción.
 *
 * ── Por qué `meeting_analyses` y no una tabla de reportes ──────────────────
 *
 * Porque todo lo que rodea a un artefacto de IA ya está resuelto ahí y no tiene
 * nada que ver con su forma: la reserva atómica ANTES de gastar, la apropiación
 * de reservas abandonadas, el consumo en tokens, el coste estimado con su NULL
 * que significa «no se sabe», las FK compuestas con tenant y cliente, y el
 * `ON DELETE CASCADE` desde la reunión —que es lo que hace que eliminar una
 * reunión se lleve también sus reportes sin que nadie se acuerde de borrarlos—.
 * Una tabla paralela duplicaría esa maquinaria para ganar sólo un nombre.
 *
 * ── La identidad de un reporte NO es su tipo ───────────────────────────────
 *
 * MEET-5 puso `UNIQUE (transcript_id)` porque «un resumen por texto» era la
 * regla. Un reporte no tiene esa regla: la misma transcripción puede tener
 * cuatro reportes de cuatro plantillas, y el mismo reporte regenerado tras
 * editar sus instrucciones debe ser una fila NUEVA y no un machaque silencioso.
 *
 * Así que las dos reglas de identidad son distintas y NO comparten índice. Dos
 * índices únicos PARCIALES:
 *
 *   - el resumen sigue siendo uno por `transcript_id`;
 *   - un reporte es único por `(transcript_id, inputs_digest)`.
 *
 * `inputs_digest` resume lo que determina el resultado: la transcripción, la
 * plantilla, su versión, el texto literal de las instrucciones, el modelo y la
 * versión del prompt interno. Con eso la reserva atómica que ya existe sigue
 * siendo la defensa contra el cobro doble, y cada caso cae donde debe: un doble
 * clic converge en la misma fila y una sola llamada; editar las instrucciones
 * cambia el digest y por tanto crea otra fila, dejando la anterior intacta.
 *
 * Un índice PARCIAL y no uno normal sobre `(transcript_id, inputs_digest)`
 * porque el resumen tiene `inputs_digest` NULL, y en SQL dos NULL no son
 * iguales: un índice normal dejaría meter dos resúmenes del mismo texto.
 *
 * ── Lo que sigue siendo del resumen y sólo del resumen ─────────────────────
 *
 * `meetings.active_analysis_id` y `meetings.analysis_state`. Un reporte no los
 * escribe. Si lo hiciera, la pestaña Resumen resolvería un reporte como si
 * fuera su análisis y pintaría un documento con la forma equivocada.
 *
 * ── Las filas que ya existen ───────────────────────────────────────────────
 *
 * Se interpretan como `kind = 'summary'` por el DEFAULT de la columna. Sin
 * backfill, sin UPDATE y sin tocar su `payload`: los dos resúmenes que hay en
 * staging quedan exactamente como están.
 *
 * OJO AL ORDEN AL DESPLEGAR: el código y esta migración van juntos, porque
 * `analyses.ts` deja de poder nombrar la restricción vieja. Entre que corre
 * esto y que sirve el contenedor nuevo, un intento de generar un RESUMEN falla
 * en el INSERT — antes de llamar al proveedor, así que no cuesta dinero y basta
 * reintentar.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- ══════════════════════════════════════════════════════════════════════
    --  Las plantillas: lo único que el usuario edita
    -- ══════════════════════════════════════════════════════════════════════
    --
    -- Por cliente, como todo el módulo. Las instrucciones de un cliente son su
    -- forma de trabajar y no tienen por qué servirle al de al lado.
    --
    -- Lo que NO está aquí, y no debe estar: el system prompt, el esquema JSON,
    -- las guardas contra invención y la lógica de citas y de coste. Eso vive en
    -- código porque no es configuración: es la parte que hace que el resultado
    -- sea verificable.
    CREATE TABLE meeting_report_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      client_id uuid NOT NULL,

      -- Estable y legible. Es lo que ata una fila a su predeterminado EN CÓDIGO,
      -- que es lo que hace posible «Restaurar predeterminado».
      slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{1,48}$'),
      name text NOT NULL CHECK (btrim(name) <> ''),
      description text NOT NULL DEFAULT '',
      -- Lenguaje natural. Se guarda tal cual se escribió.
      instructions text NOT NULL CHECK (btrim(instructions) <> ''),

      -- Empieza en 1 y sube en cada edición. Es también el testigo que evita
      -- las actualizaciones perdidas: un PATCH declara la versión que creía
      -- estar editando y el WHERE la exige.
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),

      -- true = nació de un predeterminado del código, así que se puede
      -- restaurar. Una plantilla que no lo sea no tendría a dónde volver.
      is_builtin boolean NOT NULL DEFAULT false,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,

      CONSTRAINT report_templates_client_fkey FOREIGN KEY (tenant_id, client_id)
        REFERENCES clients (tenant_id, id) ON DELETE CASCADE,
      -- Una plantilla por slug y cliente. Es lo que hace idempotente la
      -- materialización de los cuatro predeterminados.
      CONSTRAINT report_templates_slug_key UNIQUE (tenant_id, client_id, slug),
      -- Para la FK compuesta del reporte: un reporte no puede colgar de la
      -- plantilla de otro cliente ni por un error de código.
      CONSTRAINT report_templates_scope_key UNIQUE (id, tenant_id, client_id)
    );

    CREATE INDEX report_templates_client_idx
      ON meeting_report_templates (tenant_id, client_id, slug);

    -- ══════════════════════════════════════════════════════════════════════
    --  El historial: quién cambió qué y cuándo
    -- ══════════════════════════════════════════════════════════════════════
    --
    -- Una fila por versión, incluida la 1. Duplica el texto de la versión
    -- vigente con la tabla de arriba, y es a propósito: la lectura de la
    -- pantalla no debe pagar un JOIN, y un historial que hay que reconstruir
    -- no es un historial.
    CREATE TABLE meeting_report_template_versions (
      template_id uuid NOT NULL,
      version integer NOT NULL CHECK (version >= 1),
      tenant_id uuid NOT NULL,
      client_id uuid NOT NULL,

      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      instructions text NOT NULL,

      -- 'create' | 'edit' | 'restore'. Restaurar no es editar: conviene poder
      -- distinguir en la auditoría quién volvió al predeterminado.
      change_kind text NOT NULL CHECK (change_kind IN ('create','edit','restore')),
      changed_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      changed_at timestamptz NOT NULL DEFAULT now(),

      PRIMARY KEY (template_id, version),
      CONSTRAINT report_template_versions_template_fkey
        FOREIGN KEY (template_id, tenant_id, client_id)
        REFERENCES meeting_report_templates (id, tenant_id, client_id) ON DELETE CASCADE
    );

    CREATE INDEX report_template_versions_recent_idx
      ON meeting_report_template_versions (template_id, version DESC);

    -- ══════════════════════════════════════════════════════════════════════
    --  meeting_analyses, generalizada
    -- ══════════════════════════════════════════════════════════════════════

    ALTER TABLE meeting_analyses
      ADD COLUMN kind text NOT NULL DEFAULT 'summary'
        CHECK (kind IN ('summary','report')),
      ADD COLUMN template_id uuid,
      ADD COLUMN template_version integer CHECK (template_version IS NULL OR template_version >= 1),
      -- El texto EXACTO con el que se generó. Es lo que hace que editar la
      -- plantilla después no pueda alterar un reporte ya hecho: nunca se
      -- vuelven a leer las instrucciones vivas.
      ADD COLUMN instructions_snapshot text,
      -- sha256 en hexadecimal de las entradas que determinan el resultado.
      ADD COLUMN inputs_digest text CHECK (inputs_digest IS NULL OR inputs_digest ~ '^[0-9a-f]{64}$');

    ALTER TABLE meeting_analyses
      ADD CONSTRAINT analyses_template_fkey FOREIGN KEY (template_id, tenant_id, client_id)
        REFERENCES meeting_report_templates (id, tenant_id, client_id) ON DELETE RESTRICT,
      -- Un reporte SIN su plantilla, su versión, su snapshot y su digest no es
      -- auditable ni reproducible, y todo esto existe para que lo sea.
      ADD CONSTRAINT analyses_report_complete CHECK (
        kind <> 'report' OR (
          template_id IS NOT NULL AND template_version IS NOT NULL
          AND instructions_snapshot IS NOT NULL AND inputs_digest IS NOT NULL)),
      -- Y un resumen no lleva nada de eso: no tiene plantilla que lo genere.
      ADD CONSTRAINT analyses_summary_plain CHECK (
        kind <> 'summary' OR (
          template_id IS NULL AND template_version IS NULL
          AND instructions_snapshot IS NULL AND inputs_digest IS NULL));

    -- La regla vieja se va; las dos nuevas la sustituyen, cada una con su
    -- propio criterio de identidad.
    ALTER TABLE meeting_analyses DROP CONSTRAINT analyses_transcript_key;

    CREATE UNIQUE INDEX analyses_one_summary_idx
      ON meeting_analyses (transcript_id) WHERE kind = 'summary';

    CREATE UNIQUE INDEX analyses_report_inputs_idx
      ON meeting_analyses (transcript_id, inputs_digest) WHERE kind = 'report';

    -- El catálogo de reportes de una reunión, sin recorrer la tabla.
    CREATE INDEX analyses_reports_by_meeting_idx
      ON meeting_analyses (meeting_id, created_at DESC) WHERE kind = 'report';

    COMMENT ON COLUMN meeting_analyses.kind IS
      'summary = el resumen ejecutivo, uno por transcripción. report = un reporte de plantilla, varios por transcripción.';
    COMMENT ON COLUMN meeting_analyses.instructions_snapshot IS
      'Las instrucciones EXACTAS usadas. Editar la plantilla después no altera este reporte.';
    COMMENT ON COLUMN meeting_analyses.inputs_digest IS
      'sha256 de (transcripción, plantilla, versión, instrucciones, modelo, prompt interno). Es la clave de idempotencia del reporte.';
  `);
}

/**
 * Reversible, con una pérdida que hay que decir en voz alta.
 *
 * El esquema viejo admite UNA fila por `transcript_id` y no tiene dónde poner
 * ni plantillas ni reportes. Volver atrás obliga por tanto a borrar los
 * reportes: no es una elección, es que no caben. Se borran sólo los
 * `kind='report'` —los resúmenes quedan intactos— y son regenerables desde la
 * transcripción, que es la que guarda lo que de verdad no se puede
 * reconstruir. El historial de plantillas sí se pierde del todo.
 *
 * El orden importa: los reportes se borran ANTES de restaurar la restricción y
 * ANTES de tirar las plantillas, porque si no el `ADD CONSTRAINT` fallaría
 * contra las filas que él mismo prohíbe y el `DROP TABLE` chocaría con el
 * `ON DELETE RESTRICT`.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DELETE FROM meeting_analyses WHERE kind = 'report';

    DROP INDEX IF EXISTS analyses_reports_by_meeting_idx;
    DROP INDEX IF EXISTS analyses_report_inputs_idx;
    DROP INDEX IF EXISTS analyses_one_summary_idx;

    ALTER TABLE meeting_analyses
      DROP CONSTRAINT IF EXISTS analyses_summary_plain,
      DROP CONSTRAINT IF EXISTS analyses_report_complete,
      DROP CONSTRAINT IF EXISTS analyses_template_fkey;

    ALTER TABLE meeting_analyses
      ADD CONSTRAINT analyses_transcript_key UNIQUE (transcript_id);

    ALTER TABLE meeting_analyses
      DROP COLUMN inputs_digest,
      DROP COLUMN instructions_snapshot,
      DROP COLUMN template_version,
      DROP COLUMN template_id,
      DROP COLUMN kind;

    DROP TABLE IF EXISTS meeting_report_template_versions;
    DROP TABLE IF EXISTS meeting_report_templates;
  `);
}
