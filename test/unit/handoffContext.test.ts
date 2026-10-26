import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { projectConversationContext, type ContextMessage, type ContextSnapshot } from '../../src/handoff/context.js';

const row = (id: string, text = id): ContextMessage => ({
  id, text, sender: 'user', occurred_at: '2026-10-15T08:00:00Z',
  recorded_at: '2026-10-15T08:00:00Z', text_truncated: false,
});
const snapshot = (messages: ContextMessage[]): ContextSnapshot => ({
  conversation_id: 'conversation', mode: 'bot', through_message_id: 'current', latest_transition: null, messages,
});

test('context is oldest to newest, deduplicated and excludes the current inbound', () => {
  const result = projectConversationContext(snapshot([row('current'), row('new'), row('new'), row('old')]));
  assert.deepEqual(result.messages.map(m => m.id), ['old', 'new']);
  assert.equal(result.history_is_authorization, false);
});

test('pending/human mode returns no history for the bot', () => {
  for (const mode of ['pending', 'human'] as const) {
    assert.deepEqual(projectConversationContext({ ...snapshot([row('old')]), mode }).messages, []);
  }
});

test('message and character limits retain recent history and declare truncation', () => {
  const many = projectConversationContext(snapshot(Array.from({ length: 51 }, (_, i) => row(String(i)))));
  assert.equal(many.messages.length, 50);
  assert.equal(many.truncated, true);
  const long = projectConversationContext(snapshot(Array.from({ length: 20 }, (_, i) => row(String(i), 'x'.repeat(3000)))));
  assert.equal(long.messages.length, 12);
  assert.equal(long.messages.reduce((n, m) => n + m.text.length, 0), 24000);
  assert.equal(long.truncated, true);
  assert.ok(long.messages.every(m => m.text_truncated));
});

test('projection never forwards additional database fields', () => {
  const extra = { ...row('old'), metadata: { token: 'SYNTHETIC-SECRET' }, failure_detail: 'PRIVATE', agent_user_id: 'staff-id' };
  const text = JSON.stringify(projectConversationContext(snapshot([extra])));
  assert.ok(!/SYNTHETIC-SECRET|PRIVATE|staff-id|metadata|failure_detail/.test(text));
});

test('context route is opt-in, dynamic, no-store and workflow/client scoped', () => {
  const route = readFileSync(new URL('../../web/app/api/handoff/v1/context/route.ts', import.meta.url), 'utf8');
  assert.ok(route.includes('authenticateHandoffRequest(req, "handoff.context.read")'));
  assert.ok(route.includes('resolveWorkflowOr404(auth.auth, parsed.data.workflow_ref)'));
  assert.ok(route.includes('clientId: wf.clientId'));
  assert.ok(route.includes('"inbox"') && route.includes('"private, no-store"'));
  assert.ok(route.includes('force-dynamic'));
  // The editor's capability vocabulary (with labels) lives in web/lib/capabilityLabels.ts; the
  // editor (MachineTokens.tsx) renders the list DERIVED from it and keeps the default-granted set.
  const labels = readFileSync(new URL('../../web/lib/capabilityLabels.ts', import.meta.url), 'utf8');
  assert.ok(labels.includes('"handoff.context.read":'), 'the capability has an editor label');
  const picker = readFileSync(new URL('../../web/components/MachineTokens.tsx', import.meta.url), 'utf8');
  assert.ok(!picker.match(/const DEFAULT_CAPS = [^;]+;/)?.[0].includes('handoff.context.read'));
});
