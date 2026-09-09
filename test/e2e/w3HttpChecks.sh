#!/usr/bin/env bash
#
# §7 del runbook de W-3: middleware, sesión y caché contra un mai REAL.
#
#   MEETINGS_ENV_KIND=staging \
#   MAI_BASE_URL=https://… \
#   MAI_WORKER_TOKEN=… \
#   MAI_SESSION_COOKIE='better-auth.session_token=…' \
#   W3_CLIENT_ID=<uuid> [W3_MEETING_ID=<uuid>] \
#     bash test/e2e/w3HttpChecks.sh
#
# Es lo único que cubre el enrutado, el middleware y la caché de Next: las 26
# pruebas de Route Handler IMPORTAN el handler, así que nada de eso participa en
# ellas. Fue exactamente el hueco por el que se colaron las seis rutas de
# máquina rebotando a /login (B-1).
#
# ── Sobre secretos ─────────────────────────────────────────────────────────
#
# El token y la cookie se leen del entorno y NUNCA se imprimen. Lo que se
# imprime es el código HTTP y, cuando hace falta, el campo `error.code` del
# cuerpo — que es un literal del servidor. Las URLs firmadas no se piden aquí;
# si alguna llegara en un cuerpo, no se vuelca.
#
# Este script NO escribe en la base y NO sube objetos. Los pasos que crean cosas
# van por el seed (§4) y por el recorrido (§5).
set -uo pipefail

# ── Puerta de entorno, la misma que los scripts de TypeScript ─────────────
if [[ "${MEETINGS_ENV_KIND:-}" != "staging" ]]; then
  echo "✗ Falta MEETINGS_ENV_KIND=staging. Estos chequeos van contra un mai desplegado;" >&2
  echo "  la declaración explícita es lo que evita apuntarlos a producción por error." >&2
  exit 2
fi
for var in MAI_BASE_URL W3_CLIENT_ID; do
  if [[ -z "${!var:-}" ]]; then echo "✗ Falta $var" >&2; exit 2; fi
done

BASE="${MAI_BASE_URL%/}"
PASS=0; FAIL=0; SKIP=0

ok()   { PASS=$((PASS+1)); printf '  ✓ %-58s %s\n' "$1" "${2:-}"; }
bad()  { FAIL=$((FAIL+1)); printf '  ✗ %-58s %s\n' "$1" "${2:-}"; }
skip() { SKIP=$((SKIP+1)); printf '  · %-58s %s\n' "$1" "${2:-}"; }

# Código HTTP y cuerpo, SIN seguir redirecciones: seguirlas convertiría el 307
# del middleware en el 200 de /login y el fallo se vería como un éxito raro.
# Devuelve "<code>|<location>|<body>".
probe() {
  local method="$1" path="$2"; shift 2
  curl -sS --max-time 30 -o /tmp/w3body -w '%{http_code}|%{redirect_url}' \
    -X "$method" "$BASE$path" "$@" 2>/dev/null || echo "000|"
}
body_code() { python3 -c "
import json,sys
try:
    print(json.load(open('/tmp/w3body')).get('error',{}).get('code',''))
except Exception:
    print('')
" 2>/dev/null; }

echo
echo "§7 · mai en modo producción — $BASE"
echo

# ── 7.2 (a) · las SEIS rutas de máquina, sin cabecera → 401, nunca 307 ────
echo "── 7.2a · rutas de máquina sin token: deben LLEGAR al handler ──────────"
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
    ok "${path##*/v1} → 401 unauthorized" ""
  elif [[ "$code" == "307" || "$code" == "302" ]]; then
    bad "${path##*/v1}" "HTTP $code → $location · B-1 SIN ARREGLAR: el worker recibiría HTML"
  else
    bad "${path##*/v1}" "HTTP $code (se esperaba 401)"
  fi
done

# ── 7.2 (b) · con token válido → 200 o 204, nunca 307 ────────────────────
echo
echo "── 7.2b · claim con token: el camino real del worker ──────────────────"
if [[ -z "${MAI_WORKER_TOKEN:-}" ]]; then
  skip "claim con token" "sin MAI_WORKER_TOKEN"
else
  IFS='|' read -r code location _ <<<"$(probe POST /api/meetings/v1/jobs/claim \
    -H "authorization: Bearer $MAI_WORKER_TOKEN" -H 'content-type: application/json' -d '{}')"
  case "$code" in
    200) ok "claim → 200 con trabajo" "";;
    204) ok "claim → 204 sin trabajo (cola vacía)" "";;
    307|302) bad "claim con token" "HTTP $code → $location · B-1 sin arreglar";;
    *) bad "claim con token" "HTTP $code · error.code=$(body_code)";;
  esac

  # La negativa del §4.3: una credencial single_tenant NO puede barrer.
  IFS='|' read -r code _ _ <<<"$(probe POST /api/meetings/v1/maintenance/requeue-expired \
    -H "authorization: Bearer $MAI_WORKER_TOKEN" -H 'content-type: application/json' -d '{}')"
  if [[ "$code" == "404" ]]; then
    ok "mantenimiento con credencial de tenant → 404" ""
  else
    bad "mantenimiento con credencial de tenant" "HTTP $code · DEBE ser 404; revoca la credencial"
  fi

  # Un cuerpo con campos de más se rechaza en el borde.
  IFS='|' read -r code _ _ <<<"$(probe POST /api/meetings/v1/jobs/claim \
    -H "authorization: Bearer $MAI_WORKER_TOKEN" -H 'content-type: application/json' \
    -d '{"tenantId":"11111111-1111-1111-1111-111111111111"}')"
  if [[ "$code" == "400" && "$(body_code)" == "invalid_request" ]]; then
    ok "claim con tenantId de más → 400 invalid_request" "el ámbito nunca se lee del cuerpo"
  else
    bad "claim con tenantId de más" "HTTP $code $(body_code)"
  fi
