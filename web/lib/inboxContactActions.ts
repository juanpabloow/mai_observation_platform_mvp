"use server";

import { revalidatePath } from "next/cache";
import { resolveClientModuleContext } from "@/lib/clientModuleAccess";
import { isUuid } from "@/lib/clientModuleValidation";
import { getConversationForClient } from "@worker/db/repositories/handoff.js";
import { resolveContactByIdentity } from "@worker/db/repositories/contactIdentities.js";
import { linkConversationToContact } from "@worker/db/repositories/contacts.js";

/**
 * Link the open conversation to a contact (C-4). The inbox panel needs this when a
 * conversation has no contact_id yet (only the one-time backfill + the booking flow
 * link contacts today — inbound messages never do). Resolution goes through C-2's
 * identity chokepoint (resolveContactByIdentity), so the conversation's channel id
 * attaches to the right person and a duplicate candidate is recorded rather than a
 * duplicate contact created. Gated on the inbox module + client access (deny-by-default,
 * indistinguishable 404 via the generic error).
 *
 * Note: the conversation row does not carry its source channel, so the identity is
 * classified by VALUE (phone/email/external) from conversation_ref — correct for the
 * usual phone/email refs — and the contact's channel column is labelled "inbox".
 */
export type LinkResult = { ok: true; contactId: string } | { ok: false; error: string };

const GENERIC = "Not found.";

export async function linkConversationContactAction(clientId: string, conversationId: string): Promise<LinkResult> {
  if (!isUuid(conversationId)) return { ok: false, error: GENERIC };
  const resolved = await resolveClientModuleContext(clientId, "inbox");
  if (!resolved.ok) return { ok: false, error: GENERIC };
  const { scope, client } = resolved.context;

  const conversation = await getConversationForClient(scope.tenantId, client.id, conversationId);
  if (!conversation) return { ok: false, error: GENERIC };

  // Already linked → just report it (idempotent from the panel's perspective).
  if (conversation.contact_id) return { ok: true, contactId: conversation.contact_id };

  const { contact } = await resolveContactByIdentity({
    tenantId: scope.tenantId,
    clientId: client.id,
    channel: "inbox",
    channelUserId: conversation.conversation_ref,
  });
  await linkConversationToContact(scope.tenantId, conversationId, contact.id);
  revalidatePath(`/clients/${clientId}/inbox`);
  return { ok: true, contactId: contact.id };
}
