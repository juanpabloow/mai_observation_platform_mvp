import type { PoolClient, QueryResultRow } from 'pg';
import { query } from '../../client.js';

/**
 * PY-1 payments repository — the payment of a completed appointment and its itemized lines.
 * Tenant_id + client_id scoped throughout. Money is numeric(10,2)/(12,2), returned from pg as a
 * STRING (like price_snapshot); callers format with priceLabelCOP. These are plain DB ops — the
 * rules (validation, totals, commission, the status transition) live in src/scheduling/payments.ts.
 *
 * At most ONE recorded payment per appointment: enforced by the partial unique index
 * payments_one_recorded_per_appointment. A concurrent second insert throws 23505, which the engine
 * maps to a typed error. A mistake is VOIDED (setPaymentVoided), never deleted.
 */

export type PaymentStatus = 'recorded' | 'voided';
export type PaymentLineKind = 'service' | 'product';
export type AdjustmentReason = 'promocion' | 'cortesia' | 'ajuste' | 'otro';

export interface PaymentRow {
  id: string;
  tenant_id: string;
  client_id: string;
  appointment_id: string;
  contact_id: string | null;
  opportunity_id: string | null;
  status: PaymentStatus;
  method_key: string;
  total: string;
  note: string | null;
  paid_at: Date;
  recorded_by: string;
  voided_at: Date | null;
  voided_by: string | null;
  void_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PaymentLineRow {
  id: string;
  tenant_id: string;
  client_id: string;
  payment_id: string;
  kind: PaymentLineKind;
  service_id: string | null;
  product_id: string | null;
  description: string;
  staff_id: string | null;
  quantity: number;
  unit_list_price: string | null;
  unit_charged: string;
  line_total: string;
  adjustment_reason: AdjustmentReason | null;
  adjustment_note: string | null;
  commission_pct: string;
  commission_amount: string;
  created_at: Date;
}

const PAYMENT_COLS = `id, tenant_id, client_id, appointment_id, contact_id, opportunity_id, status,
  method_key, total, note, paid_at, recorded_by, voided_at, voided_by, void_reason, created_at, updated_at`;
const LINE_COLS = `id, tenant_id, client_id, payment_id, kind, service_id, product_id, description, staff_id,
  quantity, unit_list_price, unit_charged, line_total, adjustment_reason, adjustment_note,
  commission_pct, commission_amount, created_at`;

/** A line as computed by the engine (amounts already snapshotted as 2-dp strings). */
export interface ResolvedPaymentLine {
  kind: PaymentLineKind;
  serviceId: string | null;
  productId: string | null;
  description: string;
  staffId: string | null;
  quantity: number;
  unitListPrice: string | null;
  unitCharged: string;
  lineTotal: string;
  adjustmentReason: AdjustmentReason | null;
  adjustmentNote: string | null;
  commissionPct: string;
  commissionAmount: string;
}

export interface InsertPaymentInput {
  tenantId: string;
  clientId: string;
  appointmentId: string;
  contactId: string | null;
  opportunityId: string | null;
  methodKey: string;
  total: string;
  note: string | null;
  recordedBy: string;
  lines: ResolvedPaymentLine[];
}

/** Insert a recorded payment + its lines ON THE CALLER'S transaction (so it is atomic with the
 *  completion). Throws a 23505 if a recorded payment already exists for the appointment. */
export async function insertPayment(client: PoolClient, input: InsertPaymentInput): Promise<PaymentRow> {
  const p = await client.query<PaymentRow>(
    `INSERT INTO payments
       (tenant_id, client_id, appointment_id, contact_id, opportunity_id, status, method_key, total, note, recorded_by)
     VALUES ($1,$2,$3,$4,$5,'recorded',$6,$7,$8,$9)
     RETURNING ${PAYMENT_COLS}`,
    [input.tenantId, input.clientId, input.appointmentId, input.contactId, input.opportunityId, input.methodKey, input.total, input.note, input.recordedBy],
  );
  const payment = p.rows[0]!;
  for (const l of input.lines) {
    await client.query(
      `INSERT INTO payment_lines
         (tenant_id, client_id, payment_id, kind, service_id, product_id, description, staff_id,
          quantity, unit_list_price, unit_charged, line_total, adjustment_reason, adjustment_note,
          commission_pct, commission_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [input.tenantId, input.clientId, payment.id, l.kind, l.serviceId, l.productId, l.description, l.staffId,
        l.quantity, l.unitListPrice, l.unitCharged, l.lineTotal, l.adjustmentReason, l.adjustmentNote,
        l.commissionPct, l.commissionAmount],
    );
  }
  return payment;
}

const runner = (client?: PoolClient) => ({
  query: <T extends QueryResultRow>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params) : query<T>(text, params),
});

/** The recorded payment of an appointment (the one that is not voided), or null. */
export async function getRecordedPaymentForAppointment(tenantId: string, clientId: string, appointmentId: string, client?: PoolClient): Promise<PaymentRow | null> {
  const r = await runner(client).query<PaymentRow>(
    `SELECT ${PAYMENT_COLS} FROM payments
      WHERE tenant_id = $1 AND client_id = $2 AND appointment_id = $3 AND status = 'recorded'`,
    [tenantId, clientId, appointmentId],
  );
  return r.rows[0] ?? null;
}

export async function getPaymentById(tenantId: string, clientId: string, paymentId: string, client?: PoolClient): Promise<PaymentRow | null> {
  const r = await runner(client).query<PaymentRow>(
    `SELECT ${PAYMENT_COLS} FROM payments WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [paymentId, tenantId, clientId],
  );
  return r.rows[0] ?? null;
}

export async function listPaymentLines(tenantId: string, paymentId: string, client?: PoolClient): Promise<PaymentLineRow[]> {
  const r = await runner(client).query<PaymentLineRow>(
    `SELECT ${LINE_COLS} FROM payment_lines WHERE tenant_id = $1 AND payment_id = $2 ORDER BY created_at, id`,
    [tenantId, paymentId],
  );
  return r.rows;
}

/** Void a RECORDED payment (never deletes). Returns the updated row, or null if it was not
 *  recorded (already voided / not found) — the guard keeps voiding idempotent + concurrency-safe. */
export async function setPaymentVoided(
  client: PoolClient,
  tenantId: string,
  clientId: string,
  paymentId: string,
  voidedBy: string,
  voidReason: string,
): Promise<PaymentRow | null> {
  const r = await client.query<PaymentRow>(
    `UPDATE payments
        SET status = 'voided', voided_at = now(), voided_by = $4, void_reason = $5, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND status = 'recorded'
      RETURNING ${PAYMENT_COLS}`,
    [paymentId, tenantId, clientId, voidedBy, voidReason],
  );
  return r.rows[0] ?? null;
}

/** Every payment of an appointment (recorded + voided), newest first — the history a void keeps. */
export async function listPaymentsForAppointment(tenantId: string, clientId: string, appointmentId: string): Promise<PaymentRow[]> {
  const r = await query<PaymentRow>(
    `SELECT * FROM payments WHERE tenant_id = $1 AND client_id = $2 AND appointment_id = $3 ORDER BY created_at DESC LIMIT 50`,
    [tenantId, clientId, appointmentId],
  );
  return r.rows;
}

/**
 * The payment STATE of completed appointments, for the agenda's «Cobro pendiente» mark:
 * 'recorded' (a recorded payment exists) or 'pending' (completed on/after the client's
 * tracking-start instant with no recorded payment). Anything else is absent from the map —
 * history before tracking started is never «pending», and nothing is invented.
 */
export async function paymentStatesForAppointments(tenantId: string, clientId: string, appointmentIds: string[]): Promise<Map<string, 'recorded' | 'pending'>> {
  const out = new Map<string, 'recorded' | 'pending'>();
  if (appointmentIds.length === 0) return out;
  const r = await query<{ id: string; state: 'recorded' | 'pending' }>(
    `SELECT a.id,
            CASE WHEN EXISTS (SELECT 1 FROM payments p WHERE p.tenant_id = a.tenant_id AND p.appointment_id = a.id AND p.status = 'recorded')
                 THEN 'recorded' ELSE 'pending' END AS state
       FROM appointments a
       JOIN clients c ON c.id = a.client_id AND c.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1 AND a.client_id = $2 AND a.id = ANY($3::uuid[]) AND a.status = 'completed'
        AND (EXISTS (SELECT 1 FROM payments p WHERE p.tenant_id = a.tenant_id AND p.appointment_id = a.id AND p.status = 'recorded')
             OR a.start_at >= COALESCE(
                  (SELECT ps.payments_tracking_started_at FROM payment_settings ps WHERE ps.tenant_id = a.tenant_id AND ps.client_id = a.client_id),
                  c.created_at))`,
    [tenantId, clientId, appointmentIds],
  );
  for (const row of r.rows) out.set(row.id, row.state);
  return out;
}