fi

# ── 7.2 (c) · las CINCO de sesión, sin cookie → 307 al login ─────────────
echo
echo "── 7.2c · rutas de sesión sin cookie: deben SEGUIR rebotando ──────────"
MEET='00000000-0000-0000-0000-000000000000'
for path in \
  "/api/meetings/v1/meetings" \
  "/api/meetings/v1/meetings/$MEET/upload-init" \
  "/api/meetings/v1/meetings/$MEET/upload-complete" \
  "/api/meetings/v1/meetings/$MEET/cancel"
do
  IFS='|' read -r code location _ <<<"$(probe POST "$path" -H 'content-type: application/json' -d '{}')"
  if [[ "$code" == "307" || "$code" == "302" ]] && [[ "$location" == *"/login"* ]]; then
    ok "${path##*/v1} → $code /login" ""
  else
    bad "${path##*/v1}" "HTTP $code → ${location:-sin location} · el arreglo de B-1 se pasó de alcance"
  fi
done
IFS='|' read -r code location _ <<<"$(probe GET "/api/meetings/v1/meetings/$MEET?clientId=$W3_CLIENT_ID")"
if [[ "$code" == "307" || "$code" == "302" ]] && [[ "$location" == *"/login"* ]]; then
  ok "GET de estado sin cookie → $code /login" ""
else
  bad "GET de estado sin cookie" "HTTP $code → ${location:-sin location}"
fi

# ── 7.4 · sesión real ────────────────────────────────────────────────────
echo
echo "── 7.4 · con cookie de sesión real ────────────────────────────────────"
if [[ -z "${MAI_SESSION_COOKIE:-}" ]]; then
  skip "rutas de sesión con cookie" "sin MAI_SESSION_COOKIE (extráela de tu navegador)"
  skip "validación estricta con sesión" ""
