import { authenticateCrm, crmError, loadMachineContact } from "@/lib/crmApi";
import { resolveLabelParams } from "@/lib/schedulingApi";
import { findContactIdsByIdentity } from "@worker/db/repositories/contactIdentities.js";

/**
 * GET /api/crm/v1/contacts/lookup?phone=&email=&external_id=   [crm.read]
 *
 * Read-only identity resolution (C-2 model): the query value is normalized (E.164 phone
 * / lowercased email / opaque external) before lookup. Creates NOTHING — a 404 lets an
 * agent ask "do we know this person?" and branch to upsert. Channel-blind.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateCrm(req, "crm.read");
  if (!auth.ok) return auth.response;
  const labels = resolveLabelParams(req);
  if (!labels.ok) return labels.response;

  const p = new URL(req.url).searchParams;
  const phone = p.get("phone") ?? undefined;
  const email = p.get("email") ?? undefined;
  const externalId = p.get("external_id") ?? undefined;
  if (!phone && !email && !externalId) {
    return crmError(400, "invalid_request", "Provide at least one of phone, email, or external_id.");
  }

  const ids = await findContactIdsByIdentity(
    { tenantId: auth.auth.tenantId, clientId: auth.auth.clientId, channelUserId: externalId, phone, email },
  );
  if (ids.length === 0) return crmError(404, "contact_not_found", "No contact matches that identity. Call POST /api/crm/v1/contacts/upsert to create one, or check the phone/email/external id.");

  const contact = await loadMachineContact(auth.auth.tenantId, auth.auth.clientId, ids[0], { tzOverride: labels.tzOverride, locale: labels.locale });
  if (!contact) return crmError(404, "contact_not_found", "No contact matches that identity. Call POST /api/crm/v1/contacts/upsert to create one, or check the phone/email/external id.");
  return Response.json({ contact });
}
