# Reservas públicas — `/book/{slug}`

La página pública para que un cliente final reserve sin cuenta: llega desde Instagram,
WhatsApp o la web del negocio, elige servicio, profesional, fecha y hora, deja sus datos
y confirma. Vive en el **mismo Web service de Railway** y usa la **misma base de datos**
que el resto de M_AI; no hay servicio, proyecto ni app aparte.

## Ruta pública y enlace por sede

| Qué | Dónde |
| --- | --- |
| Página | `GET /book/{site.slug}` → `web/app/book/[siteSlug]/page.tsx` |
| Servicios | `GET /api/booking/{slug}/services` |
| Profesionales | `GET /api/booking/{slug}/staff?service_id=` |
| Disponibilidad | `GET /api/booking/{slug}/availability?service_id=&staff_id?=&from=&to=` (máx. 14 días) |
| Crear reserva | `POST /api/booking/{slug}` (+ cabecera `Idempotency-Key`) |

El enlace de cada sede es `{origin}/book/{site.slug}`. En **Configuración de agenda →
Sedes y horarios →** (sede) **→ Enlace de reservas** se muestra ya armado con el origin
del navegador en ese momento — nunca un `localhost` ni un dominio de Railway escrito a
mano —, con *Copiar enlace*, *Abrir página* y el estado:

- **Disponible** — sede activa y módulo de agenda encendido.
- **Sede inactiva** — el enlace responde "no disponible" hasta reactivarla.
- **Agenda desactivada** — el módulo `scheduling` del cliente está apagado.

El slug es el campo **URL pública** de la sede. No se cambia solo: si alguien lo edita,
el enlace anterior deja de funcionar (la tarjeta lo advierte).

El mes del calendario se pide en tramos consecutivos de ≤14 días (el tope del endpoint),
2–3 llamadas por mes; el motor de disponibilidad no cambió.

## Qué es público y qué nunca se expone

**Público** (proyecciones en `src/db/repositories/scheduling/publicCatalog.ts` y
`web/lib/publicBookingApi.ts`):

- Sede: nombre, dirección, zona horaria, días de la semana en que cierra.
- Servicios activos en la sede: id, nombre, descripción, duración y precio efectivos,
  familia de color.
- Profesionales **activos que toman reservas** (`takes_bookings`) y prestan el servicio:
  id, nombre, su duración y precio para ese servicio.
- Horarios libres (inicio/fin) y qué profesionales públicos están libres en cada uno.
- Confirmación: referencia pública (UUID aleatorio, no el id de la fila), sede,
  dirección, servicio, profesional asignado, inicio/fin, duración, precio, zona horaria.

**Nunca**: `tenant_id`, `client_id`, id de sede o de cita, contactos, conversaciones,
otras citas, teléfonos/correos/contacto de emergencia del equipo, horarios privados del
equipo, permisos, buffers, flags internos, tokens, secretos ni variables de entorno.
Lo prueba `test/integration/publicBookingRoutes.test.ts` sobre respuestas reales.

