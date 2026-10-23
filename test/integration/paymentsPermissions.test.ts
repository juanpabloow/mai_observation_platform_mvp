import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedMember, seedScenario } from './fixtures.js';
import { ensureClientPaymentMethods } from '../../src/db/repositories/scheduling/paymentMethods.js';
import { recordPaymentForCompleted } from '../../src/scheduling/payments.js';

/**
 * PY-1 §3 — the PERMISSION MATRIX, by hitting the server actions directly (real scope, stubbed
 * session + Next boundaries, mirroring pipelineActions.test.ts). Record = agency/owner/setter;
 * Staff may complete WITHOUT payment (own column) but never records money and never sees it;
 * the Setter can record but not void and never receives commission fields; void + settings are
 * agency/owner only; isolation holds between clients.
 */
let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: { getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null) },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), { namedExports: { redirect: () => { throw new Error('redirect'); }, notFound: () => { throw new Error('notFound'); } } });
mock.module(urlOf('next/headers'), { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) } });
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
const asUser = (id: string) => { CURRENT = { id, email: `${id.slice(0, 8)}@test.local` }; };

const {
  completeWithPaymentAction,
  recordPendingPaymentAction,
  voidPaymentAction,
  getAppointmentPaymentAction,
  listPendingPaymentsAction,
  addPaymentMethodAction,
  updateStaffCommissionAction,
} = await import('../../web/lib/paymentActions.js');
const { completeAppointmentAction } = await import('../../web/lib/schedulingActions.js');
after(closeDb);

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await query<T>(sql, params)).rows[0];
type S = Awaited<ReturnType<typeof seedScenario>>;

let slot = 0;
async function seedAppt(s: S, o: { status?: string; staffId?: string; clientId?: string; siteId?: string; priceSnapshot?: string } = {}): Promise<string> {
  const startHours = 24 + slot++ * 2;
  const r = await one<{ id: string }>(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id,
        start_at, service_end_at, blocked_from, blocked_until,
        service_name_snapshot, duration_min_snapshot, price_snapshot, buffer_before_min_snapshot, buffer_after_min_snapshot,
        status, origin, created_by_type)
     VALUES ($1,$2,$3,$4,$5,
        now() + make_interval(hours => $8::int), now() + make_interval(hours => $8::int) + interval '60 min',
        now() + make_interval(hours => $8::int), now() + make_interval(hours => $8::int) + interval '60 min',
        'Haircut', 60, $7, 0, 0, $6, 'n8n', 'n8n')
     RETURNING id`,
    [s.tenantId, o.clientId ?? s.clientId, o.siteId ?? s.siteId, o.staffId ?? s.staffA, s.serviceHaircut, o.status ?? 'scheduled', o.priceSnapshot ?? '50000', startHours],
  );
  return r.id;
}

/** A client STAFF login bound to staffA's column. */
async function seedStaffMember(s: S): Promise<string> {
  const userId = randomUUID();
  await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)`, [userId, `S ${userId.slice(0, 6)}`, `${userId.slice(0, 8)}@test.local`]);
  await query(
    `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role, scheduling_site_id, scheduling_staff_id)
       VALUES ($1, $2, 'member', $3, 'staff', $4, $5)`,
    [s.tenantId, userId, s.clientId, s.siteId, s.staffA],
  );
  return userId;
}

const draft = { methodKey: 'efectivo', service: {} };
const statusOf = (id: string) => one<{ status: string }>(`SELECT status FROM appointments WHERE id = $1`, [id]);

async function base(): Promise<S & { agency: string; owner: string; setter: string; staff: string }> {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true });
  await ensureClientPaymentMethods(s.tenantId, s.clientId);
  await ensureClientPaymentMethods(s.tenantId, s.otherClientId);
  const agency = await seedMember(s.tenantId, { role: 'owner' });
  const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
  const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  const staff = await seedStaffMember(s);
  return Object.assign(s, { agency, owner, setter, staff });
}

// ── Complete WITH payment: agency ✓ / owner ✓ / setter ✓ / staff ✗ ────────────────
test('complete with payment: agency ✓ / owner ✓ / setter ✓ / staff ✗', async () => {
  const s = await base();
  try {
    const cases: Array<[string, string, boolean]> = [
      ['agency', s.agency, true],
      ['owner', s.owner, true],
      ['setter', s.setter, true],
      ['staff', s.staff, false],
    ];
    for (const [name, uid, expectOk] of cases) {
      const appt = await seedAppt(s);
      asUser(uid);
      const r = await completeWithPaymentAction(s.clientId, appt, draft);
      assert.equal(r.ok, expectOk, `${name} record ok=${expectOk}`);
      assert.equal((await statusOf(appt)).status, expectOk ? 'completed' : 'scheduled', `${name} completion`);
    }
  } finally { await cleanupTenant(s.tenantId); }
});

// ── Complete WITHOUT payment: Staff ✓ on its own column (no money) ─────────────────
test('staff can complete WITHOUT payment on its own column, but cannot record money', async () => {
  const s = await base();
  try {
    const appt = await seedAppt(s, { staffId: s.staffA });
    asUser(s.staff);
    // The existing completion action — no payment — succeeds for staff on their column.
    assert.equal((await completeAppointmentAction(s.clientId, appt)).ok, true);
    assert.equal((await statusOf(appt)).status, 'completed');
    // …but recording the pending payment is refused (no payments.record).
    const r = await recordPendingPaymentAction(s.clientId, appt, draft);
    assert.equal(r.ok, false, 'staff cannot record money');
    assert.equal(await one<{ n: string }>(`SELECT count(*)::text AS n FROM payments WHERE appointment_id=$1`, [appt]).then((x) => x.n), '0');
  } finally { await cleanupTenant(s.tenantId); }
});

