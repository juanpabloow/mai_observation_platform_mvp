\echo ''
\echo '════════ CICLO DE VIDA DE CREDENCIALES ════════'
-- Una credencial referenciada por un job o un evento NO se borra en operación
-- normal: se revoca. Liberar un job es revocar + requeuear en la MISMA
-- transacción. El borrado físico no participa, y RESTRICT es la comprobación
-- de que nadie la referencia — hecha por la base, no por quien se acuerde.
--
-- Se monta un escenario completo: un pool, dos credenciales, un job leased con
-- su evento de claim, y un segundo job ya terminado.

INSERT INTO worker_pools (id,slug,environment,scope,tenant_id)
  VALUES ('0be1000c-0000-0000-0000-000000000000','pool-lifecycle','development','single_tenant',
          '11111111-1111-1111-1111-111111111111');
INSERT INTO worker_credentials (id,pool_id,label,token_hash,token_prefix) VALUES
  ('0c7e000a-0000-0000-0000-000000000000','0be1000c-0000-0000-0000-000000000000','viva', repeat('1',64),'mtk_aaaa'),
  ('0c7e000b-0000-0000-0000-000000000000','0be1000c-0000-0000-0000-000000000000','suelta', repeat('2',64),'mtk_bbbb'),
  ('0c7e000c-0000-0000-0000-000000000000','0be1000c-0000-0000-0000-000000000000','de-evento',repeat('3',64),'mtk_cccc');

-- Un run cerrado para poder abrir otro (una sola activa por reunión).
UPDATE meeting_processing_runs SET finished_at = now(), outcome = 'succeeded'
 WHERE meeting_id = 'dead0001-0000-0000-0000-000000000000' AND finished_at IS NULL;
INSERT INTO meeting_processing_runs (id,tenant_id,client_id,meeting_id,run_number,trigger)
  VALUES ('beef000c-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
          'aaaa0001-0000-0000-0000-000000000000','dead0001-0000-0000-0000-000000000000',9,'reprocess');

-- Job LEASED por la credencial 'viva'.
INSERT INTO meeting_processing_jobs
  (id,tenant_id,client_id,meeting_id,run_id,stage,status,
   lease_token_hash,lease_expires_at,leased_credential_id,leased_credential_label)
  VALUES ('cafe000a-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
          'aaaa0001-0000-0000-0000-000000000000','dead0001-0000-0000-0000-000000000000',
          'beef000c-0000-0000-0000-000000000000','normalize','leased',
          repeat('9',64), now() + interval '5 min',
          '0c7e000a-0000-0000-0000-000000000000','pool-lifecycle/mtk_aaaa');

-- Un evento que menciona una TERCERA credencial, para probar que la FK del
-- log de auditoría también restringe.
INSERT INTO meeting_job_events (tenant_id,client_id,meeting_id,job_id,kind,stage,credential_id)
  VALUES ('11111111-1111-1111-1111-111111111111','aaaa0001-0000-0000-0000-000000000000',
          'dead0001-0000-0000-0000-000000000000','cafe000a-0000-0000-0000-000000000000',
          'claimed','normalize','0c7e000c-0000-0000-0000-000000000000');

-- ── 1 · no se puede borrar una credencial referenciada ──────────────────────
SELECT t($q$borrar la credencial de un job leased$q$,
  $q$DELETE FROM worker_credentials WHERE id='0c7e000a-0000-0000-0000-000000000000'$q$,
  $q$jobs_credential_fkey$q$);
SELECT t($q$borrar la credencial que sólo menciona un evento$q$,
  $q$DELETE FROM worker_credentials WHERE id='0c7e000c-0000-0000-0000-000000000000'$q$,
  $q$job_events_credential_fkey$q$);
SELECT t($q$control · una credencial que nadie referencia sí se borra$q$,
  $q$DELETE FROM worker_credentials WHERE id='0c7e000b-0000-0000-0000-000000000000'$q$,
  $q$ok$q$);

-- ── 2 · revocarla sí funciona ───────────────────────────────────────────────
SELECT t($q$revocar la credencial referenciada$q$,
  $q$UPDATE worker_credentials
       SET revoked_at=now(), revoked_actor='system',
           revoked_actor_label='lease-sweep', revoked_reason='lease expirado'
     WHERE id='0c7e000a-0000-0000-0000-000000000000'$q$,
  $q$ok$q$);
SELECT a($q$ → sigue existiendo, revocada, y el job la sigue apuntando$q$,
  $q$EXISTS (SELECT 1 FROM worker_credentials c
                JOIN meeting_processing_jobs j ON j.leased_credential_id = c.id
               WHERE c.id='0c7e000a-0000-0000-0000-000000000000'
                 AND c.revoked_at IS NOT NULL
                 AND j.id='cafe000a-0000-0000-0000-000000000000')$q$);

-- ── 3 · un job activo no puede existir sólo con la etiqueta ─────────────────
SELECT t($q$leased sin uuid, sólo con etiqueta$q$,
  $q$UPDATE meeting_processing_jobs SET leased_credential_id=NULL
     WHERE id='cafe000a-0000-0000-0000-000000000000'$q$,
  $q$jobs_$q$);
SELECT t($q$leased sin etiqueta, sólo con uuid$q$,
  $q$UPDATE meeting_processing_jobs SET leased_credential_label=NULL
     WHERE id='cafe000a-0000-0000-0000-000000000000'$q$,
  $q$jobs_$q$);
