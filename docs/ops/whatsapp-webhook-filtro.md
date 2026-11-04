# Filtro de avisos de WhatsApp antes de n8n: el cambio

**Estado:** el código está desplegable, pero el receptor está **inactivo**. No recibe nada hasta
que se cambie la URL en Meta. Este documento describe ese cambio; nada de él se ha aplicado.

## Por qué

Medido el 3 nov en producción: el **69 % de las ejecuciones de n8n** (unas 2.900 de 4.197 en 25
días, ~6.000 al mes) son avisos de WhatsApp («enviado», «entregado», «leído»). Terminan en «Filter
messages types» sin hacer nada. El plan Pro de n8n da 10.000 ejecuciones al mes, se reinicia el día
1 y bajaría a ~1.800 al mes con el filtro. Meta no permite apagar esos avisos: llegan en el mismo
campo `messages` del webhook que los mensajes.

## Qué hay en MAI

`/api/whatsapp/webhook`, en el servicio **web**:

- **GET**: la verificación de Meta. Si `hub.mode=subscribe` y `hub.verify_token` coincide con
  `META_VERIFY_TOKEN`, devuelve `hub.challenge`. Si no, 403.
- **POST**:
  - Verifica `X-Hub-Signature-256`: HMAC-SHA256 del cuerpo crudo con `META_APP_SECRET`, comparado
    en tiempo constante. Si no es válida, 401 y no se reenvía nada.
  - Si **todos** los cambios traen solo `statuses`, responde 200 sin llamar a n8n.
  - Cualquier otra cosa se reenvía **tal cual** a `WHATSAPP_FORWARD_URL`: mensajes, mezcla de
    mensajes y avisos, errores o campos que no conoce. Va con la firma original de Meta en
    `X-Hub-Signature-256` y una firma propia, `X-Mai-Signature: sha256=<HMAC(WHATSAPP_FORWARD_SECRET, cuerpo)>`.
  - Si n8n no responde en 8 s, o responde algo que no es 2xx, devuelve **502** y Meta reintenta.
    Los reintentos traen el mismo `wamid` y el workflow ya descarta duplicados por él.
- **Sin las cuatro variables**, o con una URL que no sea https, responde **503** y no reenvía nada.
  Al arrancar escribe una línea con los **nombres** de las variables que faltan, nunca sus valores:
  `[whatsapp-webhook] deshabilitado: faltan META_APP_SECRET, …`. Configurado, escribe
  `[whatsapp-webhook] habilitado: reenvía mensajes a <host>`, solo el host.
- **Registros:** solo el tipo de evento (cuántos mensajes y avisos, `type` de cada mensaje y
  `status` de cada aviso), la cuenta de WhatsApp (`entry.id`), el `phone_number_id` y el resultado.
  **Nunca** el texto, el teléfono, el BSUID, el nombre del cliente ni la ruta de la URL de n8n.
- **Métrica:** cada registro lleva `counters` desde que arrancó el proceso: `forwarded`,
  `dropped_statuses`, `forward_failed` y `bad_signature`.

Código: `web/lib/whatsappWebhook.ts` y `web/app/api/whatsapp/webhook/route.ts`. Pruebas:
`test/unit/whatsappWebhook*.test.ts`. No hace falta ninguna migración.

## Lo que confirma la documentación de Meta: override por número o por cuenta

**Sí se puede.** Meta permite una URL alternativa («alternate callback URL») **por número** o
**por cuenta de WhatsApp (WABA)**, sin tocar la URL de la app. Lo explica la página
[Webhook overrides](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override):

- **Precedencia:** primero la URL alternativa del **número**, luego la de la **WABA** y, si no hay
  ninguna, la URL por defecto de la **app**.
- **Por número:** `POST /<PHONE_NUMBER_ID>` con
  `webhook_configuration: { override_callback_uri, verify_token }`.
- **Por WABA:** `POST /<WABA_ID>/subscribed_apps` con `override_callback_uri` y `verify_token`.
- **Requisito:** la app tiene que estar suscrita a los webhooks de esa cuenta de WhatsApp. URL de
  200 caracteres como máximo.
