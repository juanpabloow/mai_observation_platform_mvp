\echo ''
\echo '════════ ESTADOS DE meeting_result_uploads ════════'
-- La tabla de verdad de ru_state_invariants, probada estado por estado. Cada
-- estado tiene su caso de control (la forma válida) y sus casos imposibles.

-- Un job de destino para los artefactos.
INSERT INTO meeting_processing_jobs (id,tenant_id,client_id,meeting_id,run_id,stage)
  VALUES ('cafe00f0-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
          'aaaa0001-0000-0000-0000-000000000000','dead0001-0000-0000-0000-000000000000',
          'beef000c-0000-0000-0000-000000000000','analyze');

-- `ru` construye un INSERT con el estado y los campos que se le pasen. Un
-- 'attempt' distinto por caso para no chocar con ru_attempt_key, que es una
-- garantía diferente y ya se prueba aparte.
CREATE OR REPLACE FUNCTION ru(n int, state text, cols text, vals text) RETURNS text AS $fn$
  SELECT format(
    'INSERT INTO meeting_result_uploads (tenant_id,client_id,meeting_id,job_id,attempt,kind,schema_version,storage_key,state%s)
       VALUES (''11111111-1111-1111-1111-111111111111'',''aaaa0001-0000-0000-0000-000000000000'',
               ''dead0001-0000-0000-0000-000000000000'',''cafe00f0-0000-0000-0000-000000000000'',
               %s,''transcript'',1,''ru/%s'',''%s''%s)',
    CASE WHEN cols = '' THEN '' ELSE ',' || cols END,
    n, n, state,
    CASE WHEN vals = '' THEN '' ELSE ',' || vals END);
$fn$ LANGUAGE sql IMMUTABLE;

-- ── awaiting_upload ─────────────────────────────────────────────────────────
SELECT t($q$control · awaiting_upload limpio$q$,
  ru(1,'awaiting_upload','',''), $q$ok$q$);
SELECT t($q$awaiting_upload con uploaded_at$q$,
  ru(2,'awaiting_upload','uploaded_at','now()'), $q$ru_state_invariants$q$);
SELECT t($q$awaiting_upload con ingested_at (el peor: el barrido lo trataría como pendiente)$q$,
  ru(3,'awaiting_upload','uploaded_at,verified_at,ingested_at','now(),now(),now()'), $q$ru_state_invariants$q$);
SELECT t($q$awaiting_upload con rejected_at$q$,
  ru(4,'awaiting_upload','rejected_at','now()'), $q$ru_state_invariants$q$);

-- ── uploaded ────────────────────────────────────────────────────────────────
SELECT t($q$control · uploaded con su instante$q$,
  ru(5,'uploaded','uploaded_at','now()'), $q$ok$q$);
SELECT t($q$uploaded SIN uploaded_at$q$,
  ru(6,'uploaded','',''), $q$ru_state_invariants$q$);
SELECT t($q$uploaded con verified_at$q$,
  ru(7,'uploaded','uploaded_at,verified_at','now(),now()'), $q$ru_state_invariants$q$);

-- ── verified ────────────────────────────────────────────────────────────────
SELECT t($q$control · verified con instantes y mediciones$q$,
  ru(8,'verified','uploaded_at,verified_at,observed_bytes,observed_checksum_sha256',
     $$now(),now(),1024,repeat('a',64)$$), $q$ok$q$);
SELECT t($q$verified SIN mediciones (no se verificó nada)$q$,
  ru(9,'verified','uploaded_at,verified_at','now(),now()'), $q$ru_state_invariants$q$);
SELECT t($q$verified sin uploaded_at (verificado algo que nunca se subió)$q$,
  ru(10,'verified','verified_at,observed_bytes,observed_checksum_sha256',
     $$now(),1024,repeat('a',64)$$), $q$ru_state_invariants$q$);
SELECT t($q$verified con sólo una de las dos mediciones$q$,
  ru(11,'verified','uploaded_at,verified_at,observed_bytes','now(),now(),1024'), $q$ru_observed_pair$q$);

-- ── ingested ────────────────────────────────────────────────────────────────
SELECT t($q$control · ingested completo$q$,
  ru(12,'ingested','uploaded_at,verified_at,ingested_at,observed_bytes,observed_checksum_sha256',
     $$now(),now(),now(),1024,repeat('a',64)$$), $q$ok$q$);