else
  KEY="w3-$(date +%s)-$RANDOM"
  IFS='|' read -r code _ _ <<<"$(probe POST /api/meetings/v1/meetings \
    -H "cookie: $MAI_SESSION_COOKIE" -H 'content-type: application/json' \
    -d "{\"clientId\":\"$W3_CLIENT_ID\",\"title\":\"W-3 sesión\",\"idempotencyKey\":\"$KEY\"}")"
  if [[ "$code" == "200" ]]; then
    NEW_MEETING="$(python3 -c "import json;print(json.load(open('/tmp/w3body')).get('meetingId',''))" 2>/dev/null)"
    ok "crear reunión con sesión → 200" "meetingId=${NEW_MEETING:0:8}…"

    # Idempotencia por la ruta real: la misma clave no crea otra.
    IFS='|' read -r code2 _ _ <<<"$(probe POST /api/meetings/v1/meetings \
      -H "cookie: $MAI_SESSION_COOKIE" -H 'content-type: application/json' \
      -d "{\"clientId\":\"$W3_CLIENT_ID\",\"title\":\"otro título\",\"idempotencyKey\":\"$KEY\"}")"
    SAME="$(python3 -c "import json;print(json.load(open('/tmp/w3body')).get('meetingId',''))" 2>/dev/null)"
    if [[ "$code2" == "200" && "$SAME" == "$NEW_MEETING" ]]; then
      ok "misma idempotencyKey → la MISMA reunión" ""
    else
      bad "misma idempotencyKey" "HTTP $code2, id distinto"
    fi
  else
    bad "crear reunión con sesión" "HTTP $code · error.code=$(body_code)"
  fi

  # Validación estricta por HTTP real: el ámbito no se lee del cuerpo.
  IFS='|' read -r code _ _ <<<"$(probe POST /api/meetings/v1/meetings \
    -H "cookie: $MAI_SESSION_COOKIE" -H 'content-type: application/json' \
    -d "{\"clientId\":\"$W3_CLIENT_ID\",\"title\":\"x\",\"idempotencyKey\":\"k-$RANDOM\",\"tenantId\":\"11111111-1111-1111-1111-111111111111\"}")"
  if [[ "$code" == "400" && "$(body_code)" == "invalid_request" ]]; then
    ok "tenantId de más → 400 invalid_request" ""
  else
    bad "tenantId de más" "HTTP $code $(body_code)"
  fi

  # Un clientId que no es uuid: 404, y ANTES de tocar la sesión.
  IFS='|' read -r code _ _ <<<"$(probe POST /api/meetings/v1/meetings \
    -H "cookie: $MAI_SESSION_COOKIE" -H 'content-type: application/json' \
    -d '{"clientId":"no-soy-un-uuid","title":"x","idempotencyKey":"k"}')"
  if [[ "$code" == "400" ]]; then
    ok "clientId no-uuid → 400 en el borde" ""
  else
    bad "clientId no-uuid" "HTTP $code (se esperaba 400)"
  fi
fi

# ── 7.3 · caché de rutas, en vivo ────────────────────────────────────────
echo
echo "── 7.3 · la caché de rutas de Next ────────────────────────────────────"
if [[ -z "${MAI_SESSION_COOKIE:-}" || -z "${W3_MEETING_ID:-}" ]]; then
  skip "caché del GET de estado" "hacen falta MAI_SESSION_COOKIE y W3_MEETING_ID"
else
  GET_PATH="/api/meetings/v1/meetings/$W3_MEETING_ID?clientId=$W3_CLIENT_ID"
  curl -sS --max-time 30 -D /tmp/w3h1 -o /tmp/w3a.json \
    -H "cookie: $MAI_SESSION_COOKIE" "$BASE$GET_PATH" >/dev/null 2>&1
  sleep 1
  curl -sS --max-time 30 -D /tmp/w3h2 -o /tmp/w3b.json \
    -H "cookie: $MAI_SESSION_COOKIE" "$BASE$GET_PATH" >/dev/null 2>&1
  if grep -qi 'x-nextjs-cache: *HIT' /tmp/w3h1 /tmp/w3h2; then
    bad "el GET de estado no está cacheado" "x-nextjs-cache: HIT · añade force-dynamic"
  else
    ok "el GET de estado no está cacheado" "ningún x-nextjs-cache: HIT"
  fi
  # El build ya clasifica las once rutas como ƒ (Dynamic); esto lo confirma en
  # vivo. Si los dos cuerpos son idénticos NO es un fallo por sí solo —puede que
  # nada haya cambiado entre las dos lecturas— así que sólo se informa.
  if cmp -s /tmp/w3a.json /tmp/w3b.json; then
    printf '  · %-58s %s\n' "cuerpos idénticos" "provoca un avance de etapa y repite para distinguir"
    SKIP=$((SKIP+1))
  else
    ok "el cuerpo refleja el estado nuevo" ""
  fi
fi

rm -f /tmp/w3body /tmp/w3a.json /tmp/w3b.json /tmp/w3h1 /tmp/w3h2

echo
if [[ "$FAIL" == "0" ]]; then
  echo "§7 VERDE — $PASS pasan, $SKIP omitidas"
  exit 0
fi
echo "§7 CON FALLOS — $PASS pasan, $FAIL fallan, $SKIP omitidas"
exit 1
