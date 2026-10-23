import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedContact, seedScenario } from './fixtures.js';
import { ensureClientPaymentMethods } from '../../src/db/repositories/scheduling/paymentMethods.js';
import { getPaymentById, getRecordedPaymentForAppointment, listPaymentLines } from '../../src/db/repositories/scheduling/payments.js';
import { listPendingPaymentAppointments, setPaymentsTrackingStartedAt } from '../../src/db/repositories/scheduling/paymentSettings.js';
import { getOpportunityById, listOpportunityStageEvents } from '../../src/db/repositories/pipeline.js';
import {
  completeWithPayment,
  completeWithoutPayment,
  recordPaymentForCompleted,
  voidPayment,
  type PaymentDraft,
} from '../../src/scheduling/payments.js';

/**
 * PY-1 payments engine against the real DB. Each test seeds its own tenant and drops it.
 * Payments are written atomically with completion; the value dashboard's source numbers never
 * change; commission is snapshotted per line; the pipeline moves attended → paid → attended.
 */

const tenants: string[] = [];
after(async () => { for (const t of tenants) await cleanupTenant(t); await closeDb(); });

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await query<T>(sql, params)).rows[0];
type S = Awaited<ReturnType<typeof seedScenario>>;

async function setup(): Promise<S> {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true });
  tenants.push(s.tenantId);
  await ensureClientPaymentMethods(s.tenantId, s.clientId);
  await ensureClientPaymentMethods(s.tenantId, s.otherClientId);
  return s;
}

let slot = 0;
async function seedAppt(
  s: S,
  o: { status?: string; priceSnapshot?: string | null; staffId?: string; contactId?: string | null; opportunityId?: string | null; startHours?: number } = {},
): Promise<string> {
  const startHours = o.startHours ?? 24 + slot++ * 2;
  const r = await one<{ id: string }>(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id,
        start_at, service_end_at, blocked_from, blocked_until,
        service_name_snapshot, duration_min_snapshot, price_snapshot, buffer_before_min_snapshot, buffer_after_min_snapshot,
        status, origin, created_by_type, contact_id, opportunity_id)
     VALUES ($1,$2,$3,$4,$5,
        now() + make_interval(hours => $10::int), now() + make_interval(hours => $10::int) + interval '60 min',
        now() + make_interval(hours => $10::int), now() + make_interval(hours => $10::int) + interval '60 min',
        'Haircut', 60, $6, 0, 0, $7, 'n8n', 'n8n', $8, $9)
     RETURNING id`,
    [s.tenantId, s.clientId, s.siteId, o.staffId ?? s.staffA, s.serviceHaircut,
      o.priceSnapshot === undefined ? '50000' : o.priceSnapshot, o.status ?? 'scheduled', o.contactId ?? null, o.opportunityId ?? null, startHours],
  );
  return r.id;
}

async function seedProduct(s: S, price: string, name = `P-${randomUUID().slice(0, 6)}`, inStock = true): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO products (tenant_id, client_id, name, price, in_stock) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [s.tenantId, s.clientId, name, price, inStock],
  );
  return r.id;
}

async function seedOpp(s: S, stage: string, appointmentId: string): Promise<string> {
  const contact = await seedContact(s.tenantId, s.clientId, { channelUserId: `wa:${randomUUID().slice(0, 8)}` });
  const r = await one<{ id: string }>(
    `INSERT INTO opportunities (tenant_id, client_id, contact_id, status, stage, lead_at, booked_at)
       VALUES ($1,$2,$3,'open',$4, now(), now()) RETURNING id`,
    [s.tenantId, s.clientId, contact, stage],
  );
  await query(`UPDATE appointments SET opportunity_id = $2 WHERE id = $1`, [appointmentId, r.id]);
  return r.id;
}

// The transition writes appointment_events.actor_user_id (FK → "user"), so the payment actor
// must be a real user. One per tenant is enough.
const userCache = new Map<string, string>();
async function actorFor(s: S): Promise<{ userId: string }> {
  let u = userCache.get(s.tenantId);
  if (!u) {
    u = randomUUID();
    await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1,$2,$3,true)`, [u, `U ${u.slice(0, 6)}`, `${u.slice(0, 8)}@test.local`]);
    userCache.set(s.tenantId, u);
  }
  return { userId: u };
}
const statusOf = (id: string) => one<{ status: string }>(`SELECT status FROM appointments WHERE id = $1`, [id]);
const completedValor = (s: S) =>
  one<{ n: string; valor: string }>(
    `SELECT count(*) FILTER (WHERE status='completed')::text AS n,
            COALESCE(SUM(price_snapshot) FILTER (WHERE status='completed'), 0)::text AS valor
       FROM appointments WHERE tenant_id = $1 AND client_id = $2`,
    [s.tenantId, s.clientId],
  );

