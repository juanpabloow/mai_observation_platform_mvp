import { authenticateCrm, crmError, loadMachineContact } from "@/lib/crmApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { getContactById } from "@worker/db/repositories/contacts.js";
import { detachTag, listTags } from "@worker/db/repositories/contactTags.js";

/**
 * DELETE /api/crm/v1/contacts/{contact_id}/tags/{tag}   [crm.write]   (tag name, url-encoded)
 *
 * Remove a tag from a contact BY NAME. Idempotent: if the tag doesn't exist or isn't
 * attached, it's a no-op (the tag catalogue entry is left intact). Records tag_removed as
 * the automation only when a link actually existed. Returns the updated contact summary.
 */
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ contactId: string; tag: string }> }): Promise<Response> {
  const auth = await authenticateCrm(req, "crm.write");
  if (!auth.ok) return auth.response;
  const { tenantId, clientId } = auth.auth;
  const { contactId, tag } = await params;
  if (!isUuid(contactId)) return crmError(400, "invalid_request", "contact id must be a valid UUID.");
  const name = decodeURIComponent(tag).trim();

  if (!(await getContactById(tenantId, contactId, clientId))) return crmError(404, "contact_not_found", "No contact with that id exists for this client. Call GET /api/crm/v1/contacts/lookup or POST /api/crm/v1/contacts/upsert to resolve one.");

  const found = (await listTags(tenantId, clientId)).find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (found) {
    await detachTag({ tenantId, clientId, contactId, tagId: found.id, actorUserId: null, actorKind: "automation" });
  }

  const contact = await loadMachineContact(tenantId, clientId, contactId);
  return Response.json({ contact });
}
