import { z } from "zod";
import { authenticateCrm, crmError, loadEnrichmentContact, resolveContactTarget } from "@/lib/crmApi";
import { getContactById } from "@worker/db/repositories/contacts.js";
import { createTag, attachTag, listTags } from "@worker/db/repositories/contactTags.js";

/**
 * POST /api/crm/v1/contacts/{contact_id}/tags   [crm.write]   body: { tag }
 *
 * Attach a tag BY NAME (agents don't know ids): creates the tag for the client if it
 * doesn't exist, then attaches idempotently (re-attaching is a no-op). Records tag_added
 * as the automation only when a new link is created. Returns the ENRICHMENT contact shape
 * (no appointment fields — a contact write must never look like a booking).
 *
 * Identity-addressable (§1): {contact_id} is a UUID OR the literal `by-identity`, in which
 * case phone/email/external_id in the body identify the contact. NEVER creates a contact —
 * an unknown identity is a 404.
 */
export const dynamic = "force-dynamic";

const Body = z
  .object({
    tag: z.string().trim().min(1).max(64),
    // Only read when the path is `by-identity`; ignored for a UUID path.
    phone: z.string().trim().max(64).optional(),
    email: z.string().trim().max(256).optional(),
    external_id: z.string().trim().max(256).optional(),
  })
  .strict();

export async function POST(req: Request, { params }: { params: Promise<{ contactId: string }> }): Promise<Response> {
  const auth = await authenticateCrm(req, "crm.write");
  if (!auth.ok) return auth.response;
  const { tenantId, clientId } = auth.auth;
  const { contactId } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return crmError(422, "invalid_body", "Request body must be valid JSON.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return crmError(422, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
  const name = parsed.data.tag;

  // UUID path OR by-identity (phone/email/external_id in the body). Unknown identity → 404,
  // creates nothing.
  const target = await resolveContactTarget(auth.auth, contactId, {
    phone: parsed.data.phone,
    email: parsed.data.email,
    externalId: parsed.data.external_id,
  });
  if (!target.ok) return target.response;
  const targetId = target.contactId;

  // Verify the contact is this client's BEFORE creating a tag (no orphan tag on a foreign
  // id). For the by-identity path this is already guaranteed; it guards the UUID path.
  if (!(await getContactById(tenantId, targetId, clientId))) return crmError(404, "contact_not_found", "No contact with that id exists for this client. Call GET /api/crm/v1/contacts/lookup or POST /api/crm/v1/contacts/upsert to resolve one.");

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

  const att = await attachTag({ tenantId, clientId, contactId: targetId, tagId, actorUserId: null, actorKind: "automation" });
  if (!att.ok) return crmError(404, "contact_not_found", "No contact with that id exists for this client. Call GET /api/crm/v1/contacts/lookup or POST /api/crm/v1/contacts/upsert to resolve one.");

  const contact = await loadEnrichmentContact(tenantId, clientId, targetId);
  return Response.json({ contact });
}
