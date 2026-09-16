-- Arnés mínimo para las pruebas de esquema de Reuniones (M-1..M-4).
--
-- Cada prueba es una sentencia que se espera que PASE o que FALLE con una
-- constraint concreta. `t()` la ejecuta capturando la excepción, compara con lo
-- esperado y acumula el resultado en `_t`; `a()` evalúa una condición booleana.
-- Nombrar la constraint esperada, y no sólo "debe fallar", es lo que hace que
-- una prueba siga midiendo lo que decía medir cuando el esquema cambie: si
-- falla por OTRA razón, la prueba lo dice.
\pset pager off
\set QUIET on
CREATE TABLE IF NOT EXISTS _t (label text, expect text, got text, ok boolean);
TRUNCATE _t;

CREATE OR REPLACE FUNCTION t(label text, sql text, expect text) RETURNS void AS $fn$
DECLARE ok boolean; got text;
BEGIN
  BEGIN EXECUTE sql; got:= 'OK';
  EXCEPTION WHEN others THEN got:= 'ERR:' || COALESCE(NULLIF(SQLERRM,''),SQLSTATE); END;
  ok:= CASE WHEN expect='ok' THEN got='OK'
             ELSE got LIKE 'ERR:%' AND position(lower(expect) in lower(got))>0 END;
  INSERT INTO _t VALUES (label, expect, got, ok);
  RAISE NOTICE '% % %', CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, rpad(label,62),
    CASE WHEN ok THEN '' ELSE 'esperaba <'||expect||'> obtuvo '||left(got,130) END;
END $fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION a(label text, cond text) RETURNS void AS $fn$
DECLARE ok boolean;
BEGIN
  BEGIN EXECUTE 'SELECT ('||cond||')' INTO ok; EXCEPTION WHEN others THEN ok:= NULL; END;
  ok:= COALESCE(ok, false);
  INSERT INTO _t VALUES (label, 'true', ok::text, ok);
  RAISE NOTICE '% %', CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, rpad(label,62);
END $fn$ LANGUAGE plpgsql;
\set QUIET off
