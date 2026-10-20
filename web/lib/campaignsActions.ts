"use server";

import { revalidatePath } from "next/cache";
import { canManageCampaigns } from "./access";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { isUuid } from "./clientModuleValidation";
import {
  normalizeAdName,
  normalizeAdNote,
  normalizeCampaignBrief,
  normalizeCampaignDate,
  normalizeCampaignName,
  normalizeCampaignStatus,
  normalizeExternalCampaignId,
  normalizeMetaAdId,
  validateDateRange,
} from "./campaignsValidation";
import {
  assignAdsToCampaign,
  createAd,
  createCampaign,
  endCampaign,
  getAdByExternalId,
  getAdById,
  getCampaignById,
  removeAdCover,
  setAdCover,
  updateAd,
  updateCampaign,
  type UpdateCampaignInput,
} from "@worker/db/repositories/attribution.js";
import { getServiceById } from "@worker/db/repositories/scheduling/services.js";
import { getPromotion } from "@worker/db/repositories/scheduling/promotions.js";
import { deleteObjectKey, isR2Configured, uploadServiceImage } from "./r2";

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

/**
 * AT-2b: PRE-REGISTER an ad by its Meta id, with optional name/note/campaign. A duplicate id in
 * the same client is refused with a message pointing at the existing ad. The row is identical to
 * what AT-1 ingestion would create, so the first lead only refreshes headline/body/seen and never
 * duplicates or overwrites these person-set fields.
 */
export async function createAdAction(input: {
  clientId: string;
  externalId: string;
  name?: string | null;
  botNote?: string | null;
  campaignId?: string | null;
}): Promise<CampaignsResult> {
  const auth = await requireCampaignsManager(input.clientId);
  if (!auth.ok) return auth;

  const id = normalizeMetaAdId(input.externalId);
  if (!id.ok) return { ok: false, error: id.error };
  const name = normalizeAdName(input.name);
  if (!name.ok) return { ok: false, error: name.error };
  const note = normalizeAdNote(input.botNote);
  if (!note.ok) return { ok: false, error: note.error };
  let campaignId: string | null = null;
  if (input.campaignId) {
    if (!isUuid(input.campaignId) || !(await getCampaignById(auth.tenantId, input.clientId, input.campaignId))) {
      return { ok: false, error: "Campaña desconocida." };
    }
    campaignId = input.campaignId;
  }

  const dupMsg = `Ya existe un anuncio con ese id (…${id.value.slice(-6)}). Búscalo en la lista de anuncios.`;
  if (await getAdByExternalId(auth.tenantId, input.clientId, id.value)) return { ok: false, error: dupMsg };
  try {
    const row = await createAd({
      tenantId: auth.tenantId,
      clientId: input.clientId,
      externalId: id.value,
      name: name.value,
      botNote: note.value,
      campaignId,
    });
    revalidateCampaigns(input.clientId);
    return { ok: true, id: row.id };
  } catch (err) {
    // ads_unique (client, platform, source_type, external_id) — a race past the check above.
    if ((err as { code?: string })?.code === "23505") return { ok: false, error: dupMsg };
    return { ok: false, error: "No se pudo agregar el anuncio." };
  }
}

/** AT-2b: edit a person-set ad field (name / bot_note). */
export async function updateAdAction(
  clientId: string,
  adId: string,
  patch: { name?: string | null; botNote?: string | null },
): Promise<CampaignsResult> {
  const auth = await requireCampaignsManager(clientId);
  if (!auth.ok) return auth;
  if (!isUuid(adId)) return { ok: false, error: "Anuncio no encontrado." };
  const built: { name?: string | null; botNote?: string | null } = {};
  if (patch.name !== undefined) {
    const n = normalizeAdName(patch.name);
    if (!n.ok) return { ok: false, error: n.error };
    built.name = n.value;
  }
  if (patch.botNote !== undefined) {
    const nt = normalizeAdNote(patch.botNote);
    if (!nt.ok) return { ok: false, error: nt.error };
    built.botNote = nt.value;
  }
  const row = await updateAd(auth.tenantId, clientId, adId, built);
  if (!row) return { ok: false, error: "Anuncio no encontrado." };
  revalidateCampaigns(clientId);
  return { ok: true, id: adId };
}

/**
 * AT-2c: upload a MANUAL ad cover (FormData: clientId, adId, image). Same MANAGE permission as
 * editing the ad; the permission check comes BEFORE the R2 gate. A manual cover is marked so the
 * automatic capture never replaces it. The previous object (if any) is deleted best-effort.
 */
export async function uploadAdCoverAction(formData: FormData): Promise<CampaignsResult & { url?: string }> {
  const clientId = String(formData.get("clientId") ?? "");
  const adId = String(formData.get("adId") ?? "");
  const file = formData.get("image");

  const auth = await requireCampaignsManager(clientId);
  if (!auth.ok) return auth;
  if (!isUuid(adId)) return { ok: false, error: "Anuncio no encontrado." };
  if (!isR2Configured) return { ok: false, error: "La subida de imágenes no está configurada." };
  if (!(file instanceof File)) return { ok: false, error: "Elige una imagen." };
  if (!(await getAdById(auth.tenantId, clientId, adId))) return { ok: false, error: "Anuncio no encontrado." };

  const up = await uploadServiceImage(auth.tenantId, clientId, adId, file, "ads");
  if (!up.ok) return { ok: false, error: up.error };
  const set = await setAdCover(auth.tenantId, clientId, adId, up.key);
  if (!set.ok) {
    await deleteObjectKey(up.key).catch(() => {}); // the ad vanished mid-upload — drop the orphan
    return { ok: false, error: "Anuncio no encontrado." };
  }
  if (set.previousKey && set.previousKey !== up.key) await deleteObjectKey(set.previousKey).catch(() => {});
  revalidateCampaigns(clientId);
  return { ok: true, id: adId, url: up.url };
}

/** AT-2c: remove an ad cover. Clears cover_source so automatic capture can resume on the next touch. */
export async function removeAdCoverAction(clientId: string, adId: string): Promise<CampaignsResult> {
  const auth = await requireCampaignsManager(clientId);
  if (!auth.ok) return auth;
  if (!isUuid(adId)) return { ok: false, error: "Anuncio no encontrado." };
  const res = await removeAdCover(auth.tenantId, clientId, adId);
  if (!res.ok) return { ok: false, error: "Anuncio no encontrado." };
  if (res.previousKey) await deleteObjectKey(res.previousKey).catch(() => {});
  revalidateCampaigns(clientId);
  return { ok: true, id: adId };
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