SELECT t($q$insertar un leased sólo con etiqueta$q$,
  $q$INSERT INTO meeting_processing_jobs
      (tenant_id,client_id,meeting_id,run_id,stage,status,
       lease_token_hash,lease_expires_at,leased_credential_label)
    VALUES ('11111111-1111-1111-1111-111111111111','aaaa0001-0000-0000-0000-000000000000',
            'dead0001-0000-0000-0000-000000000000','beef000c-0000-0000-0000-000000000000',
            'transcribe','leased',repeat('8',64),now()+interval '5 min','inventada/mtk_zzzz')$q$,
  $q$jobs_credential_pair$q$);
SELECT t($q$uuid y etiqueta desparejados en un terminal$q$,
  $q$INSERT INTO meeting_processing_jobs
      (tenant_id,client_id,meeting_id,run_id,stage,status,leased_credential_label)
    VALUES ('11111111-1111-1111-1111-111111111111','aaaa0001-0000-0000-0000-000000000000',
            'dead0001-0000-0000-0000-000000000000','beef000c-0000-0000-0000-000000000000',
            'diarize','cancelled','huerfana/mtk_yyyy')$q$,
  $q$jobs_credential_pair$q$);

-- ── 4 · revocar + requeuear limpia los cuatro campos ────────────────────────
-- Es EL mecanismo de liberación. Se hace en una transacción: si el requeue
-- falla, la revocación tampoco ocurre, porque una credencial revocada con su
-- job todavía leased deja trabajo que nadie puede continuar ni reclamar.
SELECT t($q$revocar + requeuear en una transacción$q$,
  $q$UPDATE meeting_processing_jobs
       SET status='queued', lease_token_hash=NULL, lease_expires_at=NULL,
           leased_credential_id=NULL, leased_credential_label=NULL,
           attempts = attempts + 1
     WHERE leased_credential_id='0c7e000a-0000-0000-0000-000000000000'
       AND status IN ('leased','uploading_result')$q$,
  $q$ok$q$);
SELECT a($q$ → el job está en queued con los CUATRO campos a NULL$q$,
  $q$EXISTS (SELECT 1 FROM meeting_processing_jobs
               WHERE id='cafe000a-0000-0000-0000-000000000000' AND status='queued'
                 AND lease_token_hash IS NULL AND lease_expires_at IS NULL
                 AND leased_credential_id IS NULL AND leased_credential_label IS NULL
                 AND attempts = 1)$q$);
SELECT a($q$ → y la credencial ya se puede borrar: nadie la referencia$q$,
  $q$NOT EXISTS (SELECT 1 FROM meeting_processing_jobs
                   WHERE leased_credential_id='0c7e000a-0000-0000-0000-000000000000')$q$);
SELECT t($q$un queued con etiqueta residual se rechaza$q$,
  $q$UPDATE meeting_processing_jobs
       SET leased_credential_label='residual/mtk_aaaa'
     WHERE id='cafe000a-0000-0000-0000-000000000000'$q$,
  $q$jobs_$q$);
SELECT a($q$ → la atribución del intento anterior vive en job_events$q$,
  $q$EXISTS (SELECT 1 FROM meeting_job_events
               WHERE job_id='cafe000a-0000-0000-0000-000000000000'
                 AND credential_id='0c7e000c-0000-0000-0000-000000000000'
                 AND kind='claimed')$q$);

-- ── 5 · los jobs terminados conservan la atribución ─────────────────────────
SELECT t($q$terminar un job conservando uuid y etiqueta$q$,
  $q$INSERT INTO meeting_processing_jobs
      (id,tenant_id,client_id,meeting_id,run_id,stage,status,
       leased_credential_id,leased_credential_label)
    VALUES ('cafe000d-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
            'aaaa0001-0000-0000-0000-000000000000','dead0001-0000-0000-0000-000000000000',
            'beef000c-0000-0000-0000-000000000000','transcribe','succeeded',
            '0c7e000a-0000-0000-0000-000000000000','pool-lifecycle/mtk_aaaa')$q$,
  $q$ok$q$);
SELECT a($q$ → un terminal SÍ retiene quién lo procesó$q$,
  $q$EXISTS (SELECT 1 FROM meeting_processing_jobs
               WHERE id='cafe000d-0000-0000-0000-000000000000' AND status='succeeded'
                 AND leased_credential_id IS NOT NULL
                 AND leased_credential_label='pool-lifecycle/mtk_aaaa'
                 AND lease_token_hash IS NULL AND lease_expires_at IS NULL)$q$);
SELECT t($q$ y su credencial vuelve a estar protegida por RESTRICT$q$,
  $q$DELETE FROM worker_credentials WHERE id='0c7e000a-0000-0000-0000-000000000000'$q$,
  $q$jobs_credential_fkey$q$);
SELECT t($q$un terminal SIN credencial también es válido (cancelado en cola)$q$,
  $q$INSERT INTO meeting_processing_jobs
      (tenant_id,client_id,meeting_id,run_id,stage,status)
    VALUES ('11111111-1111-1111-1111-111111111111','aaaa0001-0000-0000-0000-000000000000',
            'dead0001-0000-0000-0000-000000000000','beef000c-0000-0000-0000-000000000000',
            'diarize','cancelled')$q$,
  $q$ok$q$);
