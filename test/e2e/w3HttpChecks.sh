#!/usr/bin/env bash
#
# §7 del runbook de W-3: middleware, sesión y caché contra un mai REAL.
#
# ══════════════════════════════════════════════════════════════════════════
#  DOS BLOQUES, Y LA SEPARACIÓN ES EL PUNTO
# ══════════════════════════════════════════════════════════════════════════
#
#  BLOQUE A · enrutado — SIN CAMBIOS DE DOMINIO
#      Corre siempre. No crea reuniones, no reclama jobs y no cambia ningún
#      estado del pipeline.
#
#      Lo que SÍ escribe, y hay que decirlo: `authenticateWorkerToken` dispara
#      `touchLastUsed()`, un `UPDATE worker_credentials SET last_used_at =
#      now()` best-effort. Así que las DOS llamadas autenticadas de A.2 tocan
#      esa columna. Es telemetría de la credencial —cuándo se usó por última
#      vez— y no se desactiva ni se rodea con un modo de autenticación especial:
#      un camino de autenticación distinto al de producción haría que este smoke
#      dejara de probar el camino real, que es su único motivo de existir.
#
#      La versión anterior de esta cabecera decía «NO MUTANTE». Era falso, y
#      falso en la dirección peligrosa: una afirmación de seguridad que no se
#      cumple es peor que no hacerla, porque alguien la lee y decide en
#      consecuencia.
#
#  BLOQUE B · sesión — MUTANTE DE DOMINIO
#      CREA REUNIONES. Exige `W3_ALLOW_WRITES=1` y registra los `meetingId`
#      creados para que puedas comprobar que la limpieza los retira.
#
# ── Qué decía este script y era FALSO ─────────────────────────────────────
#
# La versión anterior afirmaba «Este script NO escribe en la base y NO sube
# objetos». Las dos mitades eran falsas:
#
#   · creaba reuniones por `POST /meetings` (dos, contando la de idempotencia);
#   · hacía un `claim` CON TOKEN VÁLIDO. Un claim válido no es una consulta: es
#     `FOR UPDATE SKIP LOCKED` + `UPDATE`. Le quita el job a la cola, le pone un
#     lease de cinco minutos y consume un intento. Y como este script no
#     manda latidos ni cierra nada, el job se quedaba colgado hasta que el
#     lease caducara — con `attempts` ya gastado. Si el worker estaba corriendo,
#     este smoke le robaba trabajo.
#
# El claim con token válido **ya no está aquí**. Se elimina, no se protege: lo
# que probaba —que el middleware llega al handler— lo prueban las seis llamadas
# SIN token del bloque A, y que el token autentica y su ámbito se respeta lo
# prueba la negativa de `maintenance` (404), que no reclama nada.
#
# El claim real se prueba **en el recorrido §5**, sobre el job sembrado, por el
# worker de verdad, y con seguimiento hasta su estado terminal. Ahí sí hay quien
# lo lleve a `succeeded`.
#
# ── Secretos y destino ────────────────────────────────────────────────────
#
# El token y la cookie se leen del entorno y NUNCA se imprimen. Lo que sale es
# el código HTTP y el `error.code`, que es un literal del servidor. Los cuerpos
# se escriben en un directorio temporal con permisos 0700 que se borra al salir,
# incluso si el script muere.
#
# Y antes del PRIMER curl se valida `MAI_BASE_URL`: este script manda un token
# de worker y, en el bloque B, una cookie de sesión. Mandarlos al host
# equivocado, o por http, los entrega. Así que el destino se declara aparte
# (`W3_EXPECTED_MAI_HOST`) y se compara, igual que la base de datos en
# `stagingGuard`.
set -uo pipefail

# ── Puerta de entorno, la misma que los scripts de TypeScript ─────────────
if [[ "${MEETINGS_ENV_KIND:-}" != "staging" ]]; then
  echo "✗ Falta MEETINGS_ENV_KIND=staging. Estos chequeos van contra un mai desplegado;" >&2
  echo "  la declaración explícita es lo que evita apuntarlos a producción por error." >&2
  exit 2
