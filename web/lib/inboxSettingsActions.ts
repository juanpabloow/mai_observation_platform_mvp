"use server";

import { revalidatePath } from "next/cache";
import { hasFullAccess, type AccessScope } from "./access";
import { gateClientModule } from "./clientModuleAccess";
import { setInboxAutoReturnMinutes } from "@worker/db/repositories/inboxSettings.js";

const GENERIC = "No se pudo guardar. Inténtalo de nuevo.";
const NO_PERMISSION = "No tienes permiso para cambiar esta configuración.";

/**
 * JP-2 — who may change inbox settings: the AGENCY or the CLIENT OWNER, never a Setter/Staff (they
 * can attend conversations, not configure the client). The data layer re-checks here; the page gates
 * the same way.
 */
// Not exported: a "use server" module may only export async server actions.
function canManageInboxSettings(scope: AccessScope): boolean {
  return hasFullAccess(scope) || scope.clientRole === "owner";
}

/** Set the client's auto-return threshold in minutes (0 = never). Agency or Client Owner only. */
export async function setInboxAutoReturnMinutesAction(
  clientId: string,
  minutes: number,
): Promise<{ ok: true; value: number } | { ok: false; error: string }> {
  const g = await gateClientModule(clientId, "inbox", "inbox.view", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  const { scope, client } = g.context;
  if (!canManageInboxSettings(scope)) return { ok: false, error: NO_PERMISSION };
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10080) {
    return { ok: false, error: "Elige entre 0 y 10080 minutos (0 = nunca devolver)." };
  }
  const value = await setInboxAutoReturnMinutes(scope.tenantId, client.id, minutes);
  revalidatePath(`/clients/${client.id}/inbox/settings`);
  return { ok: true, value };
}
