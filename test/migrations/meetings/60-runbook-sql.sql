-- ══════════════════════════════════════════════════════════════════════════
-- Cada consulta del runbook de W-3, ejecutada contra el esquema REAL.
-- ══════════════════════════════════════════════════════════════════════════
--
-- Un runbook es código que corre una persona bajo presión, a mano, contra una
-- base de la que depende algo. Que una de sus consultas nombre una tabla que no
-- existe se descubre en el peor momento posible.
--
-- La revisión encontró cuatro errores en el SQL del runbook original:
--
--   · 'meeting_transcript_segments' no existe — la tabla es 'meeting_segments';
--   · 'talk_share' no existe — la columna es 'talk_share_pct';
--   · el criterio decía «suma ≈ 1» cuando es un PORCENTAJE y suma ≈ 100;
--   · 'next_attempt_at > now()' aparecía dos veces en el mismo SELECT.
--
-- Y esta suite encontró un quinto al escribirse:
--
--   · 'meeting_transcript_versions.diarization_state' no existe. El estado de
--     diarización vive en 'meetings'; la versión guarda
--     'diarization_backend', que es otra cosa (QUÉ diarizó, no CÓMO acabó).
--
-- Los cuatro primeros se habrían visto leyendo con cuidado. El quinto no: es
-- una columna plausible en la tabla equivocada. De ahí esta suite — no basta
-- con corregir los errores, hay que hacer que la clase no vuelva.
--
-- `t(label, sql, 'ok')` ejecuta y pasa si no hay excepción. Una tabla o columna
-- inexistente lanza, así que el nombre 'ok' aquí significa «esta consulta del
-- runbook es ejecutable contra este esquema».
\echo ''
\echo '════════ RUNBOOK W-3 · cada consulta contra el esquema real ════════'

-- ── Escenario sembrado ────────────────────────────────────────────────────
-- Un recorrido completo y REALISTA: original + normalizado, tres jobs, tres
-- subidas, la versión de transcript con sus segmentos y dos hablantes. Sin
-- datos, una consulta con una columna mal escrita fallaría igual, pero los
-- criterios pass/fail del runbook no se podrían comprobar.
\set T '''22222222-2222-2222-2222-222222222222'''
\set C '''ba5e0001-0000-0000-0000-000000000000'''
\set M '''ba5e0002-0000-0000-0000-000000000000'''
\set R '''ba5e0003-0000-0000-0000-000000000000'''
\set V '''ba5e0004-0000-0000-0000-000000000000'''
\set J '''ba5e0005-0000-0000-0000-000000000000'''
\set P '''ba5e0006-0000-0000-0000-000000000000'''
\set K '''ba5e0007-0000-0000-0000-000000000000'''
\set SP1 '''ba5e0008-0000-0000-0000-000000000000'''
\set SHA '''1111111111111111111111111111111111111111111111111111111111111111'''
\set SHB '''2222222222222222222222222222222222222222222222222222222222222222'''
-- El hash del token necesita valor PROPIO: 'credentials_hash_key' es UNIQUE
-- sobre toda la tabla, y reusar aquí el checksum del medio colisionaba con una
-- credencial de una suite anterior. La colisión hacía fallar el INSERT de la
-- credencial y, en cascada, los del job, sus eventos y su subida — cinco
-- aserciones en falso por una clave repetida, no por el esquema.
\set TKH '''7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b'''

\set QUIET on
INSERT INTO tenants (id, name) VALUES (:T, 'W3 runbook');
INSERT INTO clients (id, tenant_id, name, is_default) VALUES (:C, :T, 'Cliente W3', false);
INSERT INTO client_modules (tenant_id, client_id, module_key, enabled) VALUES (:T, :C, 'meetings', true);
INSERT INTO meetings (id, tenant_id, client_id, title, source_kind, idempotency_key,
                      media_state, transcript_state, diarization_state)
  VALUES (:M, :T, :C, 'W-3', 'file', 'w3-key', 'ready', 'ready', 'ready');
INSERT INTO meeting_processing_runs (id, tenant_id, client_id, meeting_id, run_number, trigger, requested_options)
  VALUES (:R, :T, :C, :M, 1, 'initial', '{"diarize": true}'::jsonb);
