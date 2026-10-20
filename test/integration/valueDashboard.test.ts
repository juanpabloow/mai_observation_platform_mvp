import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedMember, seedScenario, seedSiteForClient, seedWorkflow } from './fixtures.js';
import { MAPPINGS_FINGERPRINT_SQL, runTagged } from '../../src/db/repositories/valueDashboard.js';
import { resolvePeriod } from '../../src/analytics/valueDashboardModel.js';

/**
 * VALUE DASHBOARD — server behaviour against a real local test database:
 *   - access: agency and this client's owner only; setter, staff, another client's owner and
 *     another tenant get a refusal (the page's and the API's rule);
 *   - isolation: nothing from another client or tenant reaches the numbers;
 *   - assumptions: agency proposes, ONLY the owner confirms, append-only, server-validated;
 *   - the implementation's SQL extensions agree with the validated spec queries they refine;
 *   - unknown ≠ 0, $0 is a real price, conversations stay hidden without evidence.
 * Only the session read and Next's boundaries are stubbed (same technique as
 * crmOwnerPermissions.test.ts).
 */
let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: {
    getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null),
  },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), {
  namedExports: {
    redirect: () => { throw new Error('unexpected redirect()'); },
    notFound: () => { throw new Error('unexpected notFound()'); },
  },
});
mock.module(urlOf('next/headers'), {
  namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) },
});
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
mock.module(urlOf('server-only'), { namedExports: {} });
const asUser = (userId: string | null) => { CURRENT = userId ? { id: userId, email: `${userId.slice(0, 8)}@test.local` } : null; };

const fingerprint = async (tenantId: string, wfs: string[]) => (await query<{ fingerprint: string }>(MAPPINGS_FINGERPRINT_SQL, [tenantId, wfs])).rows[0].fingerprint;
async function review(tenantId: string, clientId: string, o: { status: 'approved' | 'rejected'; wfs: string[]; at: string; fp?: string }) {
  await query(
    `INSERT INTO instrumentation_reviews (tenant_id, client_id, status, method_version, conversational_workflow_ids, mappings_fingerprint, sample_size, correct_count, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, 'v3.1', $4, $5, 20, $6, 'test', $7)`,
    [tenantId, clientId, o.status, o.wfs, o.fp ?? (await fingerprint(tenantId, o.wfs)), o.status === 'approved' ? 20 : 15, o.at],
  );
}

const { buildValueDashboard, resolveValueAccess } = await import('../../web/lib/valueDashboard.js');
const { proposeValueAssumptionsAction, confirmValueAssumptionsAction } = await import('../../web/lib/valueAssumptionActions.js');

after(closeDb);

const NOW = new Date('2026-10-19T17:00:00Z'); // 12:00 in Bogotá
const P30 = { key: '30' as const };
const iso = (s: string) => new Date(s).toISOString();

