import { z } from "zod";
import { authenticateCrm, crmError, loadEnrichmentContact, resolveContactTarget } from "@/lib/crmApi";
import { getContactById } from "@worker/db/repositories/contacts.js";
import { detachTag, listTags } from "@worker/db/repositories/contactTags.js";

/**
 * DELETE /api/crm/v1/contacts/{contact_id}/tags/{tag}   [crm.write]   (tag name, url-encoded)
 *
 * Remove a tag from a contact BY NAME. Idempotent: if the tag doesn't exist or isn't
 * attached, it's a no-op (the tag catalogue entry is left intact). Records tag_removed as
 * the automation only when a link actually existed. Returns the ENRICHMENT contact shape
 * (no appointment fields).
 *
 * Identity-addressable (§1): {contact_id} is a UUID (no body) OR the literal `by-identity`,
 * in which case phone/email/external_id in the request body identify the contact. NEVER
 * creates a contact — an unknown identity is a 404.
 */
export const dynamic = "force-dynamic";

const Body = z
  .object({
    phone: z.string().trim().max(64).optional(),
    email: z.string().trim().max(256).optional(),
    external_id: z.string().trim().max(256).optional(),
  })
  .strict();

export async function DELETE(req: Request, { params }: { params: Promise<{ contactId: string; tag: string }> }): Promise<Response> {
  const auth = await authenticateCrm(req, "crm.write");
  if (!auth.ok) return auth.response;
  const { tenantId, clientId } = auth.auth;
  const { contactId, tag } = await params;
  const name = decodeURIComponent(tag).trim();

  // Identity for the by-identity path rides in the body; a UUID DELETE sends none.
  let ident: { phone?: string; email?: string; external_id?: string } = {};
  try {
    const parsed = Body.safeParse(await req.json());
    if (parsed.success) ident = parsed.data;
  } catch {
    /* no/invalid body → the UUID path, which needs no identity */
  }

  const target = await resolveContactTarget(auth.auth, contactId, {
    phone: ident.phone,
    email: ident.email,
    externalId: ident.external_id,
  });
  if (!target.ok) return target.response;
  const targetId = target.contactId;

  if (!(await getContactById(tenantId, targetId, clientId))) return crmError(404, "contact_not_found", "No contact with that id exists for this client. Call GET /api/crm/v1/contacts/lookup or POST /api/crm/v1/contacts/upsert to resolve one.");

  const found = (await listTags(tenantId, clientId)).find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (found) {
    await detachTag({ tenantId, clientId, contactId: targetId, tagId: found.id, actorUserId: null, actorKind: "automation" });
  }

  const contact = await loadEnrichmentContact(tenantId, clientId, targetId);
  return Response.json({ contact });
}