const draft = (over: Partial<PaymentDraft> = {}): PaymentDraft => ({ methodKey: 'efectivo', service: {}, ...over });

// ── 1. complete with payment: service only ────────────────────────────────────────
test('complete with payment — service only: appointment completed + one recorded payment', async () => {
  const s = await setup();
  const appt = await seedAppt(s, { priceSnapshot: '50000' });
  const r = await completeWithPayment({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, draft: draft(), actor: await actorFor(s) });
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.equal((await statusOf(appt)).status, 'completed');
  assert.equal(r.value.payment.status, 'recorded');
  assert.equal(r.value.payment.total, '50000.00');
  assert.equal(r.value.lines.length, 1);
  assert.equal(r.value.lines[0].kind, 'service');
  assert.equal(r.value.lines[0].line_total, '50000.00');
});

// ── 2. service + products with quantities; total computed server-side ──────────────
test('complete with payment — service + products with quantities; total is server-side', async () => {
  const s = await setup();
  const appt = await seedAppt(s, { priceSnapshot: '50000' });
  const prodA = await seedProduct(s, '10000');
  const prodB = await seedProduct(s, '8000');
  const r = await completeWithPayment({
    tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, actor: await actorFor(s),
    draft: draft({ products: [{ productId: prodA, quantity: 2, unitCharged: 10000 }, { productId: prodB, quantity: 3, unitCharged: 8000 }] }),
  });
  assert.ok(r.ok, r.ok ? '' : r.error);
  // 50000 + 2×10000 + 3×8000 = 94000 — computed from the lines, not from any client input.
  assert.equal(r.value.payment.total, '94000.00');
  assert.equal(r.value.lines.length, 3);
  const prodLines = r.value.lines.filter((l) => l.kind === 'product');
  assert.equal(prodLines.find((l) => l.product_id === prodA)?.line_total, '20000.00');
  assert.equal(prodLines.find((l) => l.product_id === prodB)?.line_total, '24000.00');
});

// ── 3. adjustment reason enforced; atomicity (nothing completes on an invalid draft) ──
test('adjustment reason enforced below list price, and an invalid draft completes nothing', async () => {
  const s = await setup();
  const appt = await seedAppt(s, { priceSnapshot: '50000' });
  const under = await completeWithPayment({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, actor: await actorFor(s), draft: draft({ service: { unitCharged: 30000 } }) });
  assert.equal(under.ok, false);
  assert.equal(under.ok ? '' : under.error, 'adjustment_required');
  assert.equal((await statusOf(appt)).status, 'scheduled', 'ATOMIC: the appointment did NOT complete');
  assert.equal(await getRecordedPaymentForAppointment(s.tenantId, s.clientId, appt), null, 'no payment written');

  const ok = await completeWithPayment({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, actor: await actorFor(s), draft: draft({ service: { unitCharged: 30000, adjustmentReason: 'cortesia' } }) });
  assert.ok(ok.ok, ok.ok ? '' : ok.error);
  assert.equal((await statusOf(appt)).status, 'completed');
  assert.equal(ok.value.lines[0].adjustment_reason, 'cortesia');
});

