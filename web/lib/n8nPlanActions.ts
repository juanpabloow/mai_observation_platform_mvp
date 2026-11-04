"use server";

import { revalidatePath } from "next/cache";
import { setConnectionPlan } from "@worker/db/repositories/n8nExecutionsUsage.js";
import { requireFullAccessForAction } from "./access";
import { isUuid } from "./clientModuleValidation";

/**
 * COSTOS DE IA → Ejecuciones — the agency types its n8n plan (n8n's API does not expose it):
 * production executions per cycle and the day the counter restarts. Agency only, checked first.
 * Both null clears the plan. Only a connection of the session's tenant can be changed.
 */

type Result = { ok: true } | { ok: false; error: string };

export async function setN8nPlanAction(input: { connectionId: string; monthlyExecutions: number | null; resetDay: number | null }): Promise<Result> {
  const scope = await requireFullAccessForAction();
  if (!isUuid(input.connectionId)) return { ok: false, error: "Conexión no encontrada." };
  const limit = input.monthlyExecutions;
  const day = input.resetDay;
  if (limit !== null && !(Number.isInteger(limit) && limit >= 1 && limit <= 100_000_000)) {
    return { ok: false, error: "El límite debe ser un número entero de ejecuciones (1 o más)." };
  }
  if (day !== null && !(Number.isInteger(day) && day >= 1 && day <= 28)) {
    return { ok: false, error: "El día de reinicio debe estar entre 1 y 28." };
  }
  const ok = await setConnectionPlan({ tenantId: scope.tenantId, connectionId: input.connectionId, monthlyExecutions: limit, resetDay: day });
  revalidatePath("/costos-ia");
  return ok ? { ok: true } : { ok: false, error: "Conexión no encontrada." };
}
