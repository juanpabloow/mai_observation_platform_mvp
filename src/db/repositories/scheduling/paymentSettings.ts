import { query } from '../../client.js';

/**
 * PY-1 payment settings — the per-client instant from which a completed, unpaid appointment
 * counts as "cobro pendiente", and the derived pending list. A missing row falls back to the
 * client's created_at, so a client the migration/seed never reached still behaves sanely.
 */

/** The effective tracking-start instant (the row, else the client's created_at). */
export async function getPaymentsTrackingStartedAt(tenantId: string, clientId: string): Promise<Date | null> {
  const r = await query<{ started_at: Date }>(
    `SELECT COALESCE(ps.payments_tracking_started_at, c.created_at) AS started_at
       FROM clients c
       LEFT JOIN payment_settings ps ON ps.tenant_id = c.tenant_id AND ps.client_id = c.id
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, clientId],
  );
  return r.rows[0]?.started_at ?? null;
}

export async function setPaymentsTrackingStartedAt(tenantId: string, clientId: string, startedAt: Date): Promise<void> {
  await query(
    `INSERT INTO payment_settings (tenant_id, client_id, payments_tracking_started_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, client_id) DO UPDATE SET payments_tracking_started_at = $3, updated_at = now()`,
    [tenantId, clientId, startedAt],
  );
}

export interface PendingPaymentRow {
  appointment_id: string;
  start_at: Date;
  service_name: string;
  price_snapshot: string | null;
  staff_id: string;
  staff_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
}

/**
 * Completed appointments that still need a payment recorded: status 'completed', on/after the
 * client's tracking-start instant, with NO recorded payment. Bounded. Read by the pending-payments
 * list (permission payments.view). Derived — there is no "pending" column on appointments.
 */
export async function listPendingPaymentAppointments(tenantId: string, clientId: string): Promise<PendingPaymentRow[]> {
  const r = await query<PendingPaymentRow>(
    `SELECT a.id AS appointment_id, a.start_at, a.service_name_snapshot AS service_name,
            a.price_snapshot, a.staff_id, st.name AS staff_name, a.contact_id, ct.name AS contact_name
       FROM appointments a
       JOIN clients c ON c.id = a.client_id AND c.tenant_id = a.tenant_id
       LEFT JOIN staff st ON st.id = a.staff_id
       LEFT JOIN contacts ct ON ct.id = a.contact_id
      WHERE a.tenant_id = $1 AND a.client_id = $2 AND a.status = 'completed'
        AND a.start_at >= COALESCE(
          (SELECT ps.payments_tracking_started_at FROM payment_settings ps
            WHERE ps.tenant_id = a.tenant_id AND ps.client_id = a.client_id),
          c.created_at)
        AND NOT EXISTS (
          SELECT 1 FROM payments p
           WHERE p.tenant_id = a.tenant_id AND p.appointment_id = a.id AND p.status = 'recorded')
      ORDER BY a.start_at DESC
      LIMIT 200`,
    [tenantId, clientId],
  );
  return r.rows;
}