- **Campos cubiertos:** incluye `messages`, el único que tiene suscrito la app. **No** cubre
  plantillas (`message_template_*`) ni eventos de cuenta (`account_*`), que siguen yendo a la URL de
  la app. Hoy la app no está suscrita a ninguno de esos.
- **Consultar:** `GET /<PHONE_NUMBER_ID>?fields=webhook_configuration` devuelve la URL del
  número, la de la WABA (si tiene) y la de la app.
- **Quitar:** en el número, mandar `override_callback_uri` vacío. En la WABA, volver a llamar a
  `subscribed_apps` sin parámetros.
- Más contexto en
  [Managing webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks/).

Las peticiones a la URL alternativa siguen siendo de la **misma app**, así que vienen firmadas con
el mismo App Secret.

**Propuesta: migrar primero solo a Gallery, con override por número**, y dejar a MAI como está:

- El número de Gallery (phone_number_id `1329841990217604`) apunta a `/api/whatsapp/webhook`.
- La URL de la app sigue siendo la del trigger de n8n, así que el número de MAI (`1079483095237963`)
  no cambia.
- El receptor reenvía a la **misma URL del trigger** con la firma original de Meta, así que **n8n no
  cambia**. Es el plan A de [`whatsapp-webhook-n8n-plan.md`](whatsapp-webhook-n8n-plan.md).
- Volver atrás es una sola llamada: vaciar el override del número.

Se elige por número, y no por WABA, porque es lo más estrecho: solo afecta a ese número. Si la WABA
de Gallery (`2364116587403050`) tuviera más números, no se tocarían.

> Para tenerlo en cuenta: el propio trigger de n8n podría descartar los avisos sin este receptor,
> con la opción «Receive Message Status Updates» vacía. Ver la última sección de
> [`whatsapp-webhook-n8n-plan.md`](whatsapp-webhook-n8n-plan.md); hay que valorarla con Juan Pablo.

## Variables de Railway (servicio web)

Las pones tú directamente en Railway. **No las pegues en ningún chat ni en el repositorio.**

| Variable | Qué es | De dónde sale |
|---|---|---|
| `META_APP_SECRET` | El App Secret de «MontserratAI Demos» | Panel de Meta → la app → Configuración de la app → Básica → Clave secreta de la app |
| `META_VERIFY_TOKEN` | Cadena nueva que Meta devuelve al verificar la URL | La generas tú en tu máquina: `openssl rand -hex 32` |
| `WHATSAPP_FORWARD_URL` | Adónde reenviar los mensajes | **Plan A:** la URL de producción del nodo «WhatsApp Trigger». Es la que Meta tiene hoy en la app (panel → WhatsApp → Configuración → URL de devolución de llamada), `https://montserratai.app.n8n.cloud/webhook/<id>/webhook`. **Plan B:** la URL de producción del nodo «MAI WhatsApp Webhook». |
| `WHATSAPP_FORWARD_SECRET` | Secreto de la firma `X-Mai-Signature` | `openssl rand -hex 32`. En el plan A n8n no lo comprueba, pero el endpoint lo exige para quedar listo para el plan B |

Si quitas cualquiera de las cuatro, el endpoint vuelve a quedar deshabilitado (503) en el siguiente
despliegue.

## Orden exacto del cambio (plan A, solo Gallery)

Necesitas un token de Graph API con `whatsapp_business_management` sobre la WABA de Gallery, por
ejemplo el de un usuario del sistema del portafolio «Montserrat AI». Ponlo en una variable de tu
terminal, no en el chat:

```bash
export GRAPH_TOKEN='…'          # solo en tu terminal
export META_VERIFY_TOKEN='…'    # el mismo valor que pusiste en Railway
export MAI='https://<dominio-de-mai>'
export GALLERY_PHONE_ID=1329841990217604
```

1. **Desplegar** la rama en Railway. En los registros del servicio web debe aparecer
   `[whatsapp-webhook] deshabilitado: faltan …`. Así queda confirmado que está inactivo.
2. **Poner las cuatro variables** en Railway y dejar que redespliegue. Debe aparecer
   `[whatsapp-webhook] habilitado: reenvía mensajes a montserratai.app.n8n.cloud`.