-- El original: sin run y sin sondeo, porque lo subió una persona.
INSERT INTO meeting_media (tenant_id, client_id, meeting_id, role, storage_key, bytes,
                           checksum_sha256, content_type)
  VALUES (:T, :C, :M, 'original', 't/w3/original/source', 1024, :SHA, 'audio/wav');
-- El normalizado: con run y con el sondeo completo, que es lo que el CHECK exige.
INSERT INTO meeting_media (tenant_id, client_id, meeting_id, run_id, role, storage_key, bytes,
                           checksum_sha256, content_type, duration_seconds, sample_rate,
                           channels, codec, probe_ok)
  VALUES (:T, :C, :M, :R, 'normalized', 't/w3/normalized/a0/audio.wav', 2048, :SHB,
          'audio/wav', 600.0, 16000, 1, 'pcm_s16le', true);
INSERT INTO worker_pools (id, slug, environment, scope, tenant_id, capabilities, concurrency)
  VALUES (:P, 'w3-runbook', 'staging', 'single_tenant', :T, '{meetings.transcribe}',
          '{"schema_version":1,"limits":{"meetings.transcribe":1}}'::jsonb);
INSERT INTO worker_credentials (id, pool_id, label, token_hash, token_prefix)
  VALUES (:K, :P, 'w3', :TKH, 'mtk_w3aa');
INSERT INTO meeting_processing_jobs (id, tenant_id, client_id, meeting_id, run_id, stage, status,
                                     attempts, leased_credential_id, leased_credential_label,
                                     failure_code)
  VALUES (:J, :T, :C, :M, :R, 'normalize', 'succeeded', 1, :K, 'w3-runbook/mtk_w3aa', NULL);
UPDATE meeting_processing_jobs SET last_heartbeat_at = now(), progress_pct = 40,
       last_progress_at = now(), next_attempt_at = now() + interval '30 seconds'
 WHERE id = :J;
INSERT INTO meeting_processing_jobs (tenant_id, client_id, meeting_id, run_id, stage, status, attempts)
  VALUES (:T, :C, :M, :R, 'transcribe', 'succeeded', 1),
         (:T, :C, :M, :R, 'diarize', 'succeeded', 1);
-- 'heartbeat' NO es un kind de meeting_job_events. Los ocho válidos son
-- claimed, state_changed, progress, retried, lease_expired, cancelled, failed y
-- result_ingested. El latido NO escribe evento: renueva el lease y actualiza
-- 'last_heartbeat_at' en la fila del job, que es donde hay que observarlo.
INSERT INTO meeting_job_events (tenant_id, client_id, meeting_id, job_id, kind, stage, credential_id, progress_pct)
  VALUES (:T, :C, :M, :J, 'claimed', 'normalize', :K, NULL),
         (:T, :C, :M, :J, 'progress', 'normalize', :K, 40),
         (:T, :C, :M, :J, 'state_changed', 'normalize', :K, NULL);
INSERT INTO meeting_result_uploads (tenant_id, client_id, meeting_id, job_id, attempt, kind,
                                    schema_version, storage_key, declared_bytes,
                                    declared_checksum_sha256, observed_bytes,
                                    observed_checksum_sha256, state, uploaded_at, verified_at,
                                    ingested_at)
  VALUES (:T, :C, :M, :J, 1, 'normalized_media', 1, 't/w3/ru/normalized', 2048, :SHB, 2048, :SHB,
          'ingested', now(), now(), now());
INSERT INTO meeting_transcript_versions (id, tenant_id, client_id, meeting_id, run_id, whisper_model,
                                         diarization_backend, language, duration_seconds,
                                         segment_count, schema_version)
  VALUES (:V, :T, :C, :M, :R, 'medium', 'wespeaker', 'es', 600.0, 2, 1);
UPDATE meetings SET active_transcript_id = :V WHERE id = :M;
INSERT INTO meeting_segments (tenant_id, client_id, transcript_id, segment_index, start_sec,
                              end_sec, speaker_label, text)
  VALUES (:T, :C, :V, 0, 0, 10, 'SPEAKER_00', 'hola'),
         (:T, :C, :V, 1, 10, 20, 'SPEAKER_01', 'adios');
