# Plan del lado de n8n para el receptor de WhatsApp de MAI

> **No se aplica todavía.** Este documento explica qué haría falta en n8n. Todo se prueba en una
> **copia QA** del workflow «Gallery - Visto y escribiendo», nunca en el oficial. El cambio
> completo, con su orden y su vuelta atrás, está en [`whatsapp-webhook-filtro.md`](whatsapp-webhook-filtro.md).

## Resumen: con el plan A no hay que tocar n8n

El receptor (`/api/whatsapp/webhook`) reenvía el **cuerpo crudo byte a byte** junto con la
cabecera **`X-Hub-Signature-256` original de Meta**. El nodo «WhatsApp Trigger» solo comprueba eso:
el HMAC-SHA256 del cuerpo crudo, calculado con el App Secret de su credencial, y que
`object === "whatsapp_business_account"`. Puedes verlo en
[`WhatsAppTrigger.node.ts`](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/WhatsApp/WhatsAppTrigger.node.ts).
Si `WHATSAPP_FORWARD_URL` es la **misma URL de producción del trigger** que hoy tiene Meta, n8n
recibe exactamente lo mismo que antes, menos los avisos de estado. No cambia ningún nodo.

| Plan | Qué cambia en n8n | Cuándo |
|---|---|---|
| **A. Relevo transparente** (recomendado) | Nada | Override solo del número de Gallery (ver el documento del cambio) |
| **B. Nodo Webhook en lugar del trigger** | Se sustituye la entrada del workflow | Solo si algún día se mueve la URL de **toda** la app a MAI, y el trigger tiene que desaparecer |

El plan B queda preparado y probado (`tools/n8n/whatsappWebhookEntry.mjs` y
`test/unit/whatsappWebhookEntry.test.ts`), pero no hace falta para el primer paso.

## Qué campos del trigger usa el workflow

Revisado en `docs/handoff-contract-v1.md` (B.1, B.1a y B.2) y `tools/n8n/handoffContextRecovery.mjs`:

| Uso | Expresión |
|---|---|
| Texto del mensaje | `$('WhatsApp Trigger').item.json.messages[0].text.body` |
| Texto, en la recuperación del contexto | `$('WhatsApp Trigger').first().json.messages[0].text.body` |
| `external_message_id` (el `wamid`, deduplicación) | `$('WhatsApp Trigger').item.json.messages[0].id` |
| Identidad (ref, teléfono o BSUID) | `$json.contacts[0].wa_id`, `contacts[0].user_id`, `messages[0].from_user_id`, `messages[0].from` |
| Usuario visible de WhatsApp | `contacts[0].profile.username` |
| Número que responde (Gallery) | `metadata.phone_number_id` |
| Tipo, en «Filter messages types» | `messages[0].type` y la presencia de `statuses` |

La salida del trigger es **un item por cada `entry[].changes[]`**, con el `value` del cambio y el
`field` añadido: `{ messaging_product, metadata, contacts, messages | statuses, field }`. El plan B
tiene que producir exactamente eso, con el **mismo nombre de nodo**.

## Plan B: Webhook + Code llamado «WhatsApp Trigger»

```
MAI WhatsApp Webhook (POST, Raw Body, responde al recibir)
  → WhatsApp Trigger   ← nodo Code: verifica X-Mai-Signature y devuelve la forma del trigger
  → Filter messages types → … (sin cambios)
```

El nodo Code se llama **«WhatsApp Trigger»** a propósito. En n8n `$('WhatsApp Trigger')` busca el
nodo por su nombre, así que todas las expresiones de la tabla anterior siguen funcionando sin
editarlas. Para eso, el trigger original se **borra** de la copia; no basta con renombrarlo.

### Pasos, siempre sobre la copia QA

1. En n8n: «Gallery - Visto y escribiendo» → **Duplicate**. Llámala `QA - Gallery - entrada MAI` y
   déjala **inactiva**.
2. En la copia, **desactiva o borra los nodos que envían o escriben fuera**: los envíos de WhatsApp,
   los POST a `/api/handoff/v1/*` de producción y las escrituras en el buffer. Una ejecución QA no
   debe escribir a ningún cliente.