fi
for var in MAI_BASE_URL W3_CLIENT_ID W3_EXPECTED_MAI_HOST; do
  if [[ -z "${!var:-}" ]]; then echo "✗ Falta $var" >&2; exit 2; fi
done

# ── El destino, ANTES del primer curl ─────────────────────────────────────
#
# Cuatro comprobaciones, todas sobre `MAI_BASE_URL` y ninguna sobre la red:
#
#   · hostname == W3_EXPECTED_MAI_HOST — declarar el destino aparte es lo que
#     convierte «pegué la URL equivocada» en un error en vez de en una fuga;
#   · https salvo en localhost — el token viaja en cada petición, y por http lo
#     ve cualquiera en el camino. Es la misma regla que el worker aplica en
#     `app/pull/settings.py`, y por la misma razón;
#   · sin usuario ni contraseña embebidos — `https://u:p@host/` acabaría en el
#     historial del shell, en los logs del proceso y en cualquier captura;
#   · esquema http(s), no `file:` ni nada raro.
#
# Si algo falla, el mensaje nombra el problema y el hostname, NUNCA la URL
# completa: si lleva credenciales embebidas, imprimirla sería la fuga que esta
# comprobación existe para impedir.
url_check() {
  python3 - "$1" "$2" <<'PY'
import sys
from urllib.parse import urlsplit

raw, expected = sys.argv[1], sys.argv[2]
try:
    parts = urlsplit(raw)
except ValueError as error:
    print(f"MAI_BASE_URL no se puede parsear ({type(error).__name__})")
    raise SystemExit(1)

if parts.scheme not in {"http", "https"}:
    print(f"MAI_BASE_URL tiene esquema '{parts.scheme or '(ninguno)'}'; se espera http o https")
    raise SystemExit(1)

# `username`/`password` son None si no hay userinfo. No se imprimen jamás.
if parts.username or parts.password:
    print(
        "MAI_BASE_URL lleva usuario o contraseña embebidos. Quítalos: acabarían en el "
        "historial del shell y en los logs. (No se imprime la URL.)"
    )
    raise SystemExit(1)

host = (parts.hostname or "").lower()
if not host:
    print("MAI_BASE_URL no tiene host")
    raise SystemExit(1)

local = host in {"localhost", "127.0.0.1", "::1"}
if parts.scheme != "https" and not local:
    print(
        f"MAI_BASE_URL es http contra '{host}'. El token de worker viaja en cada "
        f"peticion: fuera de localhost tiene que ser https."
    )
    raise SystemExit(1)

if host != expected.strip().lower():
    print(
        f"El host de MAI_BASE_URL no es el declarado.\n"
        f"    W3_EXPECTED_MAI_HOST: {expected.strip().lower()}\n"
        f"    MAI_BASE_URL apunta a: {host}\n"
        f"    No se ha enviado ninguna peticion."
    )
    raise SystemExit(1)

print(host)
PY
}

if ! MAI_HOST="$(url_check "$MAI_BASE_URL" "$W3_EXPECTED_MAI_HOST")"; then
  echo "✗ $MAI_HOST" >&2
  exit 2
fi

BASE="${MAI_BASE_URL%/}"
ALLOW_WRITES="${W3_ALLOW_WRITES:-0}"
PASS=0; FAIL=0; SKIP=0
CREATED_MEETINGS=()

