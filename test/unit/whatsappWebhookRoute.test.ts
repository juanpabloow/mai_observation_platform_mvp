import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

/**
 * El adaptador de Next (web/app/api/whatsapp/webhook/route.ts) con las variables puestas antes
 * de cargarlo, como en Railway. La lógica está probada en whatsappWebhook.test.ts; aquí solo se
 * comprueba que la ruta lee el entorno y llega a ella. Un aviso de estado no necesita red, así
 * que nada sale del proceso. Secretos inventados, solo de esta prueba.
 */

process.env.DATABASE_URL ??= 'postgres://localhost:5432/no-se-usa'; // el logger lo exige; no conecta
process.env.META_APP_SECRET = 'app-secret-de-prueba';
process.env.META_VERIFY_TOKEN = 'verify-token-de-prueba';
process.env.WHATSAPP_FORWARD_URL = 'http://127.0.0.1:1/no-se-llama';
process.env.WHATSAPP_FORWARD_SECRET = 'forward-secret-de-prueba';

const { GET, POST } = await import('../../web/app/api/whatsapp/webhook/route.js');

test('GET de verificación por la ruta real', async () => {
  const res = GET(new Request('http://mai.test/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-token-de-prueba&hub.challenge=42'));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '42');
  const bad = GET(new Request('http://mai.test/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=42'));
  assert.equal(bad.status, 403);
});

test('POST de solo avisos por la ruta real → 200 sin reenviar', async () => {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '2' }, statuses: [{ status: 'read' }] } }] }],
  });
  const sig = `sha256=${createHmac('sha256', 'app-secret-de-prueba').update(body).digest('hex')}`;
  const res = await POST(new Request('http://mai.test/api/whatsapp/webhook', { method: 'POST', headers: { 'x-hub-signature-256': sig }, body }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, forwarded: false });
  const unsigned = await POST(new Request('http://mai.test/api/whatsapp/webhook', { method: 'POST', body }));
  assert.equal(unsigned.status, 401);
});
