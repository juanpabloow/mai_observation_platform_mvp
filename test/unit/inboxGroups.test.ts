import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  conversationGroup,
  groupConversations,
  pendingCount,
  INBOX_GROUP_ORDER,
} from '../../web/lib/inboxGroups.js';
import type { InboxConversationView, InboxMode } from '../../web/lib/inboxView.js';
import { serviceWindow, serviceWindowNotice, SERVICE_WINDOW_HOURS } from '../../web/lib/inboxView.js';

/**
 * The pure state-mapping behind the three-column inbox list. REAL modes only
 * (bot|pending|human) — there is no "resolved" state, so a resolved conversation
 * (which the resolve action returns to `bot`) is never a distinct group.
 */

let seq = 0;
function view(mode: InboxMode, over: Partial<InboxConversationView> = {}): InboxConversationView {
  seq += 1;
  const stamp = `2026-07-24T10:0${seq % 10}:00.000Z`;
  return {
    id: over.id ?? `c${seq}`,
    conversationRef: over.conversationRef ?? `wa:5730000000${seq}`,
    workflowId: over.workflowId ?? 'wf-1',
    workflowName: over.workflowName ?? 'Workflow 1',
    mode,
    active: over.active ?? true,
    assignedAgentName: over.assignedAgentName ?? null,
    lastMessageText: over.lastMessageText ?? 'hi',
    lastMessageSender: over.lastMessageSender ?? 'user',
    lastMessageContentType: over.lastMessageContentType ?? 'text',
    lastMessageAt: over.lastMessageAt ?? stamp,
    createdAt: over.createdAt ?? stamp,
    pendingSince: over.pendingSince ?? null,
    escalationReasonCode: over.escalationReasonCode ?? null,
    escalationDetail: over.escalationDetail ?? null,
  };
}

test('conversationGroup maps each REAL mode to its operative group', () => {
  assert.equal(conversationGroup('pending'), 'needs_attention', 'pending → Needs human attention');
  assert.equal(conversationGroup('human'), 'human', 'human → Human is handling');
  assert.equal(conversationGroup('bot'), 'bot', 'bot → Bot is handling');
});

test('a bot conversation is "Bot is handling" — never a separate "resolved" group', () => {
  // The schema has no resolved/closed state; resolving returns mode to `bot`.
  assert.equal(conversationGroup('bot'), 'bot');
  const keys = INBOX_GROUP_ORDER.map((g) => g.key);
  assert.deepEqual(keys, ['needs_attention', 'human', 'bot'], 'exactly three real groups, no "resolved"');
  // groupConversations can only ever emit those three keys.
  const grouped = groupConversations([view('bot'), view('pending'), view('human')]);
  for (const g of grouped) assert.ok(keys.includes(g.key), `group ${g.key} is one of the real groups`);
});

test('groupConversations groups, orders groups by urgency, and omits empty groups', () => {
  const grouped = groupConversations([view('bot'), view('human'), view('pending')]);
  assert.deepEqual(grouped.map((g) => g.key), ['needs_attention', 'human', 'bot'], 'urgency order');

  const onlyBot = groupConversations([view('bot'), view('bot')]);
  assert.deepEqual(onlyBot.map((g) => g.key), ['bot'], 'empty groups are omitted');
  assert.equal(onlyBot[0].items.length, 2);
});

test('Needs human attention is sorted OLDEST-pending first (longest wait = most urgent)', () => {
  const newer = view('pending', { id: 'p-new', pendingSince: '2026-07-24T12:00:00.000Z' });
  const older = view('pending', { id: 'p-old', pendingSince: '2026-07-24T08:00:00.000Z' });
  const [group] = groupConversations([newer, older]);
  assert.equal(group.key, 'needs_attention');
  assert.deepEqual(group.items.map((v) => v.id), ['p-old', 'p-new'], 'oldest pending first');
});

test('Human / Bot groups are sorted most-recent-activity first', () => {
  const stale = view('human', { id: 'h-stale', lastMessageAt: '2026-07-24T08:00:00.000Z' });
  const fresh = view('human', { id: 'h-fresh', lastMessageAt: '2026-07-24T12:00:00.000Z' });
  const [group] = groupConversations([stale, fresh]);
  assert.deepEqual(group.items.map((v) => v.id), ['h-fresh', 'h-stale'], 'most recent first');
});

