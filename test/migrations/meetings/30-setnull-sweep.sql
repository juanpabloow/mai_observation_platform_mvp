\echo ''
\echo '════════ BARRIDO · borrar de verdad el padre de CADA FK con SET NULL ════════'
-- No prueba un caso: prueba una CLASE. Se rellena TODA columna opcional que
-- apunte a "user" y luego se borra el usuario, de modo que las ocho FK con SET
-- NULL hacia esa tabla se ejerciten en un solo DELETE. Es el barrido que
-- encontró dos contradicciones (un CHECK que exigía una columna que el borrado
-- anulaba) que ninguna lectura del esquema había detectado.
--
-- Datos propios, con el prefijo 3, para no chocar con las suites anteriores:
-- una prueba que depende de lo que otra dejó no mide lo que dice medir.

INSERT INTO tenants (id,name) VALUES ('33333333-3333-3333-3333-333333333333','T-sweep');
INSERT INTO clients (id,tenant_id,name)
  VALUES ('3aaa0001-0000-0000-0000-000000000000','33333333-3333-3333-3333-333333333333','C-sweep');
INSERT INTO "user" (id,name,email,"emailVerified")
  VALUES ('u-victim','Víctima','victim@e.test',true);
INSERT INTO contacts (id,tenant_id,client_id,channel,channel_user_id,name)
  VALUES ('3fff0001-0000-0000-0000-000000000000','33333333-3333-3333-3333-333333333333',
          '3aaa0001-0000-0000-0000-000000000000','whatsapp','+300','Contacto');

INSERT INTO meetings (id,tenant_id,client_id,title,source_kind,idempotency_key,
                      created_by_user_id,cancelled_by_user_id,cancelled_by_label,cancelled_at)
  VALUES ('3dea0001-0000-0000-0000-000000000000','33333333-3333-3333-3333-333333333333',
          '3aaa0001-0000-0000-0000-000000000000','R-sweep','file','k-sweep',
          'u-victim','u-victim','victim@e.test',now());
INSERT INTO meeting_processing_runs (id,tenant_id,client_id,meeting_id,run_number,trigger,
                                     requested_by_user_id)
  VALUES ('3bee0001-0000-0000-0000-000000000000','33333333-3333-3333-3333-333333333333',
          '3aaa0001-0000-0000-0000-000000000000','3dea0001-0000-0000-0000-000000000000',
          1,'initial','u-victim');
INSERT INTO meeting_transcript_versions (id,tenant_id,client_id,meeting_id,run_id,
                                         whisper_model,duration_seconds,segment_count,schema_version)
  VALUES ('3fad0001-0000-0000-0000-000000000000','33333333-3333-3333-3333-333333333333',
          '3aaa0001-0000-0000-0000-000000000000','3dea0001-0000-0000-0000-000000000000',
          '3bee0001-0000-0000-0000-000000000000','medium',600,120,1);
UPDATE meetings SET active_transcript_id='3fad0001-0000-0000-0000-000000000000'
 WHERE id='3dea0001-0000-0000-0000-000000000000';
INSERT INTO meeting_speakers (id,tenant_id,client_id,meeting_id,display_name,
                              contact_id,renamed_by_user_id,renamed_by_label,renamed_at)
  VALUES ('3ace0001-0000-0000-0000-000000000000','33333333-3333-3333-3333-333333333333',
          '3aaa0001-0000-0000-0000-000000000000','3dea0001-0000-0000-0000-000000000000',
          'Nombrada','3fff0001-0000-0000-0000-000000000000','u-victim','victim@e.test',now());
INSERT INTO meeting_transcript_speakers (transcript_id,speaker_label,tenant_id,client_id,
                                         meeting_id,speaker_id)
  VALUES ('3fad0001-0000-0000-0000-000000000000','SPEAKER_00',
          '33333333-3333-3333-3333-333333333333','3aaa0001-0000-0000-0000-000000000000',
          '3dea0001-0000-0000-0000-000000000000','3ace0001-0000-0000-0000-000000000000');
INSERT INTO worker_pools (id,slug,environment,scope,
                          internal_authorized_actor_label,internal_authorized_by_user_id,
                          internal_authorized_at,created_by_user_id)
  VALUES ('3be10001-0000-0000-0000-000000000000','pool-sweep','production','internal',
          'victim@e.test','u-victim',now(),'u-victim');
INSERT INTO worker_credentials (id,pool_id,label,token_hash,token_prefix,created_by_user_id,
                                revoked_at,revoked_actor,revoked_actor_label,revoked_reason,
                                revoked_by_user_id)
  VALUES ('3c7e0001-0000-0000-0000-000000000000','3be10001-0000-0000-0000-000000000000',
          'sweep-1',repeat('4',64),'mtk_3aaa','u-victim',
          now(),'user','victim@e.test','rotación','u-victim');
INSERT INTO worker_credentials (id,pool_id,label,token_hash,token_prefix,rotated_from_id)
  VALUES ('3c7e0002-0000-0000-0000-000000000000','3be10001-0000-0000-0000-000000000000',
          'sweep-2',repeat('5',64),'mtk_3bbb','3c7e0001-0000-0000-0000-000000000000');

