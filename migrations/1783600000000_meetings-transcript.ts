import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * MEET-2 · Transcript versionado e inmutable.
 *
 * Aditiva: cuatro tablas nuevas, más las dos FK que MEET-1 dejó pendientes por
 * orden de dependencia (los punteros `active_*` de `meetings`).
 *
 * ── Por qué hay DOS tablas de hablantes ────────────────────────────────────
 *
 * Es la decisión menos obvia del esquema y la más importante para D-3.
 *
 * El diarizador emite etiquetas anónimas por versión: `SPEAKER_00`,
 * `SPEAKER_01`. Cuando una persona renombra `SPEAKER_00` a "María Vanegas" y lo
 * liga a un contacto del CRM, eso es DATO DE PRODUCTO: tiene que sobrevivir a
 * un reproceso, y un reproceso genera etiquetas nuevas que no tienen por qué
 * corresponder a las viejas.
 *
 * meeting_speakers ESTABLE, por reunión. El nombre y el contacto.
 * meeting_transcript_speakers POR VERSIÓN. Mapea la etiqueta del diarizador
 * al hablante estable, más su cuota de habla.
 *
 * Con una sola tabla, reprocesar borraría el renombrado — que es exactamente el
 * bug que el historial de Transcript-Project registra ("persist renamed speaker
 * names across page reloads"). Con dos, el reproceso reescribe el mapa y deja
 * intacta la identidad.
 *
 * ── Por qué no se porta `Transcript.rawJson` ───────────────────────────────
 *
 * Guardar el JSON crudo *y* los segmentos normalizados es dos fuentes de verdad
 * del mismo hecho. Los segmentos son la fuente; el crudo se archiva en R2 como
 * `meeting_media.role = 'raw_result'` para depurar, y no participa en ninguna
 * lectura de producto.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- ═══════════════════════════════════════════════════════════════════════
    -- 1. meeting_transcript_versions — inmutable, una por run
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE meeting_transcript_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      client_id uuid NOT NULL,
      meeting_id uuid NOT NULL,
      run_id uuid NOT NULL,

      -- Lo que REALMENTE se usó, reportado por el worker. Antes la base
      -- guardaba una intención escrita antes de procesar (I-5).
      whisper_model text NOT NULL,
      diarization_backend text CHECK (diarization_backend IS NULL
                                      OR diarization_backend IN ('wespeaker','pyannote_full')),
      language text,
      duration_seconds numeric(12,3) NOT NULL CHECK (duration_seconds >= 0),
      segment_count integer NOT NULL CHECK (segment_count >= 0),

      -- Versión del contrato del artefacto. Sin esto, un worker viejo contra un
      -- mai nuevo escribe datos silenciosamente mal.
      schema_version smallint NOT NULL CHECK (schema_version >= 1),
      metrics jsonb NOT NULL DEFAULT '{}'::jsonb,

      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT tv_meeting_fkey FOREIGN KEY (meeting_id, tenant_id, client_id)
        REFERENCES meetings (id, tenant_id, client_id) ON DELETE CASCADE,
      -- El run tiene que ser de ESTA reunión: antes se podía crear un
      -- transcript con meeting_id de A y run_id de B.
      CONSTRAINT tv_run_fkey FOREIGN KEY (run_id, meeting_id, tenant_id, client_id)
        REFERENCES meeting_processing_runs (id, meeting_id, tenant_id, client_id) ON DELETE CASCADE,
      -- Un run produce como máximo un transcript.
      CONSTRAINT tv_run_key UNIQUE (run_id),
      CONSTRAINT tv_scope_key UNIQUE (id, tenant_id, client_id),
      -- La que referencian meetings.active_transcript_id y los hablantes.
      CONSTRAINT tv_meeting_scope_key UNIQUE (id, meeting_id, tenant_id, client_id),
      CONSTRAINT tv_metrics_object CHECK (jsonb_typeof(metrics) = 'object')
    );

    CREATE INDEX tv_meeting_idx
      ON meeting_transcript_versions (meeting_id, created_at DESC);

    -- ═══════════════════════════════════════════════════════════════════════
    -- 2. meeting_segments — el transcript
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE meeting_segments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      client_id uuid NOT NULL,
      transcript_id uuid NOT NULL,

      segment_index integer NOT NULL CHECK (segment_index >= 0),
      start_sec numeric(12,3) NOT NULL CHECK (start_sec >= 0),
      end_sec numeric(12,3) NOT NULL,
      -- La etiqueta CRUDA del diarizador. La identidad vive en meeting_speakers.
      speaker_label text,
      text text NOT NULL,
      overlap boolean NOT NULL DEFAULT false,
      confidence numeric(6,4) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),

      CONSTRAINT segments_tv_fkey FOREIGN KEY (transcript_id, tenant_id, client_id)
        REFERENCES meeting_transcript_versions (id, tenant_id, client_id) ON DELETE CASCADE,
      CONSTRAINT segments_time_order CHECK (end_sec >= start_sec),
      -- Idempotencia de la ingesta: reenviar el artefacto converge en vez de
      -- duplicar segmentos (ON CONFLICT DO UPDATE).
      CONSTRAINT segments_index_key UNIQUE (transcript_id, segment_index),
      -- Referenciable por meeting_citations en MEET-5.
      CONSTRAINT segments_scope_key UNIQUE (id, tenant_id, client_id)
    );

    -- La lectura del transcript, en orden.
    CREATE INDEX segments_read_idx ON meeting_segments (transcript_id, segment_index);
    -- El salto a un minuto desde una cita o un tema.
    CREATE INDEX segments_seek_idx ON meeting_segments (transcript_id, start_sec);

    -- ═══════════════════════════════════════════════════════════════════════
    -- 3. meeting_speakers — identidad ESTABLE por reunión
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE meeting_speakers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      client_id uuid NOT NULL,
      meeting_id uuid NOT NULL,

      display_name text,
      contact_id uuid,
      -- Snapshot + puntero (decisión 7 de MEET-1): el renombre es un hecho.
      renamed_by_label text,
      renamed_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      renamed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT speakers_meeting_fkey FOREIGN KEY (meeting_id, tenant_id, client_id)
        REFERENCES meetings (id, tenant_id, client_id) ON DELETE CASCADE,
      -- FK compuesta contra el UNIQUE que contacts sí tiene:
      -- (id, tenant_id, client_id). Un hablante no puede apuntar a un contacto
      -- de otro cliente ni por error de código.
      --
      -- SET NULL POR COLUMNA. Antes era 'ON DELETE SET NULL' a secas, que
      -- en una FK compuesta intenta anular LAS TRES columnas — y tenant_id y
      -- client_id son NOT NULL, así que borrar un contacto asociado habría
      -- fallado con una violación de NOT NULL en vez de desligar el hablante.
      -- PostgreSQL 15+ permite nombrar la columna a anular, y es exactamente lo
      -- que la semántica pide: se pierde el vínculo, no el hablante.
      CONSTRAINT speakers_contact_fkey FOREIGN KEY (contact_id, tenant_id, client_id)
        REFERENCES contacts (id, tenant_id, client_id) ON DELETE SET NULL (contact_id),
      CONSTRAINT speakers_scope_key UNIQUE (id, tenant_id, client_id),
      -- Referenciada por el mapa por versión.
      CONSTRAINT speakers_meeting_scope_key UNIQUE (id, meeting_id, tenant_id, client_id),
      -- Atado a la etiqueta, no a la FK: 'renamed_by_user_id' es ON DELETE SET
      -- NULL, así que borrar a quien renombró un hablante habría violado este
      -- CHECK y bloqueado el borrado del usuario.
      CONSTRAINT speakers_rename_coherent CHECK ((renamed_at IS NULL) = (renamed_by_label IS NULL))
    );

    CREATE INDEX speakers_meeting_idx ON meeting_speakers (meeting_id);
    CREATE INDEX speakers_contact_idx ON meeting_speakers (contact_id) WHERE contact_id IS NOT NULL;

    -- ═══════════════════════════════════════════════════════════════════════
    -- 4. meeting_transcript_speakers — el mapa POR VERSIÓN
    -- ═══════════════════════════════════════════════════════════════════════
    CREATE TABLE meeting_transcript_speakers (
      transcript_id uuid NOT NULL,
      speaker_label text NOT NULL,
      tenant_id uuid NOT NULL,
      client_id uuid NOT NULL,
      -- meeting_id es NUEVO. Sin él, las dos FK garantizaban tenant y
      -- cliente pero no que la versión y el hablante fueran de LA MISMA
      -- reunión: se podía mapear un hablante de la reunión A sobre el
      -- transcript de la B dentro del mismo cliente.
      meeting_id uuid NOT NULL,
      -- NULL = el diarizador lo detectó pero nadie lo ha identificado. Es el
      -- estado "Sin participantes identificados" de la UI.
      speaker_id uuid,
      talk_share_pct numeric(5,2) CHECK (talk_share_pct IS NULL OR talk_share_pct BETWEEN 0 AND 100),

      PRIMARY KEY (transcript_id, speaker_label),
      CONSTRAINT ts_tv_fkey FOREIGN KEY (transcript_id, meeting_id, tenant_id, client_id)
        REFERENCES meeting_transcript_versions (id, meeting_id, tenant_id, client_id) ON DELETE CASCADE,
      -- SET NULL POR COLUMNA: borrar un hablante desliga el mapa, no
      -- intenta anular meeting_id/tenant_id/client_id, que son NOT NULL.
      CONSTRAINT ts_speaker_fkey FOREIGN KEY (speaker_id, meeting_id, tenant_id, client_id)
        REFERENCES meeting_speakers (id, meeting_id, tenant_id, client_id)
        ON DELETE SET NULL (speaker_id)
    );

    CREATE INDEX ts_speaker_idx ON meeting_transcript_speakers (speaker_id)
      WHERE speaker_id IS NOT NULL;
    CREATE INDEX ts_meeting_idx ON meeting_transcript_speakers (meeting_id);

    -- ═══════════════════════════════════════════════════════════════════════
    -- 5. Las FK que MEET-1 dejó pendientes
    -- ═══════════════════════════════════════════════════════════════════════
    -- MEET-1 declaró 'active_transcript_id' sin FK porque la tabla destino no
    -- existía aún. Ahora sí: el puntero se ata, con la garantía compuesta de
    -- que la versión activa pertenece a la misma reunión y cliente.
    -- Dos correcciones en una sola constraint:
    --
    -- La clave incluye el PROPIO id de la reunión: la versión activa tiene
    --      que ser una versión DE ESTA reunión. Antes, con
    --      (active_transcript_id, tenant_id, client_id), una reunión podía
    --      apuntar al transcript de otra reunión del mismo cliente.
    --
    -- SET NULL nombra la columna: borrar la versión activa anula el
    --      puntero y deja intactos id, tenant_id y client_id. Sin nombrarla,
    --      PostgreSQL intentaría anular las cuatro, incluido el id de la propia
    --      fila, lo cual es imposible.
    ALTER TABLE meetings
      ADD CONSTRAINT meetings_active_transcript_fkey
      FOREIGN KEY (active_transcript_id, id, tenant_id, client_id)
      REFERENCES meeting_transcript_versions (id, meeting_id, tenant_id, client_id)
      ON DELETE SET NULL (active_transcript_id);

    -- 'active_analysis_id' se ata en MEET-5, cuando exista meeting_analyses.
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    DECLARE n bigint;
    BEGIN
      SELECT count(*) INTO n FROM meeting_transcript_versions;
      IF n > 0 THEN
        RAISE EXCEPTION
          'MEET-2 down abortado: existen % version(es) de transcript. Bórralas explícitamente antes de revertir.', n;
      END IF;
    END $$;

    ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_active_transcript_fkey;

    DROP TABLE IF EXISTS meeting_transcript_speakers;
    DROP TABLE IF EXISTS meeting_speakers;
    DROP TABLE IF EXISTS meeting_segments;
    DROP TABLE IF EXISTS meeting_transcript_versions;
  `);
}
