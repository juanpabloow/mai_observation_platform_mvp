import { z } from "zod";
import { authenticateCrm, crmError, loadMachineContact, loadEnrichmentContact, toCompactContact, applyConsentAsAutomation, recordAutomationActivity } from "@/lib/crmApi";
import { resolveLabelParams } from "@/lib/schedulingApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { getContactById, updateContact } from "@worker/db/repositories/contacts.js";
import { listFieldDefinitions, validateCustomFieldValues } from "@worker/db/repositories/clientFieldDefinitions.js";

/**
 * GET   /api/crm/v1/contacts/{contact_id}   [crm.read]  — the contact summary.
 * PATCH /api/crm/v1/contacts/{contact_id}   [crm.write] — name/email/stage/custom_fields
 *   /consent. Custom fields are validated against the client's field definitions (unknown
 *   key or wrong type → 422 naming the field). Consent OVERWRITES (an explicit opt-out
 *   must stick). Stage + consent changes write the crm_activity_events audit fact as the
 *   automation, so the C-4 timeline shows them truthfully. Channel-blind.
 */
export const dynamic = "force-dynamic";

const Patch = z
  .object({
    name: z.string().trim().max(256).optional(),
    email: z.string().trim().max(256).optional(),
    stage: z.enum(["new", "active", "customer", "archived"]).optional(),
    consent: z.enum(["unknown", "opted_in", "opted_out"]).optional(),
    custom_fields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export async function GET(req: Request, { params }: { params: Promise<{ contactId: string }> }): Promise<Response> {
  const auth = await authenticateCrm(req, "crm.read");
  if (!auth.ok) return auth.response;
  const { contactId } = await params;
  if (!isUuid(contactId)) return crmError(400, "invalid_request", "contact id must be a valid UUID.");
  const labels = resolveLabelParams(req);
  if (!labels.ok) return labels.response;

  const contact = await loadMachineContact(auth.auth.tenantId, auth.auth.clientId, contactId, { tzOverride: labels.tzOverride, locale: labels.locale });
  if (!contact) return crmError(404, "contact_not_found", "No contact with that id exists for this client. Call GET /api/crm/v1/contacts/lookup or POST /api/crm/v1/contacts/upsert to resolve one.");
  const compact = new URL(req.url).searchParams.get("compact") === "true";
  return Response.json({ contact: compact ? toCompactContact(contact) : contact });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ contactId: string }> }): Promise<Response> {
  const auth = await authenticateCrm(req, "crm.write");
  if (!auth.ok) return auth.response;
  const { tenantId, clientId } = auth.auth;
  const { contactId } = await params;
  if (!isUuid(contactId)) return crmError(400, "invalid_request", "contact id must be a valid UUID.");
  // No tz/locale here: a PATCH returns the enrichment shape, which carries no timestamps.

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return crmError(422, "invalid_body", "Request body must be valid JSON.");
  }
  const parsed = Patch.safeParse(raw);
  if (!parsed.success) return crmError(422, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
  const body = parsed.data;

  // The contact must belong to this client (missing/cross-client → the same 404).
  const existing = await getContactById(tenantId, contactId, clientId);
  if (!existing) return crmError(404, "contact_not_found", "No contact with that id exists for this client. Call GET /api/crm/v1/contacts/lookup or POST /api/crm/v1/contacts/upsert to resolve one.");

  // Custom fields validated against the client's definitions BEFORE any write.
  let customValue: Record<string, unknown> | undefined;
  let customClear: string[] = [];
  if (body.custom_fields !== undefined) {
    const defs = await listFieldDefinitions(tenantId, clientId, { enabledOnly: true });
    const check = validateCustomFieldValues(defs, body.custom_fields);
    if (!check.ok) return crmError(422, "validation", check.error);
    customValue = check.value;
    customClear = check.clear;
  }

  // Apply the profile fields (name/email/stage/custom_fields) in one update. custom_fields
  // is a PARTIAL merge (+ clear) — never a destructive replace.
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.email !== undefined) patch.email = body.email;
  if (body.stage !== undefined) patch.stage = body.stage;
  if (customValue !== undefined) {
    patch.custom_fields = customValue;
    patch.custom_fields_clear = customClear;
  }
  if (Object.keys(patch).length > 0) {
    await updateContact(tenantId, contactId, patch, clientId);
  }
  if (body.stage !== undefined && body.stage !== existing.stage) {
    await recordAutomationActivity({ tenantId, clientId, contactId, eventType: "stage_changed", detail: { from: existing.stage, to: body.stage } });
  }
  // Consent overwrites + audits (only when it actually changes).
  if (body.consent !== undefined && body.consent !== existing.messaging_consent) {
    await applyConsentAsAutomation(tenantId, clientId, contactId, body.consent, "api");
  }

  // A WRITE returns the enrichment shape — no next_appointment (a write must not look like a
  // booking). GET (below) is the read that surfaces the full contact incl. next_appointment.
  const contact = await loadEnrichmentContact(tenantId, clientId, contactId);
  return Response.json({ contact });
}
