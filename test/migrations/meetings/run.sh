#!/usr/bin/env bash
#
# Valida el esquema de Reuniones (M-1..M-4) contra una base DESECHABLE.
#
#   test/migrations/meetings/run.sh
#
# Requiere Docker. Levanta su propio PostgreSQL, siembra el esquema base
# aplicando TODAS las migraciones del repositorio desde cero, corre las suites
# y borra el contenedor. No toca ninguna base existente: el puerto y el nombre
# del contenedor son propios y el script se niega a funcionar si DATABASE_URL
# apunta a otro sitio.
#
# ── Por qué un contenedor propio y no la base de desarrollo ────────────────
#
# Estas pruebas BORRAN filas para comprobar el comportamiento de las claves
# ajenas: contactos, usuarios, hablantes, transcripts. Correrlas contra una base
# con datos reales sería destructivo, y correrlas contra una base compartida las
# haría dependientes de lo que otro haya dejado. Un contenedor efímero es la
# única forma de que el resultado signifique lo mismo cada vez.
#
# ── Qué comprueba ──────────────────────────────────────────────────────────
#
#   10  integridad relacional: cruces deliberados entre dos reuniones del mismo
#       cliente, y borrados reales sobre las FK con SET NULL por columna
#   20  pools, capabilities/concurrency, revocación, matriz de estados de lease
#   25  ciclo de vida de credenciales: RESTRICT, revocar + requeuear
#   30  barrido: borra de verdad el padre de CADA FK con SET NULL
#   35  invariantes de estado de meeting_result_uploads
#   40  detector de la CLASE de defecto "SET NULL exigido por un CHECK"
#   50  semilla para las guardas del down
#   60  cada consulta del runbook de W-3 contra el esquema real
#   70  la transición del reproceso: run nuevo + job nuevo sin tocar el fallido
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

CONTAINER="mai-meetings-schema-test"
PORT="55432"
PASSWORD="throwaway"
DB="meetings_schema_test"
URL="postgresql://postgres:${PASSWORD}@localhost:${PORT}/${DB}"

psql_() { docker exec -i "$CONTAINER" psql -U postgres -d "$DB" "$@"; }