// ── See a payment: setter ✓ (no commission) / owner ✓ (commission) / staff ✗ ───────
test('seeing a payment: setter gets no commission fields, owner does, staff is refused', async () => {
  const s = await base();
  try {
    await query(`UPDATE staff SET commission_pct_services = 10 WHERE id = $1`, [s.staffA]);
    const appt = await seedAppt(s, { status: 'completed', staffId: s.staffA });
    // Arrange a recorded payment through the engine (owner is a real user for the actor).
    const rec = await recordPaymentForCompleted({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, draft: { methodKey: 'efectivo', service: {} }, actor: { userId: s.owner } });
    assert.ok(rec.ok, rec.ok ? '' : rec.error);

    asUser(s.setter);
    const asSetter = await getAppointmentPaymentAction(s.clientId, appt);
    assert.ok(asSetter.ok && asSetter.value, 'setter sees the payment');
    assert.ok(asSetter.ok && asSetter.value && !('commissionPct' in asSetter.value.lines[0]), 'setter gets NO commission fields');

    asUser(s.owner);
    const asOwner = await getAppointmentPaymentAction(s.clientId, appt);
    assert.ok(asOwner.ok && asOwner.value && 'commissionPct' in asOwner.value.lines[0], 'owner gets commission fields');
    assert.equal(asOwner.ok && asOwner.value ? asOwner.value.lines[0].commissionPct : null, '10.00');

    asUser(s.staff);
    assert.equal((await getAppointmentPaymentAction(s.clientId, appt)).ok, false, 'staff cannot see payments');
  } finally { await cleanupTenant(s.tenantId); }
});

// ── Void: owner ✓ / setter ✗ / staff ✗ ────────────────────────────────────────────
test('void a payment: owner ✓ / setter ✗ / staff ✗', async () => {
  const s = await base();
  try {
    const appt = await seedAppt(s, { status: 'completed' });
    const rec = await recordPaymentForCompleted({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, draft: { methodKey: 'efectivo', service: {} }, actor: { userId: s.owner } });
    const paymentId = rec.ok ? rec.value.payment.id : '';

    asUser(s.setter);
    assert.equal((await voidPaymentAction(s.clientId, paymentId, 'x')).ok, false, 'setter cannot void');
    asUser(s.staff);
    assert.equal((await voidPaymentAction(s.clientId, paymentId, 'x')).ok, false, 'staff cannot void');
    assert.equal((await one<{ status: string }>(`SELECT status FROM payments WHERE id=$1`, [paymentId])).status, 'recorded', 'still recorded');
    asUser(s.owner);
    assert.equal((await voidPaymentAction(s.clientId, paymentId, 'cobro equivocado')).ok, true, 'owner voids');
    assert.equal((await one<{ status: string }>(`SELECT status FROM payments WHERE id=$1`, [paymentId])).status, 'voided');
  } finally { await cleanupTenant(s.tenantId); }
});

// ── Settings (methods + commission): owner ✓ / setter ✗ / staff ✗ ──────────────────
test('payment-method + commission settings: owner ✓ / setter ✗ / staff ✗', async () => {
  const s = await base();
  try {
    asUser(s.setter);
    assert.equal((await addPaymentMethodAction(s.clientId, 'PSE')).ok, false, 'setter cannot add a method');
    assert.equal((await updateStaffCommissionAction(s.clientId, s.staffA, 10, 5)).ok, false, 'setter cannot set commission');
    asUser(s.staff);
    assert.equal((await addPaymentMethodAction(s.clientId, 'PSE')).ok, false, 'staff cannot add a method');
    asUser(s.owner);
    assert.equal((await addPaymentMethodAction(s.clientId, 'PSE')).ok, true, 'owner adds a method');
    assert.equal((await updateStaffCommissionAction(s.clientId, s.staffA, 12.5, 5)).ok, true, 'owner sets commission');
    assert.equal((await one<{ c: string }>(`SELECT commission_pct_services::text AS c FROM staff WHERE id=$1`, [s.staffA])).c, '12.50');
  } finally { await cleanupTenant(s.tenantId); }
});

// ── Pending list: agency/owner/setter ✓ / staff ✗ ─────────────────────────────────
test('pending-payments list: agency/owner/setter ✓ / staff ✗', async () => {
  const s = await base();
  try {
    for (const [uid, ok] of [[s.agency, true], [s.owner, true], [s.setter, true], [s.staff, false]] as const) {
      asUser(uid);
      assert.equal((await listPendingPaymentsAction(s.clientId)).ok, ok);
    }
  } finally { await cleanupTenant(s.tenantId); }
});

// ── Isolation: a setter of A cannot record on B's appointment ──────────────────────
test('isolation: a setter of client A cannot act on client B at all', async () => {
  const s = await base();
  try {
    // The module gate refuses before any appointment is loaded: A's setter is not in B's scope.
    asUser(s.setter);
    assert.equal((await recordPendingPaymentAction(s.otherClientId, randomUUID(), draft)).ok, false, 'cross-client record refused');
    assert.equal((await listPendingPaymentsAction(s.otherClientId)).ok, false, 'cross-client pending list refused');
  } finally { await cleanupTenant(s.tenantId); }
});