3. **Borra** el nodo «WhatsApp Trigger» de la copia, mientras está inactiva (ver abajo por qué).
4. Pega el JSON de abajo (Ctrl+V sobre el lienzo) y conecta «WhatsApp Trigger» (el Code) con
   «Filter messages types».
5. El secreto: si el plan de n8n tiene **Variables**, crea `WHATSAPP_FORWARD_SECRET` con el mismo
   valor que en Railway. Si no las tiene, solo en la copia QA, sustituye `$vars.WHATSAPP_FORWARD_SECRET`
   por el secreto entre comillas. Nunca lo pegues en un chat.
6. Prueba con **Listen for test event** en el Webhook y una petición firmada desde tu máquina
   (abajo). Comprueba que la salida de «WhatsApp Trigger» (Code) tiene la misma forma que una
   ejecución real del trigger: abre una ejecución de producción y compara `messages[0]`,
   `metadata.phone_number_id` y `contacts[0]`.
7. Prueba también una firma mala: el nodo Code tiene que fallar con «Firma X-Mai-Signature no válida».

### JSON para pegar

Generado con `buildEntryNodes({ webhookPath: 'mai-whatsapp-qa' })` desde
`tools/n8n/whatsappWebhookEntry.mjs`. Si cambia el módulo, regenéralo; no lo edites a mano:

```bash
node -e "import('./tools/n8n/whatsappWebhookEntry.mjs').then(m=>console.log(JSON.stringify(m.buildEntryNodes({webhookPath:'mai-whatsapp-qa'}),null,2)))"
```

```json
{
  "nodes": [
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "mai-whatsapp-qa",
        "responseMode": "onReceived",
        "options": { "rawBody": true }
      },
      "name": "MAI WhatsApp Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [-460, 300]
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "// Entrada desde MAI: verifica X-Mai-Signature y devuelve la MISMA forma que el WhatsApp Trigger.\n// Generado desde tools/n8n/whatsappWebhookEntry.mjs — no editar aquí, regenerar.\nconst crypto = require('crypto');\nconst SECRET = $vars.WHATSAPP_FORWARD_SECRET; // o el secreto entre comillas, solo en la copia QA\nconst verifyMaiSignature = function verifyMaiSignature(crypto, secret, rawBody, header) {\n  if (!secret || typeof header !== 'string') return false;\n  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8');\n  const given = Buffer.from(header.trim().toLowerCase(), 'utf8');\n  return expected.length === given.length && crypto.timingSafeEqual(expected, given);\n};\nconst toTriggerItems = function toTriggerItems(body) {\n  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return [];\n  const out = [];\n  for (const entry of body.entry) {\n    for (const change of (entry && Array.isArray(entry.changes) ? entry.changes : [])) {\n      if (change && change.value && typeof change.value === 'object') out.push({ ...change.value, field: change.field });\n    }\n  }\n  return out;\n};\nconst req = $input.first().json;\nconst raw = await this.helpers.getBinaryDataBuffer(0, 'data');\nif (!verifyMaiSignature(crypto, SECRET, raw, req.headers['x-mai-signature'])) {\n  throw new Error('Firma X-Mai-Signature no válida: se ignora la petición.');\n}\nreturn toTriggerItems(JSON.parse(raw.toString('utf8'))).map((json) => ({ json, pairedItem: { item: 0 } }));"
      },
      "name": "WhatsApp Trigger",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [-240, 300]
    }
  ],
  "connections": {
    "MAI WhatsApp Webhook": {
      "main": [[{ "node": "WhatsApp Trigger", "type": "main", "index": 0 }]]
    }
  }
}
```

Notas:
- **`rawBody: true`** hace que el Webhook guarde el cuerpo exacto en el binario `data`. Sin eso,
  n8n ya lo habría parseado y la firma no se podría comprobar.
- **`responseMode: onReceived`**: n8n responde 200 al recibir, como el trigger. MAI devuelve 502 a
  Meta, para que reintente, solo si n8n no acepta la petición.
- `require('crypto')` está permitido en el nodo Code de n8n Cloud. Compruébalo en la copia QA: si
  falla, el error aparece en el primer test.
- `pairedItem: { item: 0 }` mantiene funcionando `$('WhatsApp Trigger').item` en los nodos siguientes.

### Petición de prueba firmada (sintética)

Desde tu máquina, con el secreto en una variable de entorno local. No lo pegues en ningún chat:

