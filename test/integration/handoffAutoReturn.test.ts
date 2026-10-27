import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import {
  getMode,
  getOrCreateConversation,
  insertMessage,
  listModeTransitions,
  transitionMode,
} from '../../src/db/repositories/handoff.js';
import { readConversationContext } from '../../src/db/repositories/handoffContext.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { setInboxAutoReturnMinutes } from '../../src/db/repositories/inboxSettings.js';
import { runAutoReturnOnce } from '../../src/handoff/autoReturn.js';
import { cleanupTenant, closeDb, seedMember, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * JP-2 — the auto-return sweep returns an unattended conversation to the bot after the per-client
 * threshold. Exercised through the real repos + sweep + PostgreSQL (transitions are backdated to
 * simulate age, since transitionMode stamps now()).
 */
const tenants: string[] = [];
after(async () => { for (const t of tenants) await cleanupTenant(t); await closeDb(); });

async function scenario() {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const agent = await seedMember(s.tenantId, { role: 'owner' });
  return { ...s, agent };
}
type S = Awaited<ReturnType<typeof scenario>>;

/** A fresh conversation under a workflow assigned to `clientId`. */
async function conv(s: S, clientId = s.clientId): Promise<{ id: string; ref: string; wf: string; connectionId: string }> {
  const wf = `wf-${randomUUID().slice(0, 8)}`;
  const { connectionId } = await seedWorkflow(s.tenantId, clientId, wf);
  const ref = `CO.${randomUUID().slice(0, 8)}`;
  const c = await getOrCreateConversation(s.tenantId, wf, ref);
  return { id: c.id, ref, wf, connectionId };
}
const escalate = (s: S, id: string) => transitionMode(s.tenantId, id, 'pending', { source: 'workflow', reasonCode: 'needs_human' });
const take = (s: S, id: string) => transitionMode(s.tenantId, id, 'human', { source: 'agent', agentUserId: s.agent });
/** Backdate the latest transition into `toMode` by N minutes, to simulate elapsed time. */
const ageTransition = (id: string, toMode: string, minutes: number) =>
  query(
    `UPDATE conversation_mode_transitions SET created_at = now() - make_interval(mins => $3)
      WHERE id = (SELECT id FROM conversation_mode_transitions WHERE conversation_id = $1 AND to_mode = $2 ORDER BY created_at DESC LIMIT 1)`,
    [id, toMode, minutes],
  );
const modeOf = (s: S, c: { wf: string; ref: string }) => getMode(s.tenantId, c.wf, c.ref);

test('PENDING returns to the bot after the threshold, never before; the event is written once (idempotent)', async () => {
  const s = await scenario();
  const c = await conv(s);
  await setInboxAutoReturnMinutes(s.tenantId, s.clientId, 60);
  await escalate(s, c.id);

  // Just escalated → not stale.
  assert.equal((await runAutoReturnOnce({ tenantId: s.tenantId })).returned, 0);
  assert.equal(await modeOf(s, c), 'pending');

  // Pending for 61 minutes → returned.
  await ageTransition(c.id, 'pending', 61);
  assert.equal((await runAutoReturnOnce({ tenantId: s.tenantId })).returned, 1);
  assert.equal(await modeOf(s, c), 'bot', 'the n8n gate sees bot right after');

  const trs = await listModeTransitions(s.tenantId, c.id);
  const ret = trs.filter((t) => t.reason_code === 'auto_return');
  assert.equal(ret.length, 1, 'exactly one auto_return event');
  assert.deepEqual([ret[0].from_mode, ret[0].to_mode, ret[0].source, ret[0].detail], ['pending', 'bot', 'platform_rule', '60']);

  // Idempotent: a second sweep does nothing and writes no duplicate.
  assert.equal((await runAutoReturnOnce({ tenantId: s.tenantId })).returned, 0);
  assert.equal((await listModeTransitions(s.tenantId, c.id)).filter((t) => t.reason_code === 'auto_return').length, 1);
});

test('HUMAN with a recent agent message is never taken away; silent past the threshold returns', async () => {
  const s = await scenario();
  await setInboxAutoReturnMinutes(s.tenantId, s.clientId, 60);

  // Active human: took it 2h ago but wrote 5 min ago → never returned.
  const active = await conv(s);
  await take(s, active.id);
  await ageTransition(active.id, 'human', 120);
  await insertMessage({ tenantId: s.tenantId, conversationId: active.id, sender: 'human_agent', agentUserId: s.agent, text: 'sigo aquí', status: 'sent', occurredAt: new Date(Date.now() - 5 * 60_000) });
  assert.equal((await runAutoReturnOnce({ tenantId: s.tenantId })).returned, 0);
  assert.equal(await modeOf(s, active), 'human', 'an active human conversation stays');

  // Silent human: last agent message 61 min ago → returned.
  const silent = await conv(s);
  await take(s, silent.id);
  await insertMessage({ tenantId: s.tenantId, conversationId: silent.id, sender: 'human_agent', agentUserId: s.agent, text: 'hola', status: 'sent', occurredAt: new Date(Date.now() - 61 * 60_000) });
  assert.equal((await runAutoReturnOnce({ tenantId: s.tenantId })).returned, 1);
  assert.equal(await modeOf(s, silent), 'bot');

  // Took it but never wrote, 61 min ago → also returned (measured from taking it).
  const neverWrote = await conv(s);
  await take(s, neverWrote.id);
  await ageTransition(neverWrote.id, 'human', 61);
  assert.equal((await runAutoReturnOnce({ tenantId: s.tenantId })).returned, 1);
  assert.equal(await modeOf(s, neverWrote), 'bot');
});

test('setting 0 disables; per-client isolation', async () => {
  const s = await scenario();
  // Client A: 60 min. Client B (otherClient): 0 = never.
  await setInboxAutoReturnMinutes(s.tenantId, s.clientId, 60);
  await setInboxAutoReturnMinutes(s.tenantId, s.otherClientId, 0);

  const a = await conv(s, s.clientId);
  const b = await conv(s, s.otherClientId);
  await escalate(s, a.id);
  await escalate(s, b.id);
  await ageTransition(a.id, 'pending', 180);
  await ageTransition(b.id, 'pending', 180);

  const res = await runAutoReturnOnce({ tenantId: s.tenantId });
  assert.equal(res.returned, 1, 'only the configured client returns');
  assert.equal(await modeOf(s, a), 'bot');
  assert.equal(await modeOf(s, b), 'pending', '0 = never, untouched');
});

test('/context exposes auto_returned_at so n8n can avoid immediate re-escalation', async () => {
  const s = await scenario();
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: true });
  const c = await conv(s);
  await setInboxAutoReturnMinutes(s.tenantId, s.clientId, 60);
  await escalate(s, c.id);
  await ageTransition(c.id, 'pending', 61);
  await runAutoReturnOnce({ tenantId: s.tenantId });
  assert.equal(await modeOf(s, c), 'bot');

  // A customer message to anchor the context read (it only reads history in bot mode).
  const anchor = await insertMessage({ tenantId: s.tenantId, conversationId: c.id, sender: 'user', text: 'sigo esperando', status: 'received', occurredAt: new Date() });
  const ctx = await readConversationContext({
    tenantId: s.tenantId, connectionId: c.connectionId, clientId: s.clientId,
    workflowRef: c.wf, conversationRef: c.ref, throughMessageId: anchor.message.id,
  });
  assert.ok(ctx, 'context resolves');
  assert.equal(ctx!.mode, 'bot');
  assert.ok(ctx!.auto_returned_at, 'auto_returned_at is set after an auto-return');
  assert.ok(!Number.isNaN(Date.parse(ctx!.auto_returned_at!)), 'it is an ISO timestamp');
});
