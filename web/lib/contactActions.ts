"use server";

import { revalidatePath } from "next/cache";
import { getAccessScope } from "./access";
import { updateContact, type BotHumanMode, type ContactStage } from "@worker/db/repositories/contacts.js";

/**
 * Server actions for the Contacts CRM. Session-scoped: owner/admin edit any client's
 * contacts; a member is hard-scoped to their client (updateContact ignores a
 * contact outside the scope). "Customer" status is DERIVED (≥1 completed
 * appointment), never set here.
 */

export type ContactActionResult = { ok: true } | { ok: false; error: string };

export async function updateContactAction(
  contactId: string,
  patch: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    stage?: ContactStage;
    bot_human_mode?: BotHumanMode;
  },
): Promise<ContactActionResult> {
  const scope = await getAccessScope();
  const tenantId = scope.tenantId;
  const row = await updateContact(tenantId, contactId, patch, scope.memberClientId);
  if (!row) return { ok: false, error: "Contact not found." };
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
  return { ok: true };
}
