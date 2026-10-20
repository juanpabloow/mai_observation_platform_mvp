import { query } from '../client.js';
import type { AssumptionValues } from '../../analytics/valueDashboardModel.js';

/**
 * Writes for value_estimate_assumptions (migration 1812). APPEND-ONLY: a proposal and a
 * confirmation are both NEW rows; nothing is ever updated (the table's trigger refuses it).
 * Authorization is the caller's job (web/lib/valueAssumptionActions.ts: the agency or the
 * client owner may propose, ONLY the client owner may confirm) — these functions only keep
 * the row inside its tenant + client.
 */

export interface AssumptionWrite extends AssumptionValues {
  effectiveFrom: string;
}

const METHOD_VERSION = 'v1';

export async function insertAssumptionProposal(args: {
  tenantId: string;
  clientId: string;
  userId: string;
  values: AssumptionWrite;
}): Promise<string> {
  const v = args.values;
  const r = await query<{ id: string }>(
    `INSERT INTO value_estimate_assumptions
       (tenant_id, client_id, status, method_version, min_conversacion_atendida, min_conversacion_con_cita,
        min_agendar_manual, costo_hora, effective_from, proposed_by)
     VALUES ($1, $2, 'proposed', $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [args.tenantId, args.clientId, METHOD_VERSION, v.minConversacionAtendida, v.minConversacionConCita, v.minAgendarManual, v.costoHora, v.effectiveFrom, args.userId],
  );
  return r.rows[0].id;
}

/**
 * Confirm a set of assumptions. When `proposalId` names a proposal of THIS client whose
 * values are exactly the ones being confirmed, the confirmation points at it and keeps its
 * proposer; otherwise (no proposal, another client's id, or edited values) the owner is
 * recorded as proposer too. Nothing about the proposal row changes.
 */
export async function insertAssumptionConfirmation(args: {
  tenantId: string;
  clientId: string;
  userId: string;
  values: AssumptionWrite;
  proposalId: string | null;
}): Promise<string> {
  const v = args.values;
  let basedOn: { id: string; proposed_by: string; proposed_at: Date } | null = null;
  if (args.proposalId) {
    const p = await query<{ id: string; proposed_by: string; proposed_at: Date }>(
      `SELECT id, proposed_by, proposed_at FROM value_estimate_assumptions
        WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND status = 'proposed'
          AND min_conversacion_atendida = $4 AND min_conversacion_con_cita = $5 AND min_agendar_manual = $6
          AND costo_hora = $7 AND effective_from = $8`,
      [args.proposalId, args.tenantId, args.clientId, v.minConversacionAtendida, v.minConversacionConCita, v.minAgendarManual, v.costoHora, v.effectiveFrom],
    );
    basedOn = p.rows[0] ?? null;
  }
  const r = await query<{ id: string }>(
    `INSERT INTO value_estimate_assumptions
       (tenant_id, client_id, status, method_version, min_conversacion_atendida, min_conversacion_con_cita,
        min_agendar_manual, costo_hora, effective_from, proposed_by, proposed_at, confirmed_by, confirmed_at, based_on_id)
     VALUES ($1, $2, 'confirmed', $3, $4, $5, $6, $7, $8, $9, coalesce($10, now()), $11, now(), $12)
     RETURNING id`,
    [
      args.tenantId, args.clientId, METHOD_VERSION, v.minConversacionAtendida, v.minConversacionConCita, v.minAgendarManual, v.costoHora,
      v.effectiveFrom, basedOn?.proposed_by ?? args.userId, basedOn?.proposed_at ?? null, args.userId, basedOn?.id ?? null,
    ],
  );
  return r.rows[0].id;
}
