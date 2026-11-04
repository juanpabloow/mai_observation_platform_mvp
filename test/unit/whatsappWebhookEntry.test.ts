import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import { test } from 'node:test';
import { signBody } from '../../web/lib/whatsappWebhook.js';
// @ts-expect-error — plain .mjs reference module for the n8n workflow (no types).
import { buildCodeNodeSource, buildEntryNodes, toTriggerItems, verifyMaiSignature } from '../../tools/n8n/whatsappWebhookEntry.mjs';

/**
 * PROPUESTA (tools/n8n/whatsappWebhookEntry.mjs, no conectada): la entrada de n8n que recibe lo
 * que reenvía MAI. Tiene que dar la MISMA salida que el nodo WhatsApp Trigger para que ningún
 * otro nodo cambie, y aceptar solo la firma que pone MAI (web/lib/whatsappWebhook.ts).
 * Cargas sintéticas.
 */

const SECRET = 'forward-secret-de-prueba';
const change = (value: object) => ({ field: 'messages', value });
const msgValue = {
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: '570000000000', phone_number_id: '200000000000002' },
  contacts: [{ profile: { name: 'Cliente Prueba' }, wa_id: '573000000000' }],
  messages: [{ from: '573000000000', id: 'wamid.PRUEBA1', timestamp: '1762000000', type: 'text', text: { body: 'hola' } }],
};
const { messages: _omit, contacts: _omit2, ...statusBase } = msgValue;
const body = {
  object: 'whatsapp_business_account',
  entry: [{ id: '100000000000001', changes: [change(msgValue), change({ ...statusBase, statuses: [{ status: 'read' }] })] }],
};

/** Lo que hace el trigger de n8n: `.map((change) => ({ ...change.value, field: change.field }))`. */
const triggerReference = (b: typeof body) => b.entry.flatMap((e) => e.changes).map((c) => ({ ...c.value, field: c.field }));

test('toTriggerItems da la misma salida que el WhatsApp Trigger', () => {
  assert.deepEqual(toTriggerItems(body), triggerReference(body));
  const [first] = toTriggerItems(body);
  // Los caminos que usa el workflow, intactos.
  assert.equal(first.messages[0].text.body, 'hola');
  assert.equal(first.messages[0].id, 'wamid.PRUEBA1');
  assert.equal(first.metadata.phone_number_id, '200000000000002');
  assert.equal(first.contacts[0].wa_id, '573000000000');
  assert.equal(first.field, 'messages');
});

test('toTriggerItems ignora lo que el trigger ignora', () => {
  for (const b of [null, {}, { object: 'page', entry: body.entry }, { object: 'whatsapp_business_account' }]) {
    assert.deepEqual(toTriggerItems(b), []);
  }
});

test('verifyMaiSignature acepta la firma que pone MAI y nada más', () => {
  const raw = Buffer.from(JSON.stringify(body));
  assert.equal(verifyMaiSignature(crypto, SECRET, raw, signBody(SECRET, raw)), true);
  assert.equal(verifyMaiSignature(crypto, SECRET, raw, signBody('otro', raw)), false);
  assert.equal(verifyMaiSignature(crypto, SECRET, Buffer.from(raw.toString() + ' '), signBody(SECRET, raw)), false);
  assert.equal(verifyMaiSignature(crypto, SECRET, raw, undefined), false);
  assert.equal(verifyMaiSignature(crypto, '', raw, signBody('', raw)), false, 'sin secreto no se acepta nada');
});

test('el código del nodo Code corre como en n8n y devuelve items emparejados', async () => {
  const raw = Buffer.from(JSON.stringify(body));
  const run = (header: string | undefined) => {
    // Lo que n8n pone a disposición del nodo Code: require, $vars, $input y this.helpers.
    const fn = new Function('require', '$vars', '$input', `return (async function () {\n${buildCodeNodeSource()}\n}).call(this);`);
    const ctx = { helpers: { getBinaryDataBuffer: async (i: number, prop: string) => (i === 0 && prop === 'data' ? raw : Buffer.alloc(0)) } };
    return fn.call(ctx, (m: string) => (m === 'crypto' ? crypto : undefined), { WHATSAPP_FORWARD_SECRET: SECRET }, {
      first: () => ({ json: { headers: header ? { 'x-mai-signature': header } : {} } }),
    });
  };
  const items = await run(signBody(SECRET, raw));
  assert.deepEqual(items.map((i: { json: unknown }) => i.json), triggerReference(body));
  assert.deepEqual(items[0].pairedItem, { item: 0 });
  await assert.rejects(run(signBody('otro', raw)), /X-Mai-Signature/);
  await assert.rejects(run(undefined), /X-Mai-Signature/);
});

test('buildEntryNodes: el nodo Code se llama «WhatsApp Trigger» y el Webhook recibe el cuerpo crudo', () => {
  const { nodes, connections } = buildEntryNodes({ webhookPath: 'mai-whatsapp-qa' });
  const [hook, code] = nodes;
  assert.equal(code.name, 'WhatsApp Trigger');
  assert.equal(hook.parameters.options.rawBody, true);
  assert.equal(hook.parameters.responseMode, 'onReceived');
  assert.equal(connections['MAI WhatsApp Webhook'].main[0][0].node, 'WhatsApp Trigger');
  assert.equal(JSON.stringify(nodes).includes(SECRET), false, 'el JSON no lleva secretos');
});
