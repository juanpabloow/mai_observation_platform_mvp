"use server";

import { revalidatePath } from "next/cache";
import { getCurrentTenantId } from "./tenant";
import { requireFullAccessForAction } from "./access";
import { updateContact, type BotHumanMode, type ContactStage } from "@worker/db/repositories/contacts.js";

/**
 * Server actions for the Contacts CRM. Owner/admin, tenant-scoped. Editing is
 * limited to safe person fields (name/phone/email/stage/mode/assignment) — the
 * "customer" status is DERIVED (≥1 completed appointment), never set here.
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
  await requireFullAccessForAction();
  const tenantId = await getCurrentTenantId();
  const row = await updateContact(tenantId, contactId, patch);
  if (!row) return { ok: false, error: "Contact not found." };
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
  return { ok: true };
}
