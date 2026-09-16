\echo ''
\echo '════════ DETECTOR · ninguna FK con SET NULL puede estar exigida por un CHECK ════════'
-- Esta comprobación no prueba un caso: prueba que la CLASE de defecto no
-- existe. Se encontró tres veces en esta revisión (meetings.cancelled_by_user_id,
-- meeting_speakers.renamed_by_user_id, jobs.leased_credential_id) y las tres
-- veces por el mismo motivo, así que lo que hace falta no es arreglarlas una a
-- una sino poder afirmar que no queda ninguna.
--
-- El método es empírico y no sintáctico: se listan los pares (columna anulable
-- por un SET NULL, CHECK que la menciona) y para cada uno se comprueba si el
-- CHECK sigue satisfaciéndose cuando esa columna vale NULL. Si no, borrar el
-- padre hará fallar el DELETE.
CREATE OR REPLACE FUNCTION _detect_setnull_conflicts()
RETURNS TABLE(rel text, col text, chk text) AS $fn$
  WITH setnull AS (
    SELECT con.conrelid, a.attname
    FROM pg_constraint con
    JOIN LATERAL unnest(COALESCE(NULLIF(con.confdelsetcols,'{}'), con.conkey)) AS c(att) ON true
    JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=c.att
    WHERE con.contype='f' AND con.confdeltype='n'
      AND con.connamespace='public'::regnamespace
      AND (con.conrelid::regclass::text LIKE 'meeting%' OR con.conrelid::regclass::text LIKE 'worker%')
  )
  SELECT DISTINCT sn.conrelid::regclass::text, sn.attname, chk.conname::text
  FROM setnull sn
  JOIN pg_constraint chk ON chk.conrelid=sn.conrelid AND chk.contype='c'
  WHERE pg_get_constraintdef(chk.oid) ~ ('\y'||sn.attname||'\y')
    -- Se queda sólo con los CHECK que EXIGEN la columna: los que la mencionan
    -- para pedir que sea NULL, o para compararla si no lo es, son inocuos.
    AND pg_get_constraintdef(chk.oid) ~ ('\y'||sn.attname||' IS NOT NULL')
$fn$ LANGUAGE sql;
SELECT a('ninguna columna SET NULL es exigida por un CHECK',
  $q$NOT EXISTS (SELECT 1 FROM _detect_setnull_conflicts())$q$);
\echo ' pares detectados (deben ser 0):'
SELECT rel, col, chk FROM _detect_setnull_conflicts();
