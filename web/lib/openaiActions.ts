"use server";

import { revalidatePath } from "next/cache";
import { encrypt } from "@worker/crypto.js";
import { looksLikeAdminKey } from "@worker/analytics/openaiBilling.js";
import { fetchCosts, OpenAiAdminError } from "@worker/openai/adminClient.js";
import { syncOpenAiForTenant } from "@worker/analytics/syncOpenAi.js";
import {
  deleteOpenAiConnection,
  listOpenAiProjects,
  setClientOpenAiProject,
  upsertOpenAiConnection,
} from "@worker/db/repositories/openaiBilling.js";
import { requireFullAccessForAction } from "./access";
import { isUuid } from "./clientModuleValidation";

/**
 * COSTOS DE IA — connect the agency's OpenAI organization (Admin key) to read what it was billed.
 * Agency only (tenant owner/admin), checked first in every action. The key:
 *   - is checked for shape, then TESTED with one read-only call before anything is stored;
 *   - is stored ENCRYPTED (ENCRYPTION_KEY), never returned, never logged; only its last 4
 *     characters are kept in clear as a hint;
 *   - is used only server-side by the sync (src/analytics/syncOpenAi.ts).
 */

type Result = { ok: true } | { ok: false; error: string };

export async function connectOpenAiAction(rawKey: string): Promise<Result> {
  const scope = await requireFullAccessForAction();
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!looksLikeAdminKey(key)) {
    return { ok: false, error: "Eso no parece una Admin key de OpenAI (empieza por sk-admin-)." };
  }
  // One read-only call proves the key works and can read costs, before storing anything.
  const now = Math.floor(Date.now() / 1000);
  try {
    await fetchCosts(key, now - 2 * 86_400, now);
  } catch (err) {
    return { ok: false, error: err instanceof OpenAiAdminError ? err.message : "No se pudo comprobar la clave con OpenAI." };
  }
  await upsertOpenAiConnection({ tenantId: scope.tenantId, keyEncrypted: encrypt(key), keyHint: key.slice(-4), userId: scope.userId });
  const sync = await syncOpenAiForTenant(scope.tenantId);
  revalidatePath("/costos-ia");
  return sync.ok ? { ok: true } : { ok: false, error: `Clave guardada, pero la primera sincronización falló: ${sync.error}` };
}

export async function syncOpenAiNowAction(): Promise<Result> {
  const scope = await requireFullAccessForAction();
  const sync = await syncOpenAiForTenant(scope.tenantId);
  revalidatePath("/costos-ia");
  return sync.ok ? { ok: true } : { ok: false, error: sync.error };
}

/**
 * Assign the OpenAI project a business's bots use (or clear it with null). Only a project the
 * organization actually has (as last synced) is accepted — never an arbitrary string.
 */
export async function setClientOpenAiProjectAction(input: { clientId: string; projectId: string | null }): Promise<Result> {
  const scope = await requireFullAccessForAction();
  if (!isUuid(input.clientId)) return { ok: false, error: "Negocio no encontrado." };
  if (input.projectId !== null) {
    const known = await listOpenAiProjects(scope.tenantId);
    if (!known.some((p) => p.project_id === input.projectId)) return { ok: false, error: "Ese proyecto no está en la organización conectada." };
  }
  const ok = await setClientOpenAiProject({ tenantId: scope.tenantId, clientId: input.clientId, projectId: input.projectId });
  revalidatePath("/costos-ia");
  return ok ? { ok: true } : { ok: false, error: "Negocio no encontrado." };
}

export async function disconnectOpenAiAction(): Promise<Result> {
  const scope = await requireFullAccessForAction();
  await deleteOpenAiConnection(scope.tenantId);
  revalidatePath("/costos-ia");
  return { ok: true };
}
