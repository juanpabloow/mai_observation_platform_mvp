import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { issueToken, revokeToken, updateTokenCapabilities } from '../../src/db/repositories/handoffTokens.js';
import { getOrCreateConversation } from '../../src/db/repositories/handoff.js';
import { readConversationContext } from '../../src/db/repositories/handoffContext.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';
import { GET } from '../../web/app/api/handoff/v1/context/route.js';

// Run ONLY against the explicitly provided isolated test database.
const testDb = process.env.TEST_DATABASE_URL ? new URL(process.env.TEST_DATABASE_URL) : null;
if (!testDb || !['localhost', '127.0.0.1', '[::1]'].includes(testDb.hostname)
    || testDb.pathname !== '/handoff_context_test') {
  throw new Error('Set TEST_DATABASE_URL to the isolated handoff_context_test database.');
}
const tenants: string[] = [];
after(async () => { for (const t of tenants) await cleanupTenant(t); await closeDb(); });

async function fixture() {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const workflowRef = `wf-${randomUUID()}`;
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, workflowRef);
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: true });
  const token = await issueToken(s.tenantId, connectionId, ['handoff.context.read']);
  const conversationRef = 'CO.synthetic-conversation';
  const conv = await getOrCreateConversation(s.tenantId, workflowRef, conversationRef);
  return { ...s, workflowRef, connectionId, conversationRef, conversationId: conv.id, token };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function message(s: Fixture, text: string, minute: number, opts: {
  sender?: string; status?: string; contentType?: string; conversationId?: string; occurredAt?: string;
} = {}) {
  const r = await query<{ id: string }>(
    `INSERT INTO handoff_messages (tenant_id, conversation_id, sender, status, text,
       content_type, occurred_at, created_at, metadata, failure_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{"private":"SYNTHETIC-SECRET"}','PRIVATE-ERROR') RETURNING id`,
    [s.tenantId, opts.conversationId ?? s.conversationId, opts.sender ?? 'user', opts.status ?? 'received',
      text, opts.contentType ?? 'text', opts.occurredAt ?? new Date(Date.UTC(2026, 9, 15, 8, minute)).toISOString(),
      new Date(Date.UTC(2026, 9, 15, 8, minute)).toISOString()],
  );
  return r.rows[0].id;
}
async function call(s: Fixture, anchor: string, extra: Record<string, string> = {}, token: string | null = s.token.rawToken) {
  const params = new URLSearchParams({ workflow_ref: s.workflowRef, conversation_ref: s.conversationRef, through_message_id: anchor, ...extra });
  return GET(new Request(`http://test/api/handoff/v1/context?${params}`, {
    headers: token === null ? { cookie: 'session=not-an-authorization' } : { authorization: `Bearer ${token}` },
  }));
}

test('real HTTP handler recovers customer + sent human + bot history, never failed/sending/media/future/current messages', async () => {
  const s = await fixture();
  await message(s, 'Pregunta antes del humano', 0);
  await message(s, 'Respuesta previa del bot', 1, { sender: 'bot' });
  await message(s, 'Respuesta humana entregada al canal', 2, { sender: 'human_agent', status: 'sent' });
  await message(s, 'FAILED-HUMAN', 3, { sender: 'human_agent', status: 'failed' });
  await message(s, 'SENDING-HUMAN', 4, { sender: 'human_agent', status: 'sending' });
  await message(s, 'MEDIA-CAPTION', 5, { contentType: 'image' });
  const anchor = await message(s, 'Mensaje actual', 6);
  await message(s, 'FUTURE-MESSAGE', 7);
  const res = await call(s, anchor);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(res.headers.get('Vary'), 'Authorization');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  const body = await res.json();
  assert.deepEqual(body.messages.map((m: { text: string }) => m.text), [
    'Pregunta antes del humano', 'Respuesta previa del bot', 'Respuesta humana entregada al canal',
  ]);
  assert.equal(body.history_is_authorization, false);
  assert.ok(!/SYNTHETIC-SECRET|PRIVATE-ERROR|FAILED-HUMAN|SENDING-HUMAN|FUTURE-MESSAGE|MEDIA-CAPTION/.test(JSON.stringify(body)));
});

test('missing, cookie-only, bad, revoked and legacy-only tokens all get the same 401 without history', async () => {
  const s = await fixture();
  const anchor = await message(s, 'actual', 6);
  const legacy = await issueToken(s.tenantId, s.connectionId, ['handoff', 'scheduling.read']);
  const statuses: Response[] = [await call(s, anchor, {}, null), await call(s, anchor, {}, 'bad'), await call(s, anchor, {}, legacy.rawToken)];
  await revokeToken(s.tenantId, s.token.row.id);
  statuses.push(await call(s, anchor));
  const bodies = [];
  for (const response of statuses) { assert.equal(response.status, 401); bodies.push(await response.text()); }
  assert.equal(new Set(bodies).size, 1);
});

test('removing the new capability takes effect on the next read', async () => {
  const s = await fixture(); const anchor = await message(s, 'actual', 6);
  assert.equal((await call(s, anchor)).status, 200);
  await updateTokenCapabilities(s.tenantId, s.token.row.id, ['handoff']);
  assert.equal((await call(s, anchor)).status, 401);
});

