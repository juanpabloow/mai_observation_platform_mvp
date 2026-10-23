import { isUniqueViolation, query, withTransaction } from '../db/client.js';
import { getAppointmentById } from '../db/repositories/scheduling/appointments.js';
import { transitionStatus, type BookingResult } from './booking.js';
import type { AppointmentRow } from '../db/repositories/scheduling/appointments.js';
import {
  getPaymentById,
  getRecordedPaymentForAppointment,
  listPaymentsForAppointment,
  insertPayment,
  listPaymentLines,
  setPaymentVoided,
  type AdjustmentReason,
  type PaymentLineRow,
  type PaymentRow,
  type ResolvedPaymentLine,
} from '../db/repositories/scheduling/payments.js';
import { isPaymentMethodActive } from '../db/repositories/scheduling/paymentMethods.js';
import { pipelineOnPaymentRecorded, pipelineOnPaymentVoided } from '../pipeline/hooks.js';

/**
 * PY-1 PAYMENTS ENGINE — recording what was charged when an appointment is completed, as ONE
 * transaction with the completion, through the EXISTING transitionStatus path (so every current
 * post-commit hook still fires). The TOTAL is computed server-side; any client-sent total is
 * ignored (there is no total in the draft). Payments never write price_snapshot and never change
 * an appointment's status beyond the completion itself, so the value dashboard is untouched.
 *
 * Pipeline (attended → paid, and paid → attended on a void) runs through PL-1 fail-safe hooks AFTER
 * commit and never rolls back a payment.
 */

export type PaymentError =
  | 'not_found'
  | 'not_started'
  | 'product_inactive'
  | 'invalid_status'
  | 'payment_exists'
  | 'method_inactive'
  | 'product_not_found'
  | 'seller_not_found'
  | 'invalid_amount'
  | 'invalid_quantity'
  | 'adjustment_required'
  | 'void_reason_required';

export interface PaymentActor {
  /** The person recording/voiding. Payments are never machine-driven. */
  userId: string;
}

export interface ServiceLineDraft {
  /** null → the appointment's price_snapshot (REQUIRED when the snapshot is null). */
  unitCharged?: number | null;
  adjustmentReason?: AdjustmentReason | null;
  adjustmentNote?: string | null;
}
export interface ProductLineDraft {
  productId: string;
  quantity: number;
  unitCharged: number;
  /** Optional seller (for the product commission); must be this client's staff. */
  staffId?: string | null;
  adjustmentReason?: AdjustmentReason | null;
  adjustmentNote?: string | null;
}
export interface PaymentDraft {
  methodKey: string;
  note?: string | null;
  service: ServiceLineDraft;
  products?: ProductLineDraft[];
}

export interface PaymentView {
  payment: PaymentRow;
  lines: PaymentLineRow[];
  /** Product ids charged while out of stock — a FLAG, never a block (no stock model). */
  outOfStockProductIds: string[];
}
export type PaymentResult = { ok: true; value: PaymentView } | { ok: false; error: PaymentError; message: string };

const fail = (error: PaymentError, message: string): { ok: false; error: PaymentError; message: string } => ({ ok: false, error, message });
const toCents = (n: number): number => Math.round(n * 100);
const money = (cents: number): string => (cents / 100).toFixed(2);