cleanup() {
  if [[ "${KEEP_CONTAINER:-0}" == "1" ]]; then
    echo "  (KEEP_CONTAINER=1: se conserva ${CONTAINER} en el puerto ${PORT})"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "═══ levantando PostgreSQL desechable ═══"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB="$DB" \
  -p "${PORT}:5432" postgres:18 >/dev/null

# El contenedor acepta conexiones antes de estar listo para consultas; pg_isready
# sobre el socket local es la señal fiable.
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres -d "$DB" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
docker exec "$CONTAINER" pg_isready -U postgres -d "$DB" >/dev/null

echo "  $(psql_ -At -c 'SELECT version()' | cut -d, -f1)"

echo ""
echo "═══ preflight ═══"
( cd "$ROOT" && DATABASE_URL="$URL" npx tsx src/scripts/meetingsPreflight.ts 2>&1 ) \
  | sed -n 's/.*"msg":"\(.*\)"}/  \1/p'

echo ""
echo "═══ aplicando TODAS las migraciones desde cero ═══"
# El resultado se comprueba consultando pgmigrations, NO grepeando la salida:
# node-pg-migrate imprime el SQL de cada migración ANTES de ejecutarla, así que
# contar líneas 'INSERT INTO pgmigrations' cuenta intenciones y no hechos. Con
# un fallo a mitad, ese conteo da un número alto y tranquilizador mientras la
# base está vacía.
migrate_out="$( cd "$ROOT" && DATABASE_URL="$URL" npx node-pg-migrate --tsx up 2>&1 )" || true
applied="$(psql_ -At -c 'SELECT count(*) FROM pgmigrations' 2>/dev/null || echo 0)"
expected="$(ls "$ROOT"/migrations/*.ts | wc -l | tr -d ' ')"
echo "  aplicadas $applied de $expected"
if [[ "$applied" != "$expected" ]]; then
  echo "  ✗ la cadena de migraciones no aplica desde cero:"
  grep -iE '^error:' <<<"$migrate_out" | head -3 | sed 's/^/    /'
  exit 1
fi

echo ""
echo "═══ suites ═══"
for f in "$HERE"/00-harness.sql "$HERE"/10-integrity.sql "$HERE"/20-pools-lease.sql \
         "$HERE"/25-credential-lifecycle.sql "$HERE"/30-setnull-sweep.sql \
         "$HERE"/35-result-upload-states.sql "$HERE"/40-setnull-class.sql \
         "$HERE"/60-runbook-sql.sql "$HERE"/70-reprocess-transition.sql; do
  psql_ -q -f - < "$f" 2>&1 \
    | sed -e 's/^psql:[^ ]* NOTICE:  //' -e 's/^psql:<stdin>:[0-9]*: NOTICE:  //' \
    | grep -E 'PASS|FAIL|════|ERROR' || true
done

echo ""
echo "═══ resumen ═══"
psql_ -At -c "SELECT count(*)||' pruebas · '||count(*) FILTER (WHERE ok)||' pasan · '
                    ||count(*) FILTER (WHERE NOT ok)||' fallan' FROM _t" | sed 's/^/  /'
psql_ -At -c "SELECT '  FALLA: '||label||'  (esperaba '||expect||', obtuvo '||left(got,90)||')'
                FROM _t WHERE NOT ok"
FAILED="$(psql_ -At -c 'SELECT count(*) FROM _t WHERE NOT ok')"
TOTAL="$(psql_ -At -c 'SELECT count(*) FROM _t')"

echo ""
echo "═══ guardas del down con datos presentes ═══"
# Se recorre el down de arriba abajo: cada guarda debe BLOQUEAR mientras haya
# filas suyas, y revertir en cuanto la tabla se vacíe.
#
# BASE LIMPIA, no la que dejaron las suites. Las suites terminan con jobs que
# referencian credenciales, y con RESTRICT eso hace que 'DELETE FROM
# worker_credentials' falle — el paso siguiente entonces no revierte y el
# informe culparía a la guarda de MEET-3 de algo que causó una suite anterior.
# Una prueba que depende del estado que dejó otra no mide lo que dice medir.
psql_ -q -c "SET client_min_messages=warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null 2>&1
migrate_out="$( cd "$ROOT" && DATABASE_URL="$URL" npx node-pg-migrate --tsx up 2>&1 )" || true
reapplied="$(psql_ -At -c 'SELECT count(*) FROM pgmigrations' 2>/dev/null || echo 0)"
if [[ "$reapplied" != "$expected" ]]; then
  echo "  ✗ no se pudo rehacer el esquema para las guardas ($reapplied de $expected)"
  exit 1
fi
psql_ -q -f - < "$HERE/50-down-guards-seed.sql" >/dev/null 2>&1 || true
guard_failures=0
step() { # $1 = etiqueta esperada, $2 = tabla a vaciar
  local out
  out="$( cd "$ROOT" && DATABASE_URL="$URL" npx node-pg-migrate --tsx down 1 2>&1 )" || true
  if grep -q "$1 down abortado" <<<"$out"; then
    echo "  ✓ $1 bloquea con datos presentes"
  else
    echo "  ✗ $1 NO bloqueó"
    guard_failures=$((guard_failures + 1))
    return
  fi
  psql_ -q -c "DELETE FROM $2" >/dev/null 2>&1 || true
  out="$( cd "$ROOT" && DATABASE_URL="$URL" npx node-pg-migrate --tsx down 1 2>&1 )" || true
  grep -q "Migrations complete" <<<"$out" \
    && echo "      y revierte una vez vacía" \
    || { echo "      ✗ sigue sin revertir"; guard_failures=$((guard_failures + 1)); }
}
step MEET-4 meeting_result_uploads
step MEET-3 worker_credentials
step MEET-2 meeting_transcript_versions
step MEET-1 meetings

echo ""
if [[ "$FAILED" == "0" && "$guard_failures" == "0" ]]; then
  echo "TODO VERDE — $TOTAL pruebas de esquema y 4 guardas del down"
else
  echo "HAY FALLOS: $FAILED en las suites, $guard_failures en las guardas"
  exit 1
fi
