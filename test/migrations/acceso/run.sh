#!/usr/bin/env bash
#
# ACCESO-1 — migración 1822 con la VERSIÓN ANTERIOR todavía funcionando, y rollback de código.
#
#   test/migrations/acceso/run.sh                 # versión anterior = origin/main
#   BASE_REF=<commit> test/migrations/acceso/run.sh
#   test/migrations/acceso/selftest.sh            # prueba el propio arnés (fallos → código ≠ 0)
#
# Requiere Docker. Cada ejecución crea SUS recursos con un nombre único y solo borra esos:
#   - un contenedor PostgreSQL `mai-acceso-compat-<id>`, publicado SOLO en 127.0.0.1 y en un
#     puerto libre elegido por Docker (nunca toca otros contenedores ni puertos);
#   - una base `acceso_compat_<id>` dentro de él;
#   - un worktree temporal de la versión anterior.
# KEEP=1 los conserva para depurar.
#
# Fases (cada comprobación FALLA explícitamente si no se cumple; el «OK» final solo se imprime
# si TODO pasó, y el código de salida es el del primer fallo):
#   1. esquema y código anteriores: inicia sesión, el refresco desliza la sesión 7 días
#   2. aplica SOLO la migración nueva (lo que hace el pre-deploy de Railway)
#   3. código anterior sobre el esquema nuevo (ventana del despliegue): refresco, inicio de
#      sesión, listar, revocar, cerrar sesión
#   4. código nuevo: concilia lo que escribió el anterior (recorta, nunca alarga ni inventa
#      actividad)
#   5. rollback SOLO de código; 6. código nuevo otra vez
#   7. down: se NIEGA con perfiles o fotos; con ACCESO_DOWN_ALLOW_DATA_LOSS=1 los borra
#      (SOLO en esta base desechable); up vuelve a aplicar
#
# Solo para selftest.sh: ACCESO_COMPAT_INJECT=migration-failure|check-failure y
# ACCESO_COMPAT_READY_TIMEOUT=<segundos>.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
BASE_REF="${BASE_REF:-origin/main}"
RUN_ID="$(date +%s)-$$-$RANDOM"
CONTAINER="mai-acceso-compat-${RUN_ID}"
DB="acceso_compat_${RUN_ID//-/_}"
WORK="$(mktemp -d -t acceso-compat.XXXXXX)"
OLD="$WORK/old"
STATE="$WORK/state.json"
READY_TIMEOUT="${ACCESO_COMPAT_READY_TIMEOUT:-60}"
CREATED_CONTAINER=0
CREATED_WORKTREE=0

fail() { echo "  ✗ $*" >&2; exit 1; }

cleanup() {
  local rc=$?
  if [[ "${KEEP:-0}" == "1" ]]; then
    echo "  (KEEP=1: se conservan ${CONTAINER} y ${WORK})"
  else
    if [[ $CREATED_CONTAINER == 1 ]]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || echo "  aviso: no se pudo borrar ${CONTAINER}" >&2; fi
    if [[ $CREATED_WORKTREE == 1 ]]; then git -C "$ROOT" worktree remove --force "$OLD" >/dev/null 2>&1 || echo "  aviso: no se pudo borrar el worktree ${OLD}" >&2; fi
    rm -rf "$WORK"
  fi
  if [[ $rc -ne 0 ]]; then echo "═══ FALLO (código ${rc}) ═══" >&2; fi
  exit "$rc"
}
trap cleanup EXIT

# Run a command with its full output in a log; show only the interesting lines; return the
# COMMAND's exit code (the filter never changes it). On failure, show the end of the log.
run_logged() {
  local log="$1"; shift
  local rc=0
  "$@" >"$log" 2>&1 || rc=$?
  awk '/Migrations complete|No migrations|✓|✗|^error:/' "$log"
  if [[ $rc -ne 0 && "${EXPECT_FAIL:-0}" != 1 ]]; then echo "  --- últimas líneas de $(basename "$log") ---" >&2; tail -n 25 "$log" >&2; fi
  return "$rc"
}

echo "═══ PostgreSQL desechable ═══"
echo "  contenedor: ${CONTAINER}"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=throwaway -e POSTGRES_DB="$DB" -p 127.0.0.1::5432 postgres:18 >/dev/null
CREATED_CONTAINER=1
ready=0
waited=0
# A counter, not `seq 1 N`: BSD seq counts DOWN for N=0 (prints "1 0"), which made a
# zero timeout wait anyway — caught by selftest.sh.
while (( waited < READY_TIMEOUT )); do
  if docker exec "$CONTAINER" pg_isready -U postgres -d "$DB" -h 127.0.0.1 >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
  waited=$((waited + 1))
done
[[ $ready == 1 ]] || fail "PostgreSQL no quedó listo en ${READY_TIMEOUT}s (contenedor ${CONTAINER})"
PORT="$(docker port "$CONTAINER" 5432/tcp | awk -F: '/^127\.0\.0\.1:/ {print $2; exit}')"
[[ -n "$PORT" ]] || fail "no se pudo leer el puerto publicado en 127.0.0.1"
URL="postgresql://postgres:throwaway@127.0.0.1:${PORT}/${DB}"