async function getClientProduct(tenantId: string, clientId: string, productId: string): Promise<{ id: string; name: string; price: string; in_stock: boolean; is_active: boolean } | null> {
  const r = await query<{ id: string; name: string; price: string; in_stock: boolean; is_active: boolean }>(
    `SELECT id, name, price, in_stock, is_active FROM products WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [productId, tenantId, clientId],
  );
  return r.rows[0] ?? null;
}

/** The commission percentages of a staff member of THIS client (null = not this client's staff). */
async function getClientStaffCommission(tenantId: string, clientId: string, staffId: string): Promise<{ services: number; products: number } | null> {
  const r = await query<{ services: string; products: string }>(
    `SELECT s.commission_pct_services AS services, s.commission_pct_products AS products
       FROM staff s JOIN sites si ON si.id = s.site_id
      WHERE s.id = $1 AND s.tenant_id = $2 AND si.client_id = $3`,
    [staffId, tenantId, clientId],
  );
  const row = r.rows[0];
  return row ? { services: Number(row.services), products: Number(row.products) } : null;
}

type AdjResult = { ok: true; reason: AdjustmentReason | null; note: string | null } | { ok: false; error: PaymentError; message: string };

/** An adjustment reason is REQUIRED when charged below list; 'otro' needs a note. */
function normalizeAdjustment(chargedCents: number, listCents: number | null, reason: AdjustmentReason | null | undefined, note: string | null | undefined): AdjResult {
  const under = listCents != null && chargedCents < listCents;
  if (under && !reason) return fail('adjustment_required', 'Charging below the list price needs a reason.');
  if (reason === 'otro') {
    const n = (note ?? '').trim();
    if (!n) return fail('adjustment_required', 'A note is required when the reason is "otro".');
    return { ok: true, reason, note: n };
  }
  return { ok: true, reason: reason ?? null, note: reason ? (note?.trim() || null) : null };
}

interface Resolved {
  lines: ResolvedPaymentLine[];
  total: string;
  outOfStock: string[];
}

/** Validate the draft against the appointment + catalogue and build the lines + total (server-side).
 *  Read-only: a failure here means nothing is written. */
async function resolveDraft(tenantId: string, clientId: string, appt: AppointmentRow, draft: PaymentDraft): Promise<{ ok: true; resolved: Resolved } | { ok: false; error: PaymentError; message: string }> {
  if (!(await isPaymentMethodActive(tenantId, clientId, draft.methodKey))) {
    return fail('method_inactive', 'That payment method is not active for this business.');
  }
  const lines: ResolvedPaymentLine[] = [];
  const outOfStock: string[] = [];
  let totalCents = 0;

  // ── Service line (the appointment's one service + its artist) ──
  const listCents = appt.price_snapshot == null ? null : toCents(Number(appt.price_snapshot));
  const svc = draft.service ?? {};
  let svcChargedCents: number;
  if (svc.unitCharged == null) {
    if (listCents == null) return fail('invalid_amount', 'An amount is required: this service has no stored price.');
    svcChargedCents = listCents;
  } else {
    if (!Number.isFinite(svc.unitCharged) || svc.unitCharged < 0) return fail('invalid_amount', 'The service amount must be zero or more.');
    svcChargedCents = toCents(svc.unitCharged);
  }
  const svcAdj = normalizeAdjustment(svcChargedCents, listCents, svc.adjustmentReason, svc.adjustmentNote);
  if (!svcAdj.ok) return svcAdj;
  const artistComm = await getClientStaffCommission(tenantId, clientId, appt.staff_id);
  const svcPct = artistComm?.services ?? 0;
  const svcCommissionCents = Math.round((svcChargedCents * svcPct) / 100);
  lines.push({
    kind: 'service',
    serviceId: appt.service_id,
    productId: null,
    description: appt.service_name_snapshot,
    staffId: appt.staff_id,
    quantity: 1,
    unitListPrice: listCents == null ? null : money(listCents),
    unitCharged: money(svcChargedCents),
    lineTotal: money(svcChargedCents),
    adjustmentReason: svcAdj.reason,
    adjustmentNote: svcAdj.note,
    commissionPct: svcPct.toFixed(2),
    commissionAmount: money(svcCommissionCents),
  });
  totalCents += svcChargedCents;

  // ── Product lines ──
  for (const p of draft.products ?? []) {
    if (!Number.isInteger(p.quantity) || p.quantity <= 0) return fail('invalid_quantity', 'Each product needs a quantity of 1 or more.');
    if (!Number.isFinite(p.unitCharged) || p.unitCharged < 0) return fail('invalid_amount', 'A product amount must be zero or more.');
    const prod = await getClientProduct(tenantId, clientId, p.productId);
    if (!prod) return fail('product_not_found', 'A product on this sale is not in this business catalogue.');
    // Archived after the step was opened: refused like an inactive method (out of STOCK stays sellable).
    if (!prod.is_active) return fail('product_inactive', 'A product on this sale is no longer active.');
    if (!prod.in_stock) outOfStock.push(prod.id);
    const pListCents = toCents(Number(prod.price));
    const pUnitCents = toCents(p.unitCharged);
    const pAdj = normalizeAdjustment(pUnitCents, pListCents, p.adjustmentReason, p.adjustmentNote);
    if (!pAdj.ok) return pAdj;
    let pPct = 0;
    if (p.staffId) {
      const sellerComm = await getClientStaffCommission(tenantId, clientId, p.staffId);
      if (!sellerComm) return fail('seller_not_found', 'The product seller is not a professional of this business.');
      pPct = sellerComm.products;
    }
    const pLineCents = pUnitCents * p.quantity;
    const pCommissionCents = Math.round((pLineCents * pPct) / 100);
    lines.push({
      kind: 'product',
      serviceId: null,
      productId: prod.id,
      description: prod.name,
      staffId: p.staffId ?? null,
      quantity: p.quantity,
      unitListPrice: money(pListCents),
      unitCharged: money(pUnitCents),
      lineTotal: money(pLineCents),
      adjustmentReason: pAdj.reason,
      adjustmentNote: pAdj.note,
      commissionPct: pPct.toFixed(2),
      commissionAmount: money(pCommissionCents),
    });
    totalCents += pLineCents;
  }

  return { ok: true, resolved: { lines, total: money(totalCents), outOfStock } };
}

async function viewOf(tenantId: string, payment: PaymentRow, outOfStock: string[]): Promise<PaymentView> {
  const lines = await listPaymentLines(tenantId, payment.id);
  return { payment, lines, outOfStockProductIds: outOfStock };
}

function mapBookingFailure(r: Extract<BookingResult<AppointmentRow>, { ok: false }>): { ok: false; error: PaymentError; message: string } {
  if (r.error === 'invalid_transition') return fail('invalid_status', 'This appointment can no longer be completed.');
  if (r.error === 'not_started') return fail('not_started', 'An appointment can only be completed once it has started.');
  if (r.error === 'not_found' || r.error === 'module_disabled') return fail('not_found', 'Appointment not found.');
  return fail('not_found', 'Appointment not found.');
}

/**
 * Complete a scheduled/confirmed appointment AND record its payment, atomically. Validates the
 * draft first (nothing completes if it is invalid), then transitions to completed through the
 * existing path with the payment written inside the same transaction.
 */
export async function completeWithPayment(input: {
  tenantId: string;
  clientId: string;
  appointmentId: string;
  draft: PaymentDraft;
  actor: PaymentActor;
  /** The agenda's rule (booking.ts requireStartedToComplete): refuse before the start, under
   *  the row lock. Opt-in like there, so machine callers keep their contract. */
  requireStarted?: boolean;
  now?: Date;
}): Promise<PaymentResult> {
  const { tenantId, clientId, appointmentId, draft, actor } = input;
  const appt = await getAppointmentById(tenantId, appointmentId);
  if (!appt || appt.client_id !== clientId) return fail('not_found', 'Appointment not found.');
  if (appt.status === 'cancelled' || appt.status === 'no_show') return fail('invalid_status', 'A cancelled or no-show appointment cannot be charged.');
  if (appt.status === 'completed') return fail('invalid_status', 'This appointment is already completed — record the pending payment instead.');

  const resolved = await resolveDraft(tenantId, clientId, appt, draft);
  if (!resolved.ok) return resolved;

  let payment: PaymentRow | null = null;
  let result: BookingResult<AppointmentRow>;
  try {
    result = await transitionStatus('completed', {
      tenantId,
      appointmentId,
      actorType: 'agent',
      actorUserId: actor.userId,
      scopeClientId: clientId,
      requireStartedToComplete: input.requireStarted,
      now: input.now,
      within: async (client, updated) => {
        payment = await insertPayment(client, {
          tenantId,
          clientId,
          appointmentId,
          contactId: updated.contact_id,
          opportunityId: updated.opportunity_id,
          methodKey: draft.methodKey,
          total: resolved.resolved.total,
          note: draft.note?.trim() || null,
          recordedBy: actor.userId,
          lines: resolved.resolved.lines,
        });
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return fail('payment_exists', 'This appointment already has a recorded payment.');
    throw err;
  }
  if (!result.ok) return mapBookingFailure(result);
  await pipelineOnPaymentRecorded(result.value, actor.userId);
  return { ok: true, value: await viewOf(tenantId, payment!, resolved.resolved.outOfStock) };
}

/** Today's completion, unchanged — no payment. The appointment becomes "cobro pendiente". */
export async function completeWithoutPayment(input: { tenantId: string; clientId: string; appointmentId: string; actor: PaymentActor }): Promise<BookingResult<AppointmentRow>> {
  return transitionStatus('completed', {
    tenantId: input.tenantId,
    appointmentId: input.appointmentId,
    actorType: 'agent',
    actorUserId: input.actor.userId,
    scopeClientId: input.clientId,
  });
}

/** Record the payment of an ALREADY completed appointment (the pending case). */
export async function recordPaymentForCompleted(input: { tenantId: string; clientId: string; appointmentId: string; draft: PaymentDraft; actor: PaymentActor }): Promise<PaymentResult> {
  const { tenantId, clientId, appointmentId, draft, actor } = input;
  const appt = await getAppointmentById(tenantId, appointmentId);
  if (!appt || appt.client_id !== clientId) return fail('not_found', 'Appointment not found.');
  if (appt.status !== 'completed') return fail('invalid_status', 'Only a completed appointment can have its payment recorded here.');
  if (await getRecordedPaymentForAppointment(tenantId, clientId, appointmentId)) {
    return fail('payment_exists', 'This appointment already has a recorded payment.');
  }
  const resolved = await resolveDraft(tenantId, clientId, appt, draft);
  if (!resolved.ok) return resolved;

  let payment: PaymentRow;
  try {
    payment = await withTransaction((client) =>
      insertPayment(client, {
        tenantId,
        clientId,
        appointmentId,
        contactId: appt.contact_id,
        opportunityId: appt.opportunity_id,
        methodKey: draft.methodKey,
        total: resolved.resolved.total,
        note: draft.note?.trim() || null,
        recordedBy: actor.userId,
        lines: resolved.resolved.lines,
      }),
    );
  } catch (err) {
    if (isUniqueViolation(err)) return fail('payment_exists', 'This appointment already has a recorded payment.');
    throw err;
  }
  await pipelineOnPaymentRecorded(appt, actor.userId);
  return { ok: true, value: await viewOf(tenantId, payment, resolved.resolved.outOfStock) };
}

/** Void a recorded payment (never deletes). The appointment stays completed and becomes pending
 *  again; the sale reverts paid → attended. A reason is required. */
export async function voidPayment(input: { tenantId: string; clientId: string; paymentId: string; reason: string; actor: PaymentActor }): Promise<PaymentResult> {
  const { tenantId, clientId, paymentId, actor } = input;
  const reason = (input.reason ?? '').trim();
  if (!reason) return fail('void_reason_required', 'A reason is required to void a payment.');
  const payment = await getPaymentById(tenantId, clientId, paymentId);
  if (!payment) return fail('not_found', 'Payment not found.');
  if (payment.status !== 'recorded') return fail('invalid_status', 'This payment is already voided.');

  const voided = await withTransaction((client) => setPaymentVoided(client, tenantId, clientId, paymentId, actor.userId, reason));
  if (!voided) return fail('invalid_status', 'This payment is already voided.'); // concurrent void
  const appt = await getAppointmentById(tenantId, voided.appointment_id);
  if (appt) await pipelineOnPaymentVoided(appt, actor.userId);
  return { ok: true, value: await viewOf(tenantId, voided, []) };
}

/** The payment view of an appointment (recorded payment + lines), or null. Read side for the
 *  payments.view surface; the caller strips commission fields when it lacks commissions.view. */
export async function getAppointmentPaymentView(tenantId: string, clientId: string, appointmentId: string): Promise<PaymentView | null> {
  const payment = await getRecordedPaymentForAppointment(tenantId, clientId, appointmentId);
  if (!payment) return null;
  return viewOf(tenantId, payment, []);
}

/** Every payment of an appointment, newest first — the recorded one AND the voided history
 *  (who voided it, when, why). Read side for payments.view; commission is stripped by the caller. */
export async function getAppointmentPaymentHistory(tenantId: string, clientId: string, appointmentId: string): Promise<PaymentView[]> {
  const rows = await listPaymentsForAppointment(tenantId, clientId, appointmentId);
  return Promise.all(rows.map((p) => viewOf(tenantId, p, [])));
}