# ── Temporales: mktemp -d, 0700, y trap que limpia en cualquier salida ────
#
# Los ficheros fijos /tmp/w3* de la versión anterior eran predecibles y
# compartidos: cualquier usuario del host podía leerlos o adelantarse a
# crearlos, y quedaban ahí después. Ahí se escriben CUERPOS DE RESPUESTA, que
# en este endpoint incluyen URLs firmadas.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/w3http.XXXXXXXX")" || { echo "✗ mktemp falló" >&2; exit 1; }
chmod 700 "$WORK"
cleanup() {
  local code=$?
  rm -rf "$WORK"
  if (( ${#CREATED_MEETINGS[@]} > 0 )); then
    echo ""
    echo "── REUNIONES CREADAS por este script ──────────────────────────────────"
    for id in "${CREATED_MEETINGS[@]}"; do echo "  $id"; done
    echo "  Las retira 'npm run w3:cleanup -- --tenant-id <uuid> --execute …' (§8.2)."
    echo "  Sus objetos de R2 NO: bórralos por el prefijo t/<tenant>/ (§8.3)."
  fi
  exit $code
}
trap cleanup EXIT INT TERM

BODY="$WORK/body"

ok()   { PASS=$((PASS+1)); printf '  ✓ %-58s %s\n' "$1" "${2:-}"; }
bad()  { FAIL=$((FAIL+1)); printf '  ✗ %-58s %s\n' "$1" "${2:-}"; }
skip() { SKIP=$((SKIP+1)); printf '  · %-58s %s\n' "$1" "${2:-}"; }

# Código HTTP y `location`, SIN seguir redirecciones: seguirlas convertiría el
# 307 del middleware en el 200 de /login y el fallo se vería como un éxito raro.
probe() {
  local method="$1" path="$2"; shift 2
  curl -sS --max-time 30 -o "$BODY" -w '%{http_code}|%{redirect_url}' \
    -X "$method" "$BASE$path" "$@" 2>/dev/null || echo "000|"
}
body_code() { python3 -c "
import json,sys
try:
    print(json.load(open(sys.argv[1])).get('error',{}).get('code',''))
except Exception:
    print('')
" "$BODY" 2>/dev/null; }
body_field() { python3 -c "
import json,sys
try:
    print(json.load(open(sys.argv[1])).get(sys.argv[2],''))
except Exception:
    print('')
" "$BODY" "$1" 2>/dev/null; }

echo ""
echo "══════════════════════════════════════════════════════════════════════"
echo " BLOQUE A · enrutado — SIN CAMBIOS DE DOMINIO"
echo " host: $MAI_HOST (validado: https o local, sin userinfo, host declarado)"
echo " no crea reuniones, no reclama jobs, no cambia estados del pipeline"
echo " las llamadas AUTENTICADAS de A.2 sí actualizan worker_credentials.last_used_at"
echo "══════════════════════════════════════════════════════════════════════"

# ── A.1 · las SEIS rutas de máquina, SIN cabecera → 401, nunca 307 ───────
#
# No escriben NADA, ni telemetría: `authenticateWorker` es lo primero de cada
# handler y falla antes de que se lea el cuerpo o se toque el servicio. Y sin
# token no hay credencial que identificar, así que `touchLastUsed` tampoco
# corre — eso sólo pasa cuando la autenticación tiene ÉXITO (A.2).
echo ""
echo "── A.1 · rutas de máquina sin token: deben LLEGAR al handler ──────────"
JOB='00000000-0000-0000-0000-000000000000'
for path in \
  "/api/meetings/v1/jobs/claim" \
  "/api/meetings/v1/jobs/$JOB/heartbeat" \
  "/api/meetings/v1/jobs/$JOB/fail" \
  "/api/meetings/v1/jobs/$JOB/result/init" \
  "/api/meetings/v1/jobs/$JOB/result/complete" \
  "/api/meetings/v1/maintenance/requeue-expired"
do
  IFS='|' read -r code location _ <<<"$(probe POST "$path" -H 'content-type: application/json' -d '{}')"
  if [[ "$code" == "401" && "$(body_code)" == "unauthorized" ]]; then
    ok "${path##*/v1} → 401 unauthorized"
  elif [[ "$code" == "307" || "$code" == "302" ]]; then
    bad "${path##*/v1}" "HTTP $code → $location · B-1 SIN ARREGLAR: el worker recibiría HTML"
  else
    bad "${path##*/v1}" "HTTP $code (se esperaba 401)"
  fi
done

# ── A.2 · el token autentica y su ámbito se respeta, sin reclamar nada ───
#
# `requeueExpiredLeases` comprueba `scope === 'internal'` Y la capacidad, y
# lanza `notFound()` ANTES de cualquier lectura o escritura del dominio. Así que
# un 404 aquí prueba tres cosas de una vez: el token autentica, el middleware
# dejó pasar, y el ámbito de una credencial de tenant no alcanza el
# mantenimiento global.
#
# LO QUE SÍ ESCRIBE. Autenticar con éxito dispara `touchLastUsed()`:
#
#     UPDATE worker_credentials SET last_used_at = now() WHERE id = $1
#
# best-effort, envuelto en try/catch, y deliberado — es cómo se sabe cuándo se
# usó por última vez una credencial. Las dos llamadas de este apartado la tocan.
# No es un cambio de dominio: no crea reuniones, no reclama jobs, no mueve
# ningún estado del pipeline. Y no se desactiva: un modo de autenticación
# especial para el smoke haría que el smoke dejara de probar el camino real.
echo ""
echo "── A.2 · el token, sin reclamar trabajo ───────────────────────────────"
echo "     (autenticar con éxito actualiza worker_credentials.last_used_at)"
if [[ -z "${MAI_WORKER_TOKEN:-}" ]]; then
  skip "autenticación y ámbito del token" "sin MAI_WORKER_TOKEN"
else
  IFS='|' read -r code location _ <<<"$(probe POST /api/meetings/v1/maintenance/requeue-expired \
    -H "authorization: Bearer $MAI_WORKER_TOKEN" -H 'content-type: application/json' -d '{}')"
  case "$code" in
    404)
      ok "maintenance con credencial de tenant → 404" "autentica, y su ámbito no alcanza"
      ;;
    401)
      bad "maintenance con credencial de tenant" \
          "HTTP 401 · el token NO autentica: revisa MAI_WORKER_TOKEN o si está revocado"
      ;;
    200)
      bad "maintenance con credencial de tenant" \
          "HTTP 200 · LA CREDENCIAL TIENE ALCANCE GLOBAL. Revócala y para."
      ;;
    307|302)
      bad "maintenance con credencial de tenant" "HTTP $code → $location · B-1 sin arreglar"
      ;;
    *)
      bad "maintenance con credencial de tenant" "HTTP $code · error.code=$(body_code)"
      ;;
  esac

  # Un cuerpo con campos de más: 400 en el borde. `readValidated` corre DESPUÉS
  # de autenticar y ANTES de `claim()`, así que esto no reclama nada — es la
  # única llamada a /claim con token en todo el script, y no llega al servicio.
  IFS='|' read -r code _ _ <<<"$(probe POST /api/meetings/v1/jobs/claim \
    -H "authorization: Bearer $MAI_WORKER_TOKEN" -H 'content-type: application/json' \
    -d '{"tenantId":"11111111-1111-1111-1111-111111111111"}')"
  if [[ "$code" == "400" && "$(body_code)" == "invalid_request" ]]; then
    ok "claim con tenantId de más → 400" "rechazado antes de llegar a claim()"
  else
    bad "claim con tenantId de más" "HTTP $code $(body_code)"
  fi