echo "═══ versión anterior: ${BASE_REF} ═══"
git -C "$ROOT" worktree add --detach "$OLD" "$BASE_REF" >/dev/null 2>&1 || fail "no se pudo crear el worktree de ${BASE_REF}"
CREATED_WORKTREE=1
ln -s "$ROOT/node_modules" "$OLD/node_modules"
ln -s "$ROOT/web/node_modules" "$OLD/web/node_modules"
if ls "$OLD/migrations" | grep -q "session-policy-and-personal-profile"; then
  fail "BASE_REF ya contiene la migración nueva; elige la versión anterior"
fi

export DATABASE_URL="$URL" COMPAT_DB="$DB" BETTER_AUTH_SECRET="compat-local-secret-0123456789abcdef" BETTER_AUTH_URL="http://localhost:3000"
export RESEND_API_KEY="" INVITE_FROM_EMAIL="" GOOGLE_CLIENT_ID="" GOOGLE_CLIENT_SECRET="" TEST_DATABASE_URL="" LOG_LEVEL="warn" STATE
# A throwaway key per run (the worker config requires one; nothing here is encrypted).
export ENCRYPTION_KEY="$(openssl rand -hex 32)"

# The NEW migrations; the self-test can add a migration that throws.
NEW_MIGRATIONS="$ROOT/migrations"
if [[ "${ACCESO_COMPAT_INJECT:-}" == "migration-failure" ]]; then
  NEW_MIGRATIONS="$WORK/migrations"
  cp -R "$ROOT/migrations" "$NEW_MIGRATIONS"
  cat >"$NEW_MIGRATIONS/1999999999999_harness-injected-failure.ts" <<'EOF'
export async function up(): Promise<void> {
  throw new Error('migración fallida inyectada por selftest.sh');
}
export async function down(): Promise<void> {}
EOF
fi

migrate() { local dir="$1"; local mig="$2"; shift 2; (cd "$dir" && npx node-pg-migrate --tsx -m "$mig" "$@"); }
phase() { (cd "$1/web" && CHECKOUT="$1" PHASE="$2" npx tsx --conditions=react-server "$HERE/phase.ts"); }

echo "═══ 1. esquema y código anteriores ═══"
run_logged "$WORK/m1.log" migrate "$OLD" "$OLD/migrations" up || fail "la migración de la versión anterior falló"
run_logged "$WORK/p1.log" phase "$OLD" old-baseline || fail "fase 1"

echo "═══ 2. migración nueva (como el pre-deploy de Railway) ═══"
run_logged "$WORK/m2.log" migrate "$ROOT" "$NEW_MIGRATIONS" up || fail "la migración nueva falló"
applied="$(docker exec "$CONTAINER" psql -tA -U postgres -d "$DB" -c "SELECT count(*) FROM pgmigrations WHERE name = '1822000000000_session-policy-and-personal-profile'")"
[[ "$applied" == "1" ]] || fail "1822 no figura en pgmigrations"
echo "  ✓ 1822 aplicada"

echo "═══ 3. código anterior sobre el esquema nuevo (ventana de despliegue) ═══"
run_logged "$WORK/p3.log" phase "$OLD" old-on-new-schema || fail "fase 3"

echo "═══ 4. código nuevo ═══"
run_logged "$WORK/p4.log" phase "$ROOT" new-reconcile || fail "fase 4"

echo "═══ 5. rollback solo de código ═══"
run_logged "$WORK/p5.log" phase "$OLD" old-rollback || fail "fase 5"

echo "═══ 6. código nuevo otra vez ═══"
run_logged "$WORK/p6.log" phase "$ROOT" new-after-rollback || fail "fase 6"

echo "═══ 7. down protege perfiles y fotos (solo en esta base desechable) ═══"
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -q -U postgres -d "$DB" \
  -c "INSERT INTO user_profiles (user_id, phone_e164, phone_country) SELECT id, '+573001234567', 'CO' FROM \"user\" LIMIT 1;" \
  || fail "no se pudo sembrar un perfil"
if EXPECT_FAIL=1 run_logged "$WORK/d1.log" migrate "$ROOT" "$ROOT/migrations" down 1; then
  fail "down borró perfiles SIN confirmación"
fi
grep -q "Refusing to drop user_profiles" "$WORK/d1.log" || fail "down falló, pero no por la protección de perfiles"
echo "  ✓ down se niega mientras haya teléfonos o fotos"
still="$(docker exec "$CONTAINER" psql -tA -U postgres -d "$DB" -c "SELECT count(*) FROM user_profiles")"
[[ "$still" == "1" ]] || fail "el perfil desapareció pese a la negativa"
echo "  ✓ los datos siguen intactos tras la negativa"
export ACCESO_DOWN_ALLOW_DATA_LOSS=1
run_logged "$WORK/d2.log" migrate "$ROOT" "$ROOT/migrations" down 1 || fail "down con confirmación falló"
unset ACCESO_DOWN_ALLOW_DATA_LOSS
gone="$(docker exec "$CONTAINER" psql -tA -U postgres -d "$DB" -c "SELECT to_regclass('user_profiles') IS NULL AND to_regclass('user_avatars') IS NULL")"
[[ "$gone" == "t" ]] || fail "down con confirmación no eliminó las tablas"
echo "  ✓ con ACCESO_DOWN_ALLOW_DATA_LOSS=1 elimina perfiles y fotos (pérdida de datos)"
run_logged "$WORK/m3.log" migrate "$ROOT" "$ROOT/migrations" up || fail "up tras down falló"
echo "  ✓ up vuelve a aplicar"

echo "═══ OK: compatibilidad con la versión anterior, rollback y protección del down verificados ═══"