INSERT INTO meeting_speakers (id, tenant_id, client_id, meeting_id, display_name)
  VALUES (:SP1, :T, :C, :M, 'Ana');
INSERT INTO meeting_transcript_speakers (transcript_id, speaker_label, tenant_id, client_id,
                                         meeting_id, speaker_id, talk_share_pct)
  VALUES (:V, 'SPEAKER_00', :T, :C, :M, :SP1, 62.50),
         (:V, 'SPEAKER_01', :T, :C, :M, NULL, 37.50);
\set QUIET off

-- ── §6 paso 1 · reunión creada ────────────────────────────────────────────
SELECT t($q$§6.1 estado inicial de la reunión$q$,
  $q$SELECT media_state, transcript_state, source_kind, idempotency_key
       FROM meetings WHERE id = 'ba5e0002-0000-0000-0000-000000000000'$q$, $q$ok$q$);

-- ── §6 paso 2 · ninguna URL firmada persistida ────────────────────────────
SELECT t($q$§6.2 ninguna clave contiene una firma$q$,
  $q$SELECT count(*) FROM meeting_media WHERE storage_key LIKE '%X-Amz%'$q$, $q$ok$q$);
SELECT a($q$§6.2 → y el conteo es 0 de verdad$q$,
  $q$(SELECT count(*) FROM meeting_media WHERE storage_key LIKE '%X-Amz%') = 0$q$);

-- ── §6 paso 3 · confirmación y primer job ─────────────────────────────────
SELECT t($q$§6.3 media_state tras confirmar$q$,
  $q$SELECT media_state FROM meetings WHERE id = 'ba5e0002-0000-0000-0000-000000000000'$q$, $q$ok$q$);
SELECT t($q$§6.3 medios con rol, run y sondeo$q$,
  $q$SELECT role, run_id, bytes, checksum_sha256, probe_ok
       FROM meeting_media WHERE meeting_id = 'ba5e0002-0000-0000-0000-000000000000'$q$, $q$ok$q$);
SELECT t($q$§6.3 jobs con etapa, estado y requires$q$,
  $q$SELECT stage, status, attempts, requires FROM meeting_processing_jobs
       WHERE meeting_id = 'ba5e0002-0000-0000-0000-000000000000' ORDER BY created_at$q$, $q$ok$q$);
SELECT a($q$§6.3 → el original no lleva run ni sondeo$q$,
  $q$EXISTS (SELECT 1 FROM meeting_media
            WHERE meeting_id = 'ba5e0002-0000-0000-0000-000000000000'
              AND role = 'original' AND run_id IS NULL AND probe_ok IS NULL)$q$);
SELECT a($q$§6.3 → requires de normalize es meetings.transcribe$q$,
  $q$(SELECT requires FROM meeting_processing_jobs
      WHERE meeting_id = 'ba5e0002-0000-0000-0000-000000000000' AND stage = 'normalize')
   = ARRAY['meetings.transcribe']$q$);

-- ── §6 paso 4 · claim, lease y heartbeat ──────────────────────────────────
SELECT t($q$§6.4 estado del lease$q$,
  $q$SELECT status, attempts, leased_credential_label,
             lease_token_hash IS NOT NULL AS con_token,
             lease_expires_at > now() AS lease_vivo, progress_pct
       FROM meeting_processing_jobs
      WHERE meeting_id = 'ba5e0002-0000-0000-0000-000000000000' AND stage = 'normalize'$q$, $q$ok$q$);
-- CORREGIDO: la columna de tiempo de meeting_job_events es 'at', no
-- 'created_at'. La consulta del runbook original no habría corrido.
SELECT t($q$§6.4 eventos agrupados por tipo$q$,
  $q$SELECT kind, count(*), max(at) FROM meeting_job_events
      WHERE meeting_id = 'ba5e0002-0000-0000-0000-000000000000'
      GROUP BY kind ORDER BY 3$q$, $q$ok$q$);