test('foreign tenant and connection cannot authorize a workflow or anchor', async () => {
  const a = await fixture(); const b = await fixture();
  const anchor = await message(a, 'actual', 6);
  assert.equal((await call(a, anchor, {}, b.token.rawToken)).status, 404);
  const { connectionId } = await seedWorkflow(a.tenantId, a.otherClientId, `other-${randomUUID()}`);
  const other = await issueToken(a.tenantId, connectionId, ['handoff.context.read']);
  assert.equal((await call(a, anchor, {}, other.rawToken)).status, 404);
});

test('another conversation on the same workflow cannot be used as an anchor', async () => {
  const s = await fixture();
  const other = await getOrCreateConversation(s.tenantId, s.workflowRef, 'other-conversation');
  const anchor = await message(s, 'PRIVATE-OTHER-THREAD', 6, { conversationId: other.id });
  assert.equal((await call(s, anchor)).status, 404);
});

test('bot/human/failed/media messages cannot be used as the current customer anchor', async () => {
  const s = await fixture();
  for (const opts of [{ sender: 'bot' }, { sender: 'human_agent', status: 'sent' },
    { status: 'failed' }, { contentType: 'image' }]) {
    const anchor = await message(s, 'not-a-current-customer-text', 6, opts);
    assert.equal((await call(s, anchor)).status, 404);
  }
});

test('default/unassigned client is denied even if a module row is forced on', async () => {
  const s = await fixture();
  await query('UPDATE workflows SET client_id = $2 WHERE tenant_id = $1 AND n8n_workflow_id = $3',
    [s.tenantId, s.defaultClientId, s.workflowRef]);
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.defaultClientId, moduleKey: 'inbox', enabled: true });
  const anchor = await message(s, 'actual', 6);
  assert.equal((await call(s, anchor)).status, 403);
});

test('scope cannot be supplied by the caller; malformed/duplicate/extra parameters fail', async () => {
  const s = await fixture(); const anchor = await message(s, 'actual', 6);
  assert.equal((await call(s, anchor, { client_id: s.otherClientId })).status, 422);
  assert.equal((await call(s, 'not-uuid')).status, 422);
  const params = new URLSearchParams({ workflow_ref: s.workflowRef, conversation_ref: s.conversationRef, through_message_id: anchor });
  params.append('workflow_ref', 'other');
  const res = await GET(new Request(`http://test/api/handoff/v1/context?${params}`, { headers: { authorization: `Bearer ${s.token.rawToken}` } }));
  assert.equal(res.status, 422);
});

test('unknown conversation does not create rows and returns 404', async () => {
  const s = await fixture();
  const before = await query('SELECT count(*) FROM conversations WHERE tenant_id = $1', [s.tenantId]);
  assert.equal((await call(s, randomUUID(), { conversation_ref: 'unknown' })).status, 404);
  const afterRead = await query('SELECT count(*) FROM conversations WHERE tenant_id = $1', [s.tenantId]);
  assert.equal(afterRead.rows[0].count, before.rows[0].count);
});

test('disabled Inbox denies access without modifying existing data', async () => {
  const s = await fixture(); const anchor = await message(s, 'actual', 6);
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: false });
  assert.equal((await call(s, anchor)).status, 403);
});

test('pending and human modes provide no history, bot resumes with a transition marker', async () => {
  const s = await fixture(); await message(s, 'Historial', 0); const anchor = await message(s, 'actual', 6);
  for (const mode of ['pending', 'human']) {
    await query('UPDATE conversations SET mode = $2 WHERE id = $1', [s.conversationId, mode]);
    const res = await call(s, anchor); assert.equal(res.status, 200);
    const body = await res.json(); assert.equal(body.mode, mode); assert.deepEqual(body.messages, []);
  }
  await query('UPDATE conversations SET mode = $2 WHERE id = $1', [s.conversationId, 'bot']);
  await query(`INSERT INTO conversation_mode_transitions (tenant_id, conversation_id, from_mode, to_mode, source, detail)
               VALUES ($1,$2,'human','bot','agent','PRIVATE-TRANSITION-DETAIL')`, [s.tenantId, s.conversationId]);
  const body = await (await call(s, anchor)).json();
  assert.equal(body.latest_transition.from_mode, 'human');
  assert.equal(body.latest_transition.to_mode, 'bot');
  assert.equal(body.messages.length, 1);
  assert.ok(!JSON.stringify(body).includes('PRIVATE-TRANSITION-DETAIL'));
});

test('duplicate workflow refs across connections fail closed because conversations have no connection id', async () => {
  const s = await fixture(); const anchor = await message(s, 'actual', 6);
  await seedWorkflow(s.tenantId, s.otherClientId, s.workflowRef);
  assert.equal((await call(s, anchor)).status, 404);
});

test('repository independently checks the client scope, not only route resolution', async () => {
  const s = await fixture(); const anchor = await message(s, 'actual', 6);
  const context = await readConversationContext({ tenantId: s.tenantId, connectionId: s.connectionId,
    clientId: s.otherClientId, workflowRef: s.workflowRef, conversationRef: s.conversationRef, throughMessageId: anchor });
  assert.equal(context, null);
});

test('history is bounded and ordered by recording time, not a caller-supplied occurred_at', async () => {
  const s = await fixture();
  for (let i = 0; i < 55; i++) await message(s, `history-${i}`, i, { occurredAt: '2099-01-01T00:00:00Z' });
  const anchor = await message(s, 'actual', 59);
  const body = await (await call(s, anchor)).json();
  assert.equal(body.messages.length, 50); assert.equal(body.truncated, true);
  assert.equal(body.messages[0].text, 'history-5');
  assert.equal(body.messages[49].text, 'history-54');
});