test('pendingCount counts only pending (needs-attention) conversations', () => {
  assert.equal(pendingCount([view('pending'), view('pending'), view('bot'), view('human')]), 2);
  assert.equal(pendingCount([view('bot'), view('human')]), 0);
});


// ── WhatsApp's 24-hour service window ─────────────────────────────────────────

const HOUR = 3600_000;
const at = (now: Date, hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR).toISOString();
const NOW = new Date("2026-08-12T12:00:00.000Z");

test('service window: only WhatsApp is restricted — other channels are never blocked', () => {
  const stale = [{ sender: 'user' as const, occurredAt: at(NOW, 100) }];
  for (const ch of ['webchat', 'instagram', 'telegram', null, undefined, '']) {
    assert.equal(serviceWindow(ch, stale, NOW).state, 'not_applicable', `${ch} is not WhatsApp's problem`);
    assert.equal(serviceWindowNotice(serviceWindow(ch, stale, NOW)), null, 'and shows no notice');
  }
  // Matched on the VALUE, and the label is free text, so casing/decoration must not matter.
  for (const ch of ['whatsapp', 'WhatsApp', 'whatsapp_business', 'WA whatsapp cloud']) {
    assert.equal(serviceWindow(ch, stale, NOW).state, 'closed', `${ch} is WhatsApp`);
  }
});

test('service window: measured from the last INBOUND message, not the last message', () => {
  // The business talking does NOT reopen the window — this is the case the rule exists
  // for, and measuring from "the last message" would keep it open forever.
  const w = serviceWindow('whatsapp', [
    { sender: 'user', occurredAt: at(NOW, 30) },
    { sender: 'bot', occurredAt: at(NOW, 1) },
    { sender: 'human_agent', occurredAt: at(NOW, 0.5) },
  ], NOW);
  assert.equal(w.state, 'closed');
});

test('service window: open inside 24h, closed at the boundary and after', () => {
  assert.equal(serviceWindow('whatsapp', [{ sender: 'user', occurredAt: at(NOW, 23.9) }], NOW).state, 'open');
  // Exactly at the boundary counts as CLOSED — the provider is not generous about it.
  assert.equal(serviceWindow('whatsapp', [{ sender: 'user', occurredAt: at(NOW, SERVICE_WINDOW_HOURS) }], NOW).state, 'closed');
  assert.equal(serviceWindow('whatsapp', [{ sender: 'user', occurredAt: at(NOW, 25) }], NOW).state, 'closed');
});

test('service window: the LATEST inbound wins, whatever order they arrive in', () => {
  const w = serviceWindow('whatsapp', [
    { sender: 'user', occurredAt: at(NOW, 40) },
    { sender: 'user', occurredAt: at(NOW, 2) },
    { sender: 'user', occurredAt: at(NOW, 30) },
  ], NOW);
  assert.equal(w.state, 'open', 'a recent inbound reopens it regardless of list order');
});

test('service window: never-opened is a DIFFERENT state from closed, with its own wording', () => {
  const none = serviceWindow('whatsapp', [{ sender: 'bot', occurredAt: at(NOW, 1) }], NOW);
  assert.equal(none.state, 'never_opened', 'a thread the business started has no window yet');
  assert.equal(serviceWindow('whatsapp', [], NOW).state, 'never_opened');
  const a = serviceWindowNotice(none);
  const b = serviceWindowNotice(serviceWindow('whatsapp', [{ sender: 'user', occurredAt: at(NOW, 99) }], NOW));
  assert.ok(a && b && a !== b, 'the two blocked states do not share one message');
  // An open window must never produce a notice — that is what enables the composer.
  assert.equal(serviceWindowNotice(serviceWindow('whatsapp', [{ sender: 'user', occurredAt: at(NOW, 1) }], NOW)), null);
});

test('service window: a malformed timestamp is ignored, never treated as "now"', () => {
  const w = serviceWindow('whatsapp', [
    { sender: 'user', occurredAt: 'not-a-date' },
    { sender: 'user', occurredAt: at(NOW, 50) },
  ], NOW);
  assert.equal(w.state, 'closed', 'the unparseable one does not silently open the window');
});
