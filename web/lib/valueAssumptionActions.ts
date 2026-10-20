"use server";

import { z } from "zod";
import { resolveValueAccess } from "./valueDashboard";
import { getValueDashboardContext } from "@worker/db/repositories/valueDashboard.js";
import { insertAssumptionConfirmation, insertAssumptionProposal } from "@worker/db/repositories/valueAssumptions.js";
import { addDays, ASSUMPTION_LIMITS, isValidDay, localToday } from "@worker/analytics/valueDashboardModel.js";

/**
 * The two writes of the value dashboard's estimate assumptions (spec §4). Both re-check
 * access on the SERVER from the session — the buttons the UI shows are a convenience, not
 * the rule:
 *   - propose: the agency or the client owner (a proposal shows no figure);
 *   - confirm: ONLY the client owner. The agency can never confirm on the business's behalf.
 * Both append a new version (the table refuses updates). Neither touches appointments or
 * any other data, and neither backfills anything: the effective date the confirmer picks is
 * the only way a version reaches past days, and the UI states it before confirming.
 */

const minutes = z.number().int().min(0).max(ASSUMPTION_LIMITS.minutesMax);
const Input = z.object({
  minConversacionAtendida: minutes,
  minConversacionConCita: minutes,
  minAgendarManual: minutes,
  costoHora: z.number().int().min(0).max(ASSUMPTION_LIMITS.costMax),
  effectiveFrom: z.string().refine(isValidDay, "Fecha no válida."),
  proposalId: z.string().uuid().nullable().optional(),
});

export type AssumptionActionInput = z.input<typeof Input>;
export type AssumptionActionResult = { ok: true; id: string } | { ok: false; error: string };

async function prepare(clientId: string, raw: unknown) {
  const access = await resolveValueAccess(clientId);
  if (!access.ok) return { ok: false as const, error: "No tienes acceso a este negocio." };
  const parsed = Input.safeParse(raw);
  if (!parsed.success) return { ok: false as const, error: "Revisa los valores: minutos entre 0 y 240 y un costo por hora válido." };
  const ctx = await getValueDashboardContext(access.scope.tenantId, clientId);
  if (!ctx) return { ok: false as const, error: "No tienes acceso a este negocio." };
  // Bound the effective date: at most a year back (an explicit, visible choice) and a year ahead.
  const today = localToday(new Date(), ctx.tz);
  const v = parsed.data;
  if (v.effectiveFrom < addDays(today, -366) || v.effectiveFrom > addDays(today, 366)) {
    return { ok: false as const, error: "La fecha de inicio debe estar dentro del último año o del próximo." };
  }
  return { ok: true as const, access, values: v };
}

export async function proposeValueAssumptionsAction(clientId: string, raw: AssumptionActionInput): Promise<AssumptionActionResult> {
  const p = await prepare(clientId, raw);
  if (!p.ok) return p;
  if (!p.access.canPropose) return { ok: false, error: "No puedes proponer supuestos para este negocio." };
  const { proposalId: _ignored, ...values } = p.values;
  void _ignored;
  const id = await insertAssumptionProposal({ tenantId: p.access.scope.tenantId, clientId, userId: p.access.scope.userId, values });
  return { ok: true, id };
}

export async function confirmValueAssumptionsAction(clientId: string, raw: AssumptionActionInput): Promise<AssumptionActionResult> {
  const p = await prepare(clientId, raw);
  if (!p.ok) return p;
  if (!p.access.canConfirm) return { ok: false, error: "Solo el dueño del negocio puede confirmar los supuestos." };
  const { proposalId, ...values } = p.values;
  const id = await insertAssumptionConfirmation({
    tenantId: p.access.scope.tenantId,
    clientId,
    userId: p.access.scope.userId,
    values,
    proposalId: proposalId ?? null,
  });
  return { ok: true, id };
}
