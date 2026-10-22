"use server";

import { revalidatePath } from "next/cache";
import { NO_PERMISSION, requireFullAccessForAction } from "./access";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { getClientForTenant } from "./clientWorkflow";
import { getContactById } from "@worker/db/repositories/contacts.js";
import {
  getAdById,
  getCampaignById,
  setAttributionBriefWindowDays,
  setAttributionTrackingStartedAt,
  setContactOrigin,
} from "@worker/db/repositories/attribution.js";
import { isUuid } from "./clientModuleValidation";

/**
 * AT-1 — attribution settings server action. AGENCY ONLY (requireFullAccessForAction →
 * owner/admin; a member, including a Client Owner, is refused at the data layer). UI arrives
 * in AT-2; this is enough to set the per-client tracking start now.
 *
 * `attribution_tracking_started_at` dates the moment "no referral = organic" becomes true for
 * a client. Before it, the absence of a referral proves nothing (those contacts are 'unknown').
 * Pass null to clear it (tracking effectively not started).
 */
export async function setAttributionTrackingStartedAtAction(
  clientId: string,
  iso: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const { tenantId } = await requireFullAccessForAction();
  const client = await getClientForTenant(clientId); // tenant-scoped; foreign/bogus → null
  if (!client || client.is_default) return { ok: false, error: "Unknown client." };

  let at: Date | null = null;
  if (iso !== null && iso.trim() !== "") {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { ok: false, error: "Invalid date." };
    at = d;
  }
  await setAttributionTrackingStartedAt(tenantId, clientId, at);
  revalidatePath(`/clients/${clientId}/campaigns/settings`);
  return { ok: true };
}

/**
 * AT-2 §3 — the AT-3 BRIEF WINDOW (days). AGENCY ONLY (requireFullAccessForAction). Bounded
 * 1..90 (mirrors the DB CHECK). Stored now; read by AT-3.
 */
export async function setAttributionBriefWindowDaysAction(
  clientId: string,
  days: number,
): Promise<{ ok: boolean; error?: string }> {
  const { tenantId } = await requireFullAccessForAction();
  const client = await getClientForTenant(clientId);
  if (!client || client.is_default) return { ok: false, error: "Unknown client." };
  const n = Math.trunc(Number(days));
  if (!Number.isFinite(n) || n < 1 || n > 90) {
    return { ok: false, error: "La ventana debe estar entre 1 y 90 días." };
  }
  await setAttributionBriefWindowDays(tenantId, clientId, n);
  revalidatePath(`/clients/${clientId}/campaigns/settings`);
  return { ok: true };
}

/**
 * AT-1 §2 — MANUAL origin. campaigns.manage (the agency, the Dueño) may set the
 * origin of a contact whose current origin is `unknown` or `import` — pointing it at a
 * campaign/ad or leaving a free-text note. Recorded as `manual` with the actor. It NEVER
 * overwrites a captured ad origin (enforced in setContactOrigin: overwritable is unknown/import
 * only). A member who is not this client's Owner is refused.
 */
export async function setContactOriginManualAction(
  clientId: string,
  contactId: string,
  input: { note?: string | null; adId?: string | null; campaignId?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  if (!isUuid(clientId) || !isUuid(contactId)) return { ok: false, error: "Invalid input." };
  // The contact lives in the CRM module; the permission is the campaigns one. Both are
  // required — the module gate also proves the client is in the tenant and not default.
  const gate = await resolveClientModuleContext(clientId, "crm", "campaigns.manage");
  if (!gate.ok) return { ok: false, error: gate.forbidden ? NO_PERMISSION : "Unknown client." };
  const scope = gate.context.scope;
  // Pointing the origin at an ad/campaign needs the campaigns module itself.
  if ((input.adId || input.campaignId) && !(await isClientModuleEnabled(scope.tenantId, clientId, "campaigns"))) {
    return { ok: false, error: "Las campañas no están disponibles para este cliente." };
  }

  const contact = await getContactById(scope.tenantId, contactId, clientId);
  if (!contact) return { ok: false, error: "Contact not found." };
  if (contact.origin_kind !== null && contact.origin_kind !== "unknown" && contact.origin_kind !== "import") {
    return { ok: false, error: "This contact already has a captured origin; manual origin can only set an unknown or imported contact." };
  }

  // Validate any referenced ad/campaign belongs to THIS client (never trust the id).
  let refAdId: string | null = null;
  if (input.adId) {
    if (!isUuid(input.adId) || !(await getAdById(scope.tenantId, clientId, input.adId))) return { ok: false, error: "Unknown ad." };
    refAdId = input.adId;
  }
  let refCampaignId: string | null = null;
  if (input.campaignId) {
    if (!isUuid(input.campaignId) || !(await getCampaignById(scope.tenantId, clientId, input.campaignId))) return { ok: false, error: "Unknown campaign." };
    refCampaignId = input.campaignId;
  }
  const note = (input.note ?? "").trim() || null;

  const set = await setContactOrigin({
    tenantId: scope.tenantId,
    clientId,
    contactId,
    originKind: "manual",
    setBy: scope.userId,
    note,
    refAdId,
    refCampaignId,
    overwritable: ["unknown", "import"],
  });
  if (!set) return { ok: false, error: "Could not set the origin (it may already be captured)." };
  return { ok: true };
}