3. **Comprobar el endpoint** sin tocar Meta:

   ```bash
   curl -s "$MAI/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=$META_VERIFY_TOKEN&hub.challenge=ok123"
   ```

   Esperado: `ok123`.

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "$MAI/api/whatsapp/webhook" -d '{}'
   ```

   Esperado: `401`.
4. **Anotar el estado actual** del número de Gallery. Sirve para comparar y para volver atrás:

   ```bash
   curl -s "https://graph.facebook.com/v25.0/$GALLERY_PHONE_ID?fields=webhook_configuration" -H "Authorization: Bearer $GRAPH_TOKEN"
   ```

   Esperado: solo `application`, con la URL de n8n.
5. **Poner el override** en el número de Gallery. Meta llama al GET de verificación en ese momento.
   En Railway debe verse `outcome: verify_ok`.

   ```bash
   curl -s -X POST "https://graph.facebook.com/v25.0/$GALLERY_PHONE_ID" \
     -H "Authorization: Bearer $GRAPH_TOKEN" -H 'content-type: application/json' \
     -d "{\"webhook_configuration\":{\"override_callback_uri\":\"$MAI/api/whatsapp/webhook\",\"verify_token\":\"$META_VERIFY_TOKEN\"}}"
   ```

   Esperado: `{"success":true}`.
6. **Confirmar:** repetir el paso 4. Ahora `phone_number` debe ser la URL de MAI, y `application`,
   la de n8n.
7. **Prueba real:** desde un teléfono del equipo, escribe a Gallery (+57 302 2275653). En Railway
   tiene que aparecer:
   - `outcome: forwarded`, con `phone_number_ids: ["1329841990217604"]` y `upstream_status: 200`;
   - en n8n, una ejecución que llega a «Delete Buffer 2»;
   - el bot contesta;
   - luego, `outcome: dropped_statuses` para los avisos de esa respuesta, sin ejecución en n8n.
8. **Vigilar una hora.** Filtra en Railway por `@event:whatsapp_webhook`. Si ves `forward_failed`,
   `bad_signature` sostenido o un mensaje sin respuesta, **vuelve atrás** (abajo).
9. **MAI**, más adelante y si todo va bien: el mismo override, con su phone_number_id
   `1079483095237963`.

## Riesgo: el WhatsApp Trigger de n8n borra la suscripción al desactivarse

El nodo «WhatsApp Trigger», al desactivarse, llama a `DELETE /{app-id}/subscriptions` con
`object=whatsapp_business_account`. Eso **no filtra por URL**: borra la suscripción de la app
entera, y Meta deja de enviar webhooks a los dos negocios. Al activarse, si la app ya tiene una
suscripción con **otra** URL, falla. El detalle y las fuentes están en
[`whatsapp-webhook-n8n-plan.md`](whatsapp-webhook-n8n-plan.md#riesgo-del-trigger-al-desactivarse-borra-la-suscripción-de-la-app).

Con el plan A esto se controla así:

- **No cambies la URL de la app** en el panel de Meta. Solo cambia el override del número. La
  suscripción de la app sigue siendo la que creó el trigger, con su URL, así que el trigger nunca
  ve una URL ajena.
- **No desactives el workflow «Gallery - Visto y escribiendo»** durante el cambio. Avisa a Juan
  Pablo antes del paso 5. Si se desactiva por error, reactívalo: el trigger vuelve a crear la
  suscripción con su URL, y el override del número sigue en su sitio. Compruébalo con el paso 4.
- **No actives copias QA con un WhatsApp Trigger** de la misma credencial.
- **Evita editar el workflow oficial** mientras dura el cambio. Al guardarlo activo, n8n puede
  volver a registrar el trigger y dejar unos segundos sin suscripción.

Si algún día se quiere mover la URL de **toda la app** a MAI, el trigger tiene que salir del
workflow (plan B), y al quitarlo se borra la suscripción. Eso exige volver a suscribir la app a mano,
de inmediato, y aceptar una ventana sin mensajes. Por eso el plan recomendado es el override.

## Volver atrás (unos 2 minutos)

Un solo paso devuelve Gallery al camino de antes: Meta, luego el trigger de n8n, sin MAI en medio.

```bash
curl -s -X POST "https://graph.facebook.com/v25.0/$GALLERY_PHONE_ID" \
  -H "Authorization: Bearer $GRAPH_TOKEN" -H 'content-type: application/json' \
  -d '{"webhook_configuration":{"override_callback_uri":""}}'
