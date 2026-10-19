"use server";

import { revalidatePath } from "next/cache";
import { canManageCampaigns } from "./access";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { isUuid } from "./clientModuleValidation";
import {
  normalizeCampaignBrief,
  normalizeCampaignDate,
  normalizeCampaignName,
  normalizeCampaignStatus,
  normalizeExternalCampaignId,
  validateDateRange,
} from "./campaignsValidation";
import {
  assignAdsToCampaign,
  createCampaign,
  endCampaign,
  getCampaignById,
  updateCampaign,
  type UpdateCampaignInput,
} from "@worker/db/repositories/attribution.js";
import { getServiceById } from "@worker/db/repositories/scheduling/services.js";
import { getPromotion } from "@worker/db/repositories/scheduling/promotions.js";

/**
 * CLIENT-ADMIN management for a client's CAMPAIGNS + ad→campaign assignment. Every action
 * is MANAGE-tier only (the agency OR this client's Owner — `canManageCampaigns`); a Setter
 * reads the Campañas section but runs none of these, and Staff never reaches it. Each action
 * re-resolves the route clientId against the session scope + the `campaigns` module
 * (`resolveClientModuleContext`) before the role check — a forged clientId or a disabled
 * module is one generic refusal. The clientId used for every write is the VALIDATED route id,
 * never a form field, so an action can't cross into another client. Manual CONTACT origin
 * lives in attributionActions.ts (`setContactOriginManualAction`) and is reused as-is.
 */

export type CampaignsResult = { ok: true; id?: string } | { ok: false; error: string };

const UNAVAILABLE = "Las campañas no están disponibles para este cliente.";

async function requireCampaignsManager(
  clientId: string,
): Promise<{ ok: true; tenantId: string } | { ok: false; error: string }> {
  const res = await resolveClientModuleContext(clientId, "campaigns");
  if (!res.ok || !canManageCampaigns(res.context.scope, clientId)) {
    return { ok: false, error: UNAVAILABLE };
  }
  return { ok: true, tenantId: res.context.scope.tenantId };
}

/** Validate an optional target service / promotion belongs to THIS client. */
async function resolveTargets(
  tenantId: string,
  clientId: string,
  input: { targetServiceId?: string | null; promotionId?: string | null },
): Promise<{ ok: true; targetServiceId: string | null; promotionId: string | null } | { ok: false; error: string }> {
  let targetServiceId: string | null = null;
  if (input.targetServiceId) {
    if (!isUuid(input.targetServiceId) || !(await getServiceById(tenantId, clientId, input.targetServiceId))) {
      return { ok: false, error: "Servicio objetivo desconocido." };
    }
    targetServiceId = input.targetServiceId;
  }
  let promotionId: string | null = null;
  if (input.promotionId) {
    if (!isUuid(input.promotionId) || !(await getPromotion(tenantId, clientId, input.promotionId))) {
      return { ok: false, error: "Promoción desconocida." };
    }
    promotionId = input.promotionId;
  }
  return { ok: true, targetServiceId, promotionId };
}

export interface CampaignInput {
  clientId: string;
  name: string;
  status?: string;
  startDate?: string | null;
  endDate?: string | null;
  externalCampaignId?: string | null;
  targetServiceId?: string | null;
  promotionId?: string | null;
  botBrief?: string | null;
}

export async function createCampaignAction(input: CampaignInput): Promise<CampaignsResult> {
  const auth = await requireCampaignsManager(input.clientId);
  if (!auth.ok) return auth;

  const name = normalizeCampaignName(input.name);
  if (!name.ok) return { ok: false, error: name.error };
  const status = normalizeCampaignStatus(input.status ?? "active");
  if (!status.ok) return { ok: false, error: status.error };
  const start = normalizeCampaignDate(input.startDate);
  if (!start.ok) return { ok: false, error: start.error };
  const end = normalizeCampaignDate(input.endDate);
  if (!end.ok) return { ok: false, error: end.error };
  const range = validateDateRange(start.value, end.value);
  if (!range.ok) return { ok: false, error: range.error };
  const ext = normalizeExternalCampaignId(input.externalCampaignId);
  if (!ext.ok) return { ok: false, error: ext.error };
  const brief = normalizeCampaignBrief(input.botBrief);
  if (!brief.ok) return { ok: false, error: brief.error };
  const targets = await resolveTargets(auth.tenantId, input.clientId, input);
  if (!targets.ok) return targets;

  try {
    const row = await createCampaign({
      tenantId: auth.tenantId,
      clientId: input.clientId,
      name: name.value,
      status: status.value,
      startDate: start.value,
      endDate: end.value,
      externalCampaignId: ext.value,
      targetServiceId: targets.targetServiceId,
      promotionId: targets.promotionId,
      botBrief: brief.value,
    });
    revalidateCampaigns(input.clientId);
    return { ok: true, id: row.id };
  } catch {
    return { ok: false, error: "No se pudo crear la campaña." };
  }
}