SELECT t($q$ingested sin verified_at$q$,
  ru(13,'ingested','uploaded_at,ingested_at,observed_bytes,observed_checksum_sha256',
     $$now(),now(),1024,repeat('a',64)$$), $q$ru_state_invariants$q$);
SELECT t($q$ingested sin uploaded_at$q$,
  ru(14,'ingested','verified_at,ingested_at,observed_bytes,observed_checksum_sha256',
     $$now(),now(),1024,repeat('a',64)$$), $q$ru_state_invariants$q$);
SELECT t($q$ingested sin mediciones$q$,
  ru(15,'ingested','uploaded_at,verified_at,ingested_at','now(),now(),now()'), $q$ru_state_invariants$q$);

-- ── rejected ────────────────────────────────────────────────────────────────
SELECT t($q$control · rejected con instante y código$q$,
  ru(16,'rejected','rejected_at,reject_code',$$now(),'checksum_mismatch'$$), $q$ok$q$);
SELECT t($q$rejected sin rejected_at$q$,
  ru(17,'rejected','reject_code',$$'checksum_mismatch'$$), $q$ru_state_invariants$q$);
SELECT t($q$rejected sin reject_code$q$,
  ru(18,'rejected','rejected_at','now()'), $q$ru_state_invariants$q$);
SELECT t($q$rejected con ingested_at$q$,
  ru(19,'rejected','rejected_at,reject_code,uploaded_at,verified_at,ingested_at',
     $$now(),'x',now(),now(),now()$$), $q$ru_state_invariants$q$);
SELECT t($q$control · rechazo DESPUÉS de subir (caso real)$q$,
  ru(20,'rejected','uploaded_at,rejected_at,reject_code',$$now(),now(),'size_mismatch'$$), $q$ok$q$);
SELECT t($q$detalle de rechazo sin código$q$,
  ru(21,'uploaded','uploaded_at,reject_detail',$$now(),'algo pasó'$$), $q$ru_reject_detail_needs_code$q$);

-- ── orden temporal ──────────────────────────────────────────────────────────
SELECT t($q$verificado ANTES de subir$q$,
  ru(22,'verified','uploaded_at,verified_at,observed_bytes,observed_checksum_sha256',
     $$now(),now() - interval '1 hour',1024,repeat('a',64)$$), $q$ru_time_order$q$);
SELECT t($q$ingerido ANTES de verificar$q$,
  ru(23,'ingested','uploaded_at,verified_at,ingested_at,observed_bytes,observed_checksum_sha256',
     $$now(),now(),now() - interval '1 hour',1024,repeat('a',64)$$), $q$ru_time_order$q$);

-- ── la transición completa de una fila real ─────────────────────────────────
SELECT t($q$recorrido awaiting → uploaded → verified → ingested$q$, $q$
  INSERT INTO meeting_result_uploads (id,tenant_id,client_id,meeting_id,job_id,attempt,kind,schema_version,storage_key)
    VALUES ('0111000a-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
            'aaaa0001-0000-0000-0000-000000000000','dead0001-0000-0000-0000-000000000000',
            'cafe00f0-0000-0000-0000-000000000000',90,'transcript',1,'ru/flow');
  UPDATE meeting_result_uploads SET state='uploaded', uploaded_at=now()
   WHERE id='0111000a-0000-0000-0000-000000000000';
  UPDATE meeting_result_uploads SET state='verified', verified_at=now(),
         observed_bytes=2048, observed_checksum_sha256=repeat('b',64)
   WHERE id='0111000a-0000-0000-0000-000000000000';
  UPDATE meeting_result_uploads SET state='ingested', ingested_at=now()
   WHERE id='0111000a-0000-0000-0000-000000000000'$q$, $q$ok$q$);
SELECT a($q$ → cada paso quedó registrado$q$,
  $q$EXISTS (SELECT 1 FROM meeting_result_uploads
               WHERE id='0111000a-0000-0000-0000-000000000000' AND state='ingested'
                 AND uploaded_at IS NOT NULL AND verified_at IS NOT NULL
                 AND ingested_at IS NOT NULL AND rejected_at IS NULL)$q$);
SELECT t($q$saltarse la verificación (uploaded → ingested)$q$,
  $q$UPDATE meeting_result_uploads SET state='ingested', ingested_at=now()
     WHERE storage_key='ru/5'$q$, $q$ru_state_invariants$q$);
