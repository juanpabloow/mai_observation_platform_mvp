import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedContact, seedScenario, seedWorkflow } from './fixtures.js';
import { getOrCreateConversation } from '../../src/db/repositories/handoff.js';
import { backfillPipeline } from '../../src/pipeline/backfill.js';

/**
 * PL-1 §3 — backfill. Builds opportunities from existing contacts/touches/appointments from the
 * client's tracking_started_at onward, applying §2 (incl. auto-lost). DRY-RUN == APPLY; a second
 * apply is a no-op; nothing before tracking_started_at is created.
 */
const tenants: string[] = [];
after(async () => { for (const t of tenants) await cleanupTenant(t); await closeDb(); });
const one = async <T>(sql: string, p: unknown[]): Promise<T> => (await query<T>(sql, p)).rows[0];

let slot = 0;
async function fixture() {
  const s = await seedScenario({ enableCrm: true });
  tenants.push(s.tenantId);
  await seedWorkflow(s.tenantId, s.clientId, `wf-${randomUUID()}`);
  // Tracking started 60 days ago; brief window 7 days.
  await query(
    `INSERT INTO attribution_settings (tenant_id, client_id, tracking_started_at, brief_window_days)
       VALUES ($1,$2, now() - interval '60 days', 7)
     ON CONFLICT (tenant_id, client_id) DO UPDATE SET tracking_started_at = EXCLUDED.tracking_started_at`,
    [s.tenantId, s.clientId],
  );
  return s;
}
type S = Awaited<ReturnType<typeof fixture>>;

async function contact(s: S): Promise<string> {
  return seedContact(s.tenantId, s.clientId, { name: 'C', channelUserId: `wa:${randomUUID().slice(0, 8)}` });
}
async function conv(s: S, contactId: string): Promise<string> {
  const c = await getOrCreateConversation(s.tenantId, `wf-${randomUUID()}`, `co-${randomUUID()}`);
  await query(`UPDATE conversations SET contact_id = $2 WHERE id = $1`, [c.id, contactId]);
  return c.id;
}
async function msg(s: S, conversationId: string, sender: 'user' | 'bot', agoHours: number): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO handoff_messages (tenant_id, conversation_id, sender, status, text, content_type, occurred_at, created_at)
       VALUES ($1,$2,$3,$4,'m','text', now() - make_interval(hours => $5::int), now() - make_interval(hours => $5::int)) RETURNING id`,
    [s.tenantId, conversationId, sender, sender === 'user' ? 'received' : 'sent', agoHours],
  );
  return r.id;
}
async function touch(s: S, contactId: string, conversationId: string, messageId: string, agoHours: number): Promise<void> {
  const ad = await one<{ id: string }>(`INSERT INTO ads (tenant_id, client_id, platform, source_type, external_id) VALUES ($1,$2,'meta','ad',$3) RETURNING id`, [s.tenantId, s.clientId, `ext-${randomUUID().slice(0, 8)}`]);
  await query(
    `INSERT INTO attribution_touches (tenant_id, client_id, contact_id, conversation_id, message_id, ad_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() - make_interval(hours => $7::int))`,
    [s.tenantId, s.clientId, contactId, conversationId, messageId, ad.id, agoHours],
  );
}
async function appt(s: S, contactId: string, status: string, startAgoDays: number): Promise<void> {
  // All backfill appointments here are terminal (completed/no_show) → exempt from the anti-double-book
  // exclusion, so the blocked interval can simply equal the service interval (satisfies the contains CHECK).
  slot++;
  await query(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id,
        start_at, service_end_at, blocked_from, blocked_until, service_name_snapshot, duration_min_snapshot,
        price_snapshot, buffer_before_min_snapshot, buffer_after_min_snapshot, status, origin, created_by_type, contact_id)
     VALUES ($1,$2,$3,$4,$5,
        now() - make_interval(days => $6::int), now() - make_interval(days => $6::int) + interval '60 min',
        now() - make_interval(days => $6::int), now() - make_interval(days => $6::int) + interval '60 min',
        'Haircut', 60, '50000', 0, 0, $7, 'public', 'public', $8)`,
    [s.tenantId, s.clientId, s.siteId, s.staffA, s.serviceHaircut, startAgoDays, status, contactId],
  );
}