fi

# ── A.3 · las CINCO de sesión, sin cookie → 307 al login ─────────────────
#
# El middleware corta antes del handler, así que tampoco mutan.
echo ""
echo "── A.3 · rutas de sesión sin cookie: deben SEGUIR rebotando ───────────"
MEET='00000000-0000-0000-0000-000000000000'
for path in \
  "/api/meetings/v1/meetings" \
  "/api/meetings/v1/meetings/$MEET/upload-init" \
  "/api/meetings/v1/meetings/$MEET/upload-complete" \
  "/api/meetings/v1/meetings/$MEET/cancel"
do
  IFS='|' read -r code location _ <<<"$(probe POST "$path" -H 'content-type: application/json' -d '{}')"
  if [[ "$code" == "307" || "$code" == "302" ]] && [[ "$location" == *"/login"* ]]; then
    ok "${path##*/v1} → $code /login"
  else
    bad "${path##*/v1}" "HTTP $code → ${location:-sin location} · el arreglo de B-1 se pasó de alcance"
  fi
done
IFS='|' read -r code location _ <<<"$(probe GET "/api/meetings/v1/meetings/$MEET?clientId=$W3_CLIENT_ID")"
if [[ "$code" == "307" || "$code" == "302" ]] && [[ "$location" == *"/login"* ]]; then
  ok "GET de estado sin cookie → $code /login"
