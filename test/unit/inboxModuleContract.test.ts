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
  const gates = src.match(/inboxEnabled\(scope\.tenantId, clientId\)/g) ?? [];
  assert.ok(gates.length >= 3, 'all three human actions gate on the inbox module');
  assert.ok(src.includes('isClientModuleEnabled'), 'uses the module check, not just the UI');
});

test('manual send + retry are inbox-gated', () => {
  const src = read('web/lib/sendActions.ts');
  const gates = src.match(/isClientModuleEnabled\(scope\.tenantId, clientId, "inbox"\)/g) ?? [];
  assert.ok(gates.length >= 2, 'both send + retry gate on the inbox module');
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
    read('web/app/clients/[clientId]/inbox/page.tsx').includes('requireClientModulePage(clientId, "inbox")'),
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
  const src = read('web/components/AppSidebar.tsx');
  assert.ok(src.includes('if (moduleKeys.includes("inbox"))'), 'the Conversations section is inbox-gated');
  // The pending-count endpoint (polling) lives inside that gated block.
  const gated = src.slice(src.indexOf('if (moduleKeys.includes("inbox"))'));
  assert.ok(gated.slice(0, 400).includes('/pending-count'), 'the pending badge/poll is inside the gate');
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
