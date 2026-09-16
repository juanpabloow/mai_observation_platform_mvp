-- ══════════════════════════════════════════════════════════════════════════
-- La transición del reproceso, contra los constraints REALES.
-- ══════════════════════════════════════════════════════════════════════════
--
-- `meetingsStagingReprocess` reintenta una reunión fallida creando un run nuevo
-- con `trigger='reprocess'` y un job `normalize` propio, sin tocar el job
-- fallido. Esta suite reproduce exactamente ese estado inicial —el del primer
-- job real de W-3, que murió con `worker_error` tras tres intentos— y comprueba
-- que la transición cumple TODOS los constraints, no sólo los que se recuerdan:
--
--   · runs_finish_coherent          (finished_at IS NULL) = (outcome IS NULL)
--   · runs_number_key               UNIQUE (meeting_id, run_number)
--   · runs_one_active_per_meeting   máximo un run abierto por reunión
--   · jobs_stage_key                UNIQUE (run_id, stage)
--   · jobs_lease_invariants         'queued' exige los cuatro campos de lease NULL
--   · requires                      GENERATED desde stage
--   · meetings_warnings_array       warnings sigue siendo un array
--
-- Y las dos negativas que el runbook exige y que sólo la BASE puede garantizar:
-- dos runs activos y dos `normalize` del mismo run son imposibles, no
-- improbables.
\echo ''
\echo '════════ REPROCESO · la transición contra el esquema real ════════'

\set T '''33333333-3333-3333-3333-333333333333'''
\set C '''c0de0001-0000-0000-0000-000000000000'''
\set M '''c0de0002-0000-0000-0000-000000000000'''
\set R1 '''c0de0003-0000-0000-0000-000000000000'''
\set J1 '''c0de0004-0000-0000-0000-000000000000'''
\set R2 '''c0de0005-0000-0000-0000-000000000000'''
\set J2 '''c0de0006-0000-0000-0000-000000000000'''
\set MOTRO '''c0de0007-0000-0000-0000-000000000000'''
\set SHA '''3131313131313131313131313131313131313131313131313131313131313131'''

-- ── El estado de partida: el job real que falló ──────────────────────────
\set QUIET on
INSERT INTO tenants (id, name) VALUES (:T, 'W3 reproceso');
INSERT INTO clients (id, tenant_id, name, is_default) VALUES (:C, :T, 'Cliente', false);
INSERT INTO client_modules (tenant_id, client_id, module_key, enabled) VALUES (:T, :C, 'meetings', true);
-- media_state='ready' y transcript_state='failed': exactamente lo que dejó el
-- AttributeError del worker.
INSERT INTO meetings (id, tenant_id, client_id, title, source_kind, idempotency_key,
                      media_state, transcript_state, warnings)
  VALUES (:M, :T, :C, 'La que falló', 'file', 'repro-1', 'ready', 'failed',
          '[{"at":"2026-09-10T00:48:23.085Z","code":"normalize_failed","failure_code":"worker_error"}]'::jsonb);
-- El original: vivo, sin run. Es el que el reproceso reutiliza.
INSERT INTO meeting_media (tenant_id, client_id, meeting_id, role, storage_key, bytes,
                           checksum_sha256, content_type)
  VALUES (:T, :C, :M, 'original', 't/repro/original/source', 1026007, :SHA, 'audio/wav');
-- Run 1 CERRADO con outcome, como lo dejó el tercer fallo.
INSERT INTO meeting_processing_runs (id, tenant_id, client_id, meeting_id, run_number,
                                     trigger, started_at, finished_at, outcome)
  VALUES (:R1, :T, :C, :M, 1, 'initial', now() - interval '10 min', now() - interval '5 min', 'failed');
INSERT INTO meeting_processing_jobs (id, tenant_id, client_id, meeting_id, run_id, stage,
                                     status, attempts, max_attempts, failure_code, failure_detail)
  VALUES (:J1, :T, :C, :M, :R1, 'normalize', 'failed', 3, 3, 'worker_error',
          '''dict'' object has no attribute ''duration_seconds''');
\set QUIET off

