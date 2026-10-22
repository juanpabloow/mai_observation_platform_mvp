import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLIENT_MODULE_KEYS } from '../../src/modules/registry.js';

/**
 * SOURCE-LEVEL CONTRACT for the `inbox` module gating (the runtime isolation is
 * proven by inboxModule.test.ts against PostgreSQL). These guard the WIRING the root
 * runner can't execute: the machine escalation gate, the human-action + send gates,
 * the JSON API + page gates, the sidebar/panel, and the owner/admin-only toggle.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}${rel}`, 'utf8');

test('registry: inbox is a canonical client module', () => {
  assert.ok((CLIENT_MODULE_KEYS as readonly string[]).includes('inbox'));
});

test('machine escalation is inbox-gated (race-safe) with the workflow-derived client', () => {
  const src = read('web/app/api/handoff/v1/escalations/route.ts');
  assert.ok(src.includes('inboxGate: { clientId: wf.clientId }'), 'gate uses the authenticated workflow client');
  assert.ok(src.includes('ModuleDisabledError') && src.includes('moduleDisabled("inbox")'), 'disabled → module_disabled');
  // The client is NEVER a body field — it comes from resolveWorkflowOr404.
  assert.ok(!/client_id/.test(src.split('const Body')[1]?.split('export async function')[0] ?? ''), 'no client_id body field');
});

test('human actions (take/dismiss/return) are server-side inbox-gated', () => {
  const src = read('web/lib/inboxActions.ts');
  const gates = src.match(/const denied = await inboxDenied\(scope, clientId\)/g) ?? [];
  assert.ok(gates.length >= 3, 'all three human actions gate on the inbox module + inbox.reply');
  assert.ok(src.includes('checkInboxAccess(scope, clientId, "inbox.reply")'), 'uses the shared module + permission check, not just the UI');
  const data = read('web/lib/inboxData.ts');
  assert.ok(data.includes('isClientModuleEnabled(scope.tenantId, clientId, "inbox")'), 'the shared check reads the module');
  assert.ok(data.includes('if (!client || client.is_default) return "not_found";'), 'the default client is refused too');
});

test('manual send + retry are inbox-gated', () => {
  const src = read('web/lib/sendActions.ts');
  const gates = src.match(/checkInboxAccess\(scope, clientId, "inbox\.reply"\)/g) ?? [];
  assert.ok(gates.length >= 2, 'both send + retry gate on the inbox module + inbox.reply');
});

test('inbox JSON API access resolves the inbox module (404 when off)', () => {
  const src = read('web/lib/inboxData.ts');
  // W-2 removed the per-workflow inbox surface, so resolveWorkflowInboxAccess is gone —
  // there is now ONE non-redirecting resolver (resolveInboxAccess) for the client-level
  // JSON poll routes. It gates on the inbox module and denies with the same safe 404.
  const hits = src.match(/isClientModuleEnabled\([^)]*"inbox"\)/g) ?? [];
  assert.ok(hits.length >= 1, 'the client-level access resolver gates on inbox');
  assert.ok(!src.includes('resolveWorkflowInboxAccess'), 'the per-workflow resolver was removed with the surface');
  assert.ok(src.includes('status: 404'), 'disabled → the same safe 404');
});

test('inbox pages are inbox-gated (unified + legacy thread); per-workflow defers to the target', () => {
  assert.ok(
    read('web/app/clients/[clientId]/inbox/page.tsx').includes('requireClientModulePage(clientId, "inbox", "inbox.view")'),
    'unified inbox page gated',
  );
  // W-2: the per-workflow inbox page no longer gates itself — it 307-redirects to the
  // client inbox scoped to that workflow, and THAT page does the real access/module gate.
  const perWorkflow = read('web/app/clients/[clientId]/workflows/[workflowId]/(padded)/inbox/page.tsx');
  assert.ok(perWorkflow.includes('redirect(') && perWorkflow.includes('/inbox?workflow='), 'per-workflow inbox redirects to the gated client inbox');
  assert.ok(
    read('web/app/clients/[clientId]/inbox/[conversationId]/page.tsx').includes('isClientModuleEnabled(scope.tenantId, clientId, "inbox")'),
    'legacy client thread gated',
  );
});

test('sidebar hides Conversations/Inbox (and its polling badge) when inbox is off', () => {
  // The Inbox section exists only when the module is on (lib/sectionNav.ts — a section
  // with no visible page is dropped), and the polling badge rides ONLY that section.
  const model = read('web/lib/sectionNav.ts');
  assert.ok(model.includes('inbox: [p("inbox.view") && has("inbox") && { id: "inbox"'), 'the Inbox item is inbox-gated');
  assert.ok(model.includes('if (visible.length === 0) return null;'), 'a section with no visible page is not rendered');
  const src = read('web/components/AppSidebar.tsx');
  assert.ok(src.includes('countEndpoint: sec.id === "inbox" ? `/api/inbox/${clientId}/pending-count` : undefined'), 'the pending badge/poll is inside the gate');
  // The off-client stand-in for a setter polls only when inbox is on.
  assert.match(src, /may\("inbox\.view"\) && memberModules\.includes\("inbox"\)\) \{\s*items\.push\(\{ key: "inbox"[^\n]*pending-count/);
});

test('disable policy + owner/admin-only toggle are wired in the module action', () => {
  const src = read('web/lib/clientModuleActions.ts');
  assert.ok(src.includes('requireFullAccessForAction()'), 'owner/admin only (members cannot toggle)');
  assert.ok(src.includes('disableInboxIfIdle('), 'inbox-disable uses the transactional idle-only policy');
  assert.ok(
    src.includes('Return or resolve active human conversations before disabling Inbox.'),
    'exact blocked-disable message',
  );
});

test('Modules panel exposes the Inbox card copy', () => {
  const src = read('web/components/ClientModulesPanel.tsx');
  assert.ok(src.includes('Unified conversations and human handoff'), 'inbox card description');
});