```

1. Ejecuta lo anterior. Esperado: `{"success":true}`.
2. Repite el paso 4: `phone_number` ya no debe aparecer, solo `application`, con n8n.
3. Escribe a Gallery desde un teléfono del equipo y comprueba que el bot contesta. En Railway ya no
   debe haber registros nuevos de `whatsapp_webhook`.
4. Opcional: borra `WHATSAPP_FORWARD_URL` en Railway para dejar el endpoint deshabilitado (503).
   No hace falta para volver atrás.

Mientras MAI esté caída, Meta recibe 5xx o no conecta, y reintenta. No se pierde nada hasta que
se vuelve atrás, pero las respuestas llegan tarde: por eso hay que volver atrás pronto si
`forward_failed` no baja.

## Comprobación al día siguiente

**1. Registros de Railway** (servicio web), filtrando por `@event:whatsapp_webhook`. El último
registro lleva `counters`: `dropped_statuses` debería ser de 2 a 3 veces `forwarded`, más o menos la
misma proporción que se midió. `forward_failed` y `bad_signature` deberían estar en 0 o cerca. Los
contadores se reinician en cada despliegue: mira `counters.since`.

**2. Ejecuciones de n8n** que ingiere la plataforma. Consulta de solo lectura en la consola de
Postgres de Railway. Cuenta por día las ejecuciones de producción del workflow y en qué nodo
terminan, y las separa por número cuando n8n guardó los datos de la ejecución:

```sql
-- Ejecuciones de producción de «Gallery - Visto y escribiendo» por día (hora de Bogotá):
-- cuántas acaban en «Filter messages types» (avisos y otros descartes), cuántas responden con IA
-- («Delete Buffer 2») y el total. Con el override de Gallery, filter_gallery debería caer casi a 0
-- desde el día del cambio. filter_mai sigue igual hasta que MAI tenga su override.
-- SOLO LECTURA. Lee de raw_data solo el phone_number_id del negocio, nunca datos del cliente.
WITH e AS (
  SELECT (started_at AT TIME ZONE 'America/Bogota')::date AS dia,
         coalesce(raw_data->'resultData'->>'lastNodeExecuted', '') AS ultimo_nodo,
         raw_data #>> '{resultData,runData,WhatsApp Trigger,0,data,main,0,0,json,metadata,phone_number_id}' AS phone_id
    FROM executions
   WHERE workflow_name = 'Gallery - Visto y escribiendo'
     AND mode IS DISTINCT FROM 'manual'
     AND started_at >= now() - interval '10 days'
)
SELECT dia,
       count(*)                                                                         AS total,
       count(*) FILTER (WHERE ultimo_nodo = 'Filter messages types')                    AS filter_total,
       count(*) FILTER (WHERE ultimo_nodo = 'Filter messages types' AND phone_id = '1329841990217604') AS filter_gallery,
       count(*) FILTER (WHERE ultimo_nodo = 'Filter messages types' AND phone_id = '1079483095237963') AS filter_mai,
       count(*) FILTER (WHERE ultimo_nodo = 'Filter messages types' AND phone_id IS NULL)              AS filter_sin_datos,
       count(*) FILTER (WHERE ultimo_nodo = 'Delete Buffer 2')                          AS respuestas_ia
  FROM e
 GROUP BY dia
 ORDER BY dia;
```

Cómo leerla:
- El día del cambio y los siguientes, **`filter_gallery` cae a casi 0** y **`respuestas_ia` no
  cambia**. Si `respuestas_ia` baja, se están perdiendo mensajes: vuelve atrás.
- `filter_sin_datos` cuenta las ejecuciones de las que n8n no guardó datos. No se pueden atribuir
  a un negocio, pero entran en `filter_total`.
- La ingesta va con unos minutos de retraso, así que el día en curso sale incompleto.
- La pantalla **Costos de IA → Ejecuciones** muestra lo mismo agregado, en «Dónde terminan».
