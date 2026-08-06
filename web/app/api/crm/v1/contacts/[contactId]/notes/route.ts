import { z } from "zod";
import { authenticateCrm, crmError, idempotencyKey, resolveContactTarget } from "@/lib/crmApi";
import { resolveLabelParams } from "@/lib/schedulingApi";
import { isUniqueViolation } from "@worker/db/client.js";
import { createNote, getNoteByIdempotencyKey, type ContactNoteRow } from "@worker/db/repositories/contactNotes.js";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
import { localMomentFields } from "@/lib/localTime";

/**
 * POST /api/crm/v1/contacts/{contact_id}/notes   [crm.write]
 *
 * An automation-authored note (created_by_user_id null, author_kind 'automation') — it
 * appears in the C-4 timeline attributed to "Automation". Replay-safe: with an
 * Idempotency-Key, a retry returns the ORIGINAL note (201 fresh / 200 replay) instead of
 * a duplicate. Channel-blind.
 *
 * Identity-addressable (§1): {contact_id} is a UUID OR the literal `by-identity`, in which
 * case phone/email/external_id in the body identify the contact. NEVER creates — an unknown
 * identity is a 404, not a new contact.
 */
export const dynamic = "force-dynamic";

const Body = z
  .object({
    body: z.string().trim().min(1).max(10000),
    // Only read when the path is `by-identity`; ignored for a UUID path.
    phone: z.string().trim().max(64).optional(),
    email: z.string().trim().max(256).optional(),
    external_id: z.string().trim().max(256).optional(),
  })
  .strict();

// Rule: no machine timestamp without a local label. A note has no site, so the label uses
// the ?tz override, else the client's first site timezone, else UTC.
function project(n: ContactNoteRow, tz: string, locale: string) {
  const m = localMomentFields(n.created_at, tz, locale);
  return { id: n.id, body: n.body, author: "automation" as const, created_at: n.created_at.toISOString(), created_at_local: m.local, created_at_label: m.label };
}

export async function POST(req: Request, { params }: { params: Promise<{ contactId: string }> }): Promise<Response> {
  const auth = await authenticateCrm(req, "crm.write");
  if (!auth.ok) return auth.response;
  const { tenantId, clientId } = auth.auth;
  const { contactId } = await params;
  const labels = resolveLabelParams(req);
  if (!labels.ok) return labels.response;
  const locale = labels.locale;
  const tz = labels.tzOverride ?? (await listSites(tenantId, { clientId }))[0]?.timezone ?? "UTC";

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return crmError(422, "invalid_body", "Request body must be valid JSON.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return crmError(422, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");

  // UUID path OR by-identity (phone/email/external_id in the body). Unknown identity → 404,
  // creates nothing.
  const target = await resolveContactTarget(auth.auth, contactId, {
    phone: parsed.data.phone,
    email: parsed.data.email,
    externalId: parsed.data.external_id,
  });
  if (!target.ok) return target.response;

  const key = idempotencyKey(req);
  if (key) {
    const existing = await getNoteByIdempotencyKey(tenantId, key);
    if (existing) return Response.json({ note: project(existing, tz, locale) }, { status: 200 });
  }

  try {
    const note = await createNote({
      tenantId,
      clientId,
      contactId: target.contactId,
      body: parsed.data.body,
      createdByUserId: null,
      authorKind: "automation",
      idempotencyKey: key,
    });
    if (!note) return crmError(404, "contact_not_found", "No contact with that id exists for this client. Call GET /api/crm/v1/contacts/lookup or POST /api/crm/v1/contacts/upsert to resolve one.");
    return Response.json({ note: project(note, tz, locale) }, { status: 201 });
  } catch (err) {
    // Concurrent retry with the same key raced us to the unique index → replay the winner.
    if (key && isUniqueViolation(err)) {
      const existing = await getNoteByIdempotencyKey(tenantId, key);
      if (existing) return Response.json({ note: project(existing, tz, locale) }, { status: 200 });
    }
    throw err;
  }
}
