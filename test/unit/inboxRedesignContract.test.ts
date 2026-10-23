import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE-LEVEL CONTRACT for the inbox redesign ("Inbox de Gallery"). The pure rules are
 * tested in inboxPresent.test.ts; these guard the wiring a render test cannot reach cheaply.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
const FILES = [
  'components/ClientInboxWorkspace.tsx',
  'components/InboxThread.tsx',
  'components/Composer.tsx',
  'components/ThreadActions.tsx',
  'components/MessageTranscript.tsx',
  'components/CustomerDetailsPanel.tsx',
  'components/inbox/InboxUi.tsx',
];

test('everything the operator reads is Spanish (no English UI strings left)', () => {
  for (const f of FILES) {
    const src = strip(read(f));
    for (const en of ['Loading…', '"Close"', '>Close<', 'This conversation', 'History before handoff', '‹ Back', 'No messages yet', 'Humano', 'Something went wrong', 'Enviar plantilla</']) {
      assert.equal(src.includes(en), false, `${f} still says ${JSON.stringify(en)}`);
    }
  }
});

test('take / return are ALWAYS confirmed and go through the existing server actions', () => {
  const actions = read('components/ThreadActions.tsx');
  assert.equal(/takeConversationAction|returnConversationToBotAction|dismissConversationAction/.test(actions), false, 'the buttons never act directly');
  assert.ok(actions.includes('onRequest(p.kind)'), 'they ask the thread to confirm');
  const thread = read('components/InboxThread.tsx');
  assert.ok(thread.includes('<InboxConfirm'), 'the thread owns the confirmation');
  for (const fn of ['takeConversationAction(clientId, header.id)', 'returnConversationToBotAction(clientId, header.id)', 'dismissConversationAction(clientId, header.id)']) {
    assert.ok(thread.includes(fn), `${fn} is the only path`);
  }
  assert.ok(thread.includes('threadActionPlan({'), 'what is offered comes from the pure plan');
  const ui = read('components/inbox/InboxUi.tsx');
  // Focus starts on Cancelar: it is the FIRST control inside the trapped dialog.
  assert.ok(ui.indexOf('Cancelar\n          </button>') < ui.indexOf('{pending ? "Guardando…" : confirmLabel}'), 'Cancelar comes first');
  assert.ok(ui.includes('useTrappedPanel({ active: open, onClose: onCancel })'), 'Escape + focus trap + focus return');
});

test('announcements: a permanent aria-live region for take / return / send outcomes', () => {
  const thread = read('components/InboxThread.tsx');
  assert.ok(thread.includes('<p aria-live="polite" className="sr-only">'), 'the region is always in the DOM');
  assert.ok(thread.includes('setAnnounce('), 'outcomes are written to it');
});

test('composer: in flow, a draft per conversation, Enter rules, honest template state', () => {
  const c = read('components/Composer.tsx');
  assert.ok(c.includes('`inbox-draft:${clientId}:${conversationId}`'), 'the draft is keyed by client + conversation');
  assert.ok(c.includes('sessionStorage'), 'and survives switching conversations');
  assert.ok(c.includes('(pointer: coarse) and (max-width: 767.98px)'), 'on a touch phone Enter is a line break');
  assert.ok(c.includes('e.shiftKey'), 'Shift+Enter breaks the line on desktop');
  assert.ok(c.includes('Plantilla no disponible'), 'templates are not connected — the button says so');
  assert.equal(c.includes('shadow-[var(--shadow-float)]'), false, 'the composer no longer floats');
  const thread = read('components/InboxThread.tsx');
  assert.ok(thread.includes('key={header.id}') && thread.includes('conversationId={header.id}'), 'one composer (and draft) per conversation');
});

test('the thread shows the WHOLE conversation (no history button), and never forces the scroll', () => {
  const thread = read('components/InboxThread.tsx');
  // On request (2026-10-23): nothing is folded behind «Historial antes del escalado» or a
  // «Historial anterior» disclosure — the whole thread reads top to bottom.
  assert.ok(!thread.includes('Historial antes del escalado') && !thread.includes('setShowEarlier'), 'no fold');
  assert.ok(thread.includes('const visible = merged;') && thread.includes('const visibleEvents = events;'), 'every message and event');
  assert.ok(thread.includes('function HistoryInline(') && !thread.includes('<details'), 'the pre-handoff history reads inline');
  assert.ok(thread.includes('Ir al último mensaje'), 'the jump appears on scroll-up');
  assert.ok(thread.includes('behavior: "smooth"') && thread.includes('onScroll={onScroll}'), 'it is the reader who scrolls');
});

test('the workflow menu cannot be clipped by the list column', () => {
  const ws = read('components/ClientInboxWorkspace.tsx');
  assert.ok(ws.includes('className="fixed z-50 w-[min(300px,calc(100vw-1rem))]'), 'fixed, positioned from the button');
  assert.equal(/absolute[^"]*top-full/.test(ws), false, 'not an absolute menu inside an overflow-hidden column');
});

test('the list carries who answers and the window, from REAL fields (no new state invented)', () => {
  const data = read('lib/inboxData.ts');
  assert.ok(data.includes('assignedAgentUserId: r.assigned_agent_user_id'), 'who answers, by id');
  assert.ok(data.includes('lastUserMessageAt: iso(r.last_user_message_at)'), 'the 24 h window, from the customer\'s last message');
  const repo = readFileSync(fileURLToPath(new URL('../../src/db/repositories/handoff.ts', import.meta.url)), 'utf8');
  assert.equal((repo.match(/c\.assigned_agent_user_id, c\.last_message_at, c\.last_user_message_at, c\.created_at,/g) ?? []).length, 2, 'both list queries select it');
});
