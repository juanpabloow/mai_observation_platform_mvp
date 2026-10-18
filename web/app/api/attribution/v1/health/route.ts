import { authenticateHandoffRequest, handoffError } from "@/lib/handoffApi";
import { getAttributionFailureCount } from "@worker/attribution/ingest.js";
import { countPendingAttributions } from "@worker/db/repositories/attribution.js";

/**
 * AT-1 §3 — attribution health. Token-authed (handoff), tenant-scoped:
 *   - failed_attributions: live-ingestion failures caught in THIS web process since start
 *     (in-memory, resets on deploy — a quick "is something wrong right now" signal).
 *   - pending_attributions: referral messages for this tenant with a linked contact but no touch
 *     (the durable backlog the worker reconciliation drains; a persistently rising number means
 *     attribution isn't landing).
 * Never returns ctwa_clid or any per-contact data.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateHandoffRequest(req, "handoff");
  if (!auth.ok) return auth.response;
  try {
    const pending = await countPendingAttributions(auth.auth.tenantId);
    return Response.json({
      ok: true,
      failed_attributions: getAttributionFailureCount(),
      pending_attributions: pending,
    });
  } catch {
    return handoffError(500, "health_error", "Could not read attribution health.");
  }
}
