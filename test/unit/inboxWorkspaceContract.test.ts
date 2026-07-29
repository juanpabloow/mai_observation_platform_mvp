import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE-LEVEL CONTRACT for the three-column unified inbox workspace (no render). The
 * DB isolation + thread behavior are proven elsewhere (clientInbox integration tests,
 * InboxThread); THESE guard the new layout's wiring: three columns, the preserved
 * ?c= deep link + workflow filter, reuse of the real chat/actions, client-scoped
 * fetches, and (C-4) a customer panel assembled from the SHARED contact components that
 * loads the linked contact from a session-authed route.
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

test('workspace: preserves the ?c= deep link; NO in-panel workflow filter (header owns scope)', () => {
  const src = read('components/ClientInboxWorkspace.tsx');
  assert.ok(src.includes('searchParams.get("c")'), 'selection reads the ?c= param');
  assert.ok(src.includes('p.set("c", id)'), 'selecting sets ?c= …');
  assert.ok(src.includes('searchParams.toString()'), '… while preserving the other params');
  // W-2: the in-panel workflow filter was removed — the header switcher is the single
  // workflow selector, and the list follows the active scope (the component is keyed by
  // it, re-seeded with the already-scoped payload on a scope change).
  assert.ok(!src.includes('aria-label="Filter by workflow"'), 'there is NO in-panel workflow filter');
  assert.ok(src.includes('No in-panel workflow selector'), 'the workspace follows the header scope');
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

test('customer panel: assembled from SHARED contact components, loads the linked contact (C-4)', () => {
  const src = read('components/CustomerDetailsPanel.tsx');
  // C-4: the panel is the COMPACT variant of the record — the same shared components,
  // not a parallel implementation.
  for (const comp of ['ContactIdentitySummary', 'AppointmentsSection', 'TasksSection', 'NotesSection', 'TagsSection']) {
    assert.ok(src.includes(comp), `reuses the shared ${comp}`);
  }
  // Contact data loads from the session-authed, client-scoped route (re-validated
  // server-side) — the client panel imports NO worker/db module directly.
  assert.ok(src.includes('conversations/${conversationId}/contact'), 'fetches the contact payload route');
  assert.ok(!src.includes('@worker'), 'no worker/db import in the client panel');
  // When the conversation has no linked contact, it offers to link through C-2's
  // identity chokepoint (no duplicate created).
  assert.ok(src.includes('linkConversationContactAction'), 'offers to link/create when unlinked');
});

// The "per-workflow inbox stays on the old grid + drawer (compat)" case was DELETED:
// W-2 removed that surface entirely. The ConversationGrid + InboxDrawer components no
// longer exist, and the route is now a 307-redirect to the client inbox scoped to the
// workflow (asserted by clientInboxNavContract's "legacy routes" + inboxModuleContract's
// "inbox pages are inbox-gated" cases). Nothing about a per-workflow grid remains to guard.
