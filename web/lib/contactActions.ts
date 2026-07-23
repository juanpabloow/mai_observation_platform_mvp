"use server";

import { revalidatePath } from "next/cache";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { isUuid } from "./clientModuleValidation";
import { parseContactPatch } from "./contactActionValidation";
import { updateContact } from "@worker/db/repositories/contacts.js";

/**
 * Server actions for the client-scoped Contacts CRM (Phase 3A). Every action is
 * gated by the central module resolver: the clientId must be a UUID, accessible
 * to the session (owner/admin: any client of their tenant; member: only theirs),
 * a real non-default client of the tenant, AND have the `crm` module enabled.
 * The repo write is ALWAYS client-scoped (even for owner/admin), so a forged
 * contactId from another client updates nothing. Errors are generic — no SQL,
 * internals, or existence leaks. "Customer" status stays DERIVED (≥1 completed
 * appointment), never set here.
 */

export type ContactActionResult = { ok: true } | { ok: false; error: string };

const GENERIC = "Contact not found.";

export async function updateContactAction(
  clientId: string,
  contactId: string,
  patch: unknown,
): Promise<ContactActionResult> {
  if (!isUuid(contactId)) return { ok: false, error: GENERIC };
  // ANTI-OVER-POSTING: the browser payload is validated strictly (whitelist of 5
  // fields, unknown keys — e.g. assigned_to — rejected, exact enums, bounded
  // strings, no coercion) and REBUILT; the original object is never forwarded.
  const parsedPatch = parseContactPatch(patch);
  if (!parsedPatch.ok) return { ok: false, error: GENERIC };
  // Central gate: UUID → session → canAccessClient → client-in-tenant →
  // non-default → crm enabled. Any failure is one generic error.
  const resolved = await resolveClientModuleContext(clientId, "crm");
  if (!resolved.ok) return { ok: false, error: GENERIC };
  const { scope, client } = resolved.context;

  // ALWAYS client-scoped (also for owner/admin): a contact belonging to another
  // client is a no-op null — zero writes.
  const row = await updateContact(scope.tenantId, contactId, parsedPatch.value, client.id);
  if (!row) return { ok: false, error: GENERIC };

  revalidatePath(`/clients/${client.id}/contacts`);
  revalidatePath(`/clients/${client.id}/contacts/${contactId}`);
  return { ok: true };
}