```bash
BODY='{"object":"whatsapp_business_account","entry":[{"id":"100000000000001","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"570000000000","phone_number_id":"200000000000002"},"contacts":[{"profile":{"name":"Prueba QA"},"wa_id":"573000000000"}],"messages":[{"from":"573000000000","id":"wamid.QA1","timestamp":"1762000000","type":"text","text":{"body":"prueba QA"}}]}}]}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WHATSAPP_FORWARD_SECRET" -hex | sed 's/^.* //')"
curl -sS -X POST "<URL de test del nodo MAI WhatsApp Webhook>" -H 'content-type: application/json' -H "x-mai-signature: $SIG" --data-binary "$BODY"
```

## Riesgo del trigger: al desactivarse borra la suscripción de la app

El trigger registra el webhook **en la app de Meta**, no en el workflow. Lo hace con
`webhookMethods` de [`WhatsAppTrigger.node.ts`](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/WhatsApp/WhatsAppTrigger.node.ts)
y [`GenericFunctions.ts`](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/WhatsApp/GenericFunctions.ts):

- **Al activar** (`checkExists`, luego `create`): lista `GET /{app-id}/subscriptions`. Si ya hay
  una suscripción `whatsapp_business_account` con **otra** URL, **falla** con «only one trigger per
  App». Si no la hay, la crea con `POST /{app-id}/subscriptions`, usando su propia URL y su verify token.
- **Al desactivar** (`delete`): `DELETE /{app-id}/subscriptions` con `object=whatsapp_business_account`.
  **No filtra por URL**: borra la suscripción de la app **entera**, sea cual sea su URL. Entonces
  Meta deja de mandar webhooks a todo el mundo, Gallery y MAI incluidos.

Consecuencias:
1. **Nunca actives una copia QA que tenga un WhatsApp Trigger con la misma credencial.** La
   activación falla, en el mejor caso. Y si alguien desactiva después esa copia, borra la
   suscripción de producción. Por eso, en el paso 3, el trigger se borra de la copia **antes** de
   cualquier activación.
2. **No desactives el workflow oficial** mientras dure el cambio. Con el plan A, la URL de la app
   sigue siendo la del trigger y el override del número depende de que la app siga suscrita. Si se
   desactiva por error, reactivarlo vuelve a crear la suscripción con la URL de n8n, y el override
   del número no se toca.
3. **Editar y guardar el workflow oficial mientras está activo** puede volver a registrar el
   trigger: n8n lo quita y lo vuelve a poner. Habría una ventana de segundos sin suscripción. Hazlo
   en horas de poco tráfico.
4. **Plan B en producción** (mover la URL de toda la app): quitar el trigger del workflow oficial
   **borra** la suscripción. Hay que volver a suscribir la app a mano, en el panel de Meta, con la
   URL de MAI, justo después. Sin suscripción no hay a quién entregar, así que lo esperable es que
   los mensajes de esa ventana se pierdan: Meta solo documenta reintentos de entregas que fallan. Esa es la razón principal para preferir el plan A con override.

## Alternativa sin receptor: la opción del propio trigger

El trigger tiene la opción **«Receive Message Status Updates»** (`messageStatusUpdates`; por
defecto, `all`). Según el código (`filterStatuses`):

- Si la opción **se añade y se deja vacía**, descarta todos los cambios que traen `statuses`.
- Si después de filtrar no queda nada, el trigger devuelve `{}`.
- Con `{}`, n8n contesta a Meta y **no arranca ninguna ejecución**. Lo hace `webhook-helpers.ts`,
  que sale antes de `WorkflowRunner.run` cuando no hay `workflowData`.

O sea: un solo cambio en n8n quitaría los avisos de **los dos negocios** sin desplegar nada en MAI.
Pero tiene contras:
- **Toca el workflow oficial.** Esa opción no se puede probar en una copia QA, por la consecuencia
  1 de arriba.
- Guardar el cambio vuelve a registrar el trigger, como en la consecuencia 3.
- Hay que comprobar que la versión de n8n Cloud muestra la opción. Si no aparece en «Add option» del
  nodo, esa versión no la tiene.

Vale la pena valorarla con Juan Pablo antes de mover la URL en Meta. El receptor de MAI sigue
sirviendo si se quiere ver la métrica por negocio o tener la entrada bajo control propio.
