"use server";

import { revalidatePath } from "next/cache";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { hasFullAccess } from "./access";
import {
  createFieldDefinition,
  updateFieldDefinition,
  type FieldType,
} from "@worker/db/repositories/clientFieldDefinitions.js";

/**
 * Custom-field DEFINITION management — owner/admin only (a member cannot manage
 * definitions; the gate below refuses them server-side). Gated by the `crm` module.
 */

export type FieldDefActionResult = { ok: true } | { ok: false; error: string };

async function gate(clientId: string) {
  const resolved = await resolveClientModuleContext(clientId, "crm");
  if (!resolved.ok) return null;
  if (!hasFullAccess(resolved.context.scope)) return null; // owner/admin only
  return resolved.context;
}

export async function createFieldDefinitionAction(
  clientId: string,
  input: { key: string; label: string; type: FieldType; options?: string[] | null; position?: number },
): Promise<FieldDefActionResult> {
  const ctx = await gate(clientId);
  if (!ctx) return { ok: false, error: "Not allowed." };
  const r = await createFieldDefinition({ tenantId: ctx.scope.tenantId, clientId: ctx.client.id, ...input });
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(`/clients/${ctx.client.id}/contacts/fields`);
  return { ok: true };
}

export async function updateFieldDefinitionAction(
  clientId: string,
  id: string,
  patch: { label?: string; options?: string[] | null; position?: number; enabled?: boolean },
): Promise<FieldDefActionResult> {
  const ctx = await gate(clientId);
  if (!ctx) return { ok: false, error: "Not allowed." };
  const row = await updateFieldDefinition(ctx.scope.tenantId, ctx.client.id, id, patch);
  if (!row) return { ok: false, error: "Field not found." };
  revalidatePath(`/clients/${ctx.client.id}/contacts/fields`);
  return { ok: true };
}
