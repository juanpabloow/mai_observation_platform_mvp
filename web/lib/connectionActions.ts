"use server";

import { revalidatePath } from "next/cache";
import { requireFullAccessForAction } from "./access";
import { createConnectionForTenant } from "@worker/connections/createConnection.js";
import { setConnectionActiveForTenant } from "@worker/db/repositories/n8nConnections.js";

/**
 * Connection server actions. AGENCY-ONLY: gated by requireFullAccessForAction (owner/admin),
 * like every other tenant-wide action — a client member is DENIED at the data layer, not
 * merely hidden in the UI. Tenant id comes from the session scope, never from the client.
 * The API key flows IN from the form (unavoidable — the user types it) but is NEVER returned
 * or logged: the action returns only { ok, error? }, and the key is encrypted server-side.
 */
export async function addConnectionAction(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { tenantId } = await requireFullAccessForAction();
  const result = await createConnectionForTenant({
    tenantId,
    name: input.name,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  revalidatePath("/settings/connections");
  revalidatePath("/");
  revalidatePath("/clients");
  return { ok: true };
}

export async function setConnectionActiveAction(input: {
  id: string;
  isActive: boolean;
}): Promise<{ ok: boolean }> {
  const { tenantId } = await requireFullAccessForAction();
  await setConnectionActiveForTenant({ tenantId, id: input.id, isActive: input.isActive });
  revalidatePath("/settings/connections");
  revalidatePath("/");
  return { ok: true };
}
