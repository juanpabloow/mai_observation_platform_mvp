import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import {
  describeConfig,
  handleEvent,
  handleVerify,
  readWebhookConfig,
  summarizePayload,
  WebhookCounters,
  type WebhookDeps,
  type WebhookLogEntry,
} from '../../web/lib/whatsappWebhook.js';

/**
 * Receptor del webhook de WhatsApp (web/lib/whatsappWebhook.ts) con cargas SINTÉTICAS firmadas
 * en la prueba: nada aquí llama a Meta ni a n8n. El «n8n» es un servidor HTTP local que guarda
 * lo que recibe, así se comprueba el reenvío de verdad (bytes, cabeceras, caída, timeout).
 *
 * Los ids, teléfonos y textos son inventados. Los secretos también: solo existen en esta prueba.
 */

const APP_SECRET = 'app-secret-de-prueba';
const VERIFY_TOKEN = 'verify-token-de-prueba';
const FORWARD_SECRET = 'forward-secret-de-prueba';
const WABA = '100000000000001';
const PHONE_ID = '200000000000002';
const CUSTOMER_PHONE = '573000000000';
const CUSTOMER_TEXT = 'hola, quiero una cita secreta';

const hmac = (secret: string, body: string | Buffer) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const value = (extra: Record<string, unknown>) => ({
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: '570000000000', phone_number_id: PHONE_ID },
  ...extra,
});
const messageValue = () =>
  value({
    contacts: [{ profile: { name: 'Cliente Prueba' }, wa_id: CUSTOMER_PHONE }],
    messages: [{ from: CUSTOMER_PHONE, id: 'wamid.PRUEBA1', timestamp: '1762000000', type: 'text', text: { body: CUSTOMER_TEXT } }],
  });
const statusValue = (status = 'delivered') =>
  value({ statuses: [{ id: 'wamid.PRUEBA2', status, timestamp: '1762000001', recipient_id: CUSTOMER_PHONE }] });
const payload = (...values: object[]) =>
  JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: values.map((v) => ({ field: 'messages', value: v })) }] });

// ── «n8n» local ─────────────────────────────────────────────────────────────

type Received = { body: Buffer; headers: IncomingMessage['headers'] };
let received: Received[] = [];
let upstreamStatus = 200;
let upstreamDelayMs = 0;
let server: Server;
let upstreamUrl = '';

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ body: Buffer.concat(chunks), headers: req.headers });
      setTimeout(() => {
        res.statusCode = upstreamStatus;
        res.end('{"message":"Workflow was started"}');
      }, upstreamDelayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook/abc123/webhook`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

function makeDeps(env: Record<string, string | undefined> = {}, timeoutMs?: number) {
  received = [];
  upstreamStatus = 200;
  upstreamDelayMs = 0;
  const logs: Array<{ level: string; entry: WebhookLogEntry }> = [];
  const deps: WebhookDeps = {
    config: readWebhookConfig({
      META_APP_SECRET: APP_SECRET,
      META_VERIFY_TOKEN: VERIFY_TOKEN,
      WHATSAPP_FORWARD_URL: upstreamUrl,
      WHATSAPP_FORWARD_SECRET: FORWARD_SECRET,
      ...env,
    }),
    fetch: (...a) => fetch(...a),
    log: (level, entry) => logs.push({ level, entry }),
    counters: new WebhookCounters(),
    timeoutMs,
  };
  return { deps, logs };
}

const post = (body: string, signature: string | null = hmac(APP_SECRET, body)) =>
  new Request('http://mai.test/api/whatsapp/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) },
    body,
  });

/** Ningún registro lleva el texto, el teléfono ni el nombre del cliente, ni la ruta de n8n. */
function assertNoPii(logs: Array<{ entry: WebhookLogEntry }>) {
  const text = JSON.stringify(logs);
  for (const secret of [CUSTOMER_PHONE, CUSTOMER_TEXT, 'Cliente Prueba', 'abc123', APP_SECRET, FORWARD_SECRET, VERIFY_TOKEN]) {
    assert.equal(text.includes(secret), false, `los registros no deben contener ${secret}`);
  }
}

// ── GET: verificación de Meta ───────────────────────────────────────────────

test('GET con hub.mode=subscribe y el verify token correcto devuelve el challenge', async () => {
  const { deps, logs } = makeDeps();
  const res = handleVerify(new URL(`http://mai.test/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`), deps);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '1158201444');
  assert.equal(deps.counters.verify_ok, 1);
  assertNoPii(logs);
});

test('GET con verify token equivocado, sin modo o sin challenge → 403', async () => {
  const { deps } = makeDeps();
  for (const qs of [
    'hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1',
    'hub.mode=unsubscribe&hub.verify_token=' + VERIFY_TOKEN + '&hub.challenge=1',
    'hub.mode=subscribe&hub.verify_token=' + VERIFY_TOKEN,
    '',
  ]) {
    const res = handleVerify(new URL(`http://mai.test/api/whatsapp/webhook?${qs}`), deps);
    assert.equal(res.status, 403, qs);
  }
  assert.equal(deps.counters.verify_rejected, 4);
});