// ── 4. null price_snapshot requires an amount ──────────────────────────────────────
test('a null price_snapshot requires an explicit service amount', async () => {
  const s = await setup();
  const appt = await seedAppt(s, { priceSnapshot: null });
  const missing = await completeWithPayment({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, actor: await actorFor(s), draft: draft() });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok ? '' : missing.error, 'invalid_amount');
  assert.equal((await statusOf(appt)).status, 'scheduled');

  const ok = await completeWithPayment({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, actor: await actorFor(s), draft: draft({ service: { unitCharged: 40000 } }) });
  assert.ok(ok.ok, ok.ok ? '' : ok.error);
  assert.equal(ok.value.lines[0].unit_list_price, null);
  assert.equal(ok.value.lines[0].unit_charged, '40000.00');
});

// ── 5. one payment per appointment, under concurrency ──────────────────────────────
test('at most one recorded payment per appointment (concurrency-safe)', async () => {
  const s = await setup();
  const appt = await seedAppt(s, { status: 'completed', priceSnapshot: '50000' });
  const [a, b] = await Promise.allSettled([
    recordPaymentForCompleted({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, draft: draft(), actor: await actorFor(s) }),
    recordPaymentForCompleted({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, draft: draft(), actor: await actorFor(s) }),
  ]);
  const oks = [a, b].filter((r) => r.status === 'fulfilled' && r.value.ok).length;
  assert.equal(oks, 1, 'exactly one succeeded');
  const count = await one<{ n: string }>(`SELECT count(*)::text AS n FROM payments WHERE tenant_id=$1 AND appointment_id=$2 AND status='recorded'`, [s.tenantId, appt]);
  assert.equal(count.n, '1');
});

// ── 6. complete without payment → pending only after the tracking date; then record it ──
test('complete without payment → cobro pendiente only on/after the tracking date', async () => {
  const s = await setup();
  await setPaymentsTrackingStartedAt(s.tenantId, s.clientId, new Date()); // track from "now"
  const future = await seedAppt(s, { startHours: 48 }); // starts after the tracking date
  const past = await seedAppt(s, { startHours: -200 }); // started well before it

  assert.ok((await completeWithoutPayment({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: future, actor: await actorFor(s) })).ok);
  assert.ok((await completeWithoutPayment({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: past, actor: await actorFor(s) })).ok);

  let pending = await listPendingPaymentAppointments(s.tenantId, s.clientId);
  const ids = pending.map((p) => p.appointment_id);
  assert.ok(ids.includes(future), 'the future appointment is pending');
  assert.ok(!ids.includes(past), 'the pre-tracking appointment is NOT pending');

  // Recording the future one's payment removes it from the pending list.
  assert.ok((await recordPaymentForCompleted({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: future, draft: draft(), actor: await actorFor(s) })).ok);
  pending = await listPendingPaymentAppointments(s.tenantId, s.clientId);
  assert.ok(!pending.map((p) => p.appointment_id).includes(future), 'no longer pending once paid');
});

// ── 7. void → pending again, history kept; a new payment can be recorded ────────────
test('void keeps history, returns the appointment to pending, and allows a fresh payment', async () => {
  const s = await setup();
  await setPaymentsTrackingStartedAt(s.tenantId, s.clientId, new Date(Date.now() - 86_400_000));
  const appt = await seedAppt(s, { status: 'completed', startHours: 2 });
  const rec = await recordPaymentForCompleted({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, draft: draft(), actor: await actorFor(s) });
  assert.ok(rec.ok, rec.ok ? '' : rec.error);
  const paymentId = rec.ok ? rec.value.payment.id : '';

  const v = await voidPayment({ tenantId: s.tenantId, clientId: s.clientId, paymentId, reason: 'cobro equivocado', actor: await actorFor(s) });
  assert.ok(v.ok, v.ok ? '' : v.error);
  const voided = await getPaymentById(s.tenantId, s.clientId, paymentId);
  assert.equal(voided?.status, 'voided', 'row kept as history, never deleted');
  assert.equal(voided?.void_reason, 'cobro equivocado');
  assert.equal(await getRecordedPaymentForAppointment(s.tenantId, s.clientId, appt), null, 'no recorded payment now');
  assert.ok((await listPendingPaymentAppointments(s.tenantId, s.clientId)).map((p) => p.appointment_id).includes(appt), 'pending again');

  // A fresh payment can be recorded after the void.
  assert.ok((await recordPaymentForCompleted({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, draft: draft(), actor: await actorFor(s) })).ok);
  const rows = await one<{ n: string }>(`SELECT count(*)::text AS n FROM payments WHERE tenant_id=$1 AND appointment_id=$2`, [s.tenantId, appt]);
  assert.equal(rows.n, '2', 'the voided one and the new one both exist');
});

