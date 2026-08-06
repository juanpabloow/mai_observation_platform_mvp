"use server";

import { revalidatePath } from "next/cache";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { isUuid } from "./clientModuleValidation";
import { hasFullAccess } from "./access";
import { parseContactPatch } from "./contactActionValidation";
import { updateContact, type UpdateContactInput } from "@worker/db/repositories/contacts.js";
import { getMemberInTenant } from "@worker/db/repositories/tenantMembers.js";
import { listFieldDefinitions, validateCustomFieldValues } from "@worker/db/repositories/clientFieldDefinitions.js";
import { mergeContacts, dismissCandidate } from "@worker/db/repositories/contactIdentities.js";

/**
 * Server actions for the client-scoped Contacts CRM. Every action funnels through the
 * central module gate (UUID → session → canAccessClient → non-default client → `crm`
 * enabled); the repo write is ALWAYS client-scoped, so a forged id from another client
 * writes nothing. Errors are generic (no leaks). C-2 adds owner assignment (validated
 * server-side against client access), consent (store-only), custom fields (validated
 * against the client's definitions → distinct 422 error), and merge/dismiss (owner/
 * admin only).
 */

export type ContactActionResult = { ok: true } | { ok: false; error: string };

const GENERIC = "Contact not found.";

export async function updateContactAction(
  clientId: string,
  contactId: string,
  patch: unknown,
): Promise<ContactActionResult> {
  if (!isUuid(contactId)) return { ok: false, error: GENERIC };
  const parsedPatch = parseContactPatch(patch);
  if (!parsedPatch.ok) return { ok: false, error: GENERIC };
  const resolved = await resolveClientModuleContext(clientId, "crm");
  if (!resolved.ok) return { ok: false, error: GENERIC };
  const { scope, client } = resolved.context;

  // Build the repo patch from validated fields; the two dynamic ones (owner, custom
  // fields) get their own server-side checks below.
  const { assigned_to, custom_fields, ...rest } = parsedPatch.value;
  const repoPatch: UpdateContactInput = { ...rest };

  // Owner: the assignee must be a tenant member WITH access to THIS client
  // (owner/admin = any; member = only their own). Null clears the owner.
  if (assigned_to !== undefined) {
    if (assigned_to === null || assigned_to === "") {
      repoPatch.assigned_to = null;
    } else {
      const member = await getMemberInTenant(scope.tenantId, assigned_to);
      const canAccess = member != null && (member.member_client_id === null || member.member_client_id === client.id);
      if (!canAccess) return { ok: false, error: "That user cannot be assigned to this client." };
      repoPatch.assigned_to = assigned_to;
    }
  }

  // Custom fields: validate the whole blob against the client's definitions (unknown
  // key / wrong type → 422-equivalent). Only enabled definitions are accepted.
  if (custom_fields !== undefined) {
    const defs = await listFieldDefinitions(scope.tenantId, client.id, { enabledOnly: true });
    const check = validateCustomFieldValues(defs, custom_fields);
    if (!check.ok) return { ok: false, error: check.error };
    // Partial merge: set these keys, clear the emptied ones, preserve the rest. The
    // operator form submits every defined field each save, so the observable result is
    // unchanged; a form that omits a field no longer wipes it.
    repoPatch.custom_fields = check.value;
    repoPatch.custom_fields_clear = check.clear;
  }

  const row = await updateContact(scope.tenantId, contactId, repoPatch, client.id);
  if (!row) return { ok: false, error: GENERIC };

  revalidatePath(`/clients/${client.id}/contacts`);
  revalidatePath(`/clients/${client.id}/contacts/${contactId}`);
  return { ok: true };
}

/** Merge a duplicate into a survivor. Owner/admin only. */
export async function mergeContactsAction(
  clientId: string,
  keepId: string,
  dropId: string,
): Promise<ContactActionResult> {
  if (!isUuid(keepId) || !isUuid(dropId)) return { ok: false, error: GENERIC };
  const resolved = await resolveClientModuleContext(clientId, "crm");
  if (!resolved.ok) return { ok: false, error: GENERIC };
  const { scope, client } = resolved.context;
  if (!hasFullAccess(scope)) return { ok: false, error: GENERIC }; // owner/admin only

  const result = await mergeContacts(scope.tenantId, client.id, keepId, dropId, scope.userId);
  if (!result.ok) return { ok: false, error: GENERIC };
  revalidatePath(`/clients/${client.id}/contacts`);
  return { ok: true };
}

/** Dismiss a duplicate candidate (they aren't the same person). Owner/admin only. */
export async function dismissCandidateAction(clientId: string, candidateId: string): Promise<ContactActionResult> {
  if (!isUuid(candidateId)) return { ok: false, error: GENERIC };
  const resolved = await resolveClientModuleContext(clientId, "crm");
  if (!resolved.ok) return { ok: false, error: GENERIC };
  const { scope, client } = resolved.context;
  if (!hasFullAccess(scope)) return { ok: false, error: GENERIC };

  await dismissCandidate(scope.tenantId, client.id, candidateId);
  revalidatePath(`/clients/${client.id}/contacts`);
  return { ok: true };
}