export async function updateCampaignAction(
  clientId: string,
  id: string,
  patch: Omit<CampaignInput, "clientId">,
): Promise<CampaignsResult> {
  const auth = await requireCampaignsManager(clientId);
  if (!auth.ok) return auth;
  if (!isUuid(id)) return { ok: false, error: "Campaña no encontrada." };

  const built: UpdateCampaignInput = {};
  if (patch.name !== undefined) {
    const name = normalizeCampaignName(patch.name);
    if (!name.ok) return { ok: false, error: name.error };
    built.name = name.value;
  }
  if (patch.status !== undefined) {
    const status = normalizeCampaignStatus(patch.status);
    if (!status.ok) return { ok: false, error: status.error };
    built.status = status.value;
  }
  if (patch.startDate !== undefined) {
    const start = normalizeCampaignDate(patch.startDate);
    if (!start.ok) return { ok: false, error: start.error };
    built.startDate = start.value;
  }
  if (patch.endDate !== undefined) {
    const end = normalizeCampaignDate(patch.endDate);
    if (!end.ok) return { ok: false, error: end.error };
    built.endDate = end.value;
  }
  // When both dates are being set, enforce the range against the incoming pair.
  if (built.startDate !== undefined && built.endDate !== undefined) {
    const range = validateDateRange(built.startDate, built.endDate);
    if (!range.ok) return { ok: false, error: range.error };
  }
  if (patch.externalCampaignId !== undefined) {
    const ext = normalizeExternalCampaignId(patch.externalCampaignId);
    if (!ext.ok) return { ok: false, error: ext.error };
    built.externalCampaignId = ext.value;
  }
  if (patch.botBrief !== undefined) {
    const brief = normalizeCampaignBrief(patch.botBrief);
    if (!brief.ok) return { ok: false, error: brief.error };
    built.botBrief = brief.value;
  }
  if (patch.targetServiceId !== undefined || patch.promotionId !== undefined) {
    const targets = await resolveTargets(auth.tenantId, clientId, patch);
    if (!targets.ok) return targets;
    if (patch.targetServiceId !== undefined) built.targetServiceId = targets.targetServiceId;
    if (patch.promotionId !== undefined) built.promotionId = targets.promotionId;
  }

  try {
    const row = await updateCampaign(auth.tenantId, clientId, id, built);
    if (!row) return { ok: false, error: "Campaña no encontrada." };
    revalidateCampaigns(clientId);
    return { ok: true, id };
  } catch {
    return { ok: false, error: "No se pudo guardar la campaña." };
  }
}

export async function endCampaignAction(clientId: string, id: string): Promise<CampaignsResult> {
  const auth = await requireCampaignsManager(clientId);
  if (!auth.ok) return auth;
  if (!isUuid(id)) return { ok: false, error: "Campaña no encontrada." };
  const row = await endCampaign(auth.tenantId, clientId, id);
  if (!row) return { ok: false, error: "Campaña no encontrada." };
  revalidateCampaigns(clientId);
  return { ok: true, id };
}

/** Assign (campaignId) or clear (null) the campaign of one or more ads. */
export async function assignAdsToCampaignAction(
  clientId: string,
  adIds: string[],
  campaignId: string | null,
): Promise<CampaignsResult> {
  const auth = await requireCampaignsManager(clientId);
  if (!auth.ok) return auth;
  const ids = Array.isArray(adIds) ? adIds.filter((x) => isUuid(x)) : [];
  if (ids.length === 0) return { ok: false, error: "Selecciona al menos un anuncio." };
  if (campaignId !== null) {
    if (!isUuid(campaignId) || !(await getCampaignById(auth.tenantId, clientId, campaignId))) {
      return { ok: false, error: "Campaña desconocida." };
    }
  }
  await assignAdsToCampaign(auth.tenantId, clientId, ids, campaignId);
  revalidateCampaigns(clientId);
  return { ok: true };
}

function revalidateCampaigns(clientId: string): void {
  revalidatePath(`/clients/${clientId}/campaigns`);
}
