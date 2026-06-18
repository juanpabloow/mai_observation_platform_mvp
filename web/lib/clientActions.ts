"use server";

import { revalidatePath } from "next/cache";
import {
  assignWorkflowToClient,
  createClient,
  deleteClient,
  getClientById,
  renameClient,
  updateClientLogo,
} from "@worker/db/repositories/clients.js";
import { getCurrentTenantId } from "./tenant";
import { requireFullAccessForAction } from "./access";
import { deleteLogo, isR2Configured, uploadLogo } from "./r2";

/**
 * Server actions for the Clients & Workflows view. Client management is an
 * owner/admin capability, so every action FIRST gates on requireFullAccessForAction()
 * (a member can't reach the UI, but the action fails closed if invoked directly).
 * Each then resolves the tenant via getCurrentTenantId() and delegates to the
 * (already proven, cross-tenant-safe) clients repo — no SQL is built here, and a
 * foreign client/workflow id can never take effect (the repo validates ownership).
 * They revalidate /clients so the server-rendered folder view reflects the change.
 */

/** Create a new (non-default) client. Name is required; duplicates are allowed
 * (clients are id-keyed, like folders — two may share a display name). Returns
 * the new client id so the caller can attach a logo in a second step. */
export async function createClientAction(
  name: string,
): Promise<{ ok: boolean; error?: string; clientId?: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Client name is required." };
  if (trimmed.length > 120) return { ok: false, error: "Name is too long (max 120)." };
  await requireFullAccessForAction(); // owner/admin only — client management is not a member capability
  const tenantId = await getCurrentTenantId();
  const client = await createClient(tenantId, trimmed);
  revalidatePath("/clients");
  return { ok: true, clientId: client.id };
}

/**
 * Upload (or replace) a client's logo. Tenant-scoped: the acting tenant comes
 * from the session, and the target client is validated to belong to it via the
 * repo (a foreign clientId → "not found", never an upload for another tenant's
 * client). The file is validated + stored by the R2 module under a tenant/client-
 * scoped key with a server-generated random name; the public URL is persisted on
 * the client row. A replaced logo's old object is best-effort deleted.
 *
 * Takes FormData ({ clientId, logo: File }) — the standard server-action upload
 * shape. No-ops gracefully (clear error) when R2 isn't configured.
 */
export async function uploadClientLogoAction(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  if (!isR2Configured) return { ok: false, error: "Logo upload is not configured." };

  const clientId = String(formData.get("clientId") ?? "");
  const file = formData.get("logo");
  if (!clientId) return { ok: false, error: "Missing client." };
  if (!(file instanceof File)) return { ok: false, error: "No image selected." };

  await requireFullAccessForAction(); // owner/admin only — client management is not a member capability
  const tenantId = await getCurrentTenantId();
  // Ownership check (tenant isolation) — also yields the previous logo for cleanup.
  const client = await getClientById({ tenantId, clientId });
  if (!client) return { ok: false, error: "Client not found." };

  const result = await uploadLogo(tenantId, clientId, file);
  if (!result.ok) return { ok: false, error: result.error };

  await updateClientLogo({ tenantId, clientId, logoUrl: result.url });

  // Drop the replaced object so logos don't accumulate (non-fatal on failure).
  if (client.logo_url && client.logo_url !== result.url) {
    try {
      await deleteLogo(client.logo_url);
    } catch {
      /* an orphaned old object is tolerable; never fail the upload over it */
    }
  }

  revalidatePath("/clients");
  return { ok: true };
}

/** Move a workflow to a client (both validated as this tenant's by the repo). */
export async function assignWorkflowAction(input: {
  workflowId: string;
  clientId: string;
}): Promise<{ ok: boolean }> {
  await requireFullAccessForAction(); // owner/admin only — client management is not a member capability
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
  await requireFullAccessForAction(); // owner/admin only — client management is not a member capability
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
  await requireFullAccessForAction(); // owner/admin only — client management is not a member capability
  const tenantId = await getCurrentTenantId();
  const result = await deleteClient({ tenantId, clientId: input.clientId });
  revalidatePath("/clients");
  return { ok: result === "deleted", result };
}
