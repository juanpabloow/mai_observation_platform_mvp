"use server";

import { revalidatePath } from "next/cache";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { isUuid } from "./clientModuleValidation";
import { hasFullAccess } from "./access";
import { parseContactPatch, parseContactCreate } from "./contactActionValidation";
import { isFullAccess as actorIsFullAccess } from "./crmPermissions";
import { updateContact, deleteContact, type UpdateContactInput } from "@worker/db/repositories/contacts.js";
import { getMemberInTenant } from "@worker/db/repositories/tenantMembers.js";
import { listFieldDefinitions, validateCustomFieldValues } from "@worker/db/repositories/clientFieldDefinitions.js";
import {
  mergeContacts,
  dismissCandidate,
  resolveContactByIdentity,
  findContactIdsByIdentity,
  findContactMatchesByIdentity,
} from "@worker/db/repositories/contactIdentities.js";
import { createTag, listTags, attachTag } from "@worker/db/repositories/contactTags.js";
import { createNote } from "@worker/db/repositories/contactNotes.js";

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

// ── Create ─────────────────────────────────────────────────────────────────────

export type ContactCreateResult =
  | { ok: true; contactId: string; created: boolean; skippedTags: string[] }
  | { ok: false; error: string };

/**
 * MANUAL contact creation — the browser's entry to C-2's identity chokepoint, and the
 * reason the list's "New contact" button was disabled until now.
 *
 * IT DOES NOT INSERT. It calls resolveContactByIdentity, exactly like the machine
 * `/contacts/upsert` route and the booking flow, because that is the only way a manually
 * typed number and the same number arriving later over WhatsApp stay ONE person. A
 * direct INSERT here is precisely the duplicate this chokepoint exists to prevent.
 *
 * `created` IS PART OF THE CONTRACT. When the typed identities already belong to
 * somebody, the spine resolves to that contact rather than minting a second one — so
 * "Continuar de todos modos" does not mean "make a duplicate", it means "proceed, and
 * you will be enriching the person who already has this number". The caller must say so;
 * reporting "contacto creado" when nothing was created is the lie that would teach
 * operators to distrust the dedup warning. `created` is decided by a read-only
 * findContactIdsByIdentity BEFORE resolving (one indexed lookup, no side effects).
 *
 * WHICH FIELDS ARE WRITTEN depends on that same answer, and follows the spine's
 * fill-empty philosophy:
 *  - CREATED → everything the operator chose (stage, owner, channel, consent, …).
 *  - RESOLVED to an existing contact → only ADDITIVE things: custom fields (a partial
 *    merge), tags, and the note. Stage, owner, consent and channel are left alone,
 *    because silently re-stamping a five-year customer as "Nuevo" — or overwriting a
 *    recorded consent — is data loss dressed up as a create.
 */
