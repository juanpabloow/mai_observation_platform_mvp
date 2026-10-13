import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatProviderDiagnostic } from '../../web/lib/handoffDiagnostics.js';
// @ts-expect-error — plain .mjs reference module for the n8n workflow (no types).
import { mapWhatsAppSendError } from '../../tools/n8n/handoffSendErrorMapping.mjs';

/**
 * PROPOSAL (tools/n8n/handoffSendErrorMapping.mjs, not wired into any workflow): how the n8n
 * send workflow should classify a WhatsApp error. The incident: HTTP 500 + Meta 131000
 * reported as CHANNEL_POLICY ~16.5 h after the customer's last message — inside the 24 h
 * window, so the label was wrong.
 */

test('the incident case maps to CHANNEL_ERROR, never to a window/policy rejection', () => {
  const r = mapWhatsAppSendError({ httpStatus: 500, code: 131000, traceId: 'TRACE0000synthetic' });
  assert.equal(r.code, 'CHANNEL_ERROR');
  assert.doesNotMatch(r.detail, /24 ?h|ventana|window expired/i);
  assert.deepEqual(r.provider, { http_status: 500, code: 131000, trace_id: 'TRACE0000synthetic' });
  assert.equal(formatProviderDiagnostic(r.provider), 'HTTP 500 · código 131000 · traza TRACE0000synthetic', 'the trace survives to the Inbox');
});

test('only real channel rules are CHANNEL_POLICY; only recipient codes are INVALID_RECIPIENT', () => {
  assert.equal(mapWhatsAppSendError({ httpStatus: 400, code: 131047 }).code, 'CHANNEL_POLICY', 're-engagement (24 h)');
  assert.equal(mapWhatsAppSendError({ httpStatus: 400, code: 470 }).code, 'CHANNEL_POLICY');
  assert.equal(mapWhatsAppSendError({ httpStatus: 429, code: 130429 }).code, 'CHANNEL_POLICY', 'rate limit');
  assert.equal(mapWhatsAppSendError({ httpStatus: 400, code: 131026 }).code, 'INVALID_RECIPIENT');
  for (const unknown of [{}, { httpStatus: 502 }, { httpStatus: 400, code: 999999 }, { code: 'abc' }]) {
    assert.equal(mapWhatsAppSendError(unknown).code, 'CHANNEL_ERROR', JSON.stringify(unknown));
  }
});