SELECT a('partida · el job fallido agotó sus intentos',
  format('(SELECT status=''failed'' AND attempts=3 FROM meeting_processing_jobs WHERE id=%L)', :J1));
SELECT a('partida · no hay ningún run activo',
  format('(SELECT count(*)=0 FROM meeting_processing_runs WHERE meeting_id=%L AND finished_at IS NULL)', :M));
SELECT a('partida · el original está vivo y sin run',
  format('(SELECT count(*)=1 FROM meeting_media WHERE meeting_id=%L AND role=''original'' AND run_id IS NULL AND deleted_at IS NULL)', :M));

-- ── La transición, paso a paso ───────────────────────────────────────────
SELECT t('run de reproceso: abierto y sin outcome (runs_finish_coherent)',
  format('INSERT INTO meeting_processing_runs (id, tenant_id, client_id, meeting_id, run_number, trigger, started_at)
          VALUES (%L, %L, %L, %L, 2, ''reprocess'', now())', :R2, :T, :C, :M), 'ok');

SELECT a('el run nuevo es el nº2 y es el único activo',
  format('(SELECT count(*)=1 FROM meeting_processing_runs WHERE meeting_id=%L AND finished_at IS NULL AND run_number=2 AND trigger=''reprocess'')', :M));

SELECT t('job normalize del run nuevo: queued, attempts=0, sin lease',
  format('INSERT INTO meeting_processing_jobs (id, tenant_id, client_id, meeting_id, run_id, stage)
          VALUES (%L, %L, %L, %L, %L, ''normalize'')', :J2, :T, :C, :M, :R2), 'ok');

SELECT a('requires se generó desde stage, nadie lo declaró',
  format('(SELECT requires = ''{meetings.transcribe}''::text[] FROM meeting_processing_jobs WHERE id=%L)', :J2));
SELECT a('el job nuevo nace reclamable',
  format('(SELECT status=''queued'' AND attempts=0 AND next_attempt_at<=now() AND lease_token_hash IS NULL
                 AND lease_expires_at IS NULL AND leased_credential_id IS NULL AND leased_credential_label IS NULL
           FROM meeting_processing_jobs WHERE id=%L)', :J2));

SELECT t('evento del reproceso',
  format('INSERT INTO meeting_job_events (tenant_id, client_id, meeting_id, job_id, attempt, kind, stage, detail)
          VALUES (%L, %L, %L, %L, 0, ''state_changed'', ''normalize'',
                  ''{"to":"queued","reason":"reprocess","run_number":2}''::jsonb)', :T, :C, :M, :J2), 'ok');

SELECT t('transcript_state failed → pending, con el aviso CONCATENADO',
  format('UPDATE meetings SET transcript_state=''pending'',
                 warnings = warnings || ''[{"at":"2026-09-10T01:00:00.000Z","code":"reprocess_requested","run_number":2,"previous_failure_code":"worker_error"}]''::jsonb
           WHERE id=%L', :M), 'ok');

-- ── Lo que la transición NO puede haber hecho ────────────────────────────
SELECT a('el aviso histórico sobrevive y no se duplicó',
  format('(SELECT jsonb_array_length(warnings)=2
                  AND warnings->0->>''code''=''normalize_failed''
                  AND warnings->1->>''code''=''reprocess_requested''
                  AND (SELECT count(*) FROM jsonb_array_elements(warnings) e
                        WHERE e->>''code''=''reprocess_requested'')=1
           FROM meetings WHERE id=%L)', :M));
SELECT a('warnings sigue siendo un array (meetings_warnings_array)',
  format('(SELECT jsonb_typeof(warnings)=''array'' FROM meetings WHERE id=%L)', :M));
SELECT a('el job fallido está EXACTAMENTE como estaba',
  format('(SELECT status=''failed'' AND attempts=3 AND max_attempts=3 AND failure_code=''worker_error''
                  AND run_id=%L
           FROM meeting_processing_jobs WHERE id=%L)', :R1, :J1));
SELECT a('el run 1 sigue cerrado con outcome=failed',
  format('(SELECT finished_at IS NOT NULL AND outcome=''failed'' FROM meeting_processing_runs WHERE id=%L)', :R1));
SELECT a('el original no se duplicó ni se tocó',
  format('(SELECT count(*)=1 FROM meeting_media WHERE meeting_id=%L AND role=''original'' AND deleted_at IS NULL AND bytes=1026007)', :M));
SELECT a('cero medios derivados: el run nuevo aún no produjo nada',
  format('(SELECT count(*)=0 FROM meeting_media WHERE meeting_id=%L AND role<>''original'')', :M));
SELECT a('dos jobs normalize en la reunión, uno por run, y sólo uno reclamable',
  format('(SELECT count(*)=2 AND count(*) FILTER (WHERE status=''queued'')=1
           FROM meeting_processing_jobs WHERE meeting_id=%L AND stage=''normalize'')', :M));

-- ── Las dos imposibilidades, garantizadas por la base ────────────────────
--
-- Esto es lo que hace innecesario confiar en la comprobación de código: dos
-- procesos simultáneos no pueden burlar un índice único.
SELECT t('DOS runs activos: imposible',
  format('INSERT INTO meeting_processing_runs (tenant_id, client_id, meeting_id, run_number, trigger, started_at)
          VALUES (%L, %L, %L, 3, ''reprocess'', now())', :T, :C, :M),
  'runs_one_active_per_meeting_idx');

SELECT t('DOS normalize del mismo run: imposible',
  format('INSERT INTO meeting_processing_jobs (tenant_id, client_id, meeting_id, run_id, stage)
          VALUES (%L, %L, %L, %L, ''normalize'')', :T, :C, :M, :R2),
  'jobs_stage_key');

SELECT t('reutilizar el run_number 1: imposible',
  format('INSERT INTO meeting_processing_runs (tenant_id, client_id, meeting_id, run_number, trigger, started_at, finished_at, outcome)
          VALUES (%L, %L, %L, 1, ''reprocess'', now(), now(), ''failed'')', :T, :C, :M),
  'runs_number_key');

SELECT t('un run de reproceso con outcome pero sin cerrar: imposible',
  format('INSERT INTO meeting_processing_runs (tenant_id, client_id, meeting_id, run_number, trigger, started_at, outcome)
          VALUES (%L, %L, %L, 9, ''reprocess'', now(), ''failed'')', :T, :C, :M),
  'runs_finish_coherent');

SELECT t('un trigger inventado: imposible',
  format('INSERT INTO meeting_processing_runs (tenant_id, client_id, meeting_id, run_number, trigger, started_at)
          VALUES (%L, %L, %L, 8, ''retry'', now())', :T, :C, :M),
  'trigger');

-- Un job en cola con lease residual sería a la vez reclamable y reclamado. Es
-- lo que un «reintento» hecho a mano con UPDATE deja si olvida limpiar los
-- cuatro campos — el motivo por el que el reproceso crea filas nuevas en vez de
-- reescribir las viejas.
SELECT t('queued con token de lease residual: imposible',
  format('UPDATE meeting_processing_jobs SET lease_token_hash=%L WHERE id=%L', :SHA, :J2),
  'jobs_lease_invariants');

-- ── El run nuevo pertenece a ESTA reunión y a ninguna otra ───────────────
\set QUIET on
INSERT INTO meetings (id, tenant_id, client_id, title, source_kind, idempotency_key, media_state)
  VALUES (:MOTRO, :T, :C, 'Otra del mismo cliente', 'file', 'repro-2', 'ready');
\set QUIET off
SELECT t('un job de otra reunión sobre el run del reproceso: imposible',
  format('INSERT INTO meeting_processing_jobs (tenant_id, client_id, meeting_id, run_id, stage)
          VALUES (%L, %L, %L, %L, ''transcribe'')', :T, :C, :MOTRO, :R2),
  'jobs_run_fkey');

-- ── Y la negativa que protege la reunión cancelada ───────────────────────
-- El script la rechaza en código; aquí se comprueba que el CHECK del esquema
-- exige autor cuando hay cancelación, que es lo que hace fiable esa lectura.
SELECT t('cancelar sin autor: imposible (meetings_cancel_coherent)',
  format('UPDATE meetings SET cancelled_at=now() WHERE id=%L', :MOTRO),
  'meetings_cancel_coherent');