export async function createContactAction(clientId: string, input: unknown): Promise<ContactCreateResult> {
  const parsed = parseContactCreate(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const resolved = await resolveClientModuleContext(clientId, "crm");
  if (!resolved.ok) return { ok: false, error: GENERIC };
  const { scope, client } = resolved.context;
  const tenantId = scope.tenantId;
  const v = parsed.value;

  // Owner: same rule as updateContactAction — the assignee must be a member with
  // access to THIS client (owner/admin may pick anyone, a member only themselves).
  let assignedTo: string | null = null;
  if (v.assigned_to) {
    const member = await getMemberInTenant(tenantId, v.assigned_to);
    const canAccess = member != null && (member.member_client_id === null || member.member_client_id === client.id);
    if (!canAccess) return { ok: false, error: "That user cannot be assigned to this client." };
    assignedTo = v.assigned_to;
  }

  // Custom fields validated BEFORE anything is written, so a bad blob can't leave a
  // half-populated contact behind.
  let customValue: Record<string, unknown> | undefined;
  if (v.custom_fields !== undefined) {
    const defs = await listFieldDefinitions(tenantId, client.id, { enabledOnly: true });
    const check = validateCustomFieldValues(defs, v.custom_fields);
    if (!check.ok) return { ok: false, error: check.error };
    customValue = check.value;
  }

  // Did this person already exist? Read-only — resolving would create.
  const preexisting = await findContactIdsByIdentity({
    tenantId,
    clientId: client.id,
    phone: v.phones[0] ?? null,
    email: v.emails[0] ?? null,
    channelUserId: null,
  });
  // Extra identities beyond the first pair also decide "already existed".
  const preexistingAll = new Set(preexisting);
  for (const extra of [...v.phones.slice(1), ...v.emails.slice(1)]) {
    for (const id of await findContactIdsByIdentity({ tenantId, clientId: client.id, phone: extra, email: extra })) {
      preexistingAll.add(id);
    }
  }

  // THE CHOKEPOINT. `manual` is a descriptive source label, never branched on; the
  // primary is the first phone, else the first email — the same precedence /contacts/
  // upsert uses. The full lists go through so EVERY identity is inside the collision
  // rules (see ResolveIdentityInput.phones).
  const { contact } = await resolveContactByIdentity({
    tenantId,
    clientId: client.id,
    channel: "manual",
    channelUserId: v.phones[0] ?? v.emails[0],
    name: v.name?.trim() ? v.name.trim() : null,
    phone: v.phones[0] ?? null,
    email: v.emails[0] ?? null,
    phones: v.phones,
    emails: v.emails,
  });
  const created = preexistingAll.size === 0;

  const patch: UpdateContactInput = {};
  if (created) {
    if (v.stage !== undefined) patch.stage = v.stage;
    if (assignedTo !== null) patch.assigned_to = assignedTo;
    if (v.preferred_channel !== undefined) patch.preferred_channel = v.preferred_channel;
    if (v.do_not_contact !== undefined) patch.do_not_contact = v.do_not_contact;
    if (v.messaging_consent !== undefined) {
      patch.messaging_consent = v.messaging_consent;
      patch.consent_source = v.consent_source ?? "manual";
    }
  }
  if (customValue !== undefined && Object.keys(customValue).length > 0) patch.custom_fields = customValue;
  if (Object.keys(patch).length > 0) await updateContact(tenantId, contact.id, patch, client.id);

  // TAGS are their own rows. Attach by NAME: an existing tag is reused (case-insensitive
  // — "VIP" and "vip" are one tag, not two), a new name is created only when the actor
  // may manage the catalogue. A member who cannot create tags gets the CONTACT anyway
  // and the skipped names reported: losing a whole contact over a tag permission would
  // be a worse failure than the one it prevents.
  const skippedTags: string[] = [];
  const wantedTags = (v.tags ?? []).map((t) => t.trim()).filter(Boolean);
  if (wantedTags.length > 0) {
    const catalogue = await listTags(tenantId, client.id);
    const byName = new Map(catalogue.map((t) => [t.name.toLowerCase(), t.id]));
    const mayCreate = actorIsFullAccess({ role: scope.role, userId: scope.userId });
    for (const name of wantedTags) {
      let tagId = byName.get(name.toLowerCase());
      if (!tagId) {
        if (!mayCreate) {
          skippedTags.push(name);
          continue;
        }
        const r = await createTag({ tenantId, clientId: client.id, name, color: "gray" });
        if (!r.ok) {
          skippedTags.push(name);
          continue;
        }
        tagId = r.tag.id;
        byName.set(name.toLowerCase(), tagId);
      }
      await attachTag({ tenantId, clientId: client.id, contactId: contact.id, tagId, actorUserId: scope.userId });
    }
  }

  // The note is a separate append-only row, written last so a note failure can never
  // cost the contact.
  const noteBody = v.note?.trim();
  if (noteBody) {
    await createNote({ tenantId, clientId: client.id, contactId: contact.id, body: noteBody, createdByUserId: scope.userId });
  }

  revalidatePath(`/clients/${client.id}/contacts`);
  revalidatePath(`/clients/${client.id}/contacts/${contact.id}`);
  return { ok: true, contactId: contact.id, created, skippedTags };
}

// ── Inline duplicate check ─────────────────────────────────────────────────────

export interface IdentityMatchView {
  contactId: string;
  name: string | null;
  matchedValue: string;
  stage: string;
  /** ISO — the caller renders the relative age. */
  lastContactAt: string;
  createdAt: string;
}

/**
 * The form's live "does this already exist?" probe. READ-ONLY by construction (see
 * findContactMatchesByIdentity) — it must never be able to create the very contact the
 * operator is still deciding whether to create.
 *
 * Returns `total` separately from `matches` because the heading counts all of them
 * while the list shows at most three.
 */
export async function lookupIdentityAction(
  clientId: string,
  kind: "phone" | "email",
  value: string,
  excludeContactId?: string | null,
): Promise<{ ok: true; matches: IdentityMatchView[]; total: number } | { ok: false }> {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) return { ok: false };
  if (kind !== "phone" && kind !== "email") return { ok: false };
  if (excludeContactId && !isUuid(excludeContactId)) return { ok: false };
  const resolved = await resolveClientModuleContext(clientId, "crm");
  if (!resolved.ok) return { ok: false };
  const { scope, client } = resolved.context;
  const { matches, total } = await findContactMatchesByIdentity(scope.tenantId, client.id, value, {
    limit: 3,
    excludeContactId: excludeContactId ?? null,
  });
  return {
    ok: true,
    total,
    matches: matches.map((m) => ({
      contactId: m.contact_id,
      name: m.name,
      matchedValue: m.matched_value,
      stage: m.stage,
      lastContactAt: m.last_contact_at.toISOString(),
      createdAt: m.created_at.toISOString(),
    })),
  };
}

// ── Delete ─────────────────────────────────────────────────────────────────────

/**
 * Delete a contact. Owner/admin only — a member may edit the people they work with but
 * not erase them, which matches how the tag catalogue and merge are already gated.
 * The repo call is client-scoped, so a forged id from another client deletes nothing.
 */
export async function deleteContactAction(clientId: string, contactId: string): Promise<ContactActionResult> {
  if (!isUuid(contactId)) return { ok: false, error: GENERIC };
  const resolved = await resolveClientModuleContext(clientId, "crm");
  if (!resolved.ok) return { ok: false, error: GENERIC };
  const { scope, client } = resolved.context;
  if (!hasFullAccess(scope)) return { ok: false, error: GENERIC };

  const gone = await deleteContact(scope.tenantId, client.id, contactId);
  if (!gone) return { ok: false, error: GENERIC };
  revalidatePath(`/clients/${client.id}/contacts`);
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
