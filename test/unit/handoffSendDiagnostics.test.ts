import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatProviderDiagnostic, rejectionDetail } from '../../web/lib/handoffDiagnostics.js';

/**
 * Send-failure diagnostics on the PLATFORM side (WhatsApp handoff). The incident: HTTP 500 +
 * Meta 131000 reported as CHANNEL_POLICY inside the 24 h window — the label was wrong and the
 * evidence was lost. The platform keeps the provider's numbers and never classifies on its
 * own; the workflow-side mapping proposal is tested in n8nSendErrorMapping.test.ts.
 */

test('the platform keeps the provider numbers, allow-listed — never the provider message', () => {
  assert.equal(formatProviderDiagnostic({ http_status: 500, code: 131000 }), 'HTTP 500 · código 131000');
  assert.equal(formatProviderDiagnostic({ http_status: 400, code: '131047', subcode: 2494010 }), 'HTTP 400 · código 131047 · subcódigo 2494010');
  assert.equal(formatProviderDiagnostic({ message: 'Something went wrong for +573001112233' }), null, 'free text is never kept');
  assert.equal(formatProviderDiagnostic({ http_status: 9999, code: 'x y z <script>' }), null);
  assert.equal(formatProviderDiagnostic({ trace_id: 'short' }), null, 'a trace must look like one');
  assert.equal(formatProviderDiagnostic({ trace_id: 'has spaces and <tags>' }), null);
  assert.equal(formatProviderDiagnostic(null), null);
  assert.equal(formatProviderDiagnostic([500]), null);
  assert.equal(rejectionDetail('WhatsApp returned HTTP 500.', { http_status: 500, code: 131000 }), 'WhatsApp returned HTTP 500. (HTTP 500 · código 131000)');
  assert.equal(rejectionDetail('Sin cambios', undefined), 'Sin cambios', 'without provider data the detail is unchanged');
  assert.equal(rejectionDetail(null, { code: 131000 }), '(código 131000)');
});

test('the backend never classifies on its own, and the Inbox shows the stored code', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
  const send = read('web/lib/sendToWebhook.ts');
  assert.match(send, /code: typeof obj\.code === "string" \? obj\.code : null/, 'the workflow code is passed through verbatim');
  assert.doesNotMatch(send, /CHANNEL_POLICY|window/i, 'no backend window/policy inference');
  assert.match(send, /rejectionDetail\(typeof obj\.detail === "string" \? obj\.detail : null, obj\.provider\)/);
  const bubble = read('web/components/MessageTranscript.tsx');
  assert.match(bubble, /\{msg\.failureCode \? <span className="u-mono ml-1 opacity-80">\[\{msg\.failureCode\}\]<\/span> : null\}/);
});