-- ── El DELETE que ejercita ocho FK a la vez ─────────────────────────────────
SELECT t($q$DELETE "user" · ocho FK con SET NULL en un solo borrado$q$,
  $q$DELETE FROM "user" WHERE id='u-victim'$q$, $q$ok$q$);
SELECT a($q$ → meetings.created_by_user_id anulado, la reunión intacta$q$,
  $q$EXISTS (SELECT 1 FROM meetings WHERE id='3dea0001-0000-0000-0000-000000000000'
             AND created_by_user_id IS NULL AND title='R-sweep')$q$);
SELECT a($q$ → la cancelación consta pese al borrado (cancelled_by_label)$q$,
  $q$EXISTS (SELECT 1 FROM meetings WHERE id='3dea0001-0000-0000-0000-000000000000'
             AND cancelled_by_user_id IS NULL AND cancelled_by_label='victim@e.test'
             AND cancelled_at IS NOT NULL)$q$);
SELECT a($q$ → runs.requested_by_user_id anulado, el run intacto$q$,
  $q$EXISTS (SELECT 1 FROM meeting_processing_runs WHERE id='3bee0001-0000-0000-0000-000000000000'
             AND requested_by_user_id IS NULL AND run_number=1)$q$);
SELECT a($q$ → el renombre del hablante consta (renamed_by_label)$q$,
  $q$EXISTS (SELECT 1 FROM meeting_speakers WHERE id='3ace0001-0000-0000-0000-000000000000'
             AND renamed_by_user_id IS NULL AND renamed_by_label='victim@e.test'
             AND renamed_at IS NOT NULL)$q$);
SELECT a($q$ → la autorización del pool interno consta en el snapshot$q$,
  $q$EXISTS (SELECT 1 FROM worker_pools WHERE id='3be10001-0000-0000-0000-000000000000'
             AND internal_authorized_by_user_id IS NULL
             AND internal_authorized_actor_label='victim@e.test'
             AND created_by_user_id IS NULL)$q$);
SELECT a($q$ → la revocación de la credencial consta en el snapshot$q$,
  $q$EXISTS (SELECT 1 FROM worker_credentials WHERE id='3c7e0001-0000-0000-0000-000000000000'
             AND revoked_by_user_id IS NULL AND revoked_actor='user'
             AND revoked_actor_label='victim@e.test' AND revoked_reason='rotación')$q$);

-- ── Los SET NULL por columna sobre claves compuestas ────────────────────────
SELECT t($q$DELETE contacto asociado a un hablante$q$,
  $q$DELETE FROM contacts WHERE id='3fff0001-0000-0000-0000-000000000000'$q$, $q$ok$q$);
SELECT a($q$ → el hablante sobrevive: sólo contact_id a NULL$q$,
  $q$EXISTS (SELECT 1 FROM meeting_speakers WHERE id='3ace0001-0000-0000-0000-000000000000'
             AND contact_id IS NULL AND tenant_id='33333333-3333-3333-3333-333333333333'
             AND client_id='3aaa0001-0000-0000-0000-000000000000'
             AND meeting_id='3dea0001-0000-0000-0000-000000000000')$q$);
SELECT t($q$DELETE hablante mapeado en una versión$q$,
  $q$DELETE FROM meeting_speakers WHERE id='3ace0001-0000-0000-0000-000000000000'$q$, $q$ok$q$);
SELECT a($q$ → el mapa sobrevive: sólo speaker_id a NULL$q$,
  $q$EXISTS (SELECT 1 FROM meeting_transcript_speakers
             WHERE transcript_id='3fad0001-0000-0000-0000-000000000000'
               AND speaker_label='SPEAKER_00' AND speaker_id IS NULL
               AND meeting_id='3dea0001-0000-0000-0000-000000000000')$q$);
SELECT t($q$DELETE la versión ACTIVA de la reunión$q$,
  $q$DELETE FROM meeting_transcript_versions WHERE id='3fad0001-0000-0000-0000-000000000000'$q$,
  $q$ok$q$);
SELECT a($q$ → la reunión sobrevive: sólo active_transcript_id a NULL$q$,
  $q$EXISTS (SELECT 1 FROM meetings WHERE id='3dea0001-0000-0000-0000-000000000000'
             AND active_transcript_id IS NULL AND title='R-sweep')$q$);

-- ── Y el SET NULL simple que sí es correcto ─────────────────────────────────
SELECT t($q$DELETE la credencial de la que se rotó (nadie la referencia)$q$,
  $q$DELETE FROM worker_credentials WHERE id='3c7e0001-0000-0000-0000-000000000000'$q$,
  $q$ok$q$);
SELECT a($q$ → la credencial nueva sobrevive sin el puntero de rotación$q$,
  $q$EXISTS (SELECT 1 FROM worker_credentials WHERE id='3c7e0002-0000-0000-0000-000000000000'
             AND rotated_from_id IS NULL)$q$);
