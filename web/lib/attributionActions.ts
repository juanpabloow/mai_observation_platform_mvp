"use server";

import { requireFullAccessForAction } from "./access";
import { getClientForTenant } from "./clientWorkflow";
import { setAttributionTrackingStartedAt } from "@worker/db/repositories/attribution.js";

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
  return { ok: true };
}
