import { query } from '../db/client.js';
import { getAppointmentById } from '../db/repositories/scheduling/appointments.js';
import { ensureOpportunityPaidForPayment } from './engine.js';

/**
 * JP-6 — bring every RECORDED payment's opportunity to `paid`. DRY-RUN by default; `apply` writes.
 * Heals the gap where a payment was recorded but its sale never advanced — because the appointment
 * had no opportunity (none created), or the opportunity was stuck before `attended`. For each
 * distinct appointment with a recorded payment it runs the SAME engine heal the live hook now uses
 * (`ensureOpportunityPaidForPayment`): fast-forward the linked sale, or advance the contact's open
 * sale, else create one directly at paid (origin = latest ad touch in the brief window) and link it.
 * Idempotent — a sale already at paid is left untouched; a guest walk-in with no contact is skipped.
 */
export interface PaidBackfillSummary {
  apply: boolean;
  paymentsScanned: number;
  alreadyPaid: number;
  advancedToPaid: number;
  opportunitiesCreated: number;
  skippedNoContact: number;
  failed: number;
}

interface Row {
  tenant_id: string;
  appt_id: string;
  contact_id: string | null;
  opportunity_id: string | null;
  opp_stage: string | null;
  open_opp_id: string | null;
}

function classify(row: Row): 'alreadyPaid' | 'advance' | 'create' | 'skip' {
  if (row.opportunity_id && row.opp_stage === 'paid') return 'alreadyPaid';
  if (row.opportunity_id) return 'advance'; // linked, not yet paid → fast-forward
  if (!row.contact_id) return 'skip'; // guest walk-in: nothing to attach a sale to
  return row.open_opp_id ? 'advance' : 'create';
}

export async function backfillPaidOpportunities(opts: { apply: boolean; tenantId?: string }): Promise<PaidBackfillSummary> {
  const params: unknown[] = [];
  let scope = `p.status = 'recorded'`;
  if (opts.tenantId) {
    params.push(opts.tenantId);
    scope += ` AND a.tenant_id = $${params.length}`;
  }
  const r = await query<Row>(
    `SELECT a.tenant_id, a.id AS appt_id, a.contact_id, a.opportunity_id, o.stage AS opp_stage, ob.id AS open_opp_id
       FROM appointments a
       JOIN payments p ON p.appointment_id = a.id AND p.tenant_id = a.tenant_id AND p.status = 'recorded'
       LEFT JOIN opportunities o ON o.id = a.opportunity_id AND o.tenant_id = a.tenant_id
       LEFT JOIN LATERAL (
         SELECT oo.id FROM opportunities oo
          WHERE oo.tenant_id = a.tenant_id AND oo.client_id = a.client_id AND oo.contact_id = a.contact_id AND oo.status = 'open'
          LIMIT 1
       ) ob ON a.contact_id IS NOT NULL
      WHERE ${scope}
      GROUP BY a.tenant_id, a.id, a.contact_id, a.opportunity_id, o.stage, ob.id
      ORDER BY a.tenant_id, a.id`,
    params,
  );
  const s: PaidBackfillSummary = { apply: opts.apply, paymentsScanned: 0, alreadyPaid: 0, advancedToPaid: 0, opportunitiesCreated: 0, skippedNoContact: 0, failed: 0 };
  for (const row of r.rows) {
    s.paymentsScanned += 1;
    const bucket = classify(row);
    if (bucket === 'alreadyPaid') {
      s.alreadyPaid += 1;
      continue;
    }
    if (bucket === 'skip') {
      s.skippedNoContact += 1;
      continue;
    }
    if (opts.apply) {
      try {
        const appt = await getAppointmentById(row.tenant_id, row.appt_id);
        if (appt) await ensureOpportunityPaidForPayment(appt, { kind: 'system' });
      } catch {
        s.failed += 1;
        continue;
      }
    }
    if (bucket === 'advance') s.advancedToPaid += 1;
    else s.opportunitiesCreated += 1;
  }
  return s;
}
