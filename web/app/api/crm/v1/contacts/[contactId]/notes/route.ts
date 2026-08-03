import { z } from "zod";
import { authenticateCrm, crmError, idempotencyKey } from "@/lib/crmApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { isUniqueViolation } from "@worker/db/client.js";
import { createNote, getNoteByIdempotencyKey, type ContactNoteRow } from "@worker/db/repositories/contactNotes.js";

/**
 * POST /api/crm/v1/contacts/{contact_id}/notes   [crm.write]
 *
 * An automation-authored note (created_by_user_id null, author_kind 'automation') — it
 * appears in the C-4 timeline attributed to "Automation". Replay-safe: with an
 * Idempotency-Key, a retry returns the ORIGINAL note (201 fresh / 200 replay) instead of
 * a duplicate. Channel-blind.
 */
export const dynamic = "force-dynamic";

const Body = z.object({ body: z.string().trim().min(1).max(10000) }).strict();

function project(n: ContactNoteRow) {
  return { id: n.id, body: n.body, author: "automation" as const, created_at: n.created_at.toISOString() };
}

export async function POST(req: Request, { params }: { params: Promise<{ contactId: string }> }): Promise<Response> {
  const auth = await authenticateCrm(req, "crm.write");
  if (!auth.ok) return auth.response;
  const { tenantId, clientId } = auth.auth;
  const { contactId } = await params;
  if (!isUuid(contactId)) return crmError(404, "not_found", "Contact not found.");

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return crmError(422, "invalid_body", "Request body must be valid JSON.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return crmError(422, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");

  const key = idempotencyKey(req);
  if (key) {
    const existing = await getNoteByIdempotencyKey(tenantId, key);
    if (existing) return Response.json({ note: project(existing) }, { status: 200 });
  }

  try {
    const note = await createNote({
      tenantId,
      clientId,
      contactId,
      body: parsed.data.body,
      createdByUserId: null,
      authorKind: "automation",
      idempotencyKey: key,
    });
    if (!note) return crmError(404, "not_found", "Contact not found.");
    return Response.json({ note: project(note) }, { status: 201 });
  } catch (err) {
    // Concurrent retry with the same key raced us to the unique index → replay the winner.
    if (key && isUniqueViolation(err)) {
      const existing = await getNoteByIdempotencyKey(tenantId, key);
      if (existing) return Response.json({ note: project(existing) }, { status: 200 });
    }
    throw err;
  }
}
