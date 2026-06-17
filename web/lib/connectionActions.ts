"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "./requireAuth";
import { createConnectionForTenant } from "@worker/connections/createConnection.js";
import { setConnectionActiveForTenant } from "@worker/db/repositories/n8nConnections.js";

/**
 * Connection server actions. Tenant-scoped via requireTenant() (the logged-in
 * tenant — never a tenant id from the client). The API key flows IN from the
 * form (unavoidable — the user types it) but is NEVER returned or logged: the
 * action returns only { ok, error? }, and the key is encrypted server-side.
 */
export async function addConnectionAction(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { tenantId } = await requireTenant();
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
  const { tenantId } = await requireTenant();
  await setConnectionActiveForTenant({ tenantId, id: input.id, isActive: input.isActive });
  revalidatePath("/settings/connections");
  revalidatePath("/");
  return { ok: true };
}