SELECT t($q$§6.4 'created_at' NO existe en meeting_job_events$q$,
  $q$SELECT created_at FROM meeting_job_events$q$, $q$does not exist$q$);
-- CORREGIDO: no hay kind 'heartbeat'. El latido no escribe evento — renueva el
-- lease y toca 'last_heartbeat_at'. Observarlo en los eventos habría dado
-- siempre cero y parecería que el heartbeat no funciona.
SELECT t($q$§6.4 'heartbeat' NO es un kind admitido$q$,
  $q$INSERT INTO meeting_job_events (tenant_id, client_id, meeting_id, job_id, kind, stage)
     VALUES ('22222222-2222-2222-2222-222222222222','ba5e0001-0000-0000-0000-000000000000',
             'ba5e0002-0000-0000-0000-000000000000','ba5e0005-0000-0000-0000-000000000000',
             'heartbeat','normalize')$q$, $q$meeting_job_events_kind_check$q$);
SELECT t($q$§6.4 rastro del latido en la fila del job$q$,
  $q$SELECT last_heartbeat_at, last_progress_at, progress_pct,
             lease_expires_at, extract(epoch FROM (now() - last_heartbeat_at)) AS edad_latido
       FROM meeting_processing_jobs WHERE id = 'ba5e0005-0000-0000-0000-000000000000'$q$, $q$ok$q$);
SELECT a($q$§6.4 → el latido dejó rastro$q$,
  $q$EXISTS (SELECT 1 FROM meeting_processing_jobs
            WHERE id = 'ba5e0005-0000-0000-0000-000000000000'
              AND last_heartbeat_at IS NOT NULL AND progress_pct = 40)$q$);

-- ── §6 pasos 5–6 · normalize y el sondeo real ─────────────────────────────
SELECT t($q$§6.5 sondeo del medio normalizado$q$,
  $q$SELECT role, run_id, duration_seconds, sample_rate, channels, codec, probe_ok
       FROM meeting_media WHERE meeting_id = 'ba5e0002-0000-0000-0000-000000000000'
        AND role = 'normalized' AND deleted_at IS NULL$q$, $q$ok$q$);
SELECT a($q$§6.5 → 16 kHz, mono, pcm_s16le, probe_ok, con run$q$,
  $q$EXISTS (SELECT 1 FROM meeting_media
            WHERE meeting_id = 'ba5e0002-0000-0000-0000-000000000000'
              AND role = 'normalized' AND deleted_at IS NULL
              AND sample_rate = 16000 AND channels = 1 AND codec = 'pcm_s16le'
              AND probe_ok = true AND run_id IS NOT NULL)$q$);
SELECT t($q$§6.6 subidas con checksum observado$q$,
  $q$SELECT kind, state, declared_bytes, observed_bytes,
             declared_checksum_sha256 = observed_checksum_sha256 AS checksum_cuadra,
             verified_at IS NOT NULL AS verificado
       FROM meeting_result_uploads WHERE meeting_id = 'ba5e0002-0000-0000-0000-000000000000'
       ORDER BY created_at$q$, $q$ok$q$);
SELECT a($q$§6.6 → el checksum declarado y el observado coinciden$q$,
  $q$EXISTS (SELECT 1 FROM meeting_result_uploads
            WHERE meeting_id = 'ba5e0002-0000-0000-0000-000000000000'
              AND kind = 'normalized_media' AND state = 'ingested'
              AND declared_checksum_sha256 = observed_checksum_sha256
              AND declared_bytes = observed_bytes)$q$);

-- ── §6 pasos 7–8 · opciones del run ───────────────────────────────────────
SELECT t($q$§6.8 opciones pedidas del run$q$,
  $q$SELECT requested_options FROM meeting_processing_runs
      WHERE id = 'ba5e0003-0000-0000-0000-000000000000'$q$, $q$ok$q$);

