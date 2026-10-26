import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { projectConversationContext, type ContextSnapshot } from '../../src/handoff/context.js';

/** JP-2 — the /context ping-pong field, and the Inbox line that reads the auto-return event. */

const base: ContextSnapshot = {
  conversation_id: 'c1',
  mode: 'bot',
  through_message_id: 'm0',
  latest_transition: null,
  auto_returned_at: '2026-10-26T15:00:00.000Z',
  messages: [],
};

test('projectConversationContext passes auto_returned_at straight through (set and null)', () => {
  assert.equal(projectConversationContext(base).auto_returned_at, '2026-10-26T15:00:00.000Z');
  assert.equal(projectConversationContext({ ...base, auto_returned_at: null }).auto_returned_at, null);
});

test('the Inbox thread renders the auto-return line with the threshold read aloud', () => {
  const r = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
  const transcript = r('web/components/MessageTranscript.tsx');
  // The reason_code drives a dedicated Spanish line with the threshold ("tras 1 h sin atención").
  assert.match(transcript, /reasonCode === "auto_return"/);
  assert.match(transcript, /Volvió al bot automáticamente tras \$\{humanizeMinutes\(e\.autoReturnMinutes\)\} sin atención/);
  assert.match(transcript, /function humanizeMinutes/);
  // The view carries the reason + the threshold minutes parsed from the transition detail.
  const data = r('web/lib/inboxData.ts');
  assert.match(data, /reasonCode: t\.reason_code/);
  assert.match(data, /autoReturnMinutes:/);
  assert.match(data, /t\.reason_code === "auto_return" && t\.detail/);
});