// ── 8. commission snapshot is correct and unchanged after a rate change ─────────────
test('commission is snapshotted on the line and unchanged after the rate changes', async () => {
  const s = await setup();
  await query(`UPDATE staff SET commission_pct_services = 10 WHERE id = $1`, [s.staffA]);
  const appt = await seedAppt(s, { priceSnapshot: '50000', staffId: s.staffA });
  const r = await completeWithPayment({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, draft: draft(), actor: await actorFor(s) });
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.equal(r.value.lines[0].commission_pct, '10.00');
  assert.equal(r.value.lines[0].commission_amount, '5000.00'); // 10% of 50000

  // Changing the artist's rate later must NOT revalue the stored line.
  await query(`UPDATE staff SET commission_pct_services = 20 WHERE id = $1`, [s.staffA]);
  const lines = await listPaymentLines(s.tenantId, r.value.payment.id);
  assert.equal(lines[0].commission_pct, '10.00', 'snapshot frozen');
  assert.equal(lines[0].commission_amount, '5000.00');
});

// ── 9. pipeline moves attended → paid on a payment, and paid → attended on a void ───
test('pipeline: a recorded payment sets the sale paid; a void reverts it to attended', async () => {
  const s = await setup();
  const appt = await seedAppt(s, { priceSnapshot: '50000' });
  const oppId = await seedOpp(s, 'booked', appt);
  const r = await completeWithPayment({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, draft: draft(), actor: await actorFor(s) });
  assert.ok(r.ok, r.ok ? '' : r.error);
  const paid = await getOpportunityById(s.tenantId, s.clientId, oppId);
  assert.equal(paid?.stage, 'paid');
  assert.equal(paid?.status, 'won');
  assert.ok(paid?.paid_at, 'paid_at set');
  const events = await listOpportunityStageEvents(s.tenantId, oppId);
  assert.ok(events.some((e) => e.to_stage === 'attended'), 'completion event');
  assert.ok(events.some((e) => e.to_stage === 'paid' && e.reason === 'payment_recorded'), 'paid event');

  const v = await voidPayment({ tenantId: s.tenantId, clientId: s.clientId, paymentId: r.ok ? r.value.payment.id : '', reason: 'error', actor: await actorFor(s) });
  assert.ok(v.ok, v.ok ? '' : v.error);
  const reverted = await getOpportunityById(s.tenantId, s.clientId, oppId);
  assert.equal(reverted?.stage, 'attended', 'reverted to attended');
  assert.equal(reverted?.paid_at, null);
  assert.ok((await listOpportunityStageEvents(s.tenantId, oppId)).some((e) => e.to_stage === 'attended' && e.reason === 'payment_voided'), 'void event');
});

// ── 10. the value dashboard's source numbers are identical before and after payment ──
test('recording a payment does NOT change the value dashboard source (valor = SUM price_snapshot of completed)', async () => {
  const s = await setup();
  const appt = await seedAppt(s, { priceSnapshot: '50000', startHours: 2 });
  // Complete WITHOUT payment first, so the appointment is already in the "completed valor".
  assert.ok((await completeWithoutPayment({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, actor: await actorFor(s) })).ok);
  const before = await completedValor(s);

  // Recording the payment must leave the dashboard's source numbers untouched.
  const prodA = await seedProduct(s, '10000');
  assert.ok((await recordPaymentForCompleted({ tenantId: s.tenantId, clientId: s.clientId, appointmentId: appt, draft: draft({ products: [{ productId: prodA, quantity: 2, unitCharged: 10000 }] }), actor: await actorFor(s) })).ok);
  const after = await completedValor(s);
  assert.deepEqual(after, before, 'completed count + valor identical — payments never touch price_snapshot or status');
});