-- ── §6 paso 9 · ingesta ───────────────────────────────────────────────────
-- CORREGIDO: la versión NO tiene 'diarization_state'. Ese estado vive en
-- 'meetings'; la versión guarda 'diarization_backend', que responde otra
-- pregunta. La consulta del runbook original no habría corrido.
SELECT t($q$§6.9 versión de transcript + estado de la reunión$q$,
  $q$SELECT v.id, v.whisper_model, v.diarization_backend, v.language,
             v.duration_seconds, v.segment_count, v.schema_version,
             m.diarization_state, m.transcript_state,
             m.active_transcript_id = v.id AS es_la_activa
       FROM meeting_transcript_versions v JOIN meetings m ON m.id = v.meeting_id
      WHERE v.meeting_id = 'ba5e0002-0000-0000-0000-000000000000'$q$, $q$ok$q$);
SELECT a($q$§6.9 → la versión es la activa$q$,
  $q$EXISTS (SELECT 1 FROM meeting_transcript_versions v JOIN meetings m ON m.id = v.meeting_id
            WHERE v.meeting_id = 'ba5e0002-0000-0000-0000-000000000000'
              AND m.active_transcript_id = v.id)$q$);
SELECT a($q$§6.9 → una sola versión por run (tv_run_key)$q$,
  $q$(SELECT count(*) FROM meeting_transcript_versions
      WHERE run_id = 'ba5e0003-0000-0000-0000-000000000000') = 1$q$);

-- CORREGIDO: 'meeting_segments', no 'meeting_transcript_segments'.
SELECT t($q$§6.9 conteo de segmentos (meeting_segments)$q$,
  $q$SELECT count(*) AS segmentos FROM meeting_segments
      WHERE transcript_id = 'ba5e0004-0000-0000-0000-000000000000'$q$, $q$ok$q$);
SELECT a($q$§6.9 → segmentos = segment_count$q$,
  $q$(SELECT count(*) FROM meeting_segments
      WHERE transcript_id = 'ba5e0004-0000-0000-0000-000000000000')
   = (SELECT segment_count FROM meeting_transcript_versions
       WHERE id = 'ba5e0004-0000-0000-0000-000000000000')$q$);
SELECT t($q$§6.9 la tabla mal nombrada NO existe$q$,
  $q$SELECT 1 FROM meeting_transcript_segments$q$, $q$does not exist$q$);

-- CORREGIDO: 'talk_share_pct', no 'talk_share'.
SELECT t($q$§6.9 hablantes con talk_share_pct$q$,
  $q$SELECT speaker_label, speaker_id, talk_share_pct
       FROM meeting_transcript_speakers
      WHERE transcript_id = 'ba5e0004-0000-0000-0000-000000000000'
      ORDER BY speaker_label$q$, $q$ok$q$);
SELECT t($q$§6.9 la columna mal nombrada NO existe$q$,
  $q$SELECT talk_share FROM meeting_transcript_speakers$q$, $q$does not exist$q$);
-- CORREGIDO: es un PORCENTAJE. Suma ≈ 100, no ≈ 1. El CHECK de la columna es
-- BETWEEN 0 AND 100, así que el criterio anterior era imposible salvo con dos
-- hablantes de medio punto cada uno.
SELECT a($q$§6.9 → talk_share_pct suma ≈ 100$q$,
  $q$abs(COALESCE((SELECT sum(talk_share_pct) FROM meeting_transcript_speakers
                   WHERE transcript_id = 'ba5e0004-0000-0000-0000-000000000000'), 0) - 100) < 1$q$);
SELECT a($q$§6.9 → y ≥ 2 hablantes distintos$q$,
  $q$(SELECT count(*) FROM meeting_transcript_speakers
      WHERE transcript_id = 'ba5e0004-0000-0000-0000-000000000000') >= 2$q$);
SELECT t($q$§6.9 hablantes estables de la reunión$q$,
  $q$SELECT display_name, contact_id FROM meeting_speakers
      WHERE meeting_id = 'ba5e0002-0000-0000-0000-000000000000'$q$, $q$ok$q$);

