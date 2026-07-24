import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE-LEVEL CONTRACT for the three-column unified inbox workspace (no render). The
 * DB isolation + thread behavior are proven elsewhere (clientInbox integration tests,
 * InboxThread); THESE guard the new layout's wiring: three columns, the preserved
 * ?c= deep link + workflow filter, reuse of the real chat/actions, client-scoped
 * fetches, and a details panel that uses ONLY real payload fields.
 */

const web = fileURLToPath(new URL('../../web/', import.meta.url));
const read = (rel: string): string => readFileSync(`${web}${rel}`, 'utf8');

test('workspace: three columns — conversations, conversation (chat), customer details', () => {
  const src = read('components/ClientInboxWorkspace.tsx');
  assert.ok(src.includes('aria-label="Conversations"'), 'left list column');
  assert.ok(src.includes('aria-label="Conversation"'), 'center chat column');
  assert.ok(src.includes('aria-label="Customer details"'), 'right details column/drawer');
});

test('workspace: grouped by real state + pending counter (pure mapping)', () => {
  const src = read('components/ClientInboxWorkspace.tsx');
  assert.ok(src.includes('groupConversations('), 'groups via the pure state mapping');
  assert.ok(src.includes('pendingCount('), 'shows a pending counter');
  assert.ok(src.includes('pending'), 'pending counter is surfaced');
});

test('workspace: preserves the ?c= deep link and the workflow filter', () => {
  const src = read('components/ClientInboxWorkspace.tsx');
  assert.ok(src.includes('searchParams.get("c")'), 'selection reads the ?c= param');
  assert.ok(src.includes('p.set("c", id)'), 'selecting sets ?c= …');
  assert.ok(src.includes('searchParams.toString()'), '… while preserving the other params');
  assert.ok(src.includes('aria-label="Filter by workflow"'), 'the workflow filter is kept');
});

test('workspace: reuses the REAL chat + handoff actions (InboxThread), client-scoped fetch', () => {
  const src = read('components/ClientInboxWorkspace.tsx');
  assert.ok(src.includes('<InboxThread'), 'the center reuses InboxThread (header + actions + composer + polling)');
  // The thread fetch is client-scoped (tenant+client re-validated server-side).
  assert.ok(
    src.includes('`/api/inbox/${clientId}/conversations/${selectedId}/messages?history=1`'),
    'thread fetch is scoped to the route client',
  );
  // InboxThread still wires the existing handoff actions + composer.
  const thread = read('components/InboxThread.tsx');
  assert.ok(thread.includes('<ThreadActions'), 'Take / Dismiss / Return-to-bot actions preserved');
  assert.ok(thread.includes('<Composer'), 'the manual composer is preserved (read-only unless human)');
});

test('workspace: keyboard + a11y — aria-current selection, Escape closes the details drawer', () => {
  const src = read('components/ClientInboxWorkspace.tsx');
  assert.ok(src.includes('aria-current={selected ? "page" : undefined}'), 'selected row is aria-current');
  assert.ok(src.includes('e.key === "Escape"') && src.includes('setDetailsDrawer(false)'), 'Escape closes the drawer');
});

test('customer details: REAL payload fields only — no fabricated profile, no extra query', () => {
  const src = read('components/CustomerDetailsPanel.tsx');
  // Renders only what the conversation view really carries.
  for (const field of ['Status', 'Workflow', 'Client', 'First seen', 'Last activity']) {
    assert.ok(src.includes(field), `shows the real field: ${field}`);
  }
  // Never invents contact profile fields absent from the DB payload.
  for (const bogus of ['email', 'Email', 'company', 'Company', 'address', 'Address', 'Instagram']) {
    assert.ok(!src.includes(bogus), `does not fabricate: ${bogus}`);
  }
  // No server / contacts import → no N+1 or new query was introduced here.
  assert.ok(!src.includes('@worker'), 'the panel imports no worker/contacts data');
});

test('per-workflow inbox stays on the old grid + drawer (compat, untouched)', () => {
  const page = read('app/clients/[clientId]/workflows/[workflowId]/(padded)/inbox/page.tsx');
  assert.ok(page.includes('ConversationGrid'), 'per-workflow inbox still uses the grid');
  assert.ok(page.includes('InboxDrawer'), 'per-workflow inbox still uses the drawer');
});