Todas las respuestas de la API pública llevan `Cache-Control: private, no-store`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` y
`X-Robots-Tag: noindex`. Las páginas `/book/*` reciben `nosniff`, `Referrer-Policy` y
`Permissions-Policy` desde `web/next.config.ts`. **No hay CSP**: una CSP compatible con
Next y Turnstile necesita nonces y se diseña aparte.

La página es `noindex, nofollow` (se llega por enlace; indexarla solo publicaría slugs).
Open Graph básico: "Reserva en {sede}".

## Garantías de seguridad

En orden, en `POST /api/booking/{slug}`:

1. Limitador en memoria por IP (ráfagas; se mantiene igual que antes).
2. `PUBLIC_BOOKING_DISABLED` → 404.
3. **Gate** `getPublicBookingSiteBySlug`: sede activa + cliente no-default + módulo
   `scheduling` encendido. Desconocida, inactiva, default, módulo apagado o kill switch
   → **el mismo 404, byte a byte**, antes de leer el body.
4. **Rate limit persistente IP + sede** (PostgreSQL).
5. Body **estricto** (Zod `.strict()`): cualquier clave extra — `tenant_id`, `client_id`,
   `price`, `duration_min`, `status`, `origin`, `created_by_type`… — es 422. El servidor
   deriva todo eso. Consentimiento `privacy_accepted: true` obligatorio. Hora pasada → 422.
6. **Turnstile** (solo si está activado), verificado en servidor.
7. **Rate limit persistente teléfono + sede** (con el teléfono normalizado).
8. **El mismo motor** que staff y n8n (`src/scheduling/booking.ts`): revalida
   disponibilidad, exclusión GiST en PostgreSQL contra solapes, replay por
   `Idempotency-Key` (namespaced `public:{site}:{key}`), contacto por teléfono
   normalizado, snapshot de nombre/precio/duración, `origin = public`,
   `created_by_type = public`, `channel = public`. **Nunca walk-in.**
9. **Tope de citas futuras activas por teléfono y sede** (por defecto 3; `scheduled` y
   `confirmed` cuentan, `cancelled`/`completed`/`no_show` no), dentro de la transacción
   con un advisory lock por teléfono: dos peticiones simultáneas no pueden saltárselo y
   un rechazo no escribe nada (ni siquiera el contacto).

"Cualquier profesional" se envía **sin** `staff_id`: el motor asigna a quien esté libre
al confirmar.

Logs: nunca teléfono, correo, nombre ni token. Para diagnóstico se usa un hash corto de
la sede (`site`) y la referencia pública de la cita.

## Variables de entorno

Todas opcionales salvo donde se indica. Se configuran en el **mismo Web service** de
Railway (no en el worker ni en maintenance).

| Variable | Defecto | Qué hace |
| --- | --- | --- |
| `PUBLIC_BOOKING_DISABLED` | `false` | `true` → todas las páginas y endpoints públicos responden el 404 genérico. |
| `PUBLIC_BOOKING_HASH_SECRET` | `BETTER_AUTH_SECRET` | Clave HMAC (≥16 caracteres) de los buckets de rate limit. Sin ninguna de las dos, crear reservas falla cerrado (503). Recomendado: un valor propio aleatorio. |
| `PUBLIC_BOOKING_RATE_LIMIT_IP_MAX` | `10` | Intentos de reserva por IP y sede por ventana. |
| `PUBLIC_BOOKING_RATE_LIMIT_IP_WINDOW_SECONDS` | `600` | Ventana del límite por IP. |
| `PUBLIC_BOOKING_RATE_LIMIT_PHONE_MAX` | `5` | Intentos por teléfono y sede por ventana. |
| `PUBLIC_BOOKING_RATE_LIMIT_PHONE_WINDOW_SECONDS` | `3600` | Ventana del límite por teléfono. |
| `PUBLIC_BOOKING_MAX_ACTIVE_PER_PHONE` | `3` | Citas futuras activas por teléfono y sede. |
| `PUBLIC_BOOKING_TURNSTILE_ENABLED` | `false` | `true` → token de Turnstile obligatorio. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | — | Site key de Turnstile (pública). La página la lee en cada request, así que no requiere rebuild. |
| `PUBLIC_BOOKING_TURNSTILE_SECRET_KEY` | — | Secret de Turnstile (solo servidor). |
| `PUBLIC_BOOKING_PRIVACY_POLICY_URL` | — | URL absoluta `https://…` de la política de privacidad; si existe, se enlaza junto al checkbox. |

Un valor no numérico o fuera de rango cae al defecto (nunca desactiva un límite).

### Turnstile

- Con `ENABLED=true`, falta de secret o de site key → la página lo dice y el servidor
  responde 503 (falla cerrado). Token ausente o inválido → 403, sin cita.
- Verificación solo en servidor contra `siteverify`, timeout de 5 s; error de red o
  timeout → 503. Cloudflare rechaza tokens reutilizados (`timeout-or-duplicate`); el
  `Idempotency-Key` viaja como `idempotency_key` para que un reintento de red de la MISMA
  reserva no se trate como replay.
- El widget se exige con `action = public_booking`; un token de otra acción se rechaza.
- En Cloudflare, el hostname del widget debe incluir el dominio público del Web service.
- En desarrollo puede quedar desactivado.

## Migración

`migrations/1796000000000_public-booking-rate-limit.ts` crea
`public_booking_rate_buckets` (tenant, cliente, sede, alcance `ip|phone`, hash HMAC,
ventana, contador, expiración) con FK compuesta a `sites (id, tenant_id, client_id)` y
`ON DELETE CASCADE`. Solo guarda hashes. Los buckets vencidos se barren por sede, de forma
acotada, al abrirse una ventana nueva. **Reversible**: `down()` borra la tabla (solo son
contadores). Probada up → down → up sobre la base de test local.

**Debe aplicarse antes de desplegar el código**: sin la tabla, crear reservas públicas
responde 500. No se ejecutó sobre producción.

## Cómo desactivar temporalmente las reservas públicas

De más fino a más grueso:

1. Una sede: desactivarla en Configuración de agenda (sus datos quedan intactos).
2. Un cliente: apagar su módulo de agenda (afecta también a la agenda interna).
3. Todo: `PUBLIC_BOOKING_DISABLED=true` en el Web service y redeploy/restart. Las
   agendas internas y n8n siguen funcionando.

## Checklist de lanzamiento

- [ ] Aplicar la migración en la base del entorno (`npm run migrate:prod` con la URL de ese entorno).
- [ ] Definir `PUBLIC_BOOKING_HASH_SECRET` (aleatorio, ≥32 caracteres) en el Web service.
- [ ] Revisar los límites (o dejar los defectos).
- [ ] Turnstile: crear el widget en Cloudflare con el dominio público, cargar site key y secret, luego `PUBLIC_BOOKING_TURNSTILE_ENABLED=true`.
- [ ] `PUBLIC_BOOKING_PRIVACY_POLICY_URL` con la política real (si no existe todavía, decidirlo antes de abrir el enlace al público).
- [ ] Cada sede a publicar: activa, con servicios activos y profesionales con `takes_bookings`.
- [ ] Probar el enlace desde Configuración de agenda → Abrir página, en el navegador de Instagram y de WhatsApp.
- [ ] Hacer una reserva real de prueba en una sede de prueba y cancelarla desde la agenda.
- [ ] Confirmar en logs que no aparecen teléfonos, correos ni tokens.