test('backfill: dry-run == apply, idempotent, excludes pre-tracking, applies auto-lost', async () => {
  const s = await fixture();

  // A — ad touch, customer answered last → open LEAD.
  const a = await contact(s);
  const ca = await conv(s, a);
  await touch(s, a, ca, await msg(s, ca, 'user', 48), 48);
  await msg(s, ca, 'user', 2);
  // B — a completed appointment → attended / won.
  const b = await contact(s);
  await appt(s, b, 'completed', 1);
  // C — a no-show appointment → lost (no_asistio), stage stayed booked.
  const cC = await contact(s);
  await appt(s, cC, 'no_show', 1);
  // D — an ad touch BEFORE tracking started (90 days ago) → nothing created.
  const d = await contact(s);
  const cd = await conv(s, d);
  await touch(s, d, cd, await msg(s, cd, 'user', 24 * 90), 24 * 90);
  // E — brand-new organic (first message, no touch, no appointment) → open LEAD.
  const e = await contact(s);
  const ce = await conv(s, e);
  await msg(s, ce, 'user', 5);
  // F — ad touch, BUSINESS answered last & stale (80h, default 72h) → auto-lost (no_respondio).
  const f = await contact(s);
  const cf = await conv(s, f);
  await touch(s, f, cf, await msg(s, cf, 'user', 90), 90);
  await msg(s, cf, 'bot', 80);

  // DRY RUN writes nothing.
  const dry = await backfillPipeline({ tenantId: s.tenantId, apply: false });
  assert.equal(dry.opportunitiesCreated, 5, 'A,B,C,E,F (D is before tracking)');
  assert.deepEqual(dry.byStatus, { open: 2, won: 1, lost: 2 }, 'A,E open · B won · C,F lost');
  assert.equal(dry.autoLost, 1, 'F auto-lost');
  assert.equal((await one<{ n: number }>(`SELECT count(*)::int n FROM opportunities WHERE tenant_id=$1`, [s.tenantId])).n, 0, 'dry run wrote nothing');

  // APPLY writes, with the SAME tallies.
  const applied = await backfillPipeline({ tenantId: s.tenantId, apply: true });
  assert.equal(applied.opportunitiesCreated, dry.opportunitiesCreated, 'apply count == dry count');
  assert.deepEqual(applied.byStatus, dry.byStatus);
  assert.equal((await one<{ n: number }>(`SELECT count(*)::int n FROM opportunities WHERE tenant_id=$1`, [s.tenantId])).n, 5, '5 opportunities written');
  // D created nothing.
  assert.equal((await one<{ n: number }>(`SELECT count(*)::int n FROM opportunities WHERE contact_id=$1`, [d])).n, 0, 'pre-tracking contact got no sale');
  // B won / C lost(no_asistio) / F lost(no_respondio).
  assert.equal((await one<{ status: string; stage: string }>(`SELECT status, stage FROM opportunities WHERE contact_id=$1`, [b])).status, 'won');
  assert.equal((await one<{ lost_reason: string }>(`SELECT lost_reason FROM opportunities WHERE contact_id=$1`, [cC])).lost_reason, 'no_asistio');
  assert.equal((await one<{ lost_reason: string }>(`SELECT lost_reason FROM opportunities WHERE contact_id=$1`, [f])).lost_reason, 'no_respondio');
  // Each opportunity got exactly one backfill event.
  assert.equal((await one<{ n: number }>(`SELECT count(*)::int n FROM opportunity_stage_events WHERE tenant_id=$1`, [s.tenantId])).n, 5);

  // SECOND APPLY is a no-op (every contact now has a sale).
  const again = await backfillPipeline({ tenantId: s.tenantId, apply: true });
  assert.equal(again.opportunitiesCreated, 0, 'second apply creates nothing');
  assert.equal((await one<{ n: number }>(`SELECT count(*)::int n FROM opportunities WHERE tenant_id=$1`, [s.tenantId])).n, 5, 'still 5');
});