-- ── §6 · fallo controlado ─────────────────────────────────────────────────
-- CORREGIDO: 'next_attempt_at > now()' aparecía DOS veces en el mismo SELECT.
-- PostgreSQL no se queja —dos columnas con el mismo nombre son legales— así que
-- el error habría sobrevivido a cualquier prueba de «¿corre?». Se queda una.
SELECT t($q$§6.fallo estado del job fallido$q$,
  $q$SELECT status, attempts, max_attempts, failure_code, failure_detail,
             next_attempt_at > now() AS con_backoff
       FROM meeting_processing_jobs WHERE id = 'ba5e0005-0000-0000-0000-000000000000'$q$, $q$ok$q$);
SELECT a($q$§6.fallo → 'con_backoff' aparece una sola vez$q$,
  $q$(SELECT count(*) FROM (
       SELECT status, attempts, max_attempts, failure_code, failure_detail,
              next_attempt_at > now() AS con_backoff
         FROM meeting_processing_jobs WHERE id = 'ba5e0005-0000-0000-0000-000000000000'
     ) s) = 1$q$);
SELECT t($q$§6.fallo avisos de la reunión$q$,
  $q$SELECT transcript_state, warnings FROM meetings
      WHERE id = 'ba5e0002-0000-0000-0000-000000000000'$q$, $q$ok$q$);
SELECT t($q$§6.fallo cero medios normalizados tras un fallo$q$,
  $q$SELECT count(*) FROM meeting_media
      WHERE meeting_id = 'ba5e0002-0000-0000-0000-000000000000' AND role = 'normalized'$q$, $q$ok$q$);

-- ── §4.2 · verificación de la credencial sembrada ─────────────────────────
SELECT t($q$§4.2 credencial y pool sembrados$q$,
  $q$SELECT p.scope, p.capabilities, p.concurrency->'limits', c.token_prefix,
             c.revoked_at IS NULL AS viva
       FROM worker_credentials c JOIN worker_pools p ON p.id = c.pool_id
      WHERE p.slug = 'w3-runbook'$q$, $q$ok$q$);
SELECT a($q$§4.2 → single_tenant, sólo transcribe, viva$q$,
  $q$EXISTS (SELECT 1 FROM worker_credentials c JOIN worker_pools p ON p.id = c.pool_id
            WHERE p.slug = 'w3-runbook' AND p.scope = 'single_tenant'
              AND p.capabilities = ARRAY['meetings.transcribe']
              AND c.revoked_at IS NULL)$q$);
SELECT a($q$§4.2 → y NO tiene la capacidad de mantenimiento$q$,
  $q$NOT EXISTS (SELECT 1 FROM worker_pools
                WHERE slug = 'w3-runbook' AND 'meetings.maintenance' = ANY (capabilities))$q$);
SELECT t($q$§4.2 entitlement del módulo$q$,
  $q$SELECT enabled FROM client_modules
      WHERE tenant_id = '22222222-2222-2222-2222-222222222222'
        AND client_id = 'ba5e0001-0000-0000-0000-000000000000'
        AND module_key = 'meetings'$q$, $q$ok$q$);

-- ── §7.4 · el interruptor del entitlement ─────────────────────────────────
SELECT t($q$§7.4 apagar el módulo$q$,
  $q$UPDATE client_modules SET enabled = false
      WHERE tenant_id = '22222222-2222-2222-2222-222222222222'
        AND client_id = 'ba5e0001-0000-0000-0000-000000000000'
        AND module_key = 'meetings'$q$, $q$ok$q$);
SELECT a($q$§7.4 → quedó apagado$q$,
  $q$NOT (SELECT enabled FROM client_modules
         WHERE tenant_id = '22222222-2222-2222-2222-222222222222'
           AND client_id = 'ba5e0001-0000-0000-0000-000000000000'
           AND module_key = 'meetings')$q$);
SELECT t($q$§7.4 volver a encenderlo$q$,
  $q$UPDATE client_modules SET enabled = true
      WHERE tenant_id = '22222222-2222-2222-2222-222222222222'
        AND client_id = 'ba5e0001-0000-0000-0000-000000000000'
        AND module_key = 'meetings'$q$, $q$ok$q$);

