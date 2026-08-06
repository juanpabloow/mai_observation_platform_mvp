import { z } from "zod";
import { authenticateCrm, crmError, loadMachineContact } from "@/lib/crmApi";
import { resolveLabelParams } from "@/lib/schedulingApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { getContactById } from "@worker/db/repositories/contacts.js";
import { createTag, attachTag, listTags } from "@worker/db/repositories/contactTags.js";

/**
 * POST /api/crm/v1/contacts/{contact_id}/tags   [crm.write]   body: { tag }
 *
 * Attach a tag BY NAME (agents don't know ids): creates the tag for the client if it
 * doesn't exist, then attaches idempotently (re-attaching is a no-op). Records tag_added
 * as the automation only when a new link is created. Returns the updated contact summary.
 */
export const dynamic = "force-dynamic";

const Body = z.object({ tag: z.string().trim().min(1).max(64) }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ contactId: string }> }): Promise<Response> {
  const auth = await authenticateCrm(req, "crm.write");
  if (!auth.ok) return auth.response;
  const labels = resolveLabelParams(req);
  if (!labels.ok) return labels.response;
  const { tenantId, clientId } = auth.auth;
  const { contactId } = await params;
  if (!isUuid(contactId)) return crmError(400, "invalid_request", "contact id must be a valid UUID.");

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return crmError(422, "invalid_body", "Request body must be valid JSON.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return crmError(422, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
  const name = parsed.data.tag;

  // Verify the contact is this client's BEFORE creating a tag (no orphan tag on a foreign id).
  if (!(await getContactById(tenantId, contactId, clientId))) return crmError(404, "contact_not_found", "No contact with that id exists for this client. Call GET /api/crm/v1/contacts/lookup or POST /api/crm/v1/contacts/upsert to resolve one.");

  // Find-or-create the tag by name (names are unique case-insensitively per client).
  const created = await createTag({ tenantId, clientId, name, color: "gray" });
  let tagId: string;
  if (created.ok) {
    tagId = created.tag.id;
  } else {
    const existing = (await listTags(tenantId, clientId)).find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!existing) return crmError(500, "internal", "Could not resolve the tag.");
    tagId = existing.id;
  }

  const att = await attachTag({ tenantId, clientId, contactId, tagId, actorUserId: null, actorKind: "automation" });
  if (!att.ok) return crmError(404, "contact_not_found", "No contact with that id exists for this client. Call GET /api/crm/v1/contacts/lookup or POST /api/crm/v1/contacts/upsert to resolve one.");

  const contact = await loadMachineContact(tenantId, clientId, contactId, { tzOverride: labels.tzOverride, locale: labels.locale });
  return Response.json({ contact });
}
