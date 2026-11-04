/**
 * PROPUESTA (no conectada a ningún workflow): la entrada de n8n que sustituye al nodo
 * «WhatsApp Trigger» cuando los mensajes llegan reenviados por MAI (/api/whatsapp/webhook).
 * Plan B de docs/ops/whatsapp-webhook-n8n-plan.md; el plan A no toca n8n.
 *
 *   Webhook «MAI WhatsApp Webhook» (POST, Raw Body)  →  Code «WhatsApp Trigger»
 *
 * El nodo Code se LLAMA «WhatsApp Trigger» a propósito: el resto del workflow lee
 * `$('WhatsApp Trigger').item.json.messages[0]…`, `.first().json.messages[0].text.body`,
 * `metadata.phone_number_id` y `contacts[0]…`; con el mismo nombre y la misma forma de salida
 * no cambia ningún otro nodo.
 *
 * Las funciones son autocontenidas para incrustarlas con toString() en el nodo Code, igual que
 * handoffContextRecovery.mjs: lo que se prueba aquí es exactamente lo que corre en n8n.
 */

/**
 * La salida del nodo WhatsApp Trigger de n8n (WhatsAppTrigger.node.ts): un item por cada
 * `entry[].changes[]`, con el `value` del cambio y el `field` añadido. Un `object` que no sea
 * whatsapp_business_account no produce items, como en el trigger.
 */
export function toTriggerItems(body) {
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return [];
  const out = [];
  for (const entry of body.entry) {
    for (const change of (entry && Array.isArray(entry.changes) ? entry.changes : [])) {
      if (change && change.value && typeof change.value === 'object') out.push({ ...change.value, field: change.field });
    }
  }
  return out;
}

/** `X-Mai-Signature: sha256=<hex HMAC-SHA256(secret, cuerpo crudo)>`, en tiempo constante. */
export function verifyMaiSignature(crypto, secret, rawBody, header) {
  if (!secret || typeof header !== 'string') return false;
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8');
  const given = Buffer.from(header.trim().toLowerCase(), 'utf8');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/**
 * El código del nodo Code «WhatsApp Trigger» (modo «Run Once for All Items»). El secreto sale de
 * una variable de n8n ($vars) si el plan las tiene; si no, se pega en la constante en la copia QA.
 */
export function buildCodeNodeSource() {
  return [
    "// Entrada desde MAI: verifica X-Mai-Signature y devuelve la MISMA forma que el WhatsApp Trigger.",
    "// Generado desde tools/n8n/whatsappWebhookEntry.mjs — no editar aquí, regenerar.",
    "const crypto = require('crypto');",
    "const SECRET = $vars.WHATSAPP_FORWARD_SECRET; // o el secreto entre comillas, solo en la copia QA",
    `const verifyMaiSignature = ${verifyMaiSignature.toString()};`,
    `const toTriggerItems = ${toTriggerItems.toString()};`,
    "const req = $input.first().json;",
    "const raw = await this.helpers.getBinaryDataBuffer(0, 'data');",
    "if (!verifyMaiSignature(crypto, SECRET, raw, req.headers['x-mai-signature'])) {",
    "  throw new Error('Firma X-Mai-Signature no válida: se ignora la petición.');",
    "}",
    "return toTriggerItems(JSON.parse(raw.toString('utf8'))).map((json) => ({ json, pairedItem: { item: 0 } }));",
  ].join('\n');
}

/** Los dos nodos (y su conexión) para pegar en la COPIA QA del workflow. Sin credenciales. */
export function buildEntryNodes({ webhookPath, position = [0, 0] }) {
  const [x, y] = position;
  return {
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: webhookPath,
          responseMode: 'onReceived',
          options: { rawBody: true },
        },
        name: 'MAI WhatsApp Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [x, y],
      },
      {
        parameters: { mode: 'runOnceForAllItems', jsCode: buildCodeNodeSource() },
        name: 'WhatsApp Trigger',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [x + 220, y],
      },
    ],
    connections: {
      'MAI WhatsApp Webhook': { main: [[{ node: 'WhatsApp Trigger', type: 'main', index: 0 }]] },
    },
  };
}