// ── POST: firma ─────────────────────────────────────────────────────────────

test('POST con firma inválida, de otro secreto o ausente → 401 y nada se reenvía', async () => {
  const { deps, logs } = makeDeps();
  const body = payload(messageValue());
  for (const sig of [hmac('otro-secreto', body), 'sha256=00', 'sha1=abc', null, hmac(APP_SECRET, body + ' ')]) {
    const res = await handleEvent(post(body, sig), deps);
    assert.equal(res.status, 401, String(sig));
  }
  assert.equal(received.length, 0);
  assert.equal(deps.counters.bad_signature, 5);
  assertNoPii(logs);
});

test('la firma se calcula sobre el cuerpo CRUDO: el mismo JSON re-serializado no vale', async () => {
  const { deps } = makeDeps();
  const pretty = JSON.stringify(JSON.parse(payload(messageValue())), null, 2);
  const res = await handleEvent(post(pretty, hmac(APP_SECRET, payload(messageValue()))), deps);
  assert.equal(res.status, 401);
  assert.equal(received.length, 0);
});

test('acepta la firma con el hex en mayúsculas (Meta usa minúsculas, pero no es motivo de 401)', async () => {
  const { deps } = makeDeps();
  const body = payload(messageValue());
  const res = await handleEvent(post(body, hmac(APP_SECRET, body).toUpperCase().replace('SHA256=', 'sha256=')), deps);
  assert.equal(res.status, 200);
  assert.equal(received.length, 1);
});

// ── POST: separar contenido ─────────────────────────────────────────────────

test('solo avisos de estado → 200 sin llamar a n8n, y cuenta el descarte', async () => {
  const { deps, logs } = makeDeps();
  for (const st of ['sent', 'delivered', 'read']) {
    const res = await handleEvent(post(payload(statusValue(st))), deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, forwarded: false });
  }
  // Varios cambios de avisos en un mismo POST, también.
  const res = await handleEvent(post(payload(statusValue('sent'), statusValue('read'))), deps);
  assert.equal(res.status, 200);
  assert.equal(received.length, 0);
  assert.equal(deps.counters.dropped_statuses, 4);
  assert.equal(deps.counters.forwarded, 0);
  const last = logs.at(-1)!.entry;
  assert.equal(last.outcome, 'dropped_statuses');
  assert.deepEqual(last.status_values, { sent: 1, read: 1 });
  assert.deepEqual(last.waba_ids, [WABA]);
  assert.deepEqual(last.phone_number_ids, [PHONE_ID]);
  assertNoPii(logs);
});

test('solo mensajes → se reenvía el cuerpo byte a byte con la firma de Meta y la propia', async () => {
  const { deps, logs } = makeDeps();
  const body = payload(messageValue());
  const res = await handleEvent(post(body), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, forwarded: true });
  assert.equal(received.length, 1);
  const got = received[0];
  assert.equal(got.body.toString('utf8'), body, 'cuerpo idéntico');
  assert.equal(got.headers['x-hub-signature-256'], hmac(APP_SECRET, body), 'firma original de Meta (la que comprueba el WhatsApp Trigger)');
  assert.equal(got.headers['x-mai-signature'], hmac(FORWARD_SECRET, body), 'firma propia');
  assert.equal(got.headers['content-type'], 'application/json');
  assert.equal(deps.counters.forwarded, 1);
  const entry = logs.at(-1)!.entry;
  assert.equal(entry.outcome, 'forwarded');
  assert.deepEqual(entry.message_types, { text: 1 });
  assert.equal(entry.forward_host, new URL(upstreamUrl).host);
  assert.equal(entry.upstream_status, 200);
  assertNoPii(logs);
});

test('mezcla de mensajes y avisos en un mismo POST → se reenvía entero', async () => {
  const { deps } = makeDeps();
  const body = payload(statusValue('read'), messageValue());
  const res = await handleEvent(post(body), deps);
  assert.equal(res.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].body.toString('utf8'), body);
  assert.equal(deps.counters.forwarded, 1);
  assert.equal(deps.counters.dropped_statuses, 0);
});

test('un mismo value con messages y statuses también se reenvía', async () => {
  const { deps } = makeDeps();
  const v = { ...messageValue(), statuses: statusValue().statuses };
  const res = await handleEvent(post(payload(v)), deps);
  assert.equal(res.status, 200);
  assert.equal(received.length, 1);
});

test('lo que no es ni mensaje ni aviso (errores, campos nuevos) se reenvía, como antes', async () => {
  const { deps } = makeDeps();
  const errorsOnly = value({ errors: [{ code: 131000, title: 'Something went wrong' }] });
  const res = await handleEvent(post(payload(statusValue(), errorsOnly)), deps);
  assert.equal(res.status, 200);
  assert.equal(received.length, 1);
});

