import { query } from '../../client.js';

/**
 * PY-1 payment-methods repository — the per-client list of how a business gets paid
 * (efectivo, tarjeta, Nequi, Daviplata, transferencia, Bre-B seeded). A USED method is
 * deactivated, never deleted (a past payment keeps its method_key snapshot regardless).
 *
 * The migration seeds every client that existed at deploy; ensureClientPaymentMethods seeds
 * a client created afterwards on first read, so a method list is never empty for a real client.
 */

export interface PaymentMethodRow {
  id: string;
  tenant_id: string;
  client_id: string;
  key: string;
  label: string;
  active: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

/** The seed set — kept in sync with the migration's VALUES list. */
export const DEFAULT_PAYMENT_METHODS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'efectivo', label: 'Efectivo' },
  { key: 'tarjeta', label: 'Tarjeta' },
  { key: 'nequi', label: 'Nequi' },
  { key: 'daviplata', label: 'Daviplata' },
  { key: 'transferencia', label: 'Transferencia' },
  { key: 'bre_b', label: 'Bre-B' },
];

const COLS = `id, tenant_id, client_id, key, label, active, sort_order, created_at, updated_at`;

/** Seed the standard methods for a client that has none yet (idempotent). */
export async function ensureClientPaymentMethods(tenantId: string, clientId: string): Promise<void> {
  await query(
    `INSERT INTO payment_methods (tenant_id, client_id, key, label, sort_order)
       SELECT $1, $2, v.key, v.label, v.ord
         FROM (VALUES
           ('efectivo','Efectivo',0),('tarjeta','Tarjeta',1),('nequi','Nequi',2),
           ('daviplata','Daviplata',3),('transferencia','Transferencia',4),('bre_b','Bre-B',5)
         ) AS v(key, label, ord)
     ON CONFLICT (tenant_id, client_id, key) DO NOTHING`,
    [tenantId, clientId],
  );
}

/** List a client's methods (seeding the defaults first). `activeOnly` for the payment picker. */
export async function listPaymentMethods(tenantId: string, clientId: string, opts: { activeOnly?: boolean } = {}): Promise<PaymentMethodRow[]> {
  await ensureClientPaymentMethods(tenantId, clientId);
  const where = ['tenant_id = $1', 'client_id = $2'];
  if (opts.activeOnly) where.push('active = true');
  const r = await query<PaymentMethodRow>(
    `SELECT ${COLS} FROM payment_methods WHERE ${where.join(' AND ')} ORDER BY sort_order, label`,
    [tenantId, clientId],
  );
  return r.rows;
}

/** Is `key` an ACTIVE method of this client? Used to validate a payment draft. */
export async function isPaymentMethodActive(tenantId: string, clientId: string, key: string): Promise<boolean> {
  const r = await query<{ one: number }>(
    `SELECT 1 AS one FROM payment_methods WHERE tenant_id = $1 AND client_id = $2 AND key = $3 AND active = true`,
    [tenantId, clientId, key],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Add a method. The key is derived by the caller (slug of the label); uniqueness is the
 *  partial index — a duplicate key throws 23505 for the action to map. */
export async function addPaymentMethod(tenantId: string, clientId: string, key: string, label: string): Promise<PaymentMethodRow> {
  const next = await query<{ n: number }>(
    `SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM payment_methods WHERE tenant_id = $1 AND client_id = $2`,
    [tenantId, clientId],
  );
  const r = await query<PaymentMethodRow>(
    `INSERT INTO payment_methods (tenant_id, client_id, key, label, sort_order)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${COLS}`,
    [tenantId, clientId, key, label, next.rows[0]?.n ?? 0],
  );
  return r.rows[0]!;
}

export async function renamePaymentMethod(tenantId: string, clientId: string, id: string, label: string): Promise<PaymentMethodRow | null> {
  const r = await query<PaymentMethodRow>(
    `UPDATE payment_methods SET label = $4, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND client_id = $3 RETURNING ${COLS}`,
    [id, tenantId, clientId, label],
  );
  return r.rows[0] ?? null;
}

export async function setPaymentMethodActive(tenantId: string, clientId: string, id: string, active: boolean): Promise<PaymentMethodRow | null> {
  const r = await query<PaymentMethodRow>(
    `UPDATE payment_methods SET active = $4, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND client_id = $3 RETURNING ${COLS}`,
    [id, tenantId, clientId, active],
  );
  return r.rows[0] ?? null;
}

/** Reorder: set sort_order to each id's position in `orderedIds`. Ids not of this client are
 *  ignored (the WHERE scopes them out). One statement per id, in a caller-provided order. */
export async function reorderPaymentMethods(tenantId: string, clientId: string, orderedIds: string[]): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    await query(
      `UPDATE payment_methods SET sort_order = $4, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
      [orderedIds[i], tenantId, clientId, i],
    );
  }
}