else
  bad "GET de estado sin cookie" "HTTP $code → ${location:-sin location}"
fi

echo ""
echo "══════════════════════════════════════════════════════════════════════"
echo " BLOQUE B · sesión — MUTANTE DE DOMINIO: CREA REUNIONES"
echo "══════════════════════════════════════════════════════════════════════"

# Las TRES condiciones, comprobadas juntas y aquí.
#
# Dos de ellas ya han cortado arriba si fallaban —la puerta de entorno y la
# validación del host— así que llegar hasta aquí las implica. Se reafirman de
# todos modos: este bloque es el único que escribe en el dominio, y su
# precondición no debe depender de que nadie mueva un `exit` de las primeras
# treinta líneas. Es la comprobación que quiero que siga estando cuando alguien
# refactorice la cabecera.
MUTATING_OK=1
MUTATING_WHY=()
[[ "${MEETINGS_ENV_KIND:-}" == "staging" ]] || { MUTATING_OK=0; MUTATING_WHY+=("MEETINGS_ENV_KIND != staging"); }
[[ "${MAI_HOST:-}" == "$(echo "${W3_EXPECTED_MAI_HOST:-}" | tr '[:upper:]' '[:lower:]' | tr -d ' ')" ]]   || { MUTATING_OK=0; MUTATING_WHY+=("el host no es el declarado"); }
[[ "$ALLOW_WRITES" == "1" ]] || { MUTATING_OK=0; MUTATING_WHY+=("falta W3_ALLOW_WRITES=1"); }

if [[ "$MUTATING_OK" != "1" ]]; then
  echo ""
  echo "  OMITIDO. Este bloque crea reuniones de verdad en la base de staging."
  echo "  Le falta:"
  for why in "${MUTATING_WHY[@]}"; do echo "    · $why"; done
  echo ""
  echo "  Las tres condiciones son simultáneas:"
  echo "      MEETINGS_ENV_KIND=staging"
  echo "      W3_EXPECTED_MAI_HOST == el host de MAI_BASE_URL"
  echo "      W3_ALLOW_WRITES=1"
  echo ""
  echo "      MEETINGS_ENV_KIND=staging W3_EXPECTED_MAI_HOST=… MAI_BASE_URL=… \\"
  echo "        W3_ALLOW_WRITES=1 MAI_SESSION_COOKIE='…' npm run w3:http"
  echo ""
  echo "  Las reuniones creadas se listan al terminar y las retira w3:cleanup."
  SKIP=$((SKIP+3))
elif [[ -z "${MAI_SESSION_COOKIE:-}" ]]; then
  echo ""
  skip "rutas de sesión con cookie" "W3_ALLOW_WRITES=1 pero falta MAI_SESSION_COOKIE"
  SKIP=$((SKIP+2))