test('JSON roto con firma válida → 400, nada se reenvía', async () => {
  const { deps } = makeDeps();
  const res = await handleEvent(post('{"object":'), deps);
  assert.equal(res.status, 400);
  assert.equal(received.length, 0);
});

// ── POST: n8n caído ─────────────────────────────────────────────────────────

test('n8n responde 5xx o 4xx → 502 para que Meta reintente', async () => {
  for (const status of [500, 503, 404]) {
    const { deps, logs } = makeDeps();
    upstreamStatus = status;
    const res = await handleEvent(post(payload(messageValue())), deps);
    assert.equal(res.status, 502, String(status));
    assert.equal(deps.counters.forward_failed, 1);
    assert.equal(logs.at(-1)!.entry.upstream_status, status);
    assertNoPii(logs);
  }
});

test('n8n no contesta a tiempo → 502 con error timeout', async () => {
  const { deps, logs } = makeDeps({}, 100);
  upstreamDelayMs = 1000;
  const res = await handleEvent(post(payload(messageValue())), deps);
  assert.equal(res.status, 502);
  assert.equal(logs.at(-1)!.entry.error, 'timeout');
});

test('n8n inalcanzable (conexión rechazada) → 502', async () => {
  const { deps, logs } = makeDeps({ WHATSAPP_FORWARD_URL: 'http://127.0.0.1:1/webhook' });
  const res = await handleEvent(post(payload(messageValue())), deps);
  assert.equal(res.status, 502);
  assert.equal(deps.counters.forward_failed, 1);
  assert.equal(logs.at(-1)!.entry.outcome, 'forward_failed');
});

test('una redirección de n8n no se sigue: cuenta como fallo', async () => {
  const { deps } = makeDeps();
  upstreamStatus = 302;
  const res = await handleEvent(post(payload(messageValue())), deps);
  assert.equal(res.status, 502);
});

// ── Configuración ───────────────────────────────────────────────────────────

test('sin variables el endpoint queda deshabilitado: 503 en GET y POST, sin reenviar', async () => {
  const { deps } = makeDeps({ META_APP_SECRET: undefined, WHATSAPP_FORWARD_SECRET: '  ' });
  assert.equal(deps.config.enabled, false);
  const g = handleVerify(new URL(`http://mai.test/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`), deps);
  assert.equal(g.status, 503);
  const p = await handleEvent(post(payload(messageValue())), deps);
  assert.equal(p.status, 503);
  const text = JSON.stringify(await p.json());
  assert.equal(text.includes('META_APP_SECRET'), false, 'la respuesta pública no nombra variables');
  assert.equal(received.length, 0);
});

test('describeConfig nombra las variables que faltan y el host, nunca los valores', () => {
  const off = describeConfig(readWebhookConfig({ META_VERIFY_TOKEN: VERIFY_TOKEN, WHATSAPP_FORWARD_URL: upstreamUrl }));
  assert.match(off, /deshabilitado/);
  assert.match(off, /META_APP_SECRET/);
  assert.match(off, /WHATSAPP_FORWARD_SECRET/);
  assert.equal(off.includes(VERIFY_TOKEN), false);
  const on = describeConfig(
    readWebhookConfig({
      META_APP_SECRET: APP_SECRET,
      META_VERIFY_TOKEN: VERIFY_TOKEN,
      WHATSAPP_FORWARD_URL: 'https://example.app.n8n.cloud/webhook/abc123/webhook',
      WHATSAPP_FORWARD_SECRET: FORWARD_SECRET,
    }),
  );
  assert.equal(on, '[whatsapp-webhook] habilitado: reenvía mensajes a example.app.n8n.cloud');
  for (const s of [APP_SECRET, VERIFY_TOKEN, FORWARD_SECRET, 'abc123']) assert.equal(on.includes(s), false);
});

test('la URL de reenvío debe ser https (http solo en localhost)', () => {
  const base = { META_APP_SECRET: 'a', META_VERIFY_TOKEN: 'b', WHATSAPP_FORWARD_SECRET: 'c' };
  assert.equal(readWebhookConfig({ ...base, WHATSAPP_FORWARD_URL: 'http://n8n.example.com/x' }).enabled, false);
  assert.equal(readWebhookConfig({ ...base, WHATSAPP_FORWARD_URL: 'no es una url' }).enabled, false);
  assert.equal(readWebhookConfig({ ...base, WHATSAPP_FORWARD_URL: 'https://n8n.example.com/x' }).enabled, true);
  assert.equal(readWebhookConfig({ ...base, WHATSAPP_FORWARD_URL: 'http://localhost:5678/x' }).enabled, true);
});

test('summarizePayload tolera cuerpos raros sin lanzar', () => {
  for (const b of [null, 42, 'x', [], {}, { entry: 'x' }, { entry: [null, { changes: [null, {}] }] }]) {
    const s = summarizePayload(b);
    assert.equal(s.messages, 0);
  }
});
