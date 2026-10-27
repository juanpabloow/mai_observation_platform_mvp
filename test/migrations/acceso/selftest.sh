#!/usr/bin/env bash
#
# Prueba el PROPIO arnés test/migrations/acceso/run.sh: un fallo nunca puede pasar por éxito.
#
#   test/migrations/acceso/selftest.sh
#
#   1. una migración que falla      → código ≠ 0, sin «═══ OK», con «═══ FALLO»
#   2. una comprobación que falla   → código ≠ 0, sin «═══ OK»
#   3. PostgreSQL que no queda listo → código ≠ 0, mensaje claro, sin «═══ OK»
#   4. ningún contenedor preexistente se toca (un centinela con el mismo prefijo sigue vivo),
#      y cada ejecución borra SOLO su contenedor y su worktree
#
# Un caso de éxito no hace falta aquí: es run.sh mismo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SENTINEL="mai-acceso-compat-sentinel-$$-$RANDOM"
LOGDIR="$(mktemp -d -t acceso-selftest.XXXXXX)"
failures=0

cleanup() {
  local rc=$?
  docker rm -f "$SENTINEL" >/dev/null 2>&1 || true   # the sentinel is OURS (created below)
  rm -rf "$LOGDIR"
  exit "$rc"
}
trap cleanup EXIT

bad() { echo "  ✗ $*" >&2; failures=$((failures + 1)); }
good() { echo "  ✓ $*"; }

docker create --name "$SENTINEL" postgres:18 >/dev/null
good "centinela preexistente creado: ${SENTINEL}"

expect_failure() {
  local name="$1" expect_msg="$2"; shift 2
  local log="$LOGDIR/$name.log" rc=0
  env "$@" "$HERE/run.sh" >"$log" 2>&1 || rc=$?
  local container
  container="$(awk '/contenedor: / {print $2; exit}' "$log")"
  if [[ $rc -eq 0 ]]; then bad "$name: terminó con código 0"; else good "$name: código ${rc}"; fi
  if grep -q "═══ OK" "$log"; then bad "$name: imprimió el OK final"; else good "$name: sin OK final"; fi
  if grep -q "═══ FALLO" "$log"; then good "$name: anuncia el fallo"; else bad "$name: no anuncia el fallo"; fi
  if grep -q "$expect_msg" "$log"; then good "$name: motivo visible («${expect_msg}»)"; else bad "$name: no muestra «${expect_msg}»"; fi
  if [[ -n "$container" ]] && docker inspect "$container" >/dev/null 2>&1; then bad "$name: dejó su contenedor ${container}"; else good "$name: limpió su contenedor"; fi
  if git -C "$ROOT" worktree list | grep -q "acceso-compat"; then bad "$name: dejó un worktree"; else good "$name: limpió su worktree"; fi
  if [[ $failures -gt 0 ]]; then echo "--- salida de ${name} ---" >&2; tail -n 30 "$log" >&2; fi
}

echo "═══ 1. migración fallida ═══"
expect_failure migration-failure "la migración nueva falló" ACCESO_COMPAT_INJECT=migration-failure
echo "═══ 2. comprobación fallida ═══"
expect_failure check-failure "fase 3" ACCESO_COMPAT_INJECT=check-failure
echo "═══ 3. PostgreSQL no queda listo ═══"
expect_failure pg-not-ready "PostgreSQL no quedó listo" ACCESO_COMPAT_READY_TIMEOUT=0

echo "═══ 4. recursos ajenos intactos ═══"
if docker inspect "$SENTINEL" >/dev/null 2>&1; then good "el contenedor preexistente sigue ahí"; else bad "se borró un contenedor que no era de la ejecución"; fi

if [[ $failures -gt 0 ]]; then echo "═══ SELFTEST FALLÓ: ${failures} comprobación(es) ═══" >&2; exit 1; fi
echo "═══ SELFTEST OK ═══"
