"use server";

import { revalidatePath } from "next/cache";
import {
  assignWorkflowToClient,
  createClient,
  deleteClient,
  renameClient,
} from "@worker/db/repositories/clients.js";
import { getCurrentTenantId } from "./tenant";

/**
 * Server actions for the Clients & Workflows view. Every action resolves the
 * tenant via getCurrentTenantId() and delegates to the (already proven, cross-
 * tenant-safe) clients repo — no SQL is built here, and a foreign client/workflow
 * id can never take effect (the repo validates ownership). They revalidate
 * /clients so the server-rendered folder view reflects the change.
 */

/** Create a new (non-default) client. Name is required; duplicates are allowed
 * (clients are id-keyed, like folders — two may share a display name). */
export async function createClientAction(
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Client name is required." };
  if (trimmed.length > 120) return { ok: false, error: "Name is too long (max 120)." };
  const tenantId = await getCurrentTenantId();
  await createClient(tenantId, trimmed);
  revalidatePath("/clients");
  return { ok: true };
}

/** Move a workflow to a client (both validated as this tenant's by the repo). */
export async function assignWorkflowAction(input: {
  workflowId: string;
  clientId: string;
}): Promise<{ ok: boolean }> {
  const tenantId = await getCurrentTenantId();
  const ok = await assignWorkflowToClient({
    tenantId,
    workflowId: input.workflowId,
    clientId: input.clientId,
  });
  revalidatePath("/clients");
  return { ok };
}

/** Rename a (non-default) client. */
export async function renameClientAction(input: {
  clientId: string;
  name: string;
}): Promise<{ ok: boolean; error?: string }> {
  const trimmed = input.name.trim();
  if (!trimmed) return { ok: false, error: "Client name is required." };
  if (trimmed.length > 120) return { ok: false, error: "Name is too long (max 120)." };
  const tenantId = await getCurrentTenantId();
  const ok = await renameClient({ tenantId, clientId: input.clientId, name: trimmed });
  revalidatePath("/clients");
  return { ok, error: ok ? undefined : "Client not found." };
}

/**
 * Delete a client. The repo refuses the default client and reassigns a deleted
 * client's workflows to the default (they move to "Unassigned", never orphaned).
 */
export async function deleteClientAction(input: {
  clientId: string;
}): Promise<{ ok: boolean; result: "deleted" | "not_found" | "is_default" }> {
  const tenantId = await getCurrentTenantId();
  const result = await deleteClient({ tenantId, clientId: input.clientId });
  revalidatePath("/clients");
  return { ok: result === "deleted", result };
}