async function appt(s: { tenantId: string; siteId: string; staffA: string; serviceHaircut: string }, clientId: string, o: {
  origin: string; createdAt: string; startAt: string; status?: string; price?: string | null; conv?: string | null;
}) {
  const start = new Date(o.startAt);
  const end = new Date(start.getTime() + 30 * 60000);
  await query(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id, source_conversation_id, start_at, service_end_at, blocked_from, blocked_until,
       service_name_snapshot, duration_min_snapshot, price_snapshot, buffer_before_min_snapshot, buffer_after_min_snapshot, status, origin, created_by_type, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$8,'Corte',30,$9,0,0,$10,$11,$12,$13)`,
    [s.tenantId, clientId, s.siteId, s.staffA, s.serviceHaircut, o.conv ?? null, start, end, o.price === undefined ? '50000' : o.price, o.status ?? 'scheduled',
      o.origin, o.origin === 'n8n' ? 'n8n' : o.origin === 'public' ? 'public' : 'agent', iso(o.createdAt)],
  );
}

/* ------------------------------------------------------------------ access -- */

test('access: agency and the client owner see it; setter, other owner, other tenant, no session do not', async () => {
  const s = await seedScenario();
  const other = await seedScenario();
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    const admin = await seedMember(s.tenantId, { role: 'admin' });
    const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    const ownerOfB = await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'owner' });
    const foreignAgency = await seedMember(other.tenantId, { role: 'owner' });
    const staffUser = randomUUID();
    await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Staff', $2, true)`, [staffUser, `${staffUser.slice(0, 8)}@test.local`]);
    await query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role, scheduling_site_id, scheduling_staff_id) VALUES ($1, $2, 'member', $3, 'staff', $4, $5)`,
      [s.tenantId, staffUser, s.clientId, s.siteId, s.staffA],
    );

    asUser(agency);
    const a = await resolveValueAccess(s.clientId);
    assert.ok(a.ok && a.viewer === 'agency' && a.canPropose && !a.canConfirm, 'agency: proposes, never confirms');
    asUser(admin);
    assert.ok((await resolveValueAccess(s.clientId)).ok, 'admin is agency too');
    asUser(owner);
    const o = await resolveValueAccess(s.clientId);
    assert.ok(o.ok && o.viewer === 'owner' && o.canConfirm, 'owner confirms');
    assert.deepEqual(await resolveValueAccess(s.otherClientId), { ok: false, status: 404 }, 'owner of A cannot open B');

    for (const [who, id] of [['setter', setter], ['staff', staffUser], ['owner of B', ownerOfB], ['foreign agency', foreignAgency]] as const) {
      asUser(id);
      assert.deepEqual(await resolveValueAccess(s.clientId), { ok: false, status: 404 }, `${who} is refused`);
      const r = await buildValueDashboard(s.clientId, P30, NOW);
      assert.equal(r.ok, false, `${who}: no payload`);
    }
    asUser(null);
    assert.deepEqual(await resolveValueAccess(s.clientId), { ok: false, status: 401 });
    asUser(agency);
    assert.deepEqual(await resolveValueAccess('not-a-uuid'), { ok: false, status: 404 });
    assert.deepEqual(await resolveValueAccess(randomUUID()), { ok: false, status: 404 }, 'unknown client');
  } finally {
    await cleanupTenant(s.tenantId);
    await cleanupTenant(other.tenantId);
  }
});

/* ------------------------------------------------------- metrics + isolation -- */

test('metrics: channels, unknown vs $0, other client/tenant excluded, conversations hidden without evidence', async () => {
  const s = await seedScenario();
  const other = await seedScenario();
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    // Period (30 días ending 19 oct, Bogotá) = 20 sep 00:00 → 20 oct 00:00 local.
    await appt(s, s.clientId, { origin: 'n8n', createdAt: '2026-10-02T15:00:00Z', startAt: '2026-10-05T15:00:00Z', status: 'completed', price: '50000' });
    await appt(s, s.clientId, { origin: 'n8n', createdAt: '2026-10-03T15:00:00Z', startAt: '2026-10-06T15:00:00Z', status: 'completed', price: null });
    await appt(s, s.clientId, { origin: 'public', createdAt: '2026-10-04T15:00:00Z', startAt: '2026-10-07T15:00:00Z', status: 'completed', price: '0' }); // free: $0 is a price
    await appt(s, s.clientId, { origin: 'public', createdAt: '2026-10-04T16:00:00Z', startAt: '2026-10-08T15:00:00Z', status: 'cancelled', price: '40000' });
    await appt(s, s.clientId, { origin: 'internal', createdAt: '2026-10-05T15:00:00Z', startAt: '2026-10-09T15:00:00Z', status: 'completed', price: '90000' });
    // Before the period (created) but dated in it → Q4b only.
    await appt(s, s.clientId, { origin: 'n8n', createdAt: '2026-09-10T15:00:00Z', startAt: '2026-09-25T15:00:00Z', status: 'no_show', price: '30000' });
    // Noise that must NOT count: the other client of the tenant and another tenant.
    const bSite = await seedSiteForClient(s.tenantId, s.otherClientId);
    await appt({ tenantId: s.tenantId, siteId: bSite.siteId, staffA: bSite.staffId, serviceHaircut: bSite.serviceId }, s.otherClientId, {
      origin: 'n8n', createdAt: '2026-10-02T15:00:00Z', startAt: '2026-10-05T16:00:00Z', status: 'completed', price: '999000',
    });
    await appt(other, other.clientId, { origin: 'n8n', createdAt: '2026-10-02T15:00:00Z', startAt: '2026-10-05T15:00:00Z', status: 'completed', price: '777000' });

    asUser(agency);
    const r = await buildValueDashboard(s.clientId, P30, NOW);
    assert.ok(r.ok);
    const d = r.data;
    assert.equal(d.period.fromDay, '2026-09-20');
    assert.equal(d.period.toDay, '2026-10-19');
    // Created in period: n8n 2 (one unpriced), public 2, team 1.
    assert.deepEqual(d.created.n8n.completed, { count: 2, withPrice: 1, value: 50000 }, 'partial: value of the priced one, 1 missing');
    assert.deepEqual(d.created.public.completed, { count: 1, withPrice: 1, value: 0 }, '$0 with a saved price is a REAL $0, not unknown');
    assert.deepEqual(d.created.public.cancelled, { count: 1, withPrice: 1, value: 40000 });
    assert.equal(d.created.team.completed.count, 1);
    assert.equal(d.created.n8n.no_show.count, 0, 'created before the period: not in «creadas»');
    assert.equal(d.dated.n8n.no_show.count, 1, '…but dated in it: in «atendidas»');
    // Nothing from the other tenant (777000) or the other client (999000).
    const all = JSON.stringify(d);
    assert.ok(!all.includes('777000') && !all.includes('999000'), 'no foreign amounts');
    // Units: U3 = public bookings created in the period, all statuses.
    assert.equal(d.units.reduce((n, u) => n + u.u3, 0), 2);
    assert.ok(d.units.every((u) => u.u1 === null && u.u2 === null), 'conversations disabled → U1/U2 unknown, not 0');
    // No conversational workflows at all → hidden, with the reason.
    assert.equal(d.evidence.enabled, false);
    assert.equal(d.evidence.reason, 'no_conversational');
    assert.equal(d.conversations, null, 'no conversational numbers without evidence');
    // Daily series = Q4a totals for automated channels.
    assert.equal(d.daily.reduce((n, x) => n + x.created, 0), 4);
    assert.equal(d.daily.length, 30);
  } finally {
    await cleanupTenant(s.tenantId);
    await cleanupTenant(other.tenantId);
  }
});

test('evidence: habilitable contrast is NOT enough — an approved review covering the workflows is required', async () => {
  const s = await seedScenario();
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, 'wf-bot');
    for (const role of ['conversation_id', 'user_message', 'ai_response'])
      await query(`INSERT INTO field_mappings (tenant_id, n8n_workflow_id, mapping_kind, role, node_name, json_path) VALUES ($1, 'wf-bot', 'conversation', $2, 'W', $3)`, [s.tenantId, role, `$.${role}`]);
    // 60 fully reported turns → contraste_suficiente.
    for (let i = 0; i < 60; i++) {
      const ts = new Date(Date.parse('2026-10-10T15:00:00Z') + i * 3600_000);
      const ref = `c-${i}`;
      const conv = (await query<{ id: string }>(`INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref) VALUES ($1, 'wf-bot', $2) RETURNING id`, [s.tenantId, ref])).rows[0].id;
      const ex = (await query<{ id: string }>(`INSERT INTO executions (tenant_id, n8n_connection_id, n8n_execution_id, n8n_workflow_id, status, started_at) VALUES ($1, $2, $3, 'wf-bot', 'success', $4) RETURNING id`, [s.tenantId, connectionId, randomUUID(), ts])).rows[0].id;
      await query(`INSERT INTO conversation_turns (tenant_id, n8n_workflow_id, execution_id, conversation_id, user_message, ai_response, turn_timestamp) VALUES ($1, 'wf-bot', $2, $3, 'hola', 'r', $4)`, [s.tenantId, ex, ref, ts]);
      await query(`INSERT INTO handoff_messages (tenant_id, conversation_id, sender, text, status, occurred_at) VALUES ($1, $2, 'user', 'x', 'received', $3)`, [s.tenantId, conv, ts]);
      await query(`INSERT INTO handoff_messages (tenant_id, conversation_id, sender, text, status, occurred_at) VALUES ($1, $2, 'bot', 'y', 'sent', $3)`, [s.tenantId, conv, new Date(ts.getTime() + 10_000)]);
    }
    asUser(agency);
    const r1 = await buildValueDashboard(s.clientId, P30, NOW);
    assert.ok(r1.ok);
    assert.equal(r1.data.evidence.habilitable, true, 'Q9 says habilitable');
    assert.equal(r1.data.evidence.enabled, false, 'but there is no manual review');
    assert.equal(r1.data.evidence.reason, 'no_review');
    assert.equal(r1.data.conversations, null);

    // A review that does NOT list the workflow is stale.
    await review(s.tenantId, s.clientId, { status: 'approved', wfs: ['wf-otro'], at: '2026-10-15T00:00:00Z' });
    const r2 = await buildValueDashboard(s.clientId, P30, NOW);
    assert.ok(r2.ok && r2.data.evidence.reason === 'review_stale' && r2.data.conversations === null);

    // A covering approved review opens the gate.
    await review(s.tenantId, s.clientId, { status: 'approved', wfs: ['wf-bot'], at: '2026-10-16T00:00:00Z' });
    const r3 = await buildValueDashboard(s.clientId, P30, NOW);
    assert.ok(r3.ok);
    assert.equal(r3.data.evidence.enabled, true);
    assert.ok(r3.data.conversations);
    assert.equal(r3.data.conversations.turns.turnos, 60);
    assert.equal(r3.data.conversations.turns.respondidosPorBot, 60);
    assert.equal(r3.data.conversations.turns.medianaBotS, 10);
    assert.equal(r3.data.conversations.classes.u1RespondidaPorBot, 60);
    assert.equal(r3.data.units.reduce((n, u) => n + (u.u1 ?? 0), 0), 60, 'U1 per day sums to the Q2 class');

    // A later REJECTED review closes it again.
    // Editing a reviewed mapping (upsert in place, no timestamp) invalidates the review by itself.
    await query(`UPDATE field_mappings SET json_path = '$.body.message' WHERE tenant_id = $1 AND n8n_workflow_id = 'wf-bot' AND role = 'user_message'`, [s.tenantId]);
    const rEdit = await buildValueDashboard(s.clientId, P30, NOW);
    assert.ok(rEdit.ok && rEdit.data.evidence.reason === 'review_stale' && rEdit.data.conversations === null, 'edited mapping → stale');
    // So does deleting one.
    await review(s.tenantId, s.clientId, { status: 'approved', wfs: ['wf-bot'], at: '2026-10-16T12:00:00Z' });
    assert.ok((await buildValueDashboard(s.clientId, P30, NOW)).ok, 'a new review re-approves');
    await query(`DELETE FROM field_mappings WHERE tenant_id = $1 AND n8n_workflow_id = 'wf-bot' AND role = 'ai_response'`, [s.tenantId]);
    const rDel = await buildValueDashboard(s.clientId, P30, NOW);
    assert.ok(rDel.ok && rDel.data.conversations === null, 'deleted mapping → hidden again');
    for (const role of ['ai_response']) await query(`INSERT INTO field_mappings (tenant_id, n8n_workflow_id, mapping_kind, role, node_name, json_path) VALUES ($1, 'wf-bot', 'conversation', $2, 'W', $3)`, [s.tenantId, role, `$.${role}`]);

    // A later REJECTED review closes it again.
    await review(s.tenantId, s.clientId, { status: 'rejected', wfs: ['wf-bot'], at: '2026-10-17T00:00:00Z' });
    const r4 = await buildValueDashboard(s.clientId, P30, NOW);
    assert.ok(r4.ok && r4.data.evidence.reason === 'review_rejected' && r4.data.conversations === null);
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

/* ------------------------------------------------- extensions vs spec queries -- */

test('extensions agree with the validated queries: Q4d≡Q4a, Q4bd≡Q4b, Q5h⊇Q5, Q8w≡Q8, Q2d≡Q2', async () => {
  const s = await seedScenario();
  try {
    const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, 'wf-x');
    // Bot bookings: 07:00 local (before opening), 20:00 (after closing), Sunday, inside, unpriced.
    await appt(s, s.clientId, { origin: 'n8n', createdAt: '2026-10-07T12:00:00Z', startAt: '2026-10-09T15:00:00Z' }); // Wed 07:00
    await appt(s, s.clientId, { origin: 'n8n', createdAt: '2026-10-08T01:00:00Z', startAt: '2026-10-10T15:00:00Z', price: null }); // Wed 20:00
    await appt(s, s.clientId, { origin: 'n8n', createdAt: '2026-10-11T15:00:00Z', startAt: '2026-10-13T15:00:00Z', status: 'completed' }); // Sun 10:00
    await appt(s, s.clientId, { origin: 'n8n', createdAt: '2026-10-12T15:00:00Z', startAt: '2026-10-14T16:00:00Z', status: 'completed' }); // Mon 10:00 inside
    await appt(s, s.clientId, { origin: 'public', createdAt: '2026-10-12T16:00:00Z', startAt: '2026-10-14T17:00:00Z', status: 'completed', price: null });
    for (const st of ['success', 'error', 'crashed', 'success'])
      await query(`INSERT INTO executions (tenant_id, n8n_connection_id, n8n_execution_id, n8n_workflow_id, status, started_at) VALUES ($1, $2, $3, 'wf-x', $4, '2026-10-10T12:00:00Z')`, [s.tenantId, connectionId, randomUUID(), st]);

    const p = resolvePeriod(P30, NOW, 'America/Bogota');
    assert.ok(p.ok);
    const base = { tenant: s.tenantId, client: s.clientId, from: p.period.startUtc, to: p.period.endUtc, tz: 'America/Bogota' };

    const sum = (rows: Array<Record<string, unknown>>, k: string) => rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);
    const q4a = (await runTagged('Q4a', base)).filter((r) => ['n8n', 'public'].includes(String(r.canal)));
    const q4d = await runTagged('Q4d', base);
    assert.equal(sum(q4d, 'citas'), sum(q4a, 'reservas_creadas'));
    assert.equal(sum(q4d, 'con_precio'), sum(q4a, 'con_precio'));
    assert.equal(sum(q4d, 'valor'), sum(q4a, 'valor'));

    const q4b = (await runTagged('Q4b', base)).filter((r) => ['n8n', 'public'].includes(String(r.canal)) && r.estado === 'completed');
    const q4bd = await runTagged('Q4bd', base);
    assert.equal(sum(q4bd, 'citas'), sum(q4b, 'citas_del_periodo'));
    assert.equal(sum(q4bd, 'valor'), sum(q4b, 'valor'));

    const q5 = (await runTagged('Q5', base))[0];
    const q5h = Object.fromEntries((await runTagged('Q5h', base)).map((r) => [String(r.franja), Number(r.reservas)]));
    const fuera = (q5h.antes_de_abrir ?? 0) + (q5h.despues_de_cerrar ?? 0) + (q5h.dia_sin_atencion ?? 0) + (q5h.en_pausa ?? 0);
    assert.equal(fuera, Number(q5.reservas_bot_fuera_horario_semanal), 'same «fuera» rule as Q5 when hours are configured');
    assert.deepEqual(q5h, { antes_de_abrir: 1, despues_de_cerrar: 1, dia_sin_atencion: 1, dentro: 1 });

    const q8 = (await runTagged('Q8', base))[0];
    const q8w = await runTagged('Q8w', base);
    assert.equal(sum(q8w, 'ejecuciones'), Number(q8.ejecuciones));
    assert.equal(sum(q8w, 'con_error'), Number(q8.con_error));
    assert.equal(Number(q8.con_error), 2);

    // A site with NO weekly hours: Q5 would call every bot booking «fuera»; Q5h says sin_horario.
    await query(`UPDATE sites SET opening_hours = '{}'::jsonb WHERE id = $1`, [s.siteId]);
    const q5hNone = Object.fromEntries((await runTagged('Q5h', base)).map((r) => [String(r.franja), Number(r.reservas)]));
    assert.deepEqual(q5hNone, { sin_horario: 4 });
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('Q2d per day sums to Q2 (same population and classes)', async () => {
  const s = await seedScenario();
  try {
    await seedWorkflow(s.tenantId, s.clientId, 'wf-c');
    const mk = async (ref: string) => (await query<{ id: string }>(`INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref) VALUES ($1, 'wf-c', $2) RETURNING id`, [s.tenantId, ref])).rows[0].id;
    const msg = (c: string, sender: string, at: string) =>
      query(`INSERT INTO handoff_messages (tenant_id, conversation_id, sender, text, status, occurred_at) VALUES ($1, $2, $3, 'x', $4, $5)`, [s.tenantId, c, sender, sender === 'user' ? 'received' : 'sent', at]);
    const c1 = await mk('a'); await msg(c1, 'user', '2026-10-01T15:00:00Z'); await msg(c1, 'bot', '2026-10-01T15:00:20Z');
    const c2 = await mk('b'); await msg(c2, 'user', '2026-10-02T15:00:00Z'); await msg(c2, 'human_agent', '2026-10-02T15:01:00Z');
    const c3 = await mk('c'); await msg(c3, 'user', '2026-10-03T15:00:00Z');
    const c4 = await mk('d');
    await appt(s, s.clientId, { origin: 'n8n', createdAt: '2026-10-04T15:00:00Z', startAt: '2026-10-06T15:00:00Z', conv: c4 });
    const params = { tenant: s.tenantId, client: s.clientId, from: '2026-09-20T05:00:00Z', to: '2026-10-20T05:00:00Z', now: NOW.toISOString(), ventana: '30 minutes', tz: 'America/Bogota' };
    const q2 = (await runTagged('Q2', params))[0];
    const q2d = await runTagged('Q2d', params);
    for (const k of ['con_intervencion_humana', 'con_intervencion_humana_y_cita_bot', 'u2_cita_bot', 'en_curso', 'u1_respondida_por_bot', 'con_turnos_sin_respuesta'])
      assert.equal(q2d.reduce((n, r) => n + Number(r[k]), 0), Number(q2[k]), k);
    assert.equal(Number(q2.u1_respondida_por_bot), 1);
    assert.equal(Number(q2.u2_cita_bot), 1);
    assert.equal(Number(q2.con_intervencion_humana), 1);
    assert.equal(Number(q2.con_turnos_sin_respuesta), 1);
    assert.deepEqual(q2d.map((r) => r.dia).sort(), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

/* ------------------------------------------------------------- assumptions -- */

const VALUES = { minConversacionAtendida: 3, minConversacionConCita: 8, minAgendarManual: 5, costoHora: 18000, effectiveFrom: '2026-10-01' };

test('assumptions: agency proposes but cannot confirm; owner confirms; setter/other client refused; append-only', async () => {
  const s = await seedScenario();
  const other = await seedScenario();
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    const ownerOfB = await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'owner' });
    const foreign = await seedMember(other.tenantId, { role: 'owner' });
    await appt(s, s.clientId, { origin: 'public', createdAt: '2026-10-05T15:00:00Z', startAt: '2026-10-08T15:00:00Z' });
    await appt(s, s.clientId, { origin: 'public', createdAt: '2026-09-25T15:00:00Z', startAt: '2026-09-28T15:00:00Z' }); // before effective_from

    asUser(agency);
    const before = await buildValueDashboard(s.clientId, P30, NOW);
    assert.ok(before.ok && before.data.assumptions.versions.length === 0, 'no defaults: nothing until someone proposes');

    const prop = await proposeValueAssumptionsAction(s.clientId, VALUES);
    assert.ok(prop.ok, 'agency proposes');
    assert.deepEqual(await confirmValueAssumptionsAction(s.clientId, { ...VALUES, proposalId: prop.ok ? prop.id : null }), {
      ok: false,
      error: 'Solo el dueño del negocio puede confirmar los supuestos.',
    });

    for (const id of [setter, ownerOfB, foreign]) {
      asUser(id);
      assert.equal((await proposeValueAssumptionsAction(s.clientId, VALUES)).ok, false, 'refused propose');
      assert.equal((await confirmValueAssumptionsAction(s.clientId, VALUES)).ok, false, 'refused confirm');
    }
    asUser(owner);
    assert.equal((await confirmValueAssumptionsAction(s.clientId, { ...VALUES, minAgendarManual: 999 })).ok, false, 'server validates ranges');
    assert.equal((await confirmValueAssumptionsAction(s.clientId, { ...VALUES, effectiveFrom: '2026-02-30' })).ok, false, 'server validates dates');
    const conf = await confirmValueAssumptionsAction(s.clientId, { ...VALUES, proposalId: prop.ok ? prop.id : null });
    assert.ok(conf.ok, 'owner confirms');

    const rows = await query<{ status: string; proposed_by: string; confirmed_by: string | null; based_on_id: string | null }>(
      `SELECT status, proposed_by, confirmed_by, based_on_id FROM value_estimate_assumptions WHERE tenant_id = $1 ORDER BY created_at`,
      [s.tenantId],
    );
    assert.equal(rows.rows.length, 2, 'proposal + confirmation are two rows');
    assert.equal(rows.rows[1].proposed_by, agency, 'confirmation keeps the agency as proposer');
    assert.equal(rows.rows[1].confirmed_by, owner);
    assert.ok(rows.rows[1].based_on_id);
    await assert.rejects(query(`UPDATE value_estimate_assumptions SET costo_hora = 1 WHERE tenant_id = $1`, [s.tenantId]), /append-only/);

    // The estimate uses only the days from effective_from: 1 public booking (5 min), not 2.
    const after1 = await buildValueDashboard(s.clientId, P30, NOW);
    assert.ok(after1.ok);
    const { computeEstimate } = await import('../../src/analytics/valueDashboardModel.js');
    const e = computeEstimate(after1.data.units, after1.data.assumptions.versions, after1.data.evidence.enabled);
    assert.equal(e.state, 'confirmed');
    assert.equal(e.publicOnly, true, 'without evidence only U3');
    assert.equal(e.minutes, 5);
    assert.equal(e.value, 1500);
    assert.equal(e.coveredDays, 19, '1–19 oct');

    // A proposal for another client's id cannot be used to forge a based_on link.
    const foreignProp = await query<{ id: string }>(
      `INSERT INTO value_estimate_assumptions (tenant_id, client_id, status, min_conversacion_atendida, min_conversacion_con_cita, min_agendar_manual, costo_hora, effective_from, proposed_by)
       VALUES ($1, $2, 'proposed', 3, 8, 5, 18000, '2026-10-01', 'x') RETURNING id`,
      [s.tenantId, s.otherClientId],
    );
    const c2 = await confirmValueAssumptionsAction(s.clientId, { ...VALUES, proposalId: foreignProp.rows[0].id });
    assert.ok(c2.ok);
    const last = await query<{ based_on_id: string | null; client_id: string }>(`SELECT based_on_id, client_id FROM value_estimate_assumptions WHERE id = $1`, [c2.ok ? c2.id : '']);
    assert.equal(last.rows[0].based_on_id, null);
    assert.equal(last.rows[0].client_id, s.clientId);
  } finally {
    await cleanupTenant(s.tenantId);
    await cleanupTenant(other.tenantId);
  }
});

test('owners: each business owner opens and confirms ONLY their own business', async () => {
  const s = await seedScenario();
  try {
    const ownerA = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    const ownerB = await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'owner' });

    asUser(ownerA);
    const a = await buildValueDashboard(s.clientId, P30, NOW);
    assert.ok(a.ok && a.data.viewer === 'owner' && a.data.canConfirm, 'owner A opens A and may confirm');
    const confA = await confirmValueAssumptionsAction(s.clientId, VALUES);
    assert.ok(confA.ok, 'owner A confirms A');
    assert.deepEqual(await buildValueDashboard(s.otherClientId, P30, NOW), { ok: false, status: 404, error: 'not_found' }, 'owner A cannot open B');
    assert.equal((await confirmValueAssumptionsAction(s.otherClientId, VALUES)).ok, false, 'owner A cannot confirm for B');

    asUser(ownerB);
    const b = await buildValueDashboard(s.otherClientId, P30, NOW);
    assert.ok(b.ok && b.data.canConfirm, 'owner B opens B and may confirm');
    assert.ok((await confirmValueAssumptionsAction(s.otherClientId, VALUES)).ok, 'owner B confirms B');
    assert.deepEqual(await buildValueDashboard(s.clientId, P30, NOW), { ok: false, status: 404, error: 'not_found' }, 'owner B cannot open A');
    assert.equal((await confirmValueAssumptionsAction(s.clientId, VALUES)).ok, false, 'owner B cannot confirm for A');
    assert.equal((await proposeValueAssumptionsAction(s.clientId, VALUES)).ok, false, 'owner B cannot propose for A');

    // Each confirmation landed on its own client, confirmed by its own owner.
    const rows = await query<{ client_id: string; confirmed_by: string }>(
      `SELECT client_id, confirmed_by FROM value_estimate_assumptions WHERE tenant_id = $1 AND status = 'confirmed' ORDER BY created_at`,
      [s.tenantId],
    );
    assert.deepEqual(rows.rows, [
      { client_id: s.clientId, confirmed_by: ownerA },
      { client_id: s.otherClientId, confirmed_by: ownerB },
    ]);
  } finally {
    await cleanupTenant(s.tenantId);
  }
});
