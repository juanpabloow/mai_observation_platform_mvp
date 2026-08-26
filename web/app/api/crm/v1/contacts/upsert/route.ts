import { z } from "zod";
import { authenticateCrm, crmError, loadEnrichmentContact, applyConsentAsAutomation } from "@/lib/crmApi";
import { resolveContactByIdentity } from "@worker/db/repositories/contactIdentities.js";
import { updateContact } from "@worker/db/repositories/contacts.js";
import { listFieldDefinitions, validateCustomFieldValues } from "@worker/db/repositories/clientFieldDefinitions.js";
import { identitiesSchema } from "@/lib/identities";

/**
 * POST /api/crm/v1/contacts/upsert   [crm.write]
 *
 * The ONE path that may create a contact — through C-2's resolveContactByIdentity
 * chokepoint (normalizes phone/email/external so the same person can't fork into two
 * contacts; records duplicate candidates rather than silently merging). Profile fields
 * are FILL-EMPTY (a non-empty name is never overwritten with a worse one); consent, when
 * supplied, OVERWRITES (an explicit opt-out must stick). Naturally idempotent — resolving
 * the same identity returns the same contact — and it still accepts an Idempotency-Key.
 * Channel-blind: identities are phone/email/external; `source_label` is just a free label.
 */
export const dynamic = "force-dynamic";

const Body = z
  .object({
    phone: z.string().trim().min(1).max(64).optional(),
    email: z.string().trim().min(1).max(256).optional(),
    external_id: z.string().trim().min(1).max(256).optional(),
    name: z.string().trim().max(256).optional(),
    custom_fields: z.record(z.string(), z.unknown()).optional(),
    consent: z.enum(["unknown", "opted_in", "opted_out"]).optional(),
    source_label: z.string().trim().max(64).optional(),
    // I-1: additional identities to attach to the resolved contact (phone/email/external),
    // beyond the primary phone/email/external_id. All go through the same collision rules.
    identities: identitiesSchema,
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateCrm(req, "crm.write");
  if (!auth.ok) return auth.response;
  const { tenantId, clientId } = auth.auth;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return crmError(422, "invalid_body", "Request body must be valid JSON.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return crmError(422, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
  const body = parsed.data;

  // At least one identity is required — the primary is phone → email → external.
  const primary = body.phone ?? body.email ?? body.external_id;
  if (!primary) return crmError(422, "invalid_body", "Provide at least one identity: phone, email, or external_id.");

  // Validate custom fields (if any) BEFORE creating/mutating anything.
  let customValue: Record<string, unknown> | undefined;
  let customClear: string[] = [];
  if (body.custom_fields !== undefined) {
    const defs = await listFieldDefinitions(tenantId, clientId, { enabledOnly: true });
    const check = validateCustomFieldValues(defs, body.custom_fields);
    if (!check.ok) return crmError(422, "validation", check.error);
    customValue = check.value;
    customClear = check.clear;
  }

  // Resolve (create-or-match) through the identity spine — fill-empty for name/phone/email.
  const { contact } = await resolveContactByIdentity({
    tenantId,
    clientId,
    channel: body.source_label ?? "api",
    channelUserId: primary,
    name: body.name ?? null,
    phone: body.phone ?? null,
    email: body.email ?? null,
    identities: body.identities,
  });

  if (customValue !== undefined) {
    // PARTIAL: merge these keys, clear the emptied ones, preserve everything else.
    await updateContact(tenantId, contact.id, { custom_fields: customValue, custom_fields_clear: customClear }, clientId);
  }
  if (body.consent !== undefined && body.consent !== contact.messaging_consent) {
    await applyConsentAsAutomation(tenantId, clientId, contact.id, body.consent, body.source_label ?? "api");
  }

  // Enrichment response — NO appointment-shaped field (see loadEnrichmentContact). A contact
  // write must never look like a booking confirmation.
  const summary = await loadEnrichmentContact(tenantId, clientId, contact.id);
  return Response.json({ contact: summary });
}