-- ── §8.2 · limpieza, en el orden del runbook ──────────────────────────────
-- Se ejecuta de verdad, en orden, y el conteo final tiene que dar cero. Es la
-- única forma de saber que el orden funciona: razonar sobre el orden del
-- cascade es exactamente lo que el runbook dice que no hay que hacer.
SELECT t($q$§8.2/1 revocar la credencial$q$,
  $q$UPDATE worker_credentials
        SET revoked_at = now(), revoked_actor = 'system',
            revoked_actor_label = 'w3-cleanup', revoked_reason = 'fin de W-3'
      WHERE pool_id = (SELECT id FROM worker_pools WHERE slug = 'w3-runbook')
        AND revoked_at IS NULL$q$, $q$ok$q$);
SELECT t($q$§8.2/2 borrar las reuniones (cascada)$q$,
  $q$DELETE FROM meetings WHERE tenant_id = '22222222-2222-2222-2222-222222222222'$q$, $q$ok$q$);
SELECT t($q$§8.2/3 borrar credenciales$q$,
  $q$DELETE FROM worker_credentials
      WHERE pool_id = (SELECT id FROM worker_pools WHERE slug = 'w3-runbook')$q$, $q$ok$q$);
SELECT t($q$§8.2/3 borrar el pool$q$,
  $q$DELETE FROM worker_pools WHERE slug = 'w3-runbook'$q$, $q$ok$q$);
SELECT t($q$§8.2/4 borrar módulos, cliente y tenant$q$,
  $q$DELETE FROM client_modules WHERE tenant_id = '22222222-2222-2222-2222-222222222222';
    DELETE FROM clients WHERE tenant_id = '22222222-2222-2222-2222-222222222222';
    DELETE FROM tenants WHERE id = '22222222-2222-2222-2222-222222222222'$q$, $q$ok$q$);
SELECT t($q$§8.2 el conteo final de verificación$q$,
  $q$SELECT
     (SELECT count(*) FROM meetings WHERE tenant_id = '22222222-2222-2222-2222-222222222222') AS reuniones,
     (SELECT count(*) FROM meeting_media WHERE tenant_id = '22222222-2222-2222-2222-222222222222') AS medios,
     (SELECT count(*) FROM meeting_processing_jobs WHERE tenant_id = '22222222-2222-2222-2222-222222222222') AS jobs,
     (SELECT count(*) FROM meeting_result_uploads WHERE tenant_id = '22222222-2222-2222-2222-222222222222') AS subidas,
     (SELECT count(*) FROM worker_pools WHERE tenant_id = '22222222-2222-2222-2222-222222222222') AS pools,
     (SELECT count(*) FROM clients WHERE tenant_id = '22222222-2222-2222-2222-222222222222') AS clientes,
     (SELECT count(*) FROM tenants WHERE id = '22222222-2222-2222-2222-222222222222') AS tenants$q$, $q$ok$q$);
SELECT a($q$§8.2 → los siete conteos dan 0$q$,
  $q$(SELECT count(*) FROM meetings WHERE tenant_id = '22222222-2222-2222-2222-222222222222')
   + (SELECT count(*) FROM meeting_media WHERE tenant_id = '22222222-2222-2222-2222-222222222222')
   + (SELECT count(*) FROM meeting_processing_jobs WHERE tenant_id = '22222222-2222-2222-2222-222222222222')
   + (SELECT count(*) FROM meeting_result_uploads WHERE tenant_id = '22222222-2222-2222-2222-222222222222')
   + (SELECT count(*) FROM worker_pools WHERE tenant_id = '22222222-2222-2222-2222-222222222222')
   + (SELECT count(*) FROM clients WHERE tenant_id = '22222222-2222-2222-2222-222222222222')
   + (SELECT count(*) FROM tenants WHERE id = '22222222-2222-2222-2222-222222222222') = 0$q$);
-- Y los transcripts se fueron con la reunión: sin esto, «cero reuniones» podría
-- convivir con segmentos huérfanos.
SELECT a($q$§8.2 → y ni versiones ni segmentos sobreviven$q$,
  $q$(SELECT count(*) FROM meeting_transcript_versions
      WHERE tenant_id = '22222222-2222-2222-2222-222222222222')
   + (SELECT count(*) FROM meeting_segments
      WHERE tenant_id = '22222222-2222-2222-2222-222222222222') = 0$q$);
