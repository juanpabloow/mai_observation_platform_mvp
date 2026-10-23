import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedMember, seedScenario } from './fixtures.js';
import { ensureClientPaymentMethods } from '../../src/db/repositories/scheduling/paymentMethods.js';
import { paymentStatesForAppointments } from '../../src/db/repositories/scheduling/payments.js';
import { setPaymentsTrackingStartedAt } from '../../src/db/repositories/scheduling/paymentSettings.js';

/**
 * PY-2 — the charge step INSIDE the agenda's «Completar cita», through the server actions with
 * a real scope (stubbed session + Next boundaries, as paymentsPermissions.test.ts). Pins what
 * the agenda adds on top of PY-1: completing with a charge never bypasses «only once it has
 * started», agenda.book or the appointment's reach; methods/products that stopped being offered
 * are refused with NOTHING applied; one charge under double submits; void → pending → record
 * again with history kept; «Cobro pendiente» respects the tracking start; permissions come from
 * the role's PERMISSIONS (custom roles), never its name; isolation between businesses.
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
const asUser = (id: string | null) => { CURRENT = id ? { id, email: `${id.slice(0, 8)}@test.local` } : null; };

const {
  completeWithPaymentAction,
  recordPendingPaymentAction,
  voidPaymentAction,
  getAppointmentPaymentHistoryAction,
  listCheckoutOptionsAction,
  listPendingPaymentsAction,
  setPaymentMethodActiveAction,
} = await import('../../web/lib/paymentActions.js');
const { completeAppointmentAction } = await import('../../web/lib/schedulingActions.js');

after(closeDb);
const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await query<T>(sql, params)).rows[0];
type S = Awaited<ReturnType<typeof seedScenario>>;

let slot = 0;
/** `hours` from now (negative = already started). Each slot is 60 min, 2 h apart (no overlap). */
async function appt(s: S, o: { hours?: number; price?: string | null; clientId?: string; siteId?: string; staffId?: string } = {}): Promise<string> {
  const h = o.hours ?? -(2 + slot++ * 2);
  const r = await one<{ id: string }>(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id,
        start_at, service_end_at, blocked_from, blocked_until,
        service_name_snapshot, duration_min_snapshot, price_snapshot, buffer_before_min_snapshot, buffer_after_min_snapshot,
        status, origin, created_by_type)
     VALUES ($1,$2,$3,$4,$5,
        now() + make_interval(mins => ($7::numeric * 60)::int), now() + make_interval(mins => ($7::numeric * 60)::int + 60),
        now() + make_interval(mins => ($7::numeric * 60)::int), now() + make_interval(mins => ($7::numeric * 60)::int + 60),
        'Haircut', 60, $6, 0, 0, 'confirmed', 'internal', 'agent')
     RETURNING id`,
    [s.tenantId, o.clientId ?? s.clientId, o.siteId ?? s.siteId, o.staffId ?? s.staffA, s.serviceHaircut, o.price === undefined ? '50000' : o.price, h],
  );
  return r.id;
}
const statusOf = (id: string) => one<{ status: string }>(`SELECT status FROM appointments WHERE id = $1`, [id]).then((r) => r.status);
const paymentsOf = (id: string) => one<{ n: string }>(`SELECT count(*)::text AS n FROM payments WHERE appointment_id = $1`, [id]).then((r) => Number(r.n));
const product = (s: S, price: string, active = true) =>
  one<{ id: string }>(`INSERT INTO products (tenant_id, client_id, name, price, in_stock, is_active) VALUES ($1,$2,$3,$4,true,$5) RETURNING id`, [s.tenantId, s.clientId, `P-${randomUUID().slice(0, 6)}`, price, active]).then((r) => r.id);

/** A CUSTOM role (permissions, not a name) given to a fresh login of this client. */
async function customLogin(s: S, permissions: string[]): Promise<string> {
  const userId = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  const role = await one<{ id: string }>(`INSERT INTO access_roles (tenant_id, client_id, name, description) VALUES ($1,$2,$3,'test') RETURNING id`, [s.tenantId, s.clientId, `Rol ${randomUUID().slice(0, 6)}`]);
  for (const k of permissions) await query(`INSERT INTO access_role_permissions (role_id, permission_key) VALUES ($1,$2)`, [role.id, k]);
  await query(`UPDATE tenant_members SET client_role = 'custom', access_role_id = $3 WHERE tenant_id = $1 AND user_id = $2`, [s.tenantId, userId, role.id]);
  return userId;
}

async function base() {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true });
  await ensureClientPaymentMethods(s.tenantId, s.clientId);
  await ensureClientPaymentMethods(s.tenantId, s.otherClientId);
  await query(`INSERT INTO client_modules (tenant_id, client_id, module_key, enabled) VALUES ($1,$2,'catalog',true) ON CONFLICT (tenant_id, client_id, module_key) DO UPDATE SET enabled = true`, [s.tenantId, s.clientId]).catch(() => undefined);
  const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
  const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  return Object.assign(s, { owner, setter });
}
const draft = (over: Record<string, unknown> = {}) => ({ methodKey: 'efectivo', service: {}, ...over });

test('completing with a charge NEVER happens before the appointment starts — nothing is written', async () => {
  const s = await base();
  try {
    asUser(s.setter);
    const future = await appt(s, { hours: 3 });
    const r = await completeWithPaymentAction(s.clientId, future, draft());
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error, 'Se puede completar cuando la cita empiece.');
    assert.equal(await statusOf(future), 'confirmed', 'not completed');
    assert.equal(await paymentsOf(future), 0, 'no payment');
    // The no-charge path refuses it too (the existing rule).
    assert.equal((await completeAppointmentAction(s.clientId, future)).ok, false);
    const started = await appt(s);
    assert.equal((await completeWithPaymentAction(s.clientId, started, draft())).ok, true, 'a started one completes and is charged');
    assert.equal(await statusOf(started), 'completed');
  } finally { await cleanupTenant(s.tenantId); }
});

test('custom roles: the PERMISSIONS decide — payments.record is void without agenda.book (catalogue requirement); a full custom cashier records but sees no commission', async () => {
  const s = await base();
  try {
    // payments.record requires payments.view + agenda.book in the catalogue: without agenda.book
    // the key has no effect, so neither completing with a charge nor recording one works.
    const noBook = await customLogin(s, ['agenda.view', 'payments.view', 'payments.record']);
    const cashier = await customLogin(s, ['agenda.view', 'agenda.book', 'payments.view', 'payments.record']);
    const viewOnly = await customLogin(s, ['agenda.view', 'agenda.book', 'payments.view']);
    const a1 = await appt(s);
    asUser(noBook);
    assert.equal((await completeWithPaymentAction(s.clientId, a1, draft())).ok, false, 'no agenda.book → no completion with a charge');
    assert.equal(await statusOf(a1), 'confirmed');
    asUser(s.owner);
    assert.equal((await completeAppointmentAction(s.clientId, a1)).ok, true);
    asUser(noBook);
    assert.equal((await recordPendingPaymentAction(s.clientId, a1, draft())).ok, false, 'payments.record without its requirement does nothing');
    asUser(cashier);
    assert.equal((await recordPendingPaymentAction(s.clientId, a1, draft())).ok, true, 'a valid custom role records');
    const hist = await getAppointmentPaymentHistoryAction(s.clientId, a1);
    assert.ok(hist.ok);
    assert.equal(hist.ok && hist.value[0].lines[0].commissionPct, undefined, 'no commission fields without commissions.view');
    assert.equal(hist.ok && hist.value[0].methodLabel, 'Efectivo');
    const a2 = await appt(s);
    assert.equal((await completeWithPaymentAction(s.clientId, a2, draft())).ok, true, 'the custom cashier completes with a charge');
    const a3 = await appt(s);
    asUser(viewOnly);
    assert.equal((await completeWithPaymentAction(s.clientId, a3, draft())).ok, false, 'payments.view alone records nothing');
    assert.equal((await listCheckoutOptionsAction(s.clientId)).ok, false, 'the charge step is payments.record');
    assert.equal(await statusOf(a3), 'confirmed');
  } finally { await cleanupTenant(s.tenantId); }
});

test('a method deactivated (or a product archived) between opening and saving is refused — and NOTHING completes', async () => {
  const s = await base();
  try {
    asUser(s.owner);
    const opts = await listCheckoutOptionsAction(s.clientId);
    assert.ok(opts.ok && opts.value.methods.some((m) => m.key === 'efectivo'));
    const efectivo = await one<{ id: string }>(`SELECT id FROM payment_methods WHERE tenant_id=$1 AND client_id=$2 AND key='efectivo'`, [s.tenantId, s.clientId]);
    assert.equal((await setPaymentMethodActiveAction(s.clientId, efectivo.id, false)).ok, true);
    const a = await appt(s);
    asUser(s.setter);
    const r = await completeWithPaymentAction(s.clientId, a, draft());
    assert.equal(r.ok, false);
    assert.equal(r.ok ? '' : r.error, 'Ese método de pago no está activo.');
    assert.equal(await statusOf(a), 'confirmed', 'atomic: not completed');
    assert.equal(await paymentsOf(a), 0);

    const archived = await product(s, '20000', false);
    const r2 = await completeWithPaymentAction(s.clientId, a, draft({ methodKey: 'tarjeta', products: [{ productId: archived, quantity: 1, unitCharged: 20000 }] }));
    assert.equal(r2.ok, false);
    assert.equal(r2.ok ? '' : r2.error, 'Un producto del cobro ya no está activo. Quítalo o elige otro.');
    assert.equal(await statusOf(a), 'confirmed', 'atomic: not completed');
    asUser(s.owner);
    const listed = await listCheckoutOptionsAction(s.clientId);
    assert.ok(listed.ok && !listed.value.products.some((p) => p.id === archived), 'archived products are not offered');
    assert.ok(listed.ok && !listed.value.methods.some((m) => m.key === 'efectivo'), 'deactivated methods are not offered');
  } finally { await cleanupTenant(s.tenantId); }
});

test('double click / two operators: exactly ONE charge and one completion', async () => {
  const s = await base();
  try {
    const a = await appt(s);
    asUser(s.setter);
    const p = await product(s, '15000');
    const d = draft({ products: [{ productId: p, quantity: 3, unitCharged: 15000 }] });
    const results = await Promise.all([completeWithPaymentAction(s.clientId, a, d), completeWithPaymentAction(s.clientId, a, d)]);
    assert.equal(results.filter((r) => r.ok).length, 1, 'one wins');
    assert.equal(await paymentsOf(a), 1);
    const ok = results.find((r) => r.ok);
    assert.equal(ok && ok.ok ? Number(ok.value.total) : 0, 50000 + 3 * 15000, 'total computed by the server: service + products × quantity');
  } finally { await cleanupTenant(s.tenantId); }
});

test('unknown price needs an amount; a free service charges 0; under the price needs a reason', async () => {
  const s = await base();
  try {
    asUser(s.setter);
    const unknown = await appt(s, { price: null });
    assert.equal((await completeWithPaymentAction(s.clientId, unknown, draft())).ok, false, 'unknown is not $0');
    assert.equal(await statusOf(unknown), 'confirmed');
    assert.equal((await completeWithPaymentAction(s.clientId, unknown, draft({ service: { unitCharged: 42000 } }))).ok, true);
    const free = await appt(s, { price: '0' });
    const f = await completeWithPaymentAction(s.clientId, free, draft({ service: { unitCharged: 0 } }));
    assert.ok(f.ok && Number(f.value.total) === 0, 'a free service is a real 0');
    const disc = await appt(s);
    assert.equal((await completeWithPaymentAction(s.clientId, disc, draft({ service: { unitCharged: 40000 } }))).ok, false, 'a discount needs a reason');
    assert.equal((await completeWithPaymentAction(s.clientId, disc, draft({ service: { unitCharged: 40000, adjustmentReason: 'otro' } }))).ok, false, '«otro» needs a note');
    const ok = await completeWithPaymentAction(s.clientId, disc, draft({ service: { unitCharged: 40000, adjustmentReason: 'otro', adjustmentNote: 'cliente frecuente' } }));
    assert.ok(ok.ok && ok.value.lines[0].adjustmentNote === 'cliente frecuente');
    // The appointment's stored price never changes.
    assert.equal((await one<{ p: string }>(`SELECT price_snapshot::text AS p FROM appointments WHERE id=$1`, [disc])).p, '50000.00');
  } finally { await cleanupTenant(s.tenantId); }
});

test('void → «cobro pendiente» → record again, with the voided record kept in the history', async () => {
  const s = await base();
  try {
    const a = await appt(s);
    asUser(s.setter);
    const first = await completeWithPaymentAction(s.clientId, a, draft());
    assert.ok(first.ok);
    assert.equal((await voidPaymentAction(s.clientId, first.ok ? first.value.id : '', 'x')).ok, false, 'the setter cannot void');
    asUser(s.owner);
    assert.equal((await voidPaymentAction(s.clientId, first.ok ? first.value.id : '', '')).ok, false, 'a reason is required');
    assert.equal((await voidPaymentAction(s.clientId, first.ok ? first.value.id : '', 'método equivocado')).ok, true);
    assert.equal((await paymentStatesForAppointments(s.tenantId, s.clientId, [a])).get(a) ?? null, null, 'before the tracking start: voided → not tracked as pending');
    await setPaymentsTrackingStartedAt(s.tenantId, s.clientId, new Date(Date.now() - 30 * 86_400_000));
    assert.equal((await paymentStatesForAppointments(s.tenantId, s.clientId, [a])).get(a), 'pending', 'voided → pending again');
    assert.equal(await statusOf(a), 'completed', 'voiding never un-completes');
    asUser(s.setter);
    assert.equal((await recordPendingPaymentAction(s.clientId, a, draft({ methodKey: 'tarjeta' }))).ok, true);
    assert.equal((await paymentStatesForAppointments(s.tenantId, s.clientId, [a])).get(a), 'recorded');
    const hist = await getAppointmentPaymentHistoryAction(s.clientId, a);
    assert.ok(hist.ok);
    assert.deepEqual(hist.ok ? hist.value.map((p) => p.status) : [], ['recorded', 'voided'], 'newest first, the void kept');
    assert.equal(hist.ok ? hist.value[1].voidReason : null, 'método equivocado');
  } finally { await cleanupTenant(s.tenantId); }
});

test('«cobro pendiente» counts only completed appointments since tracking started; history is never invented', async () => {
  const s = await base();
  try {
    asUser(s.owner);
    const old = await appt(s, { hours: -24 * 10 });
    const recent = await appt(s);
    for (const id of [old, recent]) assert.equal((await completeAppointmentAction(s.clientId, id)).ok, true);
    await setPaymentsTrackingStartedAt(s.tenantId, s.clientId, new Date(Date.now() - 2 * 86_400_000));
    const states = await paymentStatesForAppointments(s.tenantId, s.clientId, [old, recent]);
    assert.equal(states.get(old), undefined, 'before tracking: not pending');
    assert.equal(states.get(recent), 'pending');
    const list = await listPendingPaymentsAction(s.clientId);
    assert.ok(list.ok && list.items.some((x) => x.appointmentId === recent) && !list.items.some((x) => x.appointmentId === old));
  } finally { await cleanupTenant(s.tenantId); }
});

test('isolation: another business\'s appointment or payment is out of reach for every payment action', async () => {
  const s = await base();
  try {
    const otherSite = await one<{ id: string }>(`SELECT id FROM sites WHERE tenant_id=$1 AND client_id=$2 LIMIT 1`, [s.tenantId, s.otherClientId]).catch(() => null);
    asUser(s.setter);
    const mine = await appt(s);
    // Using MY client id with an id that is not of this client.
    assert.equal((await completeWithPaymentAction(s.clientId, randomUUID(), draft())).ok, false);
    assert.equal((await getAppointmentPaymentHistoryAction(s.otherClientId, mine)).ok, false, 'not my business');
    assert.equal((await completeWithPaymentAction(s.otherClientId, mine, draft())).ok, false);
    assert.equal(await statusOf(mine), 'confirmed');
    void otherSite;
    asUser(null);
    // Logged out: the gate redirects (throws) or refuses — either way nothing is offered.
    const anon = await listCheckoutOptionsAction(s.clientId).catch(() => ({ ok: false as const }));
    assert.equal(anon.ok, false, 'anonymous');
  } finally { await cleanupTenant(s.tenantId); }
});