else
  echo ""
  echo "── B.1 · crear reunión por la ruta real ───────────────────────────────"
  KEY="w3-$(date +%s)-$RANDOM"
  IFS='|' read -r code _ _ <<<"$(probe POST /api/meetings/v1/meetings \
    -H "cookie: $MAI_SESSION_COOKIE" -H 'content-type: application/json' \
    -d "{\"clientId\":\"$W3_CLIENT_ID\",\"title\":\"W-3 sesión\",\"idempotencyKey\":\"$KEY\"}")"
  if [[ "$code" == "200" ]]; then
    NEW_MEETING="$(body_field meetingId)"
    [[ -n "$NEW_MEETING" ]] && CREATED_MEETINGS+=("$NEW_MEETING")
    ok "crear reunión con sesión → 200" "meetingId=${NEW_MEETING:0:8}…"

    # Idempotencia por la ruta real: la misma clave NO crea otra. Esta segunda
    # llamada es mutante en intención y no en efecto — que no cree nada es
    # exactamente lo que se comprueba.
    IFS='|' read -r code2 _ _ <<<"$(probe POST /api/meetings/v1/meetings \
      -H "cookie: $MAI_SESSION_COOKIE" -H 'content-type: application/json' \
      -d "{\"clientId\":\"$W3_CLIENT_ID\",\"title\":\"otro título\",\"idempotencyKey\":\"$KEY\"}")"
    SAME="$(body_field meetingId)"
    if [[ "$code2" == "200" && "$SAME" == "$NEW_MEETING" ]]; then
      ok "misma idempotencyKey → la MISMA reunión" "no se creó una segunda"
    else
      [[ -n "$SAME" && "$SAME" != "$NEW_MEETING" ]] && CREATED_MEETINGS+=("$SAME")
      bad "misma idempotencyKey" "HTTP $code2, id distinto: $SAME"
    fi
  else
    bad "crear reunión con sesión" "HTTP $code · error.code=$(body_code)"
  fi

  echo ""
  echo "── B.2 · validación estricta con sesión (no crea nada) ────────────────"
  # Estas dos se rechazan en el borde, así que no crean reuniones. Van en el
  # bloque B porque necesitan la cookie, no porque muten.
  IFS='|' read -r code _ _ <<<"$(probe POST /api/meetings/v1/meetings \
    -H "cookie: $MAI_SESSION_COOKIE" -H 'content-type: application/json' \
    -d "{\"clientId\":\"$W3_CLIENT_ID\",\"title\":\"x\",\"idempotencyKey\":\"k-$RANDOM\",\"tenantId\":\"11111111-1111-1111-1111-111111111111\"}")"
  if [[ "$code" == "400" && "$(body_code)" == "invalid_request" ]]; then
    ok "tenantId de más → 400 invalid_request" "el ámbito nunca se lee del cuerpo"
  else
    bad "tenantId de más" "HTTP $code $(body_code)"
  fi

  IFS='|' read -r code _ _ <<<"$(probe POST /api/meetings/v1/meetings \
    -H "cookie: $MAI_SESSION_COOKIE" -H 'content-type: application/json' \
    -d '{"clientId":"no-soy-un-uuid","title":"x","idempotencyKey":"k"}')"
  if [[ "$code" == "400" ]]; then
    ok "clientId no-uuid → 400 en el borde"
  else
    bad "clientId no-uuid" "HTTP $code (se esperaba 400)"
  fi
fi

# ── B.3 · caché de rutas, en vivo (sólo lecturas) ────────────────────────
echo ""
echo "── B.3 · la caché de rutas de Next ────────────────────────────────────"
if [[ -z "${MAI_SESSION_COOKIE:-}" || -z "${W3_MEETING_ID:-}" ]]; then
  skip "caché del GET de estado" "hacen falta MAI_SESSION_COOKIE y W3_MEETING_ID"
else
  GET_PATH="/api/meetings/v1/meetings/$W3_MEETING_ID?clientId=$W3_CLIENT_ID"
  curl -sS --max-time 30 -D "$WORK/h1" -o "$WORK/a.json" \
    -H "cookie: $MAI_SESSION_COOKIE" "$BASE$GET_PATH" >/dev/null 2>&1
  sleep 1
  curl -sS --max-time 30 -D "$WORK/h2" -o "$WORK/b.json" \
    -H "cookie: $MAI_SESSION_COOKIE" "$BASE$GET_PATH" >/dev/null 2>&1
  if grep -qi 'x-nextjs-cache: *HIT' "$WORK/h1" "$WORK/h2" 2>/dev/null; then
    bad "el GET de estado no está cacheado" "x-nextjs-cache: HIT · añade force-dynamic"
  else
    ok "el GET de estado no está cacheado" "ningún x-nextjs-cache: HIT"
  fi
  # Cuerpos idénticos NO es un fallo por sí solo: puede que nada haya cambiado
  # entre las dos lecturas. Sólo se informa.
  if cmp -s "$WORK/a.json" "$WORK/b.json"; then
    skip "cuerpos idénticos" "provoca un avance de etapa y repite para distinguir"
  else
    ok "el cuerpo refleja el estado nuevo"
  fi
fi

echo ""
if [[ "$FAIL" == "0" ]]; then
  echo "§7 VERDE — $PASS pasan, $SKIP omitidas"
  exit 0
fi
echo "§7 CON FALLOS — $PASS pasan, $FAIL fallan, $SKIP omitidas"
exit 1
